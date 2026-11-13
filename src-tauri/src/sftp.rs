//! SFTP：在已有 SSH 连接上按需打开 sftp 子系统，提供浏览与传输。

use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use russh_sftp::{
    client::{error::Error as SftpError, fs::Metadata, SftpSession},
    protocol::{FileAttributes, StatusCode},
};
use serde::Serialize;
use tauri::{ipc::Channel, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{
    error::{AppError, AppResult},
    files::{Access, Grants},
    i18n::{t, Text},
    ssh::Sessions,
    store::ServerTemps,
    tree,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_link: bool,
    size: u64,
    /// Unix 时间戳（秒）
    modified: Option<u32>,
    permissions: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub transferred: u64,
    pub total: u64,
}

/// 正在进行的传输，用于取消
#[derive(Default)]
pub struct Transfers(Mutex<HashMap<String, Arc<AtomicBool>>>);

pub(crate) async fn sftp(sessions: &Sessions, session_id: &str) -> AppResult<Arc<SftpSession>> {
    let session = sessions.get(session_id)?;
    let mut slot = session.sftp.lock().await;
    if let Some(s) = slot.as_ref() {
        return Ok(s.clone());
    }
    let channel = session.handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let s = Arc::new(SftpSession::new(channel.into_stream()).await?);
    *slot = Some(s.clone());
    // 在后台清理，服务器响应慢时不耽误打开文件面板
    let (cleaner, temps) = (s.clone(), session.temps.clone());
    tokio::spawn(async move { clean_leftovers(&cleaner, &temps).await });
    Ok(s)
}

/// 删除之前的连接来不及删的临时文件
async fn clean_leftovers(s: &SftpSession, temps: &ServerTemps) {
    for temp in temps.leftovers() {
        // `.old` 还在说明替换进行到一半就断开了，目标文件可能不在，这两个文件都留给用户处理
        let Some(stem) = temp.strip_suffix(".part") else { continue };
        if !matches!(lstat(s, &format!("{stem}.old")).await, Ok(None)) {
            continue;
        }
        // 其他错误（比如又断开了）保留记录，下次再试
        if remove_if_exists(s, &temp).await {
            temps.forget(&temp);
        }
    }
}

/// 文件已经不在服务器上时返回 true
async fn remove_if_exists(s: &SftpSession, path: &str) -> bool {
    match s.remove_file(path).await {
        Ok(()) => true,
        Err(SftpError::Status(status)) => status.status_code == StatusCode::NoSuchFile,
        Err(_) => false,
    }
}

pub(crate) fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) => "/",
        Some(i) => &path[..i],
        None => ".",
    }
}

#[tauri::command]
pub async fn sftp_realpath(sessions: State<'_, Sessions>, session_id: String, path: String) -> AppResult<String> {
    Ok(sftp(&sessions, &session_id).await?.canonicalize(path).await?)
}

