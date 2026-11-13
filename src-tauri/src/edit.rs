//! 用本地程序打开远程文件，保存后自动传回服务器。
//!
//! 文件名和内容都是服务器给的。用系统默认程序打开等于让 Windows “运行”这个文件，所以可执行类型一律拦截。
//! 界面只能指定远程路径：本地路径由这里决定，用来打开文件的程序也只能经系统对话框选择，界面没法指定。

use std::{
    collections::HashMap,
    hash::Hasher,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime},
};

use russh_sftp::{client::error::Error as SftpError, protocol::StatusCode};
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{
    error::{AppError, AppResult},
    files::safe_file_name,
    i18n::{self, t},
    sftp::{download_file, sftp, upload_file, Progress, Transfers},
    ssh::Sessions,
    store::Store,
};

/// 检查本地文件有没有变化的间隔
const POLL_INTERVAL: Duration = Duration::from_millis(700);
/// 工作目录里残留的文件保留多久。没传回去的修改留给用户，但不能永远留着服务器上的文件
const LEFTOVER_LIFETIME: Duration = Duration::from_secs(7 * 24 * 3600);

/// Windows 会直接运行或解释的类型。用默认程序“打开”它们等于执行服务器给的代码。
/// 这里还包括带宏的 Office 文档、快捷方式、脚本和注册表文件。
const EXECUTABLE_TYPES: &[&str] = &[
    "exe", "com", "scr", "pif", "cpl", "msi", "msp", "mst", "msc", "dll", "ocx", "sys", "drv", "application", "appref-ms", "appx", "appxbundle", "msix", "msixbundle", "gadget", "bat", "cmd", "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "psd1", "psm1", "vb", "vbe", "vbs", "js", "jse", "ws", "wsc", "wsf", "wsh", "hta", "htm", "html", "xhtml", "mht", "mhtml", "svg", "py", "pyw", "pyc", "pyo", "pyz", "rb", "pl", "php", "sh", "bash", "lnk", "url", "scf", "shb", "shs", "library-ms", "searchconnector-ms", "settingcontent-ms", "desktop", "inf", "reg", "ins", "isp", "jar", "jnlp", "chm", "hlp", "diagcab", "diagcfg", "diagpack", "vhd", "vhdx", "iso", "img", "docm", "dotm", "xlsm", "xltm", "xlam", "xlsb", "pptm", "potm", "ppam", "ppsm", "sldm", "doc", "xls", "ppt", "rtf",
];

/// 用系统默认程序打开时不能接受的类型。返回扩展名，用于提示
pub fn blocked_type(name: &str, extra: Option<&str>) -> Option<String> {
    let safe = safe_file_name(name);
    let ext = safe.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())?;
    // `.{CLSID}` 是 Windows 资源管理器的特殊扩展名，能把文件伪装成别的东西
    if ext.starts_with('{') || EXECUTABLE_TYPES.contains(&ext.as_str()) {
        return Some(ext);
    }
    // 这台电脑上额外登记为可执行的类型（环境变量 PATHEXT）
    let listed = extra.unwrap_or("").split(';').any(|e| e.trim_start_matches('.').eq_ignore_ascii_case(&ext));
    listed.then_some(ext)
}

fn hash_file(path: &Path) -> std::io::Result<u64> {
    // 只用来判断内容有没有变，不是安全校验
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut file = std::fs::File::open(path)?;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            return Ok(hasher.finish());
        }
        hasher.write(&buf[..n]);
    }
}

/// 服务器上文件的版本：用来发现别人是否也改过
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct RemoteVersion {
    size: Option<u64>,
    mtime: Option<u32>,
}

struct Edit {
    session_id: Mutex<String>,
    /// 这个文件属于哪台服务器。重新连接时不能接到别的服务器上
    server: String,
    remote: String,
    local: PathBuf,
    /// 最后一次和服务器一致时的内容和版本
    synced: Mutex<(u64, RemoteVersion)>,
    /// 用户已经同意替换只读文件。问过一次，这个文件之后的保存不再问
    read_only_allowed: AtomicBool,
    /// 用用户选的程序打开（否则用系统默认程序）。再次打开时沿用
    with_program: AtomicBool,
    stop: AtomicBool,
}

