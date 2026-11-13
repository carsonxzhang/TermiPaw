//! 在线更新，设计见 docs/UPDATER.md。
//!
//! 更新地址和公钥都由后端决定，也不给界面开放插件自带的命令。界面只能问“有没有新版本”和
//! “更新成刚才查到的那个”，被攻破的界面最多能让程序换成一个正式签过名的新版本。
//!
//! 检查、下载和签名校验用插件（它在返回下载内容之前已经校验过签名和版本号）；
//! 绿色版没有安装程序，替换自己和重新启动在 selfupdate.rs 里。

use std::{sync::Mutex, time::Duration};

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, State, Url};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

use crate::{
    edit,
    error::{AppError, AppResult},
    i18n::t,
    selfupdate,
};

/// 检查只读一个小文件，连不上就不用等下载那么久
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// 插件的超时同时管检查和下载，这里按慢速网络下载整个程序来算
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_NOTES_CHARS: usize = 4000;
const PROGRESS_STEP: u64 = 256 * 1024;

/// 刚才查到的更新。安装时只用这里的内容，不接受界面传来的地址或版本
#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
}

struct Source {
    pubkey: String,
    endpoints: Vec<Url>,
}

/// 公钥和更新地址都配好了才算支持更新。没有配置时什么请求都不会发
fn source(app: &AppHandle) -> Option<Source> {
    // 调试版只认测试开关，不读打包配置：开发和端到端测试永远不会向 GitHub 发请求，
    // 测试用本地服务器和一次性的密钥
    if cfg!(debug_assertions) {
        let (Ok(url), Ok(pubkey)) = (std::env::var("TERMIPAW_TEST_UPDATE_URL"), std::env::var("TERMIPAW_TEST_UPDATE_PUBKEY")) else {
            return None;
        };
        return Some(Source { pubkey, endpoints: vec![Url::parse(&url).ok()?] });
    }
    source_from_config(app.config().plugins.0.get("updater")?)
}

/// 打包配置（`tauri.conf.json` 的 `plugins.updater`）里的更新地址和公钥
fn source_from_config(config: &serde_json::Value) -> Option<Source> {
    let pubkey = config.get("pubkey")?.as_str()?.to_owned();
    let endpoints = config.get("endpoints")?.as_array()?.iter().filter_map(|url| Url::parse(url.as_str()?).ok()).collect::<Vec<_>>();
    (!pubkey.is_empty() && !endpoints.is_empty()).then_some(Source { pubkey, endpoints })
}

/// 更新说明和签名无关，签名只覆盖程序文件。这里按不可信的文本处理：
/// 去掉控制字符和能改变显示顺序的字符，限制长度。界面只把它当纯文本显示
fn clean_notes(raw: &str) -> String {
    let hidden = |c: char| matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}');
    raw.chars().filter(|&c| c == '\n' || !(c.is_control() || hidden(c))).take(MAX_NOTES_CHARS).collect::<String>().trim().to_owned()
}

fn check_error(e: UpdaterError) -> AppError {
    match e {
        // 服务器有回应，只是内容不是 JSON
        UpdaterError::Reqwest(e) if e.is_decode() => t("update.badManifest").into(),
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) => t("update.unreachable").into(),
        UpdaterError::ReleaseNotFound => t("update.notFound").into(),
        UpdaterError::Serialization(_) | UpdaterError::Semver(_) | UpdaterError::UrlParse(_) => t("update.badManifest").into(),
        UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_) => t("update.noPackage").into(),
        other => t("update.checkFailed").detail(other).into(),
    }
}

fn install_error(e: UpdaterError) -> AppError {
    match e {
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => t("update.badSignature").into(),
        UpdaterError::InvalidUpdaterFormat => t("update.badFormat").into(),
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) => t("update.downloadFailed").into(),
        other => t("update.installFailed").detail(other).into(),
    }
}

#[derive(Serialize)]
pub struct UpdateStatus {
    current: String,
    configured: bool,
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    UpdateStatus { current: app.package_info().version.to_string(), configured: source(&app).is_some() }
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: String,
}

/// 没有更新时返回 `None`。版本号不比现在新的一律不算更新，不能回退
#[tauri::command]
pub async fn update_check(app: AppHandle, updates: State<'_, Updates>) -> AppResult<Option<UpdateInfo>> {
    let source = source(&app).ok_or_else(|| t("update.notConfigured"))?;
    let updater = app
        .updater_builder()
        .pubkey(source.pubkey)
        .endpoints(source.endpoints)
        .map_err(check_error)?
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(check_error)?;
    let found = tokio::time::timeout(CHECK_TIMEOUT, updater.check())
        .await
        .map_err(|_| t("update.timeout"))?
        .map_err(check_error)?;
    let info = found.as_ref().map(|update| UpdateInfo { version: update.version.clone(), notes: clean_notes(update.body.as_deref().unwrap_or_default()) });
    *updates.pending.lock().unwrap() = found;
    Ok(info)
}

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