#[tauri::command]
pub async fn sftp_list(sessions: State<'_, Sessions>, session_id: String, path: String) -> AppResult<Vec<FileEntry>> {
    let s = sftp(&sessions, &session_id).await?;
    let mut entries = Vec::new();
    for e in s.read_dir(&path).await? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let full = join(&path, &name);
        let meta = e.metadata();
        let is_link = e.file_type().is_symlink();
        // 符号链接：跟随一次以判断是否指向目录
        let is_dir = if is_link {
            s.metadata(&full).await.map(|m| m.is_dir()).unwrap_or(false)
        } else {
            e.file_type().is_dir()
        };
        entries.push(FileEntry {
            name,
            path: full,
            is_dir,
            is_link,
            size: meta.size.unwrap_or(0),
            modified: meta.mtime,
            permissions: meta.permissions,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

#[tauri::command]
pub async fn sftp_mkdir(sessions: State<'_, Sessions>, session_id: String, path: String) -> AppResult<()> {
    Ok(sftp(&sessions, &session_id).await?.create_dir(path).await?)
}

#[tauri::command]
pub async fn sftp_rename(sessions: State<'_, Sessions>, session_id: String, from: String, to: String) -> AppResult<()> {
    Ok(sftp(&sessions, &session_id).await?.rename(from, to).await?)
}

/// 删除文件或目录（目录递归删除）。是不是目录由这里自己查，不跟随链接：
/// 指向目录的链接只删链接本身，不能变成删除它指向的目录里的内容
#[tauri::command]
pub async fn sftp_remove(sessions: State<'_, Sessions>, session_id: String, path: String) -> AppResult<()> {
    let s = sftp(&sessions, &session_id).await?;
    remove_tree(&s, &path).await
}

async fn remove_tree(s: &SftpSession, path: &str) -> AppResult<()> {
    let is_dir = lstat(s, path).await?.is_some_and(|m| m.is_dir() && !m.is_symlink());
    if !is_dir {
        return Ok(s.remove_file(path).await?);
    }
    // 迭代式深度优先：先收集，再自底向上删除
    let mut stack = vec![path.to_string()];
    let mut dirs = Vec::new();
    while let Some(dir) = stack.pop() {
        for e in s.read_dir(&dir).await? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let full = join(&dir, &name);
            if e.file_type().is_dir() {
                stack.push(full);
            } else {
                s.remove_file(full).await?;
            }
        }
        dirs.push(dir);
    }
    for dir in dirs.into_iter().rev() {
        s.remove_dir(dir).await?;
    }
    Ok(())
}

async fn copy<R, W, P>(mut r: R, mut w: W, total: u64, cancel: &AtomicBool, progress: &P) -> AppResult<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    P: Fn(Progress) + Sync,
{
    let mut buf = vec![0u8; 256 * 1024];
    let mut transferred = 0u64;
    let mut last = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(t("transfer.cancelled").into());
        }
        let n = r.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n]).await?;
        transferred += n as u64;
        if last.elapsed() > Duration::from_millis(120) {
            last = Instant::now();
            progress(Progress { transferred, total });
        }
    }
    w.flush().await?;
    w.shutdown().await?;
    progress(Progress { transferred, total });
    Ok(())
}

impl Transfers {
    /// 开始一个传输。如果取消请求比它先到，返回的标志一开始就是已取消
    pub(crate) fn begin(&self, id: &str) -> Arc<AtomicBool> {
        self.0.lock().unwrap().entry(id.to_string()).or_default().clone()
    }

    pub(crate) fn end(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }

    fn cancel(&self, id: &str) {
        self.0.lock().unwrap().entry(id.to_string()).or_default().store(true, Ordering::Relaxed);
    }
}

