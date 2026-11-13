//! 目录的上传和下载。
//!
//! 服务器列出来的名字是不可信的：恶意服务器可以返回 `../../evil.exe` 或 `..\..\evil.exe`，
//! 想让文件写到下载目录外面。所以下载时每一层都检查名字，只会写到这次新建的目录里面。
//! 符号链接一律跳过，不跟随：可能指向目录外面，也可能形成循环。

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

use russh_sftp::client::SftpSession;
use serde::Serialize;

use crate::{
    error::{AppError, AppResult},
    files::safe_file_name,
    i18n::{t, Text},
    sftp::{download_file, join, lstat, upload_file, Progress},
    store::ServerTemps,
};

/// 一次传输最多处理的条目和目录层数。服务器可以构造出无穷无尽的目录，不能让它把内存和磁盘耗光
#[derive(Clone, Copy)]
pub struct Limits {
    pub entries: usize,
    pub depth: usize,
}

pub const LIMITS: Limits = Limits { entries: 200_000, depth: 64 };

/// 传输结束后要告诉用户的情况
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNote {
    /// 跳过的符号链接
    links: usize,
    /// 跳过的设备、管道等特殊文件
    special: usize,
    /// 名字有问题、被拒绝的条目
    refused: Vec<String>,
}

impl TreeNote {
    /// 每种情况一句，由界面按语言的习惯连起来
    fn messages(&self) -> Vec<Text> {
        let mut parts = Vec::new();
        if !self.refused.is_empty() {
            let sample: Vec<String> = self.refused.iter().take(3).cloned().collect();
            parts.push(t("tree.refused").arg("count", self.refused.len()).arg("names", sample));
        }
        if self.links > 0 {
            parts.push(t("tree.links").arg("count", self.links));
        }
        if self.special > 0 {
            parts.push(t("tree.special").arg("count", self.special));
        }
        parts
    }
}

/// 只能是一层名字。服务器或本地给出分隔符、`.`、`..`、控制字符的都不接受
pub fn is_plain_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.chars().any(char::is_control)
}

/// 目录项在本地的路径：名字先变成 Windows 能用的安全形式，重名（大小写不同也算）时加编号。
/// 结果一定是 `dir` 的直接子项。
fn local_child(dir: &Path, name: &str, taken: &mut HashSet<String>) -> PathBuf {
    let safe = safe_file_name(name);
    let (stem, ext) = match safe.rfind('.') {
        Some(i) if i > 0 => safe.split_at(i),
        _ => (safe.as_str(), ""),
    };
    let mut candidate = safe.clone();
    let mut n = 2;
    while !taken.insert(candidate.to_lowercase()) {
        candidate = format!("{stem} ({n}){ext}");
        n += 1;
    }
    dir.join(candidate)
}

struct DownloadPlan {
    /// 要新建的目录，父目录在前
    dirs: Vec<PathBuf>,
    files: Vec<(String, PathBuf, u64)>,
    note: TreeNote,
    /// 读取失败的子目录
    failed: Vec<(String, Text)>,
}

async fn plan_download(s: &SftpSession, remote: &str, root: &Path, limits: Limits) -> AppResult<DownloadPlan> {
    let mut plan = DownloadPlan { dirs: Vec::new(), files: Vec::new(), note: TreeNote::default(), failed: Vec::new() };
    let mut entries = 0usize;
    let mut stack = vec![(remote.to_string(), root.to_path_buf(), 0usize)];
    while let Some((dir, local, depth)) = stack.pop() {
        let listing = match s.read_dir(&dir).await {
            Ok(listing) => listing,
            // 最外层读不了就是整个传输失败
            Err(e) if depth == 0 => return Err(e.into()),
            Err(e) => {
                let e = AppError::from(e);
                if is_fatal(&e) {
                    return Err(e);
                }
                plan.failed.push((dir, e.text()));
                continue;
            }
        };
        let mut taken = HashSet::new();
        for e in listing {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            entries += 1;
            if entries > limits.entries {
                return Err(t("tree.tooManyEntries").arg("limit", limits.entries).into());
            }
            if !is_plain_name(&name) {
                plan.note.refused.push(name);
                continue;
            }
            let file_type = e.file_type();
            if file_type.is_symlink() {
                plan.note.links += 1;
            } else if file_type.is_dir() {
                if depth + 1 > limits.depth {
                    return Err(t("tree.tooDeep").arg("limit", limits.depth).into());
                }
                let child = local_child(&local, &name, &mut taken);
                plan.dirs.push(child.clone());
                stack.push((join(&dir, &name), child, depth + 1));
            } else if file_type.is_file() {
                let child = local_child(&local, &name, &mut taken);
                plan.files.push((join(&dir, &name), child, e.metadata().size.unwrap_or(0)));
            } else {
                plan.note.special += 1;
            }
        }
    }
    // 每个目录都在它的子项之前加入，所以父目录一定在前
    Ok(plan)
}