/// 下载并校验。返回的字节已经通过了签名、版本号、文件名和格式的检查
async fn fetch(update: &Update, exe: &std::path::Path, on_progress: &Channel<DownloadProgress>) -> AppResult<Vec<u8>> {
    // 先确认能写，不然白白下载一遍
    selfupdate::ensure_folder_writable(exe).map_err(|reason| t("update.notWritable").detail(reason))?;
    let (mut received, mut reported) = (0u64, 0u64);
    // 签名和版本号由插件在 download 返回之前校验
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                if received - reported >= PROGRESS_STEP || Some(received) == total {
                    reported = received;
                    let _ = on_progress.send(DownloadProgress { received, total });
                }
            },
            || {},
        )
        .await
        .map_err(install_error)?;
    if !selfupdate::signed_for_this_release(&update.signature, &update.version) {
        return Err(t("update.badSignature").into());
    }
    if !selfupdate::looks_like_our_program(&bytes) {
        return Err(t("update.badFormat").into());
    }
    Ok(bytes)
}

/// 下载、校验，然后换掉自己并重新启动。成功时程序会退出，不会返回
#[tauri::command]
pub async fn update_install(app: AppHandle, updates: State<'_, Updates>, on_progress: Channel<DownloadProgress>) -> AppResult<()> {
    let update = updates.pending.lock().unwrap().take().ok_or_else(|| t("update.nothingPending"))?;
    let exe = std::env::current_exe().map_err(|e| t("update.replaceFailed").detail(e));
    let result = match exe {
        Ok(exe) => fetch(&update, &exe, &on_progress).await.map(|bytes| (exe, bytes)),
        Err(e) => Err(e.into()),
    };
    let (exe, bytes) = match result {
        Ok(ok) => ok,
        Err(e) => {
            // 网络失败等可以直接重试
            *updates.pending.lock().unwrap() = Some(update);
            return Err(e);
        }
    };
    let replaced = if selfupdate::in_build_folder(&exe) {
        Err(t("update.replaceFailed").detail("running from a build output folder (target\\debug or target\\release)"))
    } else {
        selfupdate::replace_exe(&exe, &bytes).map_err(|e| t("update.replaceFailed").detail(e))
    };
    if let Err(e) = replaced {
        *updates.pending.lock().unwrap() = Some(update);
        return Err(e.into());
    }
    // 已经换好了。启动新程序，它会等这个进程退出
    if let Err(e) = selfupdate::start_again(&exe) {
        return Err(t("update.restartFailed").detail(e).into());
    }
    // 和关闭窗口一样：已经传回服务器的编辑临时文件不留在电脑上
    app.state::<edit::Edits>().stop_all();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_lose_control_and_reordering_characters() {
        assert_eq!(clean_notes("  修复问题\r\n\x1b[31m第二行\u{202E}txt.exe\u{2066}  "), "修复问题\n[31m第二行txt.exe");
    }

    #[test]
    fn notes_are_limited_by_characters_not_bytes() {
        let notes = clean_notes(&"更".repeat(MAX_NOTES_CHARS + 10));
        assert_eq!(notes.chars().count(), MAX_NOTES_CHARS);
    }

    /// 发布出去的配置：地址对，公钥是一把 minisign 公钥。
    /// 公钥错一个字符，所有已安装的版本都再也收不到更新，而且装上之后无法补救
    #[test]
    fn the_shipped_config_names_the_repository_and_holds_a_valid_public_key() {
        use base64ct::{Base64, Encoding};

        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let source = source_from_config(&config["plugins"]["updater"]).expect("发布的配置里没有更新地址或公钥");
        assert_eq!(source.endpoints.len(), 1);
        assert_eq!(source.endpoints[0].as_str(), "https://github.com/carsonxzhang/TermiPaw/releases/latest/download/latest.json");

        let file = String::from_utf8(Base64::decode_vec(&source.pubkey).expect("公钥不是 base64")).unwrap();
        let mut lines = file.lines();
        let comment = lines.next().unwrap();
        assert!(comment.starts_with("untrusted comment: minisign public key: "), "{comment}");
        let key = Base64::decode_vec(lines.next().expect("公钥文件缺少第二行")).unwrap();
        // 'Ed' + 8 字节密钥 ID + 32 字节公钥
        assert_eq!((key.len(), &key[..2]), (42, &b"Ed"[..]));
        // 注释里的密钥 ID 是这 8 字节倒过来的十六进制
        let id: String = key[2..10].iter().rev().map(|b| format!("{b:02X}")).collect();
        assert!(comment.ends_with(&id), "{comment} / {id}");
    }

    #[test]
    fn a_config_without_an_address_or_key_means_updates_are_off() {
        for config in [
            serde_json::json!({}),
            serde_json::json!({ "pubkey": "", "endpoints": ["https://example.com/latest.json"] }),
            serde_json::json!({ "pubkey": "abc", "endpoints": [] }),
            serde_json::json!({ "pubkey": "abc", "endpoints": ["不是地址"] }),
        ] {
            assert!(source_from_config(&config).is_none(), "{config}");
        }
    }

    /// 这些选项一旦改错，签名和回退保护就形同虚设，不能靠人记住
    #[test]
    fn the_shipped_config_keeps_the_safety_settings() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert_eq!(updater["requireSignedVersion"], true);
        for unsafe_option in ["dangerousInsecureTransportProtocol", "dangerousAcceptInvalidCerts", "dangerousAcceptInvalidHostnames", "allowDowngrades"] {
            assert!(updater.get(unsafe_option).is_none(), "{unsafe_option}");
        }
        for url in updater["endpoints"].as_array().unwrap() {
            assert!(url.as_str().unwrap().starts_with("https://"), "{url}");
        }
    }
}