#[derive(Default)]
pub struct Edits {
    items: Mutex<HashMap<String, Arc<Edit>>>,
}

/// 工作目录。放在数据目录里，跟着程序走，不写系统的缓存目录
fn work_root(app: &AppHandle) -> PathBuf {
    app.state::<Store>().dir().join("editing")
}

/// 启动时清理很久以前留下的工作目录
pub fn clean_old_work_dirs(app: &AppHandle) {
    remove_old_dirs(&work_root(app), LEFTOVER_LIFETIME);
}

fn remove_old_dirs(root: &Path, lifetime: Duration) {
    let Ok(list) = std::fs::read_dir(root) else { return };
    for entry in list.flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age > lifetime);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn editor_file(store: &Store) -> PathBuf {
    store.dir().join("editor.json")
}

fn read_editor(store: &Store) -> Option<PathBuf> {
    let raw = std::fs::read(editor_file(store)).ok()?;
    serde_json::from_slice::<String>(&raw).ok().map(PathBuf::from).filter(|p| p.is_file())
}

/// 打开本地文件。`with_program` 时用用户在系统对话框里选过的程序，否则用系统默认程序（类型检查在调用之前）
fn launch(app: &AppHandle, store: &Store, local: &Path, with_program: bool) -> AppResult<()> {
    if with_program {
        let editor = read_editor(store).ok_or_else(|| AppError::from(t("edit.noProgram")))?;
        std::process::Command::new(&editor).arg(local).spawn().map_err(|e| t("edit.startFailed").arg("program", editor.display().to_string()).detail(e))?;
    } else {
        app.opener().open_path(local.to_string_lossy(), None::<&str>).map_err(|e| AppError::from(t("edit.openFailed").detail(e)))?;
    }
    Ok(())
}