/// 新建一个不存在的目录，重名时加编号。下载总是写进新目录，这样不会覆盖任何已有文件，也不会踩到已有的链接
async fn create_fresh_dir(parent: &Path, name: &str) -> AppResult<PathBuf> {
    let safe = safe_file_name(name);
    for n in 1..1000 {
        let candidate = if n == 1 { parent.join(&safe) } else { parent.join(format!("{safe} ({n})")) };
        match tokio::fs::create_dir(&candidate).await {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(t("tree.tooManySameName").into())
}

/// 这类错误说明继续也没用，其余的（比如某个文件没有权限）跳过它接着传
fn is_fatal(e: &AppError) -> bool {
    matches!(e.code(), "transfer.cancelled" | "ssh.connectionLost" | "sftp.timeout" | "ssh.stepTimeout" | "ssh.connectTimeout")
}

/// `code` 区分上传和下载：不同语言里动词的位置和变化不一样，不能只替换一个词
fn failure_summary(failed: &[(String, Text)], code: &'static str) -> AppError {
    let (name, reason) = &failed[0];
    t(code).arg("count", failed.len()).arg("name", name.as_str()).arg("reason", reason.clone()).into()
}

/// 下载目录到 `parent` 下新建的文件夹。返回要告诉用户的情况
pub async fn download_tree<P>(s: &SftpSession, remote: &str, parent: &Path, limits: Limits, cancel: &AtomicBool, progress: &P) -> AppResult<Vec<Text>>
where
    P: Fn(Progress) + Sync,
{
    let base = remote.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    // 先列出全部内容再动本地文件：最外层读不了的话什么都不会留下。计划里的路径都相对于新目录
    let mut plan = plan_download(s, remote, Path::new(""), limits).await?;
    let root = create_fresh_dir(parent, base).await?;
    let result = run_download(s, &root, &mut plan, cancel, progress).await;
    if matches!(&result, Err(e) if e.code() == "transfer.cancelled") {
        // 取消时把这次新建的目录删掉，和取消单个文件的效果一样。目录是刚建的，里面只有这次写入的内容
        let _ = tokio::fs::remove_dir_all(&root).await;
    }
    result?;
    if !plan.failed.is_empty() {
        return Err(failure_summary(&plan.failed, "tree.downloadFailedSome"));
    }
    Ok(plan.note.messages())
}

async fn run_download<P>(s: &SftpSession, root: &Path, plan: &mut DownloadPlan, cancel: &AtomicBool, progress: &P) -> AppResult<()>
where
    P: Fn(Progress) + Sync,
{
    for dir in &plan.dirs {
        tokio::fs::create_dir(root.join(dir)).await?;
    }
    let total: u64 = plan.files.iter().map(|(_, _, size)| size).sum();
    let mut done = 0u64;
    for (remote, relative, size) in &plan.files {
        let local = root.join(relative);
        // 名字都检查过，这里再确认一次：不管前面出了什么问题，都不能写到目录外面
        if !relative.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
            plan.note.refused.push(remote.clone());
            continue;
        }
        let report = |p: Progress| progress(Progress { transferred: done + p.transferred, total });
        match download_file(s, remote, &local.to_string_lossy(), cancel, &report).await {
            Ok(()) => {}
            Err(e) if is_fatal(&e) => return Err(e),
            Err(e) => plan.failed.push((remote.clone(), e.text())),
        }
        done += size;
        progress(Progress { transferred: done, total });
    }
    Ok(())
}

/// 上传目录到 `remote`（完整路径）。`merge` 为真时允许目标目录已存在，同名文件被覆盖，其余文件保留。
#[allow(clippy::too_many_arguments)]
pub async fn upload_tree<P>(s: &SftpSession, temps: &ServerTemps, local: &Path, remote: &str, merge: bool, limits: Limits, cancel: &AtomicBool, progress: &P) -> AppResult<Vec<Text>>
where
    P: Fn(Progress) + Sync,
{
    let mut note = TreeNote::default();
    let mut dirs = vec![remote.to_string()];
    let mut files: Vec<(PathBuf, String, u64)> = Vec::new();
    let mut failed: Vec<(String, Text)> = Vec::new();
    let mut entries = 0usize;
    let mut stack = vec![(local.to_path_buf(), remote.to_string(), 0usize)];
    while let Some((dir, target, depth)) = stack.pop() {
        let mut listing = match tokio::fs::read_dir(&dir).await {
            Ok(listing) => listing,
            Err(e) if depth == 0 => return Err(e.into()),
            Err(e) => {
                failed.push((dir.to_string_lossy().into_owned(), AppError::from(e).text()));
                continue;
            }
        };
        while let Some(entry) = listing.next_entry().await? {
            entries += 1;
            if entries > limits.entries {
                return Err(t("tree.localTooManyEntries").arg("limit", limits.entries).into());
            }
            let raw = entry.file_name();
            let Some(name) = raw.to_str().filter(|n| is_plain_name(n)) else {
                note.refused.push(raw.to_string_lossy().into_owned());
                continue;
            };
            // 这里的类型不跟随链接，目录联接（junction）也算链接
            let file_type = entry.file_type().await?;
            if file_type.is_symlink() {
                note.links += 1;
            } else if file_type.is_dir() {
                if depth + 1 > limits.depth {
                    return Err(t("tree.localTooDeep").arg("limit", limits.depth).into());
                }
                let child = join(&target, name);
                dirs.push(child.clone());
                stack.push((entry.path(), child, depth + 1));
            } else if file_type.is_file() {
                let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
                files.push((entry.path(), join(&target, name), size));
            } else {
                note.special += 1;
            }
        }
    }

    for (i, dir) in dirs.iter().enumerate() {
        match lstat(s, dir).await? {
            None => s.create_dir(dir.as_str()).await?,
            // 符号链接不算目录：写进去可能跑到别处
            Some(m) if m.is_dir() && !m.is_symlink() => {
                if i == 0 && !merge {
                    return Err(t("sftp.folderExists").into());
                }
            }
            Some(_) => return Err(t("tree.notAFolder").arg("path", dir.as_str()).into()),
        }
    }

    let total: u64 = files.iter().map(|(_, _, size)| size).sum();
    let mut done = 0u64;
    for (path, target, size) in &files {
        let report = |p: Progress| progress(Progress { transferred: done + p.transferred, total });
        match upload_file(s, temps, &path.to_string_lossy(), target, merge, cancel, &report).await {
            Ok(()) => {}
            Err(e) if is_fatal(&e) => return Err(e),
            Err(e) => failed.push((target.clone(), e.text())),
        }
        done += size;
        progress(Progress { transferred: done, total });
    }
    if !failed.is_empty() {
        return Err(failure_summary(&failed, "tree.uploadFailedSome"));
    }
    Ok(note.messages())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{atomic::AtomicBool, Arc, Mutex},
    };

    use russh_sftp::client::SftpSession;

    use super::*;
    use crate::{
        sftp_sandbox::{Faults, SandboxSftp},
        store::{ServerTemps, Store},
    };

    const HOME: &str = "/home/t";

    struct Env {
        base: PathBuf,
        faults: Arc<Mutex<Faults>>,
        store: Store,
        temps: ServerTemps,
        session: SftpSession,
        link: tokio::task::AbortHandle,
    }

    impl Env {
        async fn new() -> Self {
            let base = std::env::temp_dir().join(format!("termipaw-tree-test-{}", uuid::Uuid::new_v4()));
            let remote_root = base.join("remote");
            fs::create_dir_all(remote_root.join("home/t/site")).unwrap();
            fs::create_dir_all(base.join("local")).unwrap();
            fs::create_dir_all(base.join("source")).unwrap();
            let faults = Arc::new(Mutex::new(Faults::default()));
            let (server, mut server_side) = tokio::io::duplex(1 << 20);
            let (mut client_side, client) = tokio::io::duplex(1 << 20);
            tokio::spawn(russh_sftp::server::run(server, SandboxSftp::new(remote_root, HOME, faults.clone())));
            let link = tokio::spawn(async move {
                let _ = tokio::io::copy_bidirectional(&mut client_side, &mut server_side).await;
            })
            .abort_handle();
            let session = SftpSession::new(client).await.unwrap();
            let store = Store::new(base.clone(), None);
            let temps = store.server_temps("t", "server", 22);
            Self { base, faults, store, temps, session, link }
        }

        fn remote(&self, path: &str) -> PathBuf {
            self.base.join("remote/home/t").join(path)
        }

        fn put_remote(&self, path: &str, content: &str) {
            let p = self.remote(path);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, content).unwrap();
        }

        fn local(&self, path: &str) -> PathBuf {
            self.base.join("local").join(path)
        }

        fn source(&self, path: &str) -> PathBuf {
            self.base.join("source").join(path)
        }

        fn put_source(&self, path: &str, content: &str) {
            let p = self.source(path);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, content).unwrap();
        }

        fn fake(&self, dir: &str, names: &[(&str, bool)]) {
            let entries = names.iter().map(|(n, d)| (n.to_string(), *d)).collect();
            self.faults.lock().unwrap().fake_entries.insert(format!("{HOME}/{dir}"), entries);
        }

        async fn download(&self, dir: &str) -> AppResult<Vec<Text>> {
            self.download_limited(dir, LIMITS, false).await
        }

        async fn download_limited(&self, dir: &str, limits: Limits, cancelled: bool) -> AppResult<Vec<Text>> {
            let cancel = AtomicBool::new(cancelled);
            download_tree(&self.session, &format!("{HOME}/{dir}"), &self.base.join("local"), limits, &cancel, &|_: Progress| {}).await
        }

        async fn upload(&self, dir: &str, merge: bool) -> AppResult<Vec<Text>> {
            self.upload_limited(dir, merge, LIMITS, false).await
        }

        async fn upload_limited(&self, dir: &str, merge: bool, limits: Limits, cancelled: bool) -> AppResult<Vec<Text>> {
            let cancel = AtomicBool::new(cancelled);
            upload_tree(&self.session, &self.temps, &self.source(dir), &format!("{HOME}/{dir}"), merge, limits, &cancel, &|_: Progress| {}).await
        }

        /// 下载根目录以外有没有多出东西
        fn outside_is_clean(&self) -> bool {
            names(&self.base).iter().all(|n| matches!(n.as_str(), "local" | "remote" | "source") || n.ends_with(".json")) && names(&self.base.join("local")).len() <= 1
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    /// 目录下所有文件的相对路径
    fn all_files(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap().flatten() {
                if e.path().is_dir() {
                    stack.push(e.path());
                } else {
                    out.push(e.path().strip_prefix(dir).unwrap().to_string_lossy().replace('\\', "/"));
                }
            }
        }
        out.sort();
        out
    }

    // ---------- 下载 ----------

    #[tokio::test]
    async fn a_nested_directory_is_downloaded_completely() {
        let env = Env::new().await;
        env.put_remote("site/a.txt", "A");
        env.put_remote("site/sub/deep/b.txt", "B");
        fs::create_dir_all(env.remote("site/empty")).unwrap();
        assert!(env.download("site").await.unwrap().is_empty());
        assert_eq!(all_files(&env.local("site")), ["a.txt", "sub/deep/b.txt"]);
        assert_eq!(fs::read_to_string(env.local("site/sub/deep/b.txt")).unwrap(), "B");
        assert!(env.local("site/empty").is_dir(), "空目录也要下载");
    }

    #[tokio::test]
    async fn names_that_climb_out_of_the_directory_are_refused() {
        let env = Env::new().await;
        env.put_remote("site/a.txt", "A");
        // 这些路径在服务器上是真实存在的，服务器乐于提供内容
        env.put_remote("outside.txt", "secret");
        env.fake("site", &[("../outside.txt", false), ("../../outside.txt", false), ("..", true), (".", true), ("a/b.txt", false), ("/etc/passwd", false), ("sub/../../x", true)]);
        let notes = env.download("site").await.unwrap();
        assert!(notes.iter().any(|n| n.code == "tree.refused" && n.args["count"] == crate::i18n::Arg::Num(5)), "要说明拒绝了哪些条目：{notes:?}");
        assert_eq!(all_files(&env.local("site")), ["a.txt"]);
        assert!(env.outside_is_clean(), "{:?}", names(&env.base));
    }

    #[tokio::test]
    async fn windows_style_names_stay_inside_the_directory() {
        let env = Env::new().await;
        let hostile = ["..\\..\\evil.exe", "C:\\Windows\\evil.exe", "evil.txt:stream", "CON", "NUL.txt", "trailing. ", "what?", "rtl\u{202E}txt.exe", "\\\\server\\share\\x"];
        let entries: Vec<(&str, bool)> = hostile.iter().map(|n| (*n, false)).collect();
        env.fake("site", &entries);
        // 这些文件在沙箱里并不存在，所以都算失败。要看的是有没有东西写到外面
        let _ = env.download("site").await;
        assert!(env.outside_is_clean(), "{:?}", names(&env.base));
        assert_eq!(names(&env.base.join("local")), ["site"]);
    }

    #[tokio::test]
    async fn names_that_differ_only_in_case_do_not_overwrite_each_other() {
        let env = Env::new().await;
        env.put_remote("site/a.txt", "A");
        // Windows 上大小写不敏感，服务器上却可以是两个文件
        env.fake("site", &[("A.TXT", false)]);
        env.download("site").await.unwrap();
        assert_eq!(names(&env.local("site")).len(), 2, "{:?}", names(&env.local("site")));
    }

    #[tokio::test]
    async fn an_existing_local_folder_is_left_alone() {
        let env = Env::new().await;
        env.put_remote("site/a.txt", "new");
        fs::create_dir_all(env.local("site")).unwrap();
        fs::write(env.local("site/a.txt"), "mine").unwrap();
        env.download("site").await.unwrap();
        assert_eq!(fs::read_to_string(env.local("site/a.txt")).unwrap(), "mine");
        assert_eq!(fs::read_to_string(env.local("site (2)/a.txt")).unwrap(), "new");
    }

    #[tokio::test]
    async fn symlinks_on_the_server_are_skipped() {
        let env = Env::new().await;
        env.put_remote("site/a.txt", "A");
        env.put_remote("secret/key", "secret");
        env.fake("site", &[("link", true)]);
        env.faults.lock().unwrap().links.insert(format!("{HOME}/site/link"), format!("{HOME}/secret"));
        let notes = env.download("site").await.unwrap();
        assert!(notes.contains(&t("tree.links").arg("count", 1usize)), "{notes:?}");
        assert_eq!(all_files(&env.local("site")), ["a.txt"]);
        assert!(!env.local("site/link").exists());
    }

    #[tokio::test]
    async fn cancelling_a_download_removes_the_new_folder() {
        let env = Env::new().await;
        env.put_remote("site/a.txt", "A");
        let err = env.download_limited("site", LIMITS, true).await.unwrap_err();
        assert_eq!(err.code(), "transfer.cancelled");
        assert!(names(&env.base.join("local")).is_empty());
    }

    #[tokio::test]
    async fn a_directory_that_is_too_large_or_too_deep_is_refused_before_writing() {
        let env = Env::new().await;
        for i in 0..5 {
            env.put_remote(&format!("site/{i}.txt"), "x");
        }
        env.put_remote("deep/1/2/3/4/f.txt", "x");
        let err = env.download_limited("site", Limits { entries: 3, depth: 64 }, false).await.unwrap_err();
        assert!(matches!(err.code(), "tree.tooManyEntries" | "tree.localTooManyEntries"), "{err}");
        let err = env.download_limited("deep", Limits { entries: 100, depth: 2 }, false).await.unwrap_err();
        assert!(matches!(err.code(), "tree.tooDeep" | "tree.localTooDeep"), "{err}");
        assert!(names(&env.base.join("local")).is_empty());
    }

    #[tokio::test]
    async fn one_bad_file_does_not_stop_the_others() {
        let env = Env::new().await;
        env.put_remote("site/a.txt", "A");
        env.put_remote("site/z.txt", "Z");
        env.fake("site", &[("ghost.txt", false)]);
        let err = env.download("site").await.unwrap_err().to_string();
        assert!(err.starts_with("tree.downloadFailedSome") && err.contains("count=1") && err.contains("ghost.txt"), "{err}");
        assert_eq!(all_files(&env.local("site")), ["a.txt", "z.txt"]);
    }

    #[tokio::test]
    async fn an_unreadable_directory_leaves_nothing_behind() {
        let env = Env::new().await;
        assert!(env.download("no-such-dir").await.is_err());
        assert!(names(&env.base.join("local")).is_empty());
    }

    #[tokio::test]
    async fn a_lost_connection_stops_the_transfer() {
        let env = Env::new().await;
        env.put_remote("site/a.txt", "A");
        env.link.abort();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let err = env.download("site").await.unwrap_err();
        assert!(err.to_string().contains("ssh.connectionLost"), "{err}");
    }

    // ---------- 上传 ----------

    #[tokio::test]
    async fn a_nested_folder_is_uploaded_completely() {
        let env = Env::new().await;
        env.put_source("app/a.txt", "A");
        env.put_source("app/sub/deep/b.txt", "B");
        fs::create_dir_all(env.source("app/empty")).unwrap();
        assert!(env.upload("app", false).await.unwrap().is_empty());
        assert_eq!(all_files(&env.remote("app")), ["a.txt", "sub/deep/b.txt"]);
        assert!(env.remote("app/empty").is_dir());
        assert!(env.temps.leftovers().is_empty());
        let _ = &env.store;
    }

    #[tokio::test]
    async fn an_existing_remote_folder_needs_permission_to_merge() {
        let env = Env::new().await;
        env.put_source("app/a.txt", "new");
        env.put_source("app/b.txt", "added");
        env.put_remote("app/a.txt", "old");
        env.put_remote("app/keep.txt", "keep");
        let err = env.upload("app", false).await.unwrap_err();
        assert!(err.to_string().contains("Exists"), "{err}");
        assert_eq!(fs::read_to_string(env.remote("app/a.txt")).unwrap(), "old");

        env.upload("app", true).await.unwrap();
        assert_eq!(fs::read_to_string(env.remote("app/a.txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(env.remote("app/b.txt")).unwrap(), "added");
        assert_eq!(fs::read_to_string(env.remote("app/keep.txt")).unwrap(), "keep", "合并不能删除服务器上其余的文件");
        assert!(!names(&env.remote("app")).iter().any(|n| n.starts_with(".termipaw-")));
    }

    #[tokio::test]
    async fn merging_refuses_to_write_through_a_remote_symlink() {
        let env = Env::new().await;
        env.put_source("app/sub/a.txt", "A");
        env.put_remote("app/keep.txt", "keep");
        env.put_remote("target/keep.txt", "keep");
        fs::create_dir_all(env.remote("app/sub")).unwrap();
        env.faults.lock().unwrap().links.insert(format!("{HOME}/app/sub"), format!("{HOME}/target"));
        let err = env.upload("app", true).await.unwrap_err();
        assert!(err.to_string().contains("tree.notAFolder"), "{err}");
        assert_eq!(names(&env.remote("target")), ["keep.txt"]);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn local_junctions_are_skipped() {
        let env = Env::new().await;
        env.put_source("app/a.txt", "A");
        env.put_source("private/secret.txt", "secret");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(env.source("app").join("link"))
            .arg(env.source("private"))
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let notes = env.upload("app", false).await.unwrap();
        assert!(notes.contains(&t("tree.links").arg("count", 1usize)), "要说明跳过了链接：{notes:?}");
        assert_eq!(all_files(&env.remote("app")), ["a.txt"]);
        assert!(!env.remote("app/link").exists());
    }

    #[tokio::test]
    async fn cancelling_an_upload_leaves_no_temporary_files() {
        let env = Env::new().await;
        env.put_source("app/a.txt", "A");
        let err = env.upload_limited("app", false, LIMITS, true).await.unwrap_err();
        assert_eq!(err.code(), "transfer.cancelled");
        assert!(names(&env.remote("app")).is_empty());
        assert!(env.temps.leftovers().is_empty());
    }

    #[tokio::test]
    async fn a_folder_that_is_too_large_is_refused_before_uploading() {
        let env = Env::new().await;
        for i in 0..5 {
            env.put_source(&format!("app/{i}.txt"), "x");
        }
        let err = env.upload_limited("app", false, Limits { entries: 3, depth: 64 }, false).await.unwrap_err();
        assert!(matches!(err.code(), "tree.tooManyEntries" | "tree.localTooManyEntries"), "{err}");
        assert!(!env.remote("app").exists());
    }

    #[tokio::test]
    async fn a_failed_file_is_reported_and_the_rest_still_arrive() {
        let env = Env::new().await;
        env.put_source("app/a.txt", "A");
        env.put_source("app/z.txt", "Z");
        // 服务器上同名的是文件夹，这一个文件传不了
        fs::create_dir_all(env.remote("app/a.txt")).unwrap();
        let err = env.upload("app", true).await.unwrap_err().to_string();
        assert!(err.starts_with("tree.uploadFailedSome") && err.contains("count=1"), "{err}");
        assert_eq!(fs::read_to_string(env.remote("app/z.txt")).unwrap(), "Z");
    }

    // ---------- 名字 ----------

    #[test]
    fn plain_names_have_one_level() {
        for ok in ["a", "a.txt", ".hidden", "..hidden", "...", "a..b", "中文", "a b", "a\\b"] {
            assert!(is_plain_name(ok), "{ok}");
        }
        for bad in ["", ".", "..", "/", "a/b", "../a", "/etc", "a/", "a\nb", "a\0b", "a\u{1b}b", "a\u{9b}b"] {
            assert!(!is_plain_name(bad), "{bad:?}");
        }
    }

    /// 模糊测试：名字通过检查后，本地路径只会是目录的直接子项，而且不会和已有的重复
    #[test]
    fn local_children_stay_directly_under_the_directory() {
        use rand::RngExt;
        let pieces = ["..", ".", "/", "\\", ":", " ", "\n", "\u{202E}", "CON", "a", "A", "b.txt", "B.TXT", "中", "?", "*", "C:", "~1"];
        let dir = Path::new("D:\\root\\sub");
        let mut rng = rand::rng();
        for _ in 0..20_000 {
            let mut taken = HashSet::new();
            for _ in 0..6 {
                let name: String = (0..rng.random_range(1..6)).map(|_| pieces[rng.random_range(0..pieces.len())]).collect();
                if !is_plain_name(&name) {
                    continue;
                }
                let child = local_child(dir, &name, &mut taken);
                assert_eq!(child.parent(), Some(dir), "{name:?} -> {child:?}");
                assert!(child.components().all(|c| !matches!(c, std::path::Component::ParentDir)), "{name:?}");
            }
        }
    }

    #[test]
    fn local_children_get_numbered_when_names_collide() {
        let dir = Path::new("root");
        let mut taken = HashSet::new();
        assert_eq!(local_child(dir, "a.txt", &mut taken), dir.join("a.txt"));
        assert_eq!(local_child(dir, "A.TXT", &mut taken), dir.join("A (2).TXT"));
        assert_eq!(local_child(dir, "a?.txt", &mut taken), dir.join("a_.txt"));
        assert_eq!(local_child(dir, "a*.txt", &mut taken), dir.join("a_ (2).txt"));
    }
}
