//! 本地文件的授权。
//!
//! 界面不能直接指定要读写的本地路径，否则界面一旦被攻破（比如某个前端依赖被投毒），
//! 就能把任意本地文件上传到已连接的服务器，或者覆盖任意本地文件。
//!
//! 路径只有两个来源：用户在系统文件对话框里的选择，或把文件拖进窗口。这两件事都在后端处理，
//! 只把一次性的令牌和文件名交给界面；之后的上传、下载凭令牌换回路径。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{
    error::AppResult,
    i18n::{self, t},
    store::Store,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
    /// 下载目录时选择的存放位置，在它下面新建文件夹
    WriteDir,
}

struct Grant {
    path: PathBuf,
    access: Access,
    created: Instant,
}

/// 令牌的有效期。选了文件之后可能先停在“是否覆盖”的确认上，所以不能太短
const LIFETIME: Duration = Duration::from_secs(30 * 60);

#[derive(Default)]
pub struct Grants(Mutex<HashMap<String, Grant>>);

impl Grants {
    pub fn grant(&self, path: PathBuf, access: Access) -> String {
        self.grant_at(path, access, Instant::now())
    }

    fn grant_at(&self, path: PathBuf, access: Access, created: Instant) -> String {
        let mut grants = self.0.lock().unwrap();
        grants.retain(|_, g| g.created.elapsed() < LIFETIME);
        let token = uuid::Uuid::new_v4().to_string();
        grants.insert(token.clone(), Grant { path, access, created });
        token
    }

    /// 用令牌换回路径。令牌只能用一次，而且读写类型要对得上。
    pub fn take(&self, token: &str, access: Access) -> AppResult<PathBuf> {
        let grant = self
            .0
            .lock()
            .unwrap()
            .remove(token)
            .ok_or_else(|| t("grant.invalid"))?;
        if grant.created.elapsed() >= LIFETIME {
            return Err(t("grant.expired").into());
        }
        if grant.access != access {
            return Err(t("grant.wrongUse").into());
        }
        Ok(grant.path)
    }
}

/// 交给界面的本地文件：只有令牌和显示用的文件名，没有路径
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    token: String,
    name: String,
    is_dir: bool,
}

fn grant_file(grants: &Grants, path: PathBuf, access: Access) -> LocalFile {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let is_dir = path.is_dir();
    LocalFile { token: grants.grant(path, access), name, is_dir }
}

/// 文件名的长度上限（字符数）。给扩展名和重名时的编号留出余地，Windows 的单个名字最长 255
const MAX_LOCAL_NAME: usize = 200;

/// 看不见但会改变显示的字符。RTL 覆盖能把 `.exe` 显示成别的扩展名
fn is_invisible(c: char) -> bool {
    matches!(c as u32,
        0xAD | 0x34F | 0x61C | 0x180E | 0x200B | 0x200E | 0x200F | 0x2028..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB)
}

/// 把服务器给的文件名变成可以在本地使用的安全名字：去掉路径分隔符、控制字符、看不见的字符和 Windows 不允许的字符
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !is_invisible(*c))
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim_matches(|c| c == ' ' || c == '.');
    if cleaned.is_empty() {
        return "download".into();
    }
    let cleaned = shorten(cleaned);
    let cleaned = cleaned.trim_end_matches([' ', '.']);
    // CON、NUL、COM1 等设备名（带不带扩展名都一样）不能用作文件名
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.ends_with(|c: char| c.is_ascii_digit() && c != '0'));
    if reserved {
        format!("_{cleaned}")
    } else {
        cleaned.to_string()
    }
}

/// 太长的名字从中间截断，保留扩展名
fn shorten(name: &str) -> String {
    let count = name.chars().count();
    if count <= MAX_LOCAL_NAME {
        return name.to_string();
    }
    let ext: String = match name.rfind('.') {
        Some(i) if name[i..].chars().count() <= 20 => name[i..].to_string(),
        _ => String::new(),
    };
    let keep = MAX_LOCAL_NAME - ext.chars().count();
    name.chars().take(keep).collect::<String>() + &ext
}

/// 对话框一开始显示的目录。端到端测试时指向测试目录：脚本操作对话框万一失败，
/// 对话框会直接返回这个目录，不能让它碰到用户真实的“下载”文件夹。
fn dialog_start_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("TERMIPAW_DATA_DIR").filter(|_| cfg!(debug_assertions)) {
        let start = PathBuf::from(dir).join("dialog-start");
        return std::fs::create_dir_all(&start).ok().map(|()| start);
    }
    app.path().download_dir().ok()
}