/// 打开前的检查。交给用户选的程序时只是把文件给它，不会运行文件本身，不用拦截；
/// 用系统默认程序时，会被直接运行的类型要拦下
fn check_openable(store: &Store, name: &str, with_program: bool) -> AppResult<()> {
    if with_program {
        return read_editor(store).map(|_| ()).ok_or_else(|| t("edit.noProgram").into());
    }
    match blocked_type(name, std::env::var("PATHEXT").ok().as_deref()) {
        Some(ext) => Err(t("edit.blocked").arg("ext", ext).into()),
        None => Ok(()),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum EditEvent {
    /// 本地文件保存过，内容和服务器上的不一样了
    Changed,
    /// 本地文件不见了（被删除或工作目录被清理）
    LocalMissing,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOpened {
    id: String,
}

fn watch(edit: Arc<Edit>, on_event: Channel<EditEvent>) {
    tokio::spawn(async move {
        let stamp = |path: &Path| std::fs::metadata(path).ok().map(|m| (m.modified().ok(), m.len()));
        let mut seen = stamp(&edit.local);
        let mut pending = false;
        let mut notified: Option<u64> = None;
        let mut reported_missing = false;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            if edit.stop.load(Ordering::Relaxed) {
                return;
            }
            let now = stamp(&edit.local);
            // 编辑器可能先删除再写入，也可能写到一半。等它连续两次检查都没变化再看内容
            if now != seen {
                seen = now;
                pending = true;
                reported_missing = false;
                continue;
            }
            if now.is_none() {
                if pending && !reported_missing {
                    reported_missing = true;
                    let _ = on_event.send(EditEvent::LocalMissing);
                }
                pending = false;
                continue;
            }
            if !pending {
                continue;
            }
            pending = false;
            let Ok(hash) = hash_file(&edit.local) else {
                pending = true; // 编辑器可能正独占着文件，下次再试
                continue;
            };
            let synced = edit.synced.lock().unwrap().0;
            if hash == synced {
                notified = None; // 改回去了，或者只是重新保存了一次
            } else if notified != Some(hash) {
                notified = Some(hash);
                let _ = on_event.send(EditEvent::Changed);
            }
        }
    });
}

/// 没有任何写权限位。服务器没有报告权限时当作不是只读
fn is_read_only(permissions: Option<u32>) -> bool {
    permissions.is_some_and(|mode| mode & 0o222 == 0)
}

/// 服务器上文件现在的状态。符号链接看它指向的文件，传回时写的也是那个文件
struct RemoteState {
    version: RemoteVersion,
    read_only: bool,
}

async fn remote_state(s: &russh_sftp::client::SftpSession, remote: &str) -> AppResult<Option<RemoteState>> {
    match s.metadata(remote).await {
        Ok(m) => Ok(Some(RemoteState { version: RemoteVersion { size: m.size, mtime: m.mtime }, read_only: is_read_only(m.permissions) })),
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 下载到工作目录并打开，之后监视本地文件的变化
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn edit_open(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    edits: State<'_, Edits>,
    store: State<'_, Store>,
    session_id: String,
    transfer_id: String,
    remote: String,
    with_program: bool,
    on_event: Channel<EditEvent>,
    on_progress: Channel<Progress>,
) -> AppResult<EditOpened> {
    let base = remote.rsplit('/').next().unwrap_or("");
    check_openable(&store, base, with_program)?;
    let name = safe_file_name(base);

    let s = sftp(&sessions, &session_id).await?;
    let server = sessions.get(&session_id)?.temps.server().to_string();
    let Some(RemoteState { version, .. }) = remote_state(&s, &remote).await? else {
        return Err(t("edit.remoteMissing").into());
    };

    // 每个文件一个目录：名字可以保持原样，同名文件互不影响
    let id = uuid::Uuid::new_v4().to_string();
    let dir = work_root(&app).join(&id);
    tokio::fs::create_dir_all(&dir).await?;
    let local = dir.join(&name);

    let cancel = transfers.begin(&transfer_id);
    let report = |p| {
        let _ = on_progress.send(p);
    };
    let result = download_file(&s, &remote, &local.to_string_lossy(), &cancel, &report).await;
    transfers.end(&transfer_id);
    let opened = result.and_then(|()| hash_file(&local).map_err(AppError::from)).and_then(|hash| launch(&app, &store, &local, with_program).map(|()| hash));
    let hash = match opened {
        Ok(hash) => hash,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err(e);
        }
    };

    let edit = Arc::new(Edit { session_id: Mutex::new(session_id), server, remote, local, synced: Mutex::new((hash, version)), read_only_allowed: AtomicBool::new(false), with_program: AtomicBool::new(with_program), stop: AtomicBool::new(false) });
    edits.items.lock().unwrap().insert(id.clone(), edit.clone());
    watch(edit, on_event);
    Ok(EditOpened { id })
}

fn get(edits: &Edits, id: &str) -> AppResult<Arc<Edit>> {
    edits.items.lock().unwrap().get(id).cloned().ok_or_else(|| t("edit.notEditing").into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "result")]
pub enum EditUpload {
    Done,
    /// 服务器上的文件在这期间被别人改过
    ChangedOnServer,
    /// 服务器上的文件被删除了
    DeletedOnServer,
    /// 内容和服务器上的一样，不用传
    Unchanged,
    /// 服务器上的文件是只读的，用户还没同意替换
    ReadOnly,
}

/// 把本地文件传回服务器。除非 `force`，否则服务器上的文件变过时不覆盖。
/// 只读文件要用户同意一次（`allow_read_only`）：`force` 只回答了“别人也改过”，不算同意替换只读文件。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn edit_upload(
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    edits: State<'_, Edits>,
    edit_id: String,
    transfer_id: String,
    force: bool,
    allow_read_only: bool,
    on_progress: Channel<Progress>,
) -> AppResult<EditUpload> {
    let edit = get(&edits, &edit_id)?;
    let session_id = edit.session_id.lock().unwrap().clone();
    let s = sftp(&sessions, &session_id).await?;
    let temps = sessions.get(&session_id)?.temps.clone();

    let hash = hash_file(&edit.local)?;
    let (synced_hash, synced_version) = *edit.synced.lock().unwrap();
    if hash == synced_hash && !force {
        return Ok(EditUpload::Unchanged);
    }
    let state = remote_state(&s, &edit.remote).await?;
    if !force {
        match &state {
            None => return Ok(EditUpload::DeletedOnServer),
            Some(r) if r.version != synced_version => return Ok(EditUpload::ChangedOnServer),
            Some(_) => {}
        }
    }
    if allow_read_only {
        edit.read_only_allowed.store(true, Ordering::Relaxed);
    }
    if state.is_some_and(|r| r.read_only) && !edit.read_only_allowed.load(Ordering::Relaxed) {
        return Ok(EditUpload::ReadOnly);
    }

    let cancel = transfers.begin(&transfer_id);
    let report = |p| {
        let _ = on_progress.send(p);
    };
    let result = upload_file(&s, &temps, &edit.local.to_string_lossy(), &edit.remote, true, &cancel, &report).await;
    transfers.end(&transfer_id);
    result?;
    let version = remote_state(&s, &edit.remote).await?.map_or(synced_version, |r| r.version);
    *edit.synced.lock().unwrap() = (hash, version);
    Ok(EditUpload::Done)
}

/// 重新连接后，把正在编辑的文件接到新的连接上。只能是同一台服务器
#[tauri::command]
pub fn edit_attach(sessions: State<'_, Sessions>, edits: State<'_, Edits>, edit_id: String, session_id: String) -> AppResult<()> {
    let edit = get(&edits, &edit_id)?;
    if sessions.get(&session_id)?.temps.server() != edit.server {
        return Err(t("edit.otherServer").into());
    }
    *edit.session_id.lock().unwrap() = session_id;
    Ok(())
}

/// 再次用本地程序打开。`with_program` 不给时沿用上次的打开方式
#[tauri::command]
pub fn edit_reopen(app: AppHandle, edits: State<'_, Edits>, store: State<'_, Store>, edit_id: String, with_program: Option<bool>) -> AppResult<()> {
    let edit = get(&edits, &edit_id)?;
    let with_program = with_program.unwrap_or_else(|| edit.with_program.load(Ordering::Relaxed));
    let name = edit.local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    check_openable(&store, &name, with_program)?;
    launch(&app, &store, &edit.local, with_program)?;
    edit.with_program.store(with_program, Ordering::Relaxed);
    Ok(())
}

/// 停止编辑。本地还有没传回去的修改时保留文件，返回它的路径，否则删除工作目录
#[tauri::command]
pub fn edit_stop(edits: State<'_, Edits>, edit_id: String) -> Option<String> {
    let edit = edits.items.lock().unwrap().remove(&edit_id)?;
    stop_edit(&edit)
}

fn stop_edit(edit: &Edit) -> Option<String> {
    edit.stop.store(true, Ordering::Relaxed);
    let unsynced = hash_file(&edit.local).map(|hash| hash != edit.synced.lock().unwrap().0).unwrap_or(false);
    if unsynced {
        return Some(edit.local.to_string_lossy().into_owned());
    }
    // 编辑器还开着时可能删不掉，留给下次启动时清理
    if let Some(dir) = edit.local.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
    None
}

impl Edits {
    /// 程序退出时清理已经同步的文件。没传回去的留着，下次启动时超过期限才清理
    pub fn stop_all(&self) {
        let items: Vec<_> = self.items.lock().unwrap().drain().map(|(_, e)| e).collect();
        for edit in items {
            stop_edit(&edit);
        }
    }
}

/// 上次选过的、用来打开远程文件的程序，没有时为 `None`
#[tauri::command]
pub fn editor_get(store: State<'_, Store>) -> Option<String> {
    read_editor(&store).map(|p| p.to_string_lossy().into_owned())
}

/// 选择用来打开远程文件的程序，记下来供下次直接用。只接受系统对话框里选的可执行文件，界面不能直接指定路径：
/// 否则界面一旦被攻破，就能让后端运行任意程序。
#[tauri::command]
pub async fn editor_pick(window: WebviewWindow, store: State<'_, Store>) -> AppResult<Option<String>> {
    let app = window.app_handle().clone();
    let picked = tokio::task::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_parent(&window).set_title(i18n::dialog_title(i18n::Dialog::Editor));
        if cfg!(windows) {
            dialog = dialog.add_filter(i18n::programs_filter(), &["exe"]);
        }
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|e| t("dialog.failed").detail(e))?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    // .cmd 和 .bat 的参数转义不可靠，文件名可能被当作命令执行
    if cfg!(windows) && !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
        return Err(t("edit.notExe").into());
    }
    let raw = serde_json::to_vec(&path.to_string_lossy()).map_err(AppError::from)?;
    std::fs::write(editor_file(&store), raw)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_types_are_blocked() {
        for name in [
            "a.exe", "A.EXE", "run.bat", "run.cmd", "x.com", "x.scr", "x.pif", "x.lnk", "x.url", "x.msi", "x.ps1", "x.vbs", "x.js", "x.hta", "x.jar", "x.reg", "x.cpl", "x.dll", "x.chm", "x.py", "x.docm", "x.xlsm", "x.iso", "x.html", "x.settingcontent-ms", "x.library-ms",
        ] {
            assert!(blocked_type(name, None).is_some(), "{name}");
        }
    }

    #[test]
    fn disguised_executables_are_still_blocked() {
        for name in [
            "evil.exe.",
            "evil.exe ",
            "evil.exe. . ",
            "evil.txt.exe",
            "evil.EXE",
            "invoice\u{202E}txt.exe",
            "evil\u{200B}.exe",
            "evil.exe\u{FEFF}",
            "evil.exe\u{200B}.",
            "evil.{3D0F7A0E-1F7C-4A11-8F5E-000000000000}",
            "folder\\evil.exe",
            "..\\..\\evil.bat",
        ] {
            assert!(blocked_type(name, None).is_some(), "{name:?}");
        }
    }

    #[test]
    fn ordinary_documents_are_allowed() {
        for name in ["a.txt", "nginx.conf", "app.log", "data.json", "photo.png", "report.pdf", "notes.md", "archive.tar.gz", "Makefile", ".bashrc", "evil.exe.txt", "a.exe_", "a.docx"] {
            assert_eq!(blocked_type(name, None), None, "{name}");
        }
    }

    #[test]
    fn types_registered_on_this_computer_are_blocked_too() {
        assert_eq!(blocked_type("a.foo", Some(".COM;.EXE;.FOO")).as_deref(), Some("foo"));
        assert_eq!(blocked_type("a.bar", Some(".COM;.EXE;.FOO")), None);
    }

    /// 模糊测试：往可执行扩展名里混各种字符，只要 Windows 最终会把它当可执行文件，就要被拦截
    #[test]
    fn any_disguise_of_an_executable_extension_is_caught() {
        use rand::RngExt;
        let noise = ["", " ", ".", "\u{200B}", "\u{202E}", "\u{FEFF}", "\u{2060}", "\u{AD}", ". ", " ."];
        let mut rng = rand::rng();
        for _ in 0..50_000 {
            let ext = EXECUTABLE_TYPES[rng.random_range(0..EXECUTABLE_TYPES.len())];
            let mixed: String = ext
                .chars()
                .map(|c| {
                    let c = if rng.random_bool(0.5) { c.to_ascii_uppercase() } else { c };
                    // 看不见的字符可以夹在中间，点和空格只能出现在结尾，否则就不是这个扩展名了
                    let invisible = noise[rng.random_range(1..noise.len())];
                    if invisible.contains(['.', ' ']) { c.to_string() } else if rng.random_bool(0.2) { format!("{invisible}{c}") } else { c.to_string() }
                })
                .collect();
            let tail: String = (0..rng.random_range(0..3)).map(|_| noise[rng.random_range(0..noise.len())]).collect();
            let name = format!("doc.txt.{mixed}{tail}");
            assert!(blocked_type(&name, None).is_some(), "{name:?} -> {:?}", safe_file_name(&name));
        }
    }

    #[test]
    fn read_only_means_no_write_bit_at_all() {
        for mode in [0o444, 0o400, 0o555, 0o000, 0o100444] {
            assert!(is_read_only(Some(mode)), "{mode:o}");
        }
        for mode in [0o644, 0o200, 0o020, 0o002, 0o100644] {
            assert!(!is_read_only(Some(mode)), "{mode:o}");
        }
        assert!(!is_read_only(None));
    }

    #[test]
    fn old_work_directories_are_removed_and_recent_ones_kept() {
        let root = std::env::temp_dir().join(format!("termipaw-edit-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("recent")).unwrap();
        remove_old_dirs(&root, Duration::from_secs(3600));
        assert!(root.join("recent").exists());
        remove_old_dirs(&root, Duration::ZERO);
        std::thread::sleep(Duration::from_millis(20));
        remove_old_dirs(&root, Duration::ZERO);
        assert!(!root.join("recent").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