/// 路径的元数据；路径不存在时返回 `None`，不跟随符号链接
pub(crate) async fn lstat(s: &SftpSession, path: &str) -> AppResult<Option<Metadata>> {
    match s.symlink_metadata(path).await {
        Ok(m) => Ok(Some(m)),
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 用已上传完成的临时文件替换目标文件。
///
/// 标准 SFTP 的改名在目标已存在时会失败，所以替换分两步：先把原文件移开，再把新文件移到位，
/// 第二步失败时恢复原文件。
async fn replace_remote(s: &SftpSession, temp: &str, target: &str, backup: &str, exists: bool) -> AppResult<()> {
    if !exists {
        return Ok(s.rename(temp, target).await?);
    }
    s.rename(target, backup).await?;
    if let Err(e) = s.rename(temp, target).await {
        return Err(match s.rename(backup, target).await {
            Ok(()) => e.into(),
            Err(restore) => t("sftp.replaceFailed").arg("detail", AppError::from(e).text()).arg("restore", AppError::from(restore).text()).arg("backup", backup).into(),
        });
    }
    let _ = s.remove_file(backup).await;
    Ok(())
}

/// 上传到同目录下的临时文件，全部写完才替换目标。任何一步失败，目标文件都保持原样。
pub(crate) async fn upload_file<P>(s: &SftpSession, temps: &ServerTemps, local: &str, remote: &str, overwrite: bool, cancel: &AtomicBool, progress: &P) -> AppResult<()>
where
    P: Fn(Progress) + Sync,
{
    if tokio::fs::metadata(local).await?.is_dir() {
        return Err(t("sftp.folderUnsupported").into());
    }
    let file = tokio::fs::File::open(local).await?;
    let total = file.metadata().await?.len();

    // 目标是符号链接时写入它指向的文件，否则替换后链接会变成普通文件
    let target = match lstat(s, remote).await? {
        Some(m) if m.is_symlink() => s.canonicalize(remote).await?,
        _ => remote.to_string(),
    };
    let existing = lstat(s, &target).await?;
    if let Some(m) = &existing {
        if m.is_dir() {
            return Err(t("sftp.folderExists").into());
        }
        if !overwrite {
            return Err(t("sftp.fileExists").into());
        }
    }

    let id = uuid::Uuid::new_v4();
    let temp = join(parent(&target), &format!(".termipaw-{id}.part"));
    let backup = join(parent(&target), &format!(".termipaw-{id}.old"));
    temps.begin(&temp);
    let result = async {
        let dst = s.create(temp.as_str()).await?;
        copy(file, dst, total, cancel, progress).await?;
        // 新文件沿用原文件的权限，否则替换后脚本会失去可执行权限
        if let Some(mode) = existing.as_ref().and_then(|m| m.permissions) {
            let attrs = FileAttributes { permissions: Some(mode & 0o7777), ..Default::default() };
            let _ = s.set_metadata(temp.as_str(), attrs).await;
        }
        replace_remote(s, &temp, &target, &backup, existing.is_some()).await
    }
    .await;
    let gone = result.is_ok() || remove_if_exists(s, &temp).await;
    temps.finish(&temp, gone);
    result
}

/// 下载到同目录下的临时文件，全部写完才替换目标。任何一步失败，本地已有文件都保持原样。
pub(crate) async fn download_file<P>(s: &SftpSession, remote: &str, local: &str, cancel: &AtomicBool, progress: &P) -> AppResult<()>
where
    P: Fn(Progress) + Sync,
{
    let total = s.metadata(remote).await?.size.unwrap_or(0);
    let src = s.open(remote).await?;

    let local = Path::new(local);
    let temp = local
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!(".termipaw-{}.part", uuid::Uuid::new_v4()));
    let result: AppResult<()> = async {
        let mut dst = tokio::fs::File::create_new(&temp).await?;
        copy(src, &mut dst, total, cancel, progress).await?;
        dst.sync_all().await?;
        drop(dst);
        tokio::fs::rename(&temp, local).await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_upload(
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    grants: State<'_, Grants>,
    session_id: String,
    transfer_id: String,
    local_token: String,
    remote: String,
    overwrite: bool,
    on_progress: Channel<Progress>,
) -> AppResult<Vec<Text>> {
    let local = grants.take(&local_token, Access::Read)?;
    let s = sftp(&sessions, &session_id).await?;
    let temps = sessions.get(&session_id)?.temps.clone();
    let cancel = transfers.begin(&transfer_id);
    let report = |p| {
        let _ = on_progress.send(p);
    };
    let result = if local.is_dir() {
        tree::upload_tree(&s, &temps, &local, &remote, overwrite, tree::LIMITS, &cancel, &report).await
    } else {
        upload_file(&s, &temps, &local.to_string_lossy(), &remote, overwrite, &cancel, &report).await.map(|()| Vec::new())
    };
    transfers.end(&transfer_id);
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_download(
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    grants: State<'_, Grants>,
    session_id: String,
    transfer_id: String,
    remote: String,
    local_token: String,
    on_progress: Channel<Progress>,
) -> AppResult<()> {
    let local = grants.take(&local_token, Access::Write)?.to_string_lossy().into_owned();
    let s = sftp(&sessions, &session_id).await?;
    let cancel = transfers.begin(&transfer_id);
    let report = |p| {
        let _ = on_progress.send(p);
    };
    let result = download_file(&s, &remote, &local, &cancel, &report).await;
    transfers.end(&transfer_id);
    result
}

/// 下载目录到用户选择的位置下面新建的文件夹。返回要告诉用户的情况（比如跳过了哪些条目）
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_download_dir(
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    grants: State<'_, Grants>,
    session_id: String,
    transfer_id: String,
    remote: String,
    local_token: String,
    on_progress: Channel<Progress>,
) -> AppResult<Vec<Text>> {
    let parent = grants.take(&local_token, Access::WriteDir)?;
    let s = sftp(&sessions, &session_id).await?;
    let cancel = transfers.begin(&transfer_id);
    let report = |p| {
        let _ = on_progress.send(p);
    };
    let result = tree::download_tree(&s, &remote, &parent, tree::LIMITS, &cancel, &report).await;
    transfers.end(&transfer_id);
    result
}

#[tauri::command]
pub fn sftp_cancel(transfers: State<'_, Transfers>, transfer_id: String) {
    transfers.cancel(&transfer_id);
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{atomic::AtomicBool, Arc, Mutex},
        time::Duration,
    };

    use russh_sftp::client::SftpSession;

    use std::sync::atomic::Ordering;

    use super::{clean_leftovers, download_file, remove_tree, upload_file, Progress, Transfers};
    use crate::{
        sftp_sandbox::{Faults, SandboxSftp},
        store::{ServerTemps, Store},
    };

    const HOME: &str = "/home/t";

    fn temps_of(store: &Store) -> ServerTemps {
        store.server_temps("t", "server", 22)
    }

    struct Env {
        base: PathBuf,
        remote_root: PathBuf,
        faults: Arc<Mutex<Faults>>,
        store: Store,
        temps: ServerTemps,
        session: SftpSession,
        /// 客户端和服务端之间的转发任务，中止它就相当于断线
        link: tokio::task::AbortHandle,
    }

    async fn open_session(remote_root: &Path, faults: &Arc<Mutex<Faults>>) -> (SftpSession, tokio::task::AbortHandle) {
        let (server, mut server_side) = tokio::io::duplex(1 << 20);
        let (mut client_side, client) = tokio::io::duplex(1 << 20);
        tokio::spawn(russh_sftp::server::run(server, SandboxSftp::new(remote_root.to_path_buf(), HOME, faults.clone())));
        let link = tokio::spawn(async move {
            let _ = tokio::io::copy_bidirectional(&mut client_side, &mut server_side).await;
        })
        .abort_handle();
        (SftpSession::new(client).await.unwrap(), link)
    }

    impl Env {
        async fn new() -> Self {
            let base = std::env::temp_dir().join(format!("termipaw-sftp-test-{}", uuid::Uuid::new_v4()));
            let remote_root = base.join("remote");
            fs::create_dir_all(remote_root.join("home/t")).unwrap();
            fs::create_dir_all(base.join("local")).unwrap();
            let faults = Arc::new(Mutex::new(Faults::default()));
            let (session, link) = open_session(&remote_root, &faults).await;
            let store = Store::new(base.clone(), None);
            let temps = temps_of(&store);
            Self { base, remote_root, faults, store, temps, session, link }
        }

        /// 断线后重新连接
        async fn reconnect(&self) -> SftpSession {
            open_session(&self.remote_root, &self.faults).await.0
        }

        fn remote_temp_files(&self) -> Vec<String> {
            entries(&self.remote_path("")).into_iter().filter(|n| n.starts_with(".termipaw-")).collect()
        }

        /// 上传到一半断线，留下一个临时文件
        async fn upload_and_lose_connection(&self) -> Result<(), String> {
            self.faults.lock().unwrap().write_delay = Some(Duration::from_millis(20));
            let local = self.local_path("big.bin");
            fs::write(&local, vec![b'x'; 16 << 20]).unwrap();
            let local = local.to_string_lossy().into_owned();
            let run = async { tokio::join!(self.upload(&local, "a.txt", true), cut_when_uploading(self)) };
            let (result, ()) = tokio::time::timeout(Duration::from_secs(60), run).await.expect("上传或断线卡住了");
            self.faults.lock().unwrap().write_delay = None;
            result
        }

        fn remote_path(&self, name: &str) -> PathBuf {
            self.remote_root.join("home/t").join(name)
        }

        fn local_path(&self, name: &str) -> PathBuf {
            self.base.join("local").join(name)
        }

        fn put_remote(&self, name: &str, content: &str) {
            fs::write(self.remote_path(name), content).unwrap();
        }

        fn put_local(&self, name: &str, content: &str) -> String {
            let p = self.local_path(name);
            fs::write(&p, content).unwrap();
            p.to_string_lossy().into_owned()
        }

        fn read_remote(&self, name: &str) -> Option<String> {
            fs::read_to_string(self.remote_path(name)).ok()
        }

        fn read_local(&self, name: &str) -> Option<String> {
            fs::read_to_string(self.local_path(name)).ok()
        }

        async fn upload(&self, local: &str, name: &str, overwrite: bool) -> Result<(), String> {
            self.upload_cancellable(local, name, overwrite, false).await
        }

        async fn upload_cancellable(&self, local: &str, name: &str, overwrite: bool, cancelled: bool) -> Result<(), String> {
            let cancel = AtomicBool::new(cancelled);
            upload_file(&self.session, &self.temps, local, &format!("{HOME}/{name}"), overwrite, &cancel, &|_: Progress| {})
                .await
                .map_err(|e| format!("{e:?}"))
        }

        async fn download(&self, name: &str, local: &str, cancelled: bool) -> Result<(), String> {
            let cancel = AtomicBool::new(cancelled);
            download_file(&self.session, &format!("{HOME}/{name}"), local, &cancel, &|_: Progress| {})
                .await
                .map_err(|e| format!("{e:?}"))
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn a_cancel_that_arrives_before_the_transfer_starts_is_remembered() {
        let transfers = Transfers::default();
        transfers.cancel("t1");
        assert!(transfers.begin("t1").load(Ordering::Relaxed));
        // 别的传输不受影响，结束后记录也清掉了
        assert!(!transfers.begin("t2").load(Ordering::Relaxed));
        transfers.end("t1");
        assert!(!transfers.begin("t1").load(Ordering::Relaxed));
    }

    // ---------- 上传 ----------

    #[tokio::test]
    async fn upload_new_file_leaves_no_temp_files() {
        let env = Env::new().await;
        let local = env.put_local("a.txt", "new");
        env.upload(&local, "a.txt", false).await.unwrap();
        assert_eq!(env.read_remote("a.txt").as_deref(), Some("new"));
        assert_eq!(entries(&env.remote_path("")), ["a.txt"]);
    }

    #[tokio::test]
    async fn upload_refuses_to_replace_without_overwrite() {
        let env = Env::new().await;
        env.put_remote("a.txt", "old");
        let local = env.put_local("a.txt", "new");
        assert!(env.upload(&local, "a.txt", false).await.is_err());
        assert_eq!(env.read_remote("a.txt").as_deref(), Some("old"));
    }

    #[tokio::test]
    async fn upload_with_overwrite_replaces_and_keeps_permissions() {
        let env = Env::new().await;
        env.put_remote("run.sh", "old");
        env.faults.lock().unwrap().modes.insert(format!("{HOME}/run.sh"), 0o100755);
        let local = env.put_local("run.sh", "new");
        env.upload(&local, "run.sh", true).await.unwrap();
        assert_eq!(env.read_remote("run.sh").as_deref(), Some("new"));
        assert_eq!(entries(&env.remote_path("")), ["run.sh"]);
        let mode = env.faults.lock().unwrap().modes.get(&format!("{HOME}/run.sh")).copied();
        assert_eq!(mode.map(|m| m & 0o777), Some(0o755));
    }

    #[tokio::test]
    async fn upload_missing_local_file_keeps_remote_file() {
        let env = Env::new().await;
        env.put_remote("a.txt", "old");
        let missing = env.local_path("missing.txt").to_string_lossy().into_owned();
        assert!(env.upload(&missing, "a.txt", true).await.is_err());
        assert_eq!(env.read_remote("a.txt").as_deref(), Some("old"));
    }

    #[tokio::test]
    async fn upload_denied_by_server_keeps_remote_file() {
        // 文件只读、目录可写：无法写入，但可以删除
        let env = Env::new().await;
        env.put_remote("a.txt", "old");
        env.faults.lock().unwrap().deny_open_for_write = true;
        let local = env.put_local("a.txt", "new");
        assert!(env.upload(&local, "a.txt", true).await.is_err());
        assert_eq!(env.read_remote("a.txt").as_deref(), Some("old"));
    }

    #[tokio::test]
    async fn cancelled_upload_keeps_remote_file() {
        let env = Env::new().await;
        env.put_remote("a.txt", "old");
        let local = env.put_local("a.txt", "new");
        assert!(env.upload_cancellable(&local, "a.txt", true, true).await.is_err());
        assert_eq!(env.read_remote("a.txt").as_deref(), Some("old"));
        assert_eq!(entries(&env.remote_path("")), ["a.txt"]);
    }

    #[tokio::test]
    async fn upload_write_failure_keeps_remote_file() {
        let env = Env::new().await;
        env.put_remote("a.txt", "old");
        env.faults.lock().unwrap().fail_writes = true;
        let local = env.put_local("a.txt", "new");
        assert!(env.upload(&local, "a.txt", true).await.is_err());
        assert_eq!(env.read_remote("a.txt").as_deref(), Some("old"));
        assert_eq!(entries(&env.remote_path("")), ["a.txt"]);
    }

    #[tokio::test]
    async fn upload_restores_original_when_final_rename_fails() {
        let env = Env::new().await;
        env.put_remote("a.txt", "old");
        env.faults.lock().unwrap().deny_rename_from_containing = Some(".part".into());
        let local = env.put_local("a.txt", "new");
        assert!(env.upload(&local, "a.txt", true).await.is_err());
        assert_eq!(env.read_remote("a.txt").as_deref(), Some("old"));
        assert_eq!(entries(&env.remote_path("")), ["a.txt"]);
    }

    #[tokio::test]
    async fn upload_refuses_to_replace_a_directory() {
        let env = Env::new().await;
        fs::create_dir(env.remote_path("d")).unwrap();
        env.put_remote("d/inner.txt", "keep");
        let local = env.put_local("d", "new");
        assert!(env.upload(&local, "d", true).await.is_err());
        assert_eq!(env.read_remote("d/inner.txt").as_deref(), Some("keep"));
        assert_eq!(entries(&env.remote_path("")), ["d"]);
    }

    #[tokio::test]
    async fn uploading_a_local_directory_is_rejected_and_keeps_remote_file() {
        let env = Env::new().await;
        env.put_remote("folder", "old");
        fs::create_dir(env.local_path("folder")).unwrap();
        let local = env.local_path("folder").to_string_lossy().into_owned();
        assert!(env.upload(&local, "folder", true).await.is_err());
        assert_eq!(env.read_remote("folder").as_deref(), Some("old"));
    }

    #[tokio::test]
    async fn upload_over_symlink_writes_through_to_its_target() {
        let env = Env::new().await;
        env.put_remote("real.conf", "old");
        env.put_remote("link.conf", "");
        env.faults.lock().unwrap().links.insert(format!("{HOME}/link.conf"), format!("{HOME}/real.conf"));
        let local = env.put_local("link.conf", "new");
        env.upload(&local, "link.conf", true).await.unwrap();
        assert_eq!(env.read_remote("real.conf").as_deref(), Some("new"));
        assert_eq!(env.read_remote("link.conf").as_deref(), Some(""));
    }

    /// 等服务器上出现已经写入内容的临时文件，然后断线
    async fn cut_when_uploading(env: &Env) {
        loop {
            // 文件还开着时，Windows 目录项里的大小一直是 0，要单独查询
            let started = fs::read_dir(env.remote_path("")).unwrap().flatten().any(|e| {
                e.file_name().to_string_lossy().ends_with(".part") && fs::metadata(e.path()).is_ok_and(|m| m.len() > 0)
            });
            if started {
                env.link.abort();
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn lost_connection_is_reported_plainly_and_the_temp_file_is_cleaned_after_reconnecting() {
        let env = Env::new().await;
        env.put_remote("a.txt", "old");
        let error = env.upload_and_lose_connection().await.unwrap_err();
        assert!(error.contains("ssh.connectionLost"), "{error}");
        assert_eq!(env.read_remote("a.txt").as_deref(), Some("old"));
        assert_eq!(env.remote_temp_files().len(), 1, "断线时没法当场删除");
        assert_eq!(env.temps.leftovers().len(), 1);

        let session = env.reconnect().await;
        clean_leftovers(&session, &env.temps).await;
        assert_eq!(entries(&env.remote_path("")), ["a.txt"]);
        assert_eq!(env.read_remote("a.txt").as_deref(), Some("old"));
        assert!(env.temps.leftovers().is_empty());
    }

    #[tokio::test]
    async fn the_record_of_leftovers_survives_a_restart() {
        let env = Env::new().await;
        env.put_remote("a.txt", "old");
        env.upload_and_lose_connection().await.unwrap_err();

        let restarted = Store::new(env.base.clone(), None);
        let temps = temps_of(&restarted);
        clean_leftovers(&env.reconnect().await, &temps).await;
        assert_eq!(entries(&env.remote_path("")), ["a.txt"]);
        // 删除后的记录也要落盘
        assert!(temps_of(&Store::new(env.base.clone(), None)).leftovers().is_empty());
    }

    #[tokio::test]
    async fn cleaning_leaves_other_servers_and_running_uploads_alone() {
        let env = Env::new().await;
        env.put_remote("a.txt", "old");
        env.upload_and_lose_connection().await.unwrap_err();
        let leftover = env.remote_temp_files();

        // 其他服务器的记录不算
        let other = env.store.server_temps("t", "another-server", 22);
        clean_leftovers(&env.reconnect().await, &other).await;
        assert_eq!(env.remote_temp_files(), leftover);

        // 另一个会话正在上传的文件
        let running = format!("{HOME}/.termipaw-running.part");
        env.put_remote(".termipaw-running.part", "writing");
        env.temps.begin(&running);
        clean_leftovers(&env.reconnect().await, &env.temps).await;
        assert_eq!(env.remote_temp_files(), [".termipaw-running.part"]);

        // 上传结束后才算遗留
        env.temps.finish(&running, false);
        clean_leftovers(&env.reconnect().await, &env.temps).await;
        assert!(env.remote_temp_files().is_empty());
    }

    /// 替换到一半断开：原文件在 `.old`，这时不能删除任何东西
    #[tokio::test]
    async fn cleaning_keeps_both_files_when_a_replace_was_interrupted() {
        let env = Env::new().await;
        let temp = format!("{HOME}/.termipaw-x.part");
        env.put_remote(".termipaw-x.part", "new");
        env.put_remote(".termipaw-x.old", "original");
        env.temps.begin(&temp);
        env.temps.finish(&temp, false);
        clean_leftovers(&env.reconnect().await, &env.temps).await;
        assert_eq!(env.remote_temp_files(), [".termipaw-x.old", ".termipaw-x.part"]);
    }

    #[tokio::test]
    async fn a_file_that_is_already_gone_is_dropped_from_the_record() {
        let env = Env::new().await;
        let temp = format!("{HOME}/.termipaw-gone.part");
        env.temps.begin(&temp);
        env.temps.finish(&temp, false);
        clean_leftovers(&env.reconnect().await, &env.temps).await;
        assert!(env.temps.leftovers().is_empty());
    }

    #[tokio::test]
    async fn finished_and_failed_uploads_leave_no_record() {
        let env = Env::new().await;
        let local = env.put_local("a.txt", "new");
        env.upload(&local, "a.txt", false).await.unwrap();
        assert!(env.temps.leftovers().is_empty());

        env.faults.lock().unwrap().fail_writes = true;
        assert!(env.upload(&local, "a.txt", true).await.is_err());
        assert!(env.temps.leftovers().is_empty(), "连接还在时当场就删掉了");
    }

    // ---------- 删除 ----------

    #[tokio::test]
    async fn removing_a_folder_removes_everything_inside_it() {
        let env = Env::new().await;
        fs::create_dir_all(env.remote_path("d/sub")).unwrap();
        env.put_remote("d/a.txt", "a");
        env.put_remote("d/sub/b.txt", "b");
        remove_tree(&env.session, &format!("{HOME}/d")).await.unwrap();
        assert!(entries(&env.remote_path("")).is_empty());
    }

    /// 指向目录的链接只删链接，不管界面怎么说，都不能删到它指向的目录里去
    #[tokio::test]
    async fn removing_a_link_to_a_folder_keeps_the_folder() {
        let env = Env::new().await;
        fs::create_dir(env.remote_path("real")).unwrap();
        env.put_remote("real/keep.txt", "keep");
        env.put_remote("link", "");
        env.faults.lock().unwrap().links.insert(format!("{HOME}/link"), format!("{HOME}/real"));
        remove_tree(&env.session, &format!("{HOME}/link")).await.unwrap();
        assert_eq!(entries(&env.remote_path("")), ["real"]);
        assert_eq!(env.read_remote("real/keep.txt").as_deref(), Some("keep"));
    }

    // ---------- 下载 ----------

    #[tokio::test]
    async fn download_new_file_leaves_no_temp_files() {
        let env = Env::new().await;
        env.put_remote("a.txt", "remote");
        let local = env.local_path("a.txt").to_string_lossy().into_owned();
        env.download("a.txt", &local, false).await.unwrap();
        assert_eq!(env.read_local("a.txt").as_deref(), Some("remote"));
        assert_eq!(entries(&env.base.join("local")), ["a.txt"]);
    }

    #[tokio::test]
    async fn download_replaces_existing_local_file() {
        let env = Env::new().await;
        env.put_remote("a.txt", "remote");
        let local = env.put_local("a.txt", "old");
        env.download("a.txt", &local, false).await.unwrap();
        assert_eq!(env.read_local("a.txt").as_deref(), Some("remote"));
        assert_eq!(entries(&env.base.join("local")), ["a.txt"]);
    }

    #[tokio::test]
    async fn download_of_missing_remote_file_keeps_local_file() {
        let env = Env::new().await;
        let local = env.put_local("a.txt", "old");
        assert!(env.download("missing.txt", &local, false).await.is_err());
        assert_eq!(env.read_local("a.txt").as_deref(), Some("old"));
    }

    #[tokio::test]
    async fn cancelled_download_keeps_local_file() {
        let env = Env::new().await;
        env.put_remote("a.txt", "remote");
        let local = env.put_local("a.txt", "old");
        assert!(env.download("a.txt", &local, true).await.is_err());
        assert_eq!(env.read_local("a.txt").as_deref(), Some("old"));
        assert_eq!(entries(&env.base.join("local")), ["a.txt"]);
    }

    #[tokio::test]
    async fn download_read_failure_keeps_local_file() {
        let env = Env::new().await;
        env.put_remote("a.txt", "remote");
        env.faults.lock().unwrap().fail_reads = true;
        let local = env.put_local("a.txt", "old");
        assert!(env.download("a.txt", &local, false).await.is_err());
        assert_eq!(env.read_local("a.txt").as_deref(), Some("old"));
        assert_eq!(entries(&env.base.join("local")), ["a.txt"]);
    }
}