/// 端到端测试用：系统的文件夹对话框没法用脚本填路径，测试把答案写在 `folder-answer.txt` 里，用一次就删掉。
/// 只有调试版、并且数据目录指向别处时才生效。
fn test_folder_answer() -> Option<PathBuf> {
    let dir = std::env::var_os("TERMIPAW_DATA_DIR").filter(|_| cfg!(debug_assertions))?;
    let file = PathBuf::from(dir).join("folder-answer.txt");
    let answer = std::fs::read_to_string(&file).ok()?;
    let _ = std::fs::remove_file(&file);
    Some(PathBuf::from(answer.trim()))
}

async fn blocking_dialog<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| t("dialog.failed").detail(e).into())
}

#[tauri::command]
pub async fn pick_upload_files(window: WebviewWindow, grants: State<'_, Grants>) -> AppResult<Vec<LocalFile>> {
    let app = window.app_handle().clone();
    let picked = blocking_dialog(move || app.dialog().file().set_parent(&window).set_title(i18n::dialog_title(i18n::Dialog::UploadFiles)).blocking_pick_files()).await?;
    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|path| grant_file(&grants, path, Access::Read))
        .collect())
}

#[tauri::command]
pub async fn pick_upload_folder(window: WebviewWindow, grants: State<'_, Grants>) -> AppResult<Option<LocalFile>> {
    if let Some(path) = test_folder_answer() {
        return Ok(Some(grant_file(&grants, path, Access::Read)));
    }
    let app = window.app_handle().clone();
    let start = std::env::var_os("TERMIPAW_DATA_DIR").is_some().then(|| dialog_start_dir(&app)).flatten();
    let picked = blocking_dialog(move || {
        let mut dialog = app.dialog().file().set_parent(&window).set_title(i18n::dialog_title(i18n::Dialog::UploadFolder));
        if let Some(dir) = start {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_pick_folder()
    })
    .await?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|path| grant_file(&grants, path, Access::Read)))
}

/// 选择下载目录的存放位置。文件夹会新建在它下面
#[tauri::command]
pub async fn pick_download_folder(window: WebviewWindow, grants: State<'_, Grants>) -> AppResult<Option<LocalFile>> {
    if let Some(path) = test_folder_answer() {
        return Ok(Some(grant_file(&grants, path, Access::WriteDir)));
    }
    let app = window.app_handle().clone();
    let downloads = dialog_start_dir(&app);
    let picked = blocking_dialog(move || {
        let mut dialog = app.dialog().file().set_parent(&window).set_title(i18n::dialog_title(i18n::Dialog::DownloadTo));
        if let Some(dir) = downloads {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_pick_folder()
    })
    .await?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|path| grant_file(&grants, path, Access::WriteDir)))
}

/// 系统的“保存到”对话框。建议的文件名先变成安全的名字
async fn save_dialog(window: WebviewWindow, default_name: &str, start: Option<PathBuf>) -> AppResult<Option<PathBuf>> {
    let app = window.app_handle().clone();
    let name = safe_file_name(default_name);
    let picked = blocking_dialog(move || {
        let mut dialog = app.dialog().file().set_parent(&window).set_title(i18n::dialog_title(i18n::Dialog::SaveTo)).set_file_name(name);
        if let Some(dir) = start {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_save_file()
    })
    .await?;
    Ok(picked.and_then(|p| p.into_path().ok()))
}

#[tauri::command]
pub async fn pick_save_location(window: WebviewWindow, grants: State<'_, Grants>, default_name: String) -> AppResult<Option<LocalFile>> {
    let downloads = dialog_start_dir(window.app_handle());
    Ok(save_dialog(window, &default_name, downloads).await?.map(|path| grant_file(&grants, path, Access::Write)))
}

/// 保存终端输出的默认位置：数据目录里的 `logs\`。程序旁边只留一个数据目录，不再多出别的文件夹
fn logs_dir(data: &Path) -> PathBuf {
    data.join("logs")
}

/// 把终端里的内容存成文本文件。位置由用户在系统对话框里选，界面只给内容和建议的文件名。
/// 返回保存的位置，用户取消时为 `None`
#[tauri::command]
pub async fn save_terminal_output(window: WebviewWindow, store: State<'_, Store>, default_name: String, text: String) -> AppResult<Option<String>> {
    let logs = logs_dir(store.dir());
    // 对话框要打开在 `logs\` 里，所以先建好。最后没存进去的话再删掉，不留空文件夹
    let created = !logs.exists() && std::fs::create_dir_all(&logs).is_ok();
    let start = logs.is_dir().then(|| logs.clone());
    let result = match save_dialog(window, &default_name, start).await {
        Ok(Some(path)) => std::fs::write(&path, text.as_bytes()).map(|()| Some(path.display().to_string())).map_err(Into::into),
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    };
    if created {
        // 只能删掉空文件夹：存进了 `logs\` 的话这一步什么也不做
        let _ = std::fs::remove_dir(&logs);
    }
    result
}

/// 选私钥文件。路径本来就要显示在主机设置里并保存下来，所以直接返回路径
#[tauri::command]
pub async fn pick_key_file(window: WebviewWindow) -> AppResult<Option<String>> {
    let app = window.app_handle().clone();
    let picked = blocking_dialog(move || app.dialog().file().set_parent(&window).set_title(i18n::dialog_title(i18n::Dialog::KeyFile)).blocking_pick_file()).await?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

// ---------- 拖拽 ----------

#[derive(Clone, Serialize)]
struct Position {
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize)]
struct Dropped {
    x: f64,
    y: f64,
    files: Vec<LocalFile>,
}

/// 把窗口收到的拖拽事件转成界面能用的事件：位置照常给，落下的文件换成令牌
pub fn handle_drag_drop(app: &AppHandle, event: &DragDropEvent) {
    // 锁定时界面被遮住了，拖进来的文件不能悄悄开始上传
    let vault = &app.state::<crate::store::Store>().vault;
    if vault.is_on() && !vault.is_unlocked() {
        return;
    }
    match event {
        DragDropEvent::Enter { position, .. } | DragDropEvent::Over { position } => {
            let _ = app.emit("files-drag", Position { x: position.x, y: position.y });
        }
        DragDropEvent::Drop { paths, position } => {
            let grants = app.state::<Grants>();
            let files = paths.iter().map(|p| grant_file(&grants, p.clone(), Access::Read)).collect();
            let _ = app.emit("files-dropped", Dropped { x: position.x, y: position.y, files });
        }
        DragDropEvent::Leave => {
            let _ = app.emit("files-drag-leave", ());
        }
        _ => {}
    }
}

/// 端到端测试用：模拟把文件拖进窗口。系统的拖拽事件没法从外部触发，这里走同一个处理函数。
/// 发布版里什么都不做。
#[tauri::command]
pub fn debug_drop(app: AppHandle, paths: Vec<String>, x: f64, y: f64) -> AppResult<()> {
    if !cfg!(debug_assertions) {
        return Err(t("debug.only").into());
    }
    let paths = paths.iter().map(|p| Path::new(p).to_path_buf()).collect();
    handle_drag_drop(&app, &DragDropEvent::Drop { paths, position: tauri::PhysicalPosition::new(x, y) });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_output_goes_into_the_data_folder() {
        assert_eq!(logs_dir(Path::new(r"D:\tools\TermiPaw_Data")), PathBuf::from(r"D:\tools\TermiPaw_Data\logs"));
    }

    #[test]
    fn a_token_returns_its_path_once() {
        let grants = Grants::default();
        let token = grants.grant("C:\\data\\a.txt".into(), Access::Read);
        assert_eq!(grants.take(&token, Access::Read).unwrap(), PathBuf::from("C:\\data\\a.txt"));
        assert!(grants.take(&token, Access::Read).is_err(), "令牌只能用一次");
    }

    #[test]
    fn unknown_tokens_and_paths_are_refused() {
        let grants = Grants::default();
        assert!(grants.take("not-a-token", Access::Read).is_err());
        // 路径不能冒充令牌
        assert!(grants.take("C:\\Windows\\win.ini", Access::Read).is_err());
        assert!(grants.take("", Access::Write).is_err());
    }

    #[test]
    fn a_read_grant_cannot_be_used_for_writing_and_vice_versa() {
        let grants = Grants::default();
        let read = grants.grant("a".into(), Access::Read);
        assert!(grants.take(&read, Access::Write).is_err());
        let write = grants.grant("b".into(), Access::Write);
        assert!(grants.take(&write, Access::Read).is_err());
        // 用错之后令牌就作废了
        assert!(grants.take(&write, Access::Write).is_err());
    }

    #[test]
    fn grants_expire() {
        let grants = Grants::default();
        let old = Instant::now().checked_sub(LIFETIME + Duration::from_secs(1)).expect("系统运行时间不够长");
        let token = grants.grant_at("a".into(), Access::Read, old);
        let err = grants.take(&token, Access::Read).unwrap_err();
        assert!(err.to_string().contains("grant.expired"), "{err}");
    }

    #[test]
    fn expired_grants_are_dropped_when_new_ones_are_made() {
        let grants = Grants::default();
        let old = Instant::now().checked_sub(LIFETIME + Duration::from_secs(1)).expect("系统运行时间不够长");
        grants.grant_at("a".into(), Access::Read, old);
        grants.grant("b".into(), Access::Read);
        assert_eq!(grants.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn file_names_from_the_server_become_safe_defaults() {
        let cases = [
            ("report.txt", "report.txt"),
            ("..\\..\\Windows\\evil.exe", "_.._Windows_evil.exe"),
            ("a/b.txt", "a_b.txt"),
            ("C:secret.txt", "C_secret.txt"),
            ("what?.txt", "what_.txt"),
            ("tab\there\n.txt", "tab_here_.txt"),
            ("trailing. . ", "trailing"),
            ("", "download"),
            ("...", "download"),
            ("CON", "_CON"),
            ("nul.txt", "_nul.txt"),
            ("com1.log", "_com1.log"),
            ("COM0.txt", "COM0.txt"),
            ("console.txt", "console.txt"),
            ("文件.txt", "文件.txt"),
            ("evil\u{202E}txt.exe", "eviltxt.exe"),
            ("\u{200B}\u{FEFF}", "download"),
            ("evil.exe\u{200B}. ", "evil.exe"),
            ("a.txt:stream", "a.txt_stream"),
        ];
        for (input, expected) in cases {
            assert_eq!(safe_file_name(input), expected, "{input:?}");
        }
    }

    #[test]
    fn long_names_are_shortened_and_keep_their_extension() {
        let name = safe_file_name(&format!("{}.txt", "长".repeat(400)));
        assert_eq!(name.chars().count(), MAX_LOCAL_NAME);
        assert!(name.ends_with(".txt"));
        // 截断后不能以点或空格结尾
        let name = safe_file_name(&format!("{}. {}", "a".repeat(198), "b".repeat(100)));
        assert!(!name.ends_with(['.', ' ']), "{name}");
    }

    /// 模糊测试：不管服务器给什么名字，结果都是一个能用的、只有一层的名字
    #[test]
    fn any_name_becomes_a_single_safe_component() {
        use rand::RngExt;
        let pieces = [
            "..", ".", "/", "\\", ":", "*", "?", "\"", "<", ">", "|", " ", "\0", "\n", "\r", "\x1b", "\u{202E}", "\u{200B}", "\u{FEFF}", "\u{7F}", "\u{9B}", "CON", "nul", "COM1", "LPT9", "aux", "a", "中", ".exe", ".txt", "~", "$", "%2e", "C:", "\\\\?\\", "\u{10FFFF}",
        ];
        let mut rng = rand::rng();
        for _ in 0..100_000 {
            let name: String = (0..rng.random_range(0..12)).map(|_| pieces[rng.random_range(0..pieces.len())]).collect();
            let safe = safe_file_name(&name);
            assert!(!safe.is_empty(), "{name:?}");
            assert!(safe.chars().count() <= MAX_LOCAL_NAME + 1, "{name:?}");
            assert!(!safe.chars().any(|c| c.is_control() || is_invisible(c) || "<>:\"/\\|?*".contains(c)), "{name:?} -> {safe:?}");
            assert!(!safe.ends_with(['.', ' ']), "{name:?} -> {safe:?}");
            assert_ne!(safe, "..");
            let path = Path::new("C:\\root").join(&safe);
            assert_eq!(path.parent(), Some(Path::new("C:\\root")), "{name:?} -> {safe:?}");
            let stem = safe.split('.').next().unwrap().to_ascii_uppercase();
            assert!(!matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "LPT9"), "{name:?} -> {safe:?}");
        }
    }
}
