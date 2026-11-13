//! 主机配置、known_hosts 与上传临时文件的记录。
//!
//! 主机配置写入 `hosts.json`，**不包含任何密码**。密码与私钥口令只能存进主密码保险库，
//! 没开保险库就不保存；开启“加密主机信息”后，这几个文件也搬进保险库，见 `docs/VAULT.md`。

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use russh::keys::{self, known_hosts, PublicKey};
use zeroize::Zeroizing;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    error::{raw, AppError, AppResult},
    i18n::{t, Text},
    ssh::ConnectTarget,
    vault::{Contents, Vault},
};

/// 这些文件开启“加密主机信息”后不再以明文存在
const HOSTS_FILE: &str = "hosts.json";
const KNOWN_HOSTS_FILE: &str = "known_hosts.json";
const UPLOAD_TEMPS_FILE: &str = "upload_temp_files.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Key,
    /// ssh-agent / Pageant 里的私钥
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub key_path: Option<String>,
    /// 是否在保险库中保存了密码 / 口令
    #[serde(default)]
    pub save_secret: bool,
    #[serde(default)]
    pub last_connected: Option<i64>,
    /// 服务器用的编码，界面按它转换终端的输入输出。没有就是 UTF-8
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

/// 界面支持的编码（WHATWG 的名字）。UTF-8 是默认值，不保存
const ENCODINGS: [&str; 6] = ["gb18030", "big5", "shift_jis", "euc-jp", "euc-kr", "windows-1252"];

/// 认识的编码原样保存，UTF-8 和不认识的都当作默认值
fn normalize_encoding(encoding: Option<String>) -> Option<String> {
    encoding.filter(|e| ENCODINGS.contains(&e.as_str()))
}

/// 写文件时先写临时文件再重命名，避免崩溃或断电导致配置损坏。
pub(crate) fn write_atomic(path: &Path, data: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension("tmp");
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    Ok(result?)
}

/// 读取文件内容，文件不存在时返回 `None`。杀毒软件等可能短暂占用文件，所以失败时重试几次。
pub(crate) fn read_with_retry(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    const ATTEMPTS: u32 = 3;
    let mut failures = 0;
    loop {
        match fs::read(path) {
            Ok(bytes) => return Ok(Some(bytes)),
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                failures += 1;
                if failures == ATTEMPTS {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

/// 把损坏的文件移到不重名的备份路径，每次损坏都保留一份
pub(crate) fn move_to_backup(path: &Path) -> std::io::Result<PathBuf> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let backup = (0..)
        .map(|n| match n {
            0 => path.with_file_name(format!("{name}.bak-{stamp}")),
            n => path.with_file_name(format!("{name}.bak-{stamp}-{n}")),
        })
        .find(|p| !p.exists())
        .expect("the backup name sequence is endless");
    fs::rename(path, &backup)?;
    Ok(backup)
}

/// 启动时读取配置发现的问题，由界面提示给用户
#[derive(Clone, Debug, Serialize)]
pub struct StoreIssue {
    title: Text,
    message: Text,
}

/// 文件无法解析时怎么办
enum OnCorrupt {
    /// 移到备份后按空内容继续，参数是说明对用户影响的文字代码
    Backup(&'static str),
    /// 留在原处并拒绝使用。文件被移走后，下次启动会变成“文件不存在”，等于静默清空
    Keep,
}

enum Blocked {
    ReadFailed(Text),
    Corrupted,
}

/// 一个 JSON 配置文件。内容不可信时拒绝写入，避免用空内容覆盖用户数据。
struct JsonFile {
    path: PathBuf,
    blocked: Mutex<Option<Blocked>>,
}

impl JsonFile {
    fn new(path: PathBuf, blocked: Option<Blocked>) -> Self {
        Self { path, blocked: Mutex::new(blocked) }
    }

    /// `label` 是这个文件在界面上的名称（文字代码）
    fn load<T>(path: PathBuf, label: &'static str, on_corrupt: OnCorrupt, issues: &mut Vec<StoreIssue>) -> (Self, T)
    where
        T: for<'de> Deserialize<'de> + Default,
    {
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let bytes = match read_with_retry(&path) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return (Self::new(path, None), T::default()),
            Err(e) => {
                issues.push(StoreIssue {
                    title: t("store.readFailedTitle").arg("what", t(label)),
                    message: t("store.readFailed").arg("file", name.as_str()).detail(&e).arg("what", t(label)),
                });
                return (Self::new(path, Some(Blocked::ReadFailed(raw(e)))), T::default());
            }
        };
        // 兼容记事本等编辑器写入的 UTF-8 BOM
        if let Ok(value) = serde_json::from_slice(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)) {
            return (Self::new(path, None), value);
        }
        let title = t("store.corruptTitle").arg("what", t(label));
        match on_corrupt {
            OnCorrupt::Keep => {
                issues.push(StoreIssue {
                    title,
                    message: t("store.corruptKept").arg("file", name.as_str()).arg("what", t(label)),
                });
                (Self::new(path, Some(Blocked::Corrupted)), T::default())
            }
            OnCorrupt::Backup(consequence) => match move_to_backup(&path) {
                Ok(backup) => {
                    issues.push(StoreIssue {
                        title,
                        message: t("store.corruptBackedUp").arg("file", name.as_str()).arg("backup", backup.display().to_string()).arg("consequence", t(consequence)),
                    });
                    (Self::new(path, None), T::default())
                }
                Err(e) => {
                    issues.push(StoreIssue {
                        title,
                        message: t("store.corruptNoBackup").arg("file", name.as_str()).detail(&e).arg("what", t(label)),
                    });
                    (Self::new(path, Some(Blocked::ReadFailed(t("store.corruptNoBackupShort").detail(&e)))), T::default())
                }
            },
        }
    }

    /// 保险库重置后重新读取明文文件
    fn reload<T>(&self, label: &'static str, on_corrupt: OnCorrupt, issues: &mut Vec<StoreIssue>) -> T
    where
        T: for<'de> Deserialize<'de> + Default,
    {
        let (fresh, value) = Self::load(self.path.clone(), label, on_corrupt, issues);
        *self.blocked.lock().unwrap() = fresh.blocked.into_inner().unwrap();
        value
    }

    fn remove(&self) {
        // 写入时崩溃可能留下临时文件，里面也是明文
        let _ = fs::remove_file(self.path.with_extension("tmp"));
        if let Err(e) = fs::remove_file(&self.path) {
            if e.kind() != ErrorKind::NotFound {
                eprintln!("failed to delete {}: {e}", self.path.display());
            }
        }
    }

    fn ensure_writable(&self) -> AppResult<()> {
        match &*self.blocked.lock().unwrap() {
            Some(Blocked::ReadFailed(e)) => Err(t("store.writeBlocked").arg("reason", e.clone()).into()),
            Some(Blocked::Corrupted) => Err(t("store.writeBlockedCorrupt").into()),
            None => Ok(()),
        }
    }

    fn write<T: Serialize + ?Sized>(&self, value: &T) -> AppResult<()> {
        self.ensure_writable()?;
        write_atomic(&self.path, &serde_json::to_vec_pretty(value)?)
    }
}

// ---------- 上传的临时文件 ----------

#[derive(Default)]
struct TempFilesState {
    /// 服务器 -> 还没确认删除的临时文件
    recorded: BTreeMap<String, BTreeSet<String>>,
    /// 本程序正在写入的临时文件，不能当作遗留文件清理
    active: BTreeSet<(String, String)>,
    /// 还有修改没写进保险库：锁定时写不了，解锁后补上
    unsaved: bool,
}

/// 记录上传用的临时文件。连接断开时没法当场删除，下次连上同一台服务器再删。
/// 只记本程序自己创建的文件，不靠扫描目录，所以不会碰到别的客户端正在上传的文件。
pub struct TempFiles {
    file: JsonFile,
    state: Mutex<TempFilesState>,
    vault: Arc<Vault>,
}

const UPLOAD_TEMPS_LABEL: &str = "store.uploadTemps";
const UPLOAD_TEMPS_CORRUPT: OnCorrupt = OnCorrupt::Backup("store.uploadTempsLost");

impl TempFiles {
    fn new(path: PathBuf, vault: Arc<Vault>, issues: &mut Vec<StoreIssue>) -> Self {
        let (file, recorded) = if vault.metadata_protected() {
            (JsonFile::new(path, None), BTreeMap::new())
        } else {
            JsonFile::load(path, UPLOAD_TEMPS_LABEL, UPLOAD_TEMPS_CORRUPT, issues)
        };
        Self { file, state: Mutex::new(TempFilesState { recorded, ..Default::default() }), vault }
    }

    /// 写入失败不影响上传，只是这个文件以后不能自动清理。
    /// 锁定时上传还在继续，记录先留在内存里：万一这期间崩溃，服务器上的 `.part` 不会被自动清理，但不影响目标文件
    fn save(&self, state: &mut TempFilesState) {
        if self.vault.encrypts_metadata() {
            let recorded = state.recorded.clone();
            state.unsaved = self.vault.update(move |c| c.upload_temps = Some(recorded)).is_err();
        } else if let Err(e) = self.file.write(&state.recorded) {
            eprintln!("failed to save the upload temp file record: {e}");
        }
    }

    fn remove(state: &mut TempFilesState, server: &str, temp: &str) {
        if let Some(files) = state.recorded.get_mut(server) {
            files.remove(temp);
            if files.is_empty() {
                state.recorded.remove(server);
            }
        }
    }
}

/// 某一台服务器（`用户@地址:端口`）上的临时文件记录
#[derive(Clone)]
pub struct ServerTemps {
    all: Arc<TempFiles>,
    server: String,
}

impl ServerTemps {
    /// 这个连接对应的服务器（用户、地址、端口）
    pub fn server(&self) -> &str {
        &self.server
    }

    /// 创建临时文件之前调用，这样无论什么时候中断都有记录
    pub fn begin(&self, temp: &str) {
        let mut state = self.all.state.lock().unwrap();
        state.recorded.entry(self.server.clone()).or_default().insert(temp.to_string());
        state.active.insert((self.server.clone(), temp.to_string()));
        self.all.save(&mut state);
    }

    /// 上传结束。`gone` 表示临时文件已经不在服务器上了，否则留到下次连接时清理
    pub fn finish(&self, temp: &str, gone: bool) {
        let mut state = self.all.state.lock().unwrap();
        state.active.remove(&(self.server.clone(), temp.to_string()));
        if gone {
            TempFiles::remove(&mut state, &self.server, temp);
            self.all.save(&mut state);
        }
    }

    /// 之前遗留的临时文件，不包括正在上传的
    pub fn leftovers(&self) -> Vec<String> {
        let state = self.all.state.lock().unwrap();
        let Some(files) = state.recorded.get(&self.server) else {
            return Vec::new();
        };
        files.iter().filter(|f| !state.active.contains(&(self.server.clone(), (*f).clone()))).cloned().collect()
    }

    pub fn forget(&self, temp: &str) {
        let mut state = self.all.state.lock().unwrap();
        TempFiles::remove(&mut state, &self.server, temp);
        self.all.save(&mut state);
    }
}

pub struct Store {
    dir: PathBuf,
    hosts_file: JsonFile,
    /// `None` 表示主机信息在保险库里、现在读不到。不用空列表表示，这样任何路径都不可能把空列表写回去
    hosts: Mutex<Option<Vec<Host>>>,
    pub known: Arc<KnownHosts>,
    temp_files: Arc<TempFiles>,
    issues: Mutex<Vec<StoreIssue>>,
    pub vault: Arc<Vault>,
}

const HOSTS_LABEL: &str = "store.hosts";
const HOSTS_CORRUPT: OnCorrupt = OnCorrupt::Backup("store.hostsEmpty");
const KNOWN_HOSTS_LABEL: &str = "store.knownHosts";

impl Store {
    /// `openssh_known_hosts` 是 OpenSSH 的 known_hosts 文件，只读取，不写入
    pub fn new(dir: PathBuf, openssh_known_hosts: Option<PathBuf>) -> Self {
        let mut issues = Vec::new();
        let vault = Arc::new(Vault::load(dir.join("vault.json")));
        // 主机信息在保险库里时不读明文文件：那里最多是没删干净的残留
        let (hosts_file, hosts) = if vault.metadata_protected() {
            (JsonFile::new(dir.join(HOSTS_FILE), None), None)
        } else {
            let (file, hosts) = JsonFile::load(dir.join(HOSTS_FILE), HOSTS_LABEL, HOSTS_CORRUPT, &mut issues);
            (file, Some(hosts))
        };
        let known = KnownHosts::new(dir.join(KNOWN_HOSTS_FILE), openssh_known_hosts, vault.clone(), &mut issues);
        let temp_files = TempFiles::new(dir.join(UPLOAD_TEMPS_FILE), vault.clone(), &mut issues);
        Self {
            dir,
            hosts_file,
            hosts: Mutex::new(hosts),
            known: Arc::new(known),
            temp_files: Arc::new(temp_files),
            issues: Mutex::new(issues),
            vault,
        }
    }

    pub fn server_temps(&self, username: &str, host: &str, port: u16) -> ServerTemps {
        ServerTemps { all: self.temp_files.clone(), server: format!("{username}@{host}:{port}") }
    }

    /// 配置文件所在的目录
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn save(&self, hosts: &[Host]) -> AppResult<()> {
        if self.vault.encrypts_metadata() {
            let hosts = hosts.to_vec();
            self.vault.update(move |c| c.hosts = Some(hosts))
        } else {
            self.hosts_file.write(hosts)
        }
    }

    /// 主机信息读不到时什么也不做：这只用来记录最近连接时间这类小事，正在连接时刚好锁定不算错误
    pub fn update(&self, id: &str, f: impl FnOnce(&mut Host)) -> AppResult<()> {
        let mut guard = self.hosts.lock().unwrap();
        let Some(hosts) = guard.as_mut() else { return Ok(()) };
        if let Some(h) = hosts.iter_mut().find(|h| h.id == id) {
            f(h);
            self.save(hosts)?;
        }
        Ok(())
    }

    fn host_saved_secret(hosts: &[Host], id: &str) -> bool {
        hosts.iter().any(|h| h.id == id && h.save_secret)
    }

    /// 这次连接的目标和保存的主机是不是同一个。地址是界面传来的：不核对的话，
    /// 界面只要说“用这台主机的密码，连到那个地址”，保存的密码就会发给别的服务器
    pub fn target_is_saved_host(&self, target: &ConnectTarget) -> bool {
        let guard = self.hosts.lock().unwrap();
        let Some(id) = target.host_id.as_deref() else { return false };
        guard.as_deref().unwrap_or_default().iter().any(|h| h.id == id && h.host == target.host && h.port == target.port && h.username == target.username && h.auth == target.auth && h.key_path == target.key_path)
    }

    /// 连接时用的已保存密码。目标和保存的主机对不上时不给，界面会让用户输入
    pub fn saved_secret(&self, target: &ConnectTarget) -> AppResult<Option<Zeroizing<String>>> {
        if target.auth == AuthMethod::Agent || !self.target_is_saved_host(target) {
            return Ok(None);
        }
        let Some(id) = target.host_id.as_deref() else { return Ok(None) };
        let saved = self.hosts.lock().unwrap().as_deref().is_some_and(|hosts| Self::host_saved_secret(hosts, id));
        self.vault.secret_get(id, saved)
    }

    // ---------- 保险库 ----------

    /// 锁定。主机信息在保险库里时，内存里的也清掉
    pub fn lock_vault(&self) {
        self.vault.lock();
        if self.vault.metadata_protected() {
            *self.hosts.lock().unwrap() = None;
            self.known.forget();
        }
    }

    /// 解锁之后：取回主机信息，补上锁定期间没写进去的记录，继续没做完的清理。
    /// 这些失败都不影响已经解锁，下次解锁时会再试
    pub fn after_unlock(&self, contents: Contents) {
        // 解锁的同时刚好又锁定了
        if !self.vault.is_unlocked() {
            return;
        }
        if self.vault.encrypts_metadata() {
            let complete = contents.hosts.is_some();
            *self.hosts.lock().unwrap() = Some(contents.hosts.unwrap_or_default());
            self.known.restore(contents.known_hosts.unwrap_or_default());
            {
                let mut state = self.temp_files.state.lock().unwrap();
                if state.unsaved {
                    self.temp_files.save(&mut state);
                } else if let Some(recorded) = contents.upload_temps {
                    state.recorded = recorded;
                }
            }
            // 以保险库为准。删除明文文件之前中断时会留下残留
            if complete {
                self.remove_plain_metadata();
            }
        }
        // 上面这段时间里又锁定了：刚取回的主机信息不能留在内存里
        if !self.vault.is_unlocked() && self.vault.metadata_protected() {
            *self.hosts.lock().unwrap() = None;
            self.known.forget();
        }
    }

    fn remove_plain_metadata(&self) {
        self.hosts_file.remove();
        self.known.file.remove();
        self.temp_files.file.remove();
    }

    fn metadata_files_writable(&self) -> AppResult<()> {
        self.hosts_file.ensure_writable()?;
        self.known.file.ensure_writable()?;
        self.temp_files.file.ensure_writable()
    }

    /// 开启保险库。返回恢复密钥，和标记了“已保存密码”但其实没有的主机名（保险库从空开始）。
    /// 配置文件不可写时中止，什么都不改
    pub fn enable_vault(&self, password: &str, recovery: bool, encrypt_metadata: bool) -> AppResult<(Option<Zeroizing<String>>, Vec<String>)> {
        if self.vault.is_on() {
            return Err(t("vault.alreadyOn").into());
        }
        self.metadata_files_writable()?;
        let mut guard = self.hosts.lock().unwrap();
        let hosts = guard.as_mut().ok_or_else(AppError::vault_locked)?;

        let recovery_key = self.vault.create(password, recovery, Contents::new())?;

        // 没开保险库时不能保存密码，所以主机记录里写着“已保存”的，只可能是从旧版本带过来的：其实没有。
        // 保险库是空的，把这些标记去掉，名字告诉用户
        let mut missing = Vec::new();
        for host in hosts.iter_mut().filter(|h| h.save_secret) {
            host.save_secret = false;
            if host.auth != AuthMethod::Agent {
                missing.push(host.name.clone());
            }
        }
        self.save(hosts)?;
        drop(guard);
        if encrypt_metadata {
            self.set_encrypt_metadata(true)?;
        }
        Ok((recovery_key, missing))
    }

    /// 改“加密主机信息”的开关。不管在哪一步中断，都以保险库文件里的开关为准，内容不会丢
    pub fn set_encrypt_metadata(&self, on: bool) -> AppResult<()> {
        if !self.vault.is_unlocked() {
            return Err(AppError::vault_locked());
        }
        if on == self.vault.encrypts_metadata() {
            return Ok(());
        }
        let hosts_guard = self.hosts.lock().unwrap();
        let hosts = hosts_guard.as_ref().ok_or_else(AppError::vault_locked)?;
        let known_guard = self.known.map.lock().unwrap();
        let known = known_guard.as_ref().ok_or_else(AppError::vault_locked)?;
        let temps_guard = self.temp_files.state.lock().unwrap();
        if on {
            self.metadata_files_writable()?;
            let (h, k, t) = (hosts.clone(), known.clone(), temps_guard.recorded.clone());
            self.vault.set_encrypt_metadata(true, move |c| {
                c.hosts = Some(h);
                c.known_hosts = Some(k);
                c.upload_temps = Some(t);
            })?;
            self.remove_plain_metadata();
        } else {
            self.write_plain_metadata(hosts, known, &temps_guard.recorded)?;
            self.vault.set_encrypt_metadata(false, |c| {
                c.hosts = None;
                c.known_hosts = None;
                c.upload_temps = None;
            })?;
        }
        Ok(())
    }

    fn write_plain_metadata(&self, hosts: &[Host], known: &BTreeMap<String, String>, temps: &BTreeMap<String, BTreeSet<String>>) -> AppResult<()> {
        self.hosts_file.write(hosts)?;
        self.known.file.write(known)?;
        self.temp_files.file.write(temps)
    }

    /// 关闭保险库。主机信息加密时先写回明文文件，写好了才删除保险库文件
    pub fn disable_vault(&self, password: &str) -> AppResult<()> {
        // 保险库里的密码随保险库一起删除，不搬到别处：绿色版不写系统的凭据管理器
        self.vault.check_password(password)?;
        // 主机信息先写回明文文件，写好了才删保险库：中途失败时什么都没丢
        if self.vault.encrypts_metadata() {
            let hosts_guard = self.hosts.lock().unwrap();
            let hosts = hosts_guard.as_ref().ok_or_else(AppError::vault_locked)?;
            let known_guard = self.known.map.lock().unwrap();
            let known = known_guard.as_ref().ok_or_else(AppError::vault_locked)?;
            let temps_guard = self.temp_files.state.lock().unwrap();
            self.write_plain_metadata(hosts, known, &temps_guard.recorded)?;
        }
        self.vault.remove_file()
    }

    /// 忘记主密码时放弃保险库。备份文件保留。之后用明文文件里有的内容继续
    pub fn reset_vault(&self) -> AppResult<PathBuf> {
        let protected = self.vault.metadata_protected();
        let backup = self.vault.reset()?;
        let mut issues = Vec::new();
        if protected {
            *self.hosts.lock().unwrap() = Some(self.hosts_file.reload(HOSTS_LABEL, HOSTS_CORRUPT, &mut issues));
            self.known.restore(self.known.file.reload(KNOWN_HOSTS_LABEL, OnCorrupt::Keep, &mut issues));
            let recorded = self.temp_files.file.reload(UPLOAD_TEMPS_LABEL, UPLOAD_TEMPS_CORRUPT, &mut issues);
            self.temp_files.state.lock().unwrap().recorded = recorded;
        }
        self.issues.lock().unwrap().extend(issues);
        // 密码都在保险库里，不能还显示“已保存”
        let mut guard = self.hosts.lock().unwrap();
        if let Some(hosts) = guard.as_mut() {
            if hosts.iter().any(|h| h.save_secret) {
                hosts.iter_mut().for_each(|h| h.save_secret = false);
                self.save(hosts)?;
            }
        }
        Ok(backup)
    }

    /// 还留着明文主机信息的旧备份。开启加密时告诉用户，由用户决定是否删除：它们可能是仅有的备份
    pub fn old_backups(&self) -> Vec<String> {
        let prefixes = [HOSTS_FILE, KNOWN_HOSTS_FILE, UPLOAD_TEMPS_FILE].map(|f| format!("{f}.bak-"));
        let Ok(list) = fs::read_dir(&self.dir) else { return Vec::new() };
        list.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|name| prefixes.iter().any(|p| name.starts_with(p))).collect()
    }

    pub fn delete_old_backups(&self) -> AppResult<()> {
        for name in self.old_backups() {
            fs::remove_file(self.dir.join(name))?;
        }
        Ok(())
    }
}

// ---------- known_hosts ----------

pub enum KeyCheck {
    Trusted,
    Unknown,
    Changed,
    /// 记录在保险库里，现在读不到。不能当作首次连接，否则“指纹已变化”的警告会失效
    Locked,
    /// 指纹记录不可用，无法判断。此时不能当作首次连接，否则“指纹已变化”的警告会失效
    Blocked { text: Text, can_reset: bool },
}

/// `"host:port" -> "ssh-ed25519 AAAA..."`
pub struct KnownHosts {
    file: JsonFile,
    /// `None` 表示记录在保险库里、现在读不到
    map: Mutex<Option<BTreeMap<String, String>>>,
    vault: Arc<Vault>,
    openssh_file: Option<PathBuf>,
    /// 最近一次握手时服务器出示的、还没被信任的指纹。界面只能确认这一把，不能自己指定要信任什么
    pending: Mutex<BTreeMap<String, (String, Instant)>>,
}

/// 暂存的指纹多久内可以确认
const PENDING_LIFETIME: Duration = Duration::from_secs(10 * 60);

impl KnownHosts {
    fn new(path: PathBuf, openssh_file: Option<PathBuf>, vault: Arc<Vault>, issues: &mut Vec<StoreIssue>) -> Self {
        let (file, map) = if vault.metadata_protected() {
            (JsonFile::new(path, None), None)
        } else {
            let (file, map) = JsonFile::load(path, KNOWN_HOSTS_LABEL, OnCorrupt::Keep, issues);
            (file, Some(map))
        };
        Self { file, map: Mutex::new(map), vault, openssh_file, pending: Mutex::default() }
    }

    /// 锁定：内存里不留连接过的地址
    fn forget(&self) {
        *self.map.lock().unwrap() = None;
        self.pending.lock().unwrap().clear();
    }

    fn restore(&self, map: BTreeMap<String, String>) {
        *self.map.lock().unwrap() = Some(map);
    }

    /// 记下服务器这次出示的指纹，等用户确认
    pub fn stage(&self, host: &str, port: u16, key: &PublicKey) {
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, (_, at)| at.elapsed() < PENDING_LIFETIME);
        pending.insert(Self::key(host, port), (key.to_openssh().unwrap_or_default(), Instant::now()));
    }

    /// 信任最近一次出示的指纹。没有待确认的指纹（或已过期）就失败，不接受界面传来的密钥
    pub fn trust_pending(&self, host: &str, port: u16) -> AppResult<()> {
        self.file.ensure_writable()?;
        let key = {
            let mut pending = self.pending.lock().unwrap();
            match pending.remove(&Self::key(host, port)) {
                Some((key, at)) if at.elapsed() < PENDING_LIFETIME => key,
                _ => return Err(t("knownHosts.noPending").into()),
            }
        };
        self.trust(host, port, &key)
    }

    fn key(host: &str, port: u16) -> String {
        format!("{}:{port}", host.to_ascii_lowercase())
    }

    /// 先查自己的记录，再查 OpenSSH 的 known_hosts。
    ///
    /// OpenSSH 文件里无法识别的行（通配符、`@revoked` 等）不算匹配，会回到首次连接的确认。
    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> KeyCheck {
        match &*self.file.blocked.lock().unwrap() {
            Some(Blocked::ReadFailed(e)) => {
                return KeyCheck::Blocked {
                    text: t("knownHosts.readFailed").arg("detail", e.clone()),
                    can_reset: false,
                }
            }
            Some(Blocked::Corrupted) => {
                return KeyCheck::Blocked {
                    text: t("knownHosts.corrupt"),
                    can_reset: true,
                }
            }
            None => {}
        }
        let openssh = key.to_openssh().unwrap_or_default();
        {
            let guard = self.map.lock().unwrap();
            let Some(map) = guard.as_ref() else { return KeyCheck::Locked };
            match map.get(&Self::key(host, port)) {
                Some(recorded) if *recorded == openssh => return KeyCheck::Trusted,
                Some(_) => return KeyCheck::Changed,
                None => {}
            }
        }
        let Some(path) = &self.openssh_file else { return KeyCheck::Unknown };
        // OpenSSH 写入时统一用小写主机名
        match known_hosts::check_known_hosts_path(&host.to_ascii_lowercase(), port, key, path) {
            Ok(true) => KeyCheck::Trusted,
            Err(keys::Error::KeyChanged { .. }) => KeyCheck::Changed,
            _ => KeyCheck::Unknown,
        }
    }

    /// 备份损坏的指纹文件并清空记录。之后所有主机都按首次连接确认
    pub fn reset(&self) -> AppResult<()> {
        let mut blocked = self.file.blocked.lock().unwrap();
        if !matches!(*blocked, Some(Blocked::Corrupted)) {
            return Err(t("knownHosts.resetOnlyCorrupt").into());
        }
        move_to_backup(&self.file.path)?;
        *blocked = None;
        Ok(())
    }

    fn trust(&self, host: &str, port: u16, key: &str) -> AppResult<()> {
        self.file.ensure_writable()?;
        let mut guard = self.map.lock().unwrap();
        let map = guard.as_mut().ok_or_else(AppError::vault_locked)?;
        map.insert(Self::key(host, port), key.to_string());
        if self.vault.encrypts_metadata() {
            let map = map.clone();
            self.vault.update(move |c| c.known_hosts = Some(map))
        } else {
            self.file.write(map)
        }
    }
}

// ---------- 命令 ----------

#[tauri::command]
pub fn hosts_list(store: State<'_, Store>) -> Vec<Host> {
    store.visible_hosts()
}

/// 新增或更新主机。`secret` 为 `Some` 时更新保险库中的密码 / 口令。
#[tauri::command]
pub fn hosts_save(store: State<'_, Store>, host: Host, secret: Option<String>) -> AppResult<Host> {
    store.save_host(host, secret.map(Zeroizing::new).as_ref().map(|s| s.as_str()))
}

#[tauri::command]
pub fn hosts_delete(store: State<'_, Store>, id: String) -> AppResult<()> {
    store.delete_host(&id)
}

impl Store {
    /// 界面看到的主机列表。没开保险库就没有保存的密码：文件里残留的“已保存”标记
    /// （从旧版本带来的，或关闭保险库时留下的）不显示出来
    pub fn visible_hosts(&self) -> Vec<Host> {
        let mut hosts = self.hosts.lock().unwrap().clone().unwrap_or_default();
        if !self.vault.is_on() {
            hosts.iter_mut().for_each(|h| h.save_secret = false);
        }
        hosts
    }

    fn save_host(&self, host: Host, secret: Option<&str>) -> AppResult<Host> {
        if host.host.trim().is_empty() || host.username.trim().is_empty() {
            return Err(t("hosts.required").into());
        }
        // 先确认能保存，避免只写入了密码却没有保存主机
        self.hosts_file.ensure_writable()?;
        let mut guard = self.hosts.lock().unwrap();
        let hosts = guard.as_mut().ok_or_else(AppError::vault_locked)?;
        let mut host = host;
        host.encoding = normalize_encoding(host.encoding.take());
        if !self.vault.is_on() {
            // 要保存新密码却没有保险库：明说，不能悄悄不存
            if host.save_secret && secret.is_some_and(|s| !s.is_empty()) {
                return Err(t("vault.needed").into());
            }
            host.save_secret = false;
        }
        if host.save_secret {
            if let Some(s) = secret.filter(|s| !s.is_empty()) {
                self.vault.secret_set(&host.id, s)?;
            }
        } else {
            self.vault.secret_delete(&host.id, Self::host_saved_secret(hosts, &host.id))?;
        }

        match hosts.iter_mut().find(|h| h.id == host.id) {
            Some(existing) => {
                let last = existing.last_connected;
                *existing = host.clone();
                existing.last_connected = last;
            }
            None => hosts.push(host.clone()),
        }
        self.save(hosts)?;
        Ok(host)
    }

    fn delete_host(&self, id: &str) -> AppResult<()> {
        self.hosts_file.ensure_writable()?;
        let mut guard = self.hosts.lock().unwrap();
        let hosts = guard.as_mut().ok_or_else(AppError::vault_locked)?;
        // 保险库锁着时这里会报错，主机留着：否则密码会成为保险库里的孤儿记录
        self.vault.secret_delete(id, Self::host_saved_secret(hosts, id))?;
        hosts.retain(|h| h.id != id);
        self.save(hosts)
    }
}

#[cfg(test)]
impl Store {
    pub fn hosts_for_test(&self) -> Vec<Host> {
        self.hosts.lock().unwrap().clone().unwrap_or_default()
    }

    pub fn save_hosts_for_test(&self, hosts: Vec<Host>) {
        self.save(&hosts).map_err(|e| e.to_string()).unwrap();
        *self.hosts.lock().unwrap() = Some(hosts);
    }

    pub fn save_host_for_test(&self, host: Host) -> AppResult<Host> {
        self.save_host(host, None)
    }

    pub fn save_host_with_secret_for_test(&self, host: Host, secret: Option<&str>) -> AppResult<Host> {
        self.save_host(host, secret)
    }

    pub fn delete_host_for_test(&self, id: &str) -> AppResult<()> {
        self.delete_host(id)
    }
}

/// 信任服务器最近一次出示的指纹。要信任哪一把由后端记着，界面只能说“就是它”
#[tauri::command]
pub fn known_hosts_trust(store: State<'_, Store>, host: String, port: u16) -> AppResult<()> {
    store.known.trust_pending(&host, port)
}

#[tauri::command]
pub fn known_hosts_reset(store: State<'_, Store>) -> AppResult<()> {
    store.known.reset()
}

/// 取走启动时发现的配置问题，每个问题只提示一次
#[tauri::command]
pub fn store_take_issues(store: State<'_, Store>) -> Vec<StoreIssue> {
    std::mem::take(&mut *store.issues.lock().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 0.7.x 及以前保存的主机带着严格模式和兼容旧服务器的字段，读进来时忽略，不能报错
    #[test]
    fn hosts_from_older_versions_still_load() {
        let old = r#"[{"id":"a","name":"a","host":"h","port":22,"username":"u","auth":"password","strict":true,"legacyRsa":true}]"#;
        let hosts: Vec<Host> = serde_json::from_str(old).unwrap();
        assert_eq!(hosts[0].host, "h");
        let saved = serde_json::to_string(&hosts).unwrap();
        assert!(!saved.contains("strict") && !saved.contains("legacyRsa"), "{saved}");
        assert!(!saved.contains("encoding"), "默认的 UTF-8 不写进文件：{saved}");
    }

    #[test]
    fn only_known_encodings_are_saved() {
        let dir = TempDir::new();
        let store = open(&dir);
        let with = |id: &str, encoding: &str| Host { encoding: Some(encoding.into()), ..host(id) };
        let saved = |id: &str| store.hosts_for_test().into_iter().find(|h| h.id == id).unwrap().encoding;
        store.save_host_for_test(with("gbk", "gb18030")).unwrap();
        store.save_host_for_test(with("utf8", "utf-8")).unwrap();
        store.save_host_for_test(with("odd", "../../etc")).unwrap();
        assert_eq!(saved("gbk").as_deref(), Some("gb18030"));
        assert_eq!(saved("utf8"), None);
        assert_eq!(saved("odd"), None);
        assert_eq!(open(&dir).hosts_for_test().into_iter().find(|h| h.id == "gbk").unwrap().encoding.as_deref(), Some("gb18030"));
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("termipaw-store-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn backups(&self, prefix: &str) -> Vec<String> {
            fs::read_dir(&self.0)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with(prefix) && n.contains("bak"))
                .collect()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn host(id: &str) -> Host {
        Host {
            id: id.into(),
            name: id.into(),
            group: String::new(),
            host: "example.com".into(),
            port: 22,
            username: "u".into(),
            auth: AuthMethod::Password,
            key_path: None,
            save_secret: false,
            last_connected: None,
            encoding: None,
        }
    }

    fn open(dir: &TempDir) -> Store {
        Store::new(dir.0.clone(), None)
    }

    fn random_key() -> PublicKey {
        keys::PrivateKey::random(&mut rand::rng(), keys::Algorithm::Ed25519).unwrap().public_key().clone()
    }

    fn openssh(key: &PublicKey) -> String {
        key.to_openssh().unwrap()
    }

    #[test]
    fn missing_files_load_as_empty_and_can_be_saved() {
        let dir = TempDir::new();
        let store = open(&dir);
        assert!(store.hosts_for_test().is_empty());
        store.save(&[host("a")]).unwrap();
        let reloaded = open(&dir);
        assert_eq!(reloaded.hosts_for_test().len(), 1);
    }

    #[test]
    fn utf8_bom_is_tolerated() {
        let dir = TempDir::new();
        let mut bytes = b"\xEF\xBB\xBF".to_vec();
        bytes.extend(serde_json::to_vec(&[host("a")]).unwrap());
        fs::write(dir.0.join("hosts.json"), bytes).unwrap();
        let store = open(&dir);
        assert_eq!(store.hosts_for_test().len(), 1);
    }

    #[test]
    fn every_corrupt_file_gets_its_own_backup() {
        let dir = TempDir::new();
        fs::write(dir.0.join("hosts.json"), "broken one").unwrap();
        drop(open(&dir));
        fs::write(dir.0.join("hosts.json"), "broken two").unwrap();
        drop(open(&dir));

        let backups = dir.backups("hosts");
        assert_eq!(backups.len(), 2, "{backups:?}");
        let contents: Vec<String> = backups.iter().map(|b| fs::read_to_string(dir.0.join(b)).unwrap()).collect();
        assert!(contents.contains(&"broken one".to_string()));
        assert!(contents.contains(&"broken two".to_string()));
    }

    /// 启动时配置文件被其他程序独占（如杀毒软件），之后保存不能覆盖原有主机
    #[cfg(windows)]
    #[test]
    fn hosts_are_not_overwritten_after_a_failed_read() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = TempDir::new();
        let path = dir.0.join("hosts.json");
        let original = serde_json::to_vec(&[host("keep-1"), host("keep-2")]).unwrap();
        fs::write(&path, &original).unwrap();

        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
        let store = open(&dir);
        drop(lock);

        assert!(store.save(&[host("new")]).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(store.issues.lock().unwrap().len(), 1);
    }

    #[test]
    fn read_failure_blocks_saving_hosts_and_host_keys() {
        // 目录无法按文件读取，在所有平台上都会触发“文件不存在”以外的读取错误
        let dir = TempDir::new();
        fs::create_dir(dir.0.join("hosts.json")).unwrap();
        fs::create_dir(dir.0.join("known_hosts.json")).unwrap();
        let store = open(&dir);
        assert!(store.save(&[host("new")]).is_err());
        assert!(store.known.trust("example.com", 22, "ssh-ed25519 AAAA").is_err());
        assert!(matches!(store.known.check("example.com", 22, &random_key()), KeyCheck::Blocked { can_reset: false, .. }));
        assert!(store.known.reset().is_err());
        assert_eq!(store.issues.lock().unwrap().len(), 2);
    }

    /// 损坏的指纹文件不能被移走：否则下次启动变成“文件不存在”，等于静默清空所有指纹
    #[test]
    fn corrupt_host_keys_block_connections_and_stay_in_place_until_reset() {
        let dir = TempDir::new();
        let path = dir.0.join("known_hosts.json");
        fs::write(&path, "broken").unwrap();

        for _ in 0..2 {
            let store = open(&dir);
            assert!(matches!(store.known.check("example.com", 22, &random_key()), KeyCheck::Blocked { can_reset: true, .. }));
            assert!(store.known.trust("example.com", 22, "ssh-ed25519 AAAA").is_err());
            assert_eq!(store.issues.lock().unwrap().len(), 1);
            assert_eq!(fs::read_to_string(&path).unwrap(), "broken");
        }

        let store = open(&dir);
        store.known.reset().unwrap();
        assert_eq!(dir.backups("known_hosts").len(), 1);
        let key = random_key();
        assert!(matches!(store.known.check("example.com", 22, &key), KeyCheck::Unknown));
        store.known.trust("example.com", 22, &openssh(&key)).unwrap();
        assert!(matches!(open(&dir).known.check("example.com", 22, &key), KeyCheck::Trusted));
    }

    #[test]
    fn openssh_known_hosts_is_consulted_but_never_modified() {
        let dir = TempDir::new();
        let key = random_key();
        let other_type = keys::PrivateKey::random(&mut rand::rng(), keys::Algorithm::Ecdsa { curve: keys::EcdsaCurve::NistP256 })
            .unwrap()
            .public_key()
            .clone();
        let base64 = openssh(&key).split(' ').nth(1).unwrap().to_string();
        let content = format!(
            "# comment\nplain.example.com ssh-ed25519 {base64} me@laptop\n[ported.example.com]:2222 ssh-ed25519 {base64}\n@revoked revoked.example.com ssh-ed25519 {base64}\n*.wild.example.com ssh-ed25519 {base64}\n"
        );
        let path = dir.0.join("openssh_known_hosts");
        fs::write(&path, &content).unwrap();
        let store = Store::new(dir.0.clone(), Some(path.clone()));

        let check = |host: &str, port, k: &PublicKey| store.known.check(host, port, k);
        assert!(matches!(check("plain.example.com", 22, &key), KeyCheck::Trusted));
        assert!(matches!(check("PLAIN.example.com", 22, &key), KeyCheck::Trusted));
        assert!(matches!(check("ported.example.com", 2222, &key), KeyCheck::Trusted));
        // 端口不同是另一台主机
        assert!(matches!(check("plain.example.com", 2222, &key), KeyCheck::Unknown));
        // 同类型的密钥不同：可能是中间人
        assert!(matches!(check("plain.example.com", 22, &random_key()), KeyCheck::Changed));
        // 其他类型的密钥：OpenSSH 允许一台主机有多种密钥，按首次连接确认
        assert!(matches!(check("plain.example.com", 22, &other_type), KeyCheck::Unknown));
        // 无法识别的行不算匹配
        assert!(matches!(check("revoked.example.com", 22, &key), KeyCheck::Unknown));
        assert!(matches!(check("a.wild.example.com", 22, &key), KeyCheck::Unknown));
        assert!(matches!(check("unknown.example.com", 22, &key), KeyCheck::Unknown));

        // 自己的记录优先，且不写回 OpenSSH 的文件
        let new_key = random_key();
        store.known.trust("plain.example.com", 22, &openssh(&new_key)).unwrap();
        assert!(matches!(check("plain.example.com", 22, &new_key), KeyCheck::Trusted));
        assert!(matches!(check("plain.example.com", 22, &key), KeyCheck::Changed));
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
    }

    /// 条目由 `ssh-keygen -H` 生成，对应主机名 hashed.example.com
    #[test]
    fn hashed_openssh_entries_are_recognized() {
        const HASHED_HOST: &str = "|1|e4mG5IEgeUR8qe/fho7Anx++7oM=|LUWq99/Djw2w7A58TzKYV9DvIFU=";
        let dir = TempDir::new();
        let key = random_key();
        let base64 = openssh(&key).split(' ').nth(1).unwrap().to_string();
        let path = dir.0.join("openssh_known_hosts");
        fs::write(&path, format!("{HASHED_HOST} ssh-ed25519 {base64}\n")).unwrap();
        let store = Store::new(dir.0.clone(), Some(path));
        assert!(matches!(store.known.check("hashed.example.com", 22, &key), KeyCheck::Trusted));
        assert!(matches!(store.known.check("other.example.com", 22, &key), KeyCheck::Unknown));
    }

    #[test]
    fn corrupt_file_is_reported_and_saving_continues() {
        let dir = TempDir::new();
        fs::write(dir.0.join("hosts.json"), "broken").unwrap();
        let store = open(&dir);
        let issues = store.issues.lock().unwrap().clone();
        assert_eq!(issues.len(), 1);
        assert!(issues[0].message.to_string().contains(".bak-"), "{:?}", issues[0]);
        store.save(&[host("new")]).unwrap();
        assert_eq!(open(&dir).hosts_for_test().len(), 1);
    }

    #[test]
    fn trusted_key_survives_a_restart_and_a_changed_key_is_detected() {
        let dir = TempDir::new();
        let key = random_key();
        open(&dir).known.trust("Example.com", 22, &openssh(&key)).unwrap();
        let store = open(&dir);
        assert!(matches!(store.known.check("example.com", 22, &key), KeyCheck::Trusted));
        assert!(matches!(store.known.check("example.com", 22, &random_key()), KeyCheck::Changed));
        assert!(matches!(store.known.check("example.com", 2222, &key), KeyCheck::Unknown));
    }

    /// 界面不能自己指定要信任哪一把密钥，只能确认服务器出示过的那一把
    #[test]
    fn only_a_key_the_server_presented_can_be_trusted() {
        let dir = TempDir::new();
        let store = open(&dir);
        // 没有出示过：不能信任
        assert!(store.known.trust_pending("example.com", 22).is_err());

        let key = random_key();
        store.known.stage("Example.com", 22, &key);
        // 另一个地址或端口也不行
        assert!(store.known.trust_pending("example.com", 2222).is_err());
        assert!(store.known.trust_pending("other.com", 22).is_err());
        assert!(matches!(store.known.check("example.com", 22, &key), KeyCheck::Unknown));

        store.known.trust_pending("example.com", 22).unwrap();
        assert!(matches!(store.known.check("example.com", 22, &key), KeyCheck::Trusted));
        // 确认一次就用掉了
        assert!(store.known.trust_pending("example.com", 22).is_err());
        assert!(matches!(open(&dir).known.check("example.com", 22, &key), KeyCheck::Trusted));
    }

    #[test]
    fn the_latest_presented_key_wins_and_stale_ones_expire() {
        let dir = TempDir::new();
        let store = open(&dir);
        let (first, second) = (random_key(), random_key());
        store.known.stage("example.com", 22, &first);
        store.known.stage("example.com", 22, &second);
        store.known.trust_pending("example.com", 22).unwrap();
        assert!(matches!(store.known.check("example.com", 22, &second), KeyCheck::Trusted));
        assert!(matches!(store.known.check("example.com", 22, &first), KeyCheck::Changed));

        store.known.stage("old.example.com", 22, &first);
        let long_ago = Instant::now().checked_sub(PENDING_LIFETIME + Duration::from_secs(1)).expect("系统运行时间不够长");
        store.known.pending.lock().unwrap().get_mut("old.example.com:22").unwrap().1 = long_ago;
        assert!(store.known.trust_pending("old.example.com", 22).is_err());
    }

    #[test]
    fn nothing_can_be_trusted_while_the_record_file_is_unusable() {
        let dir = TempDir::new();
        fs::write(dir.0.join("known_hosts.json"), "broken").unwrap();
        let store = open(&dir);
        store.known.stage("example.com", 22, &random_key());
        assert!(store.known.trust_pending("example.com", 22).is_err());
        assert_eq!(fs::read_to_string(dir.0.join("known_hosts.json")).unwrap(), "broken");
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp_file() {
        let dir = TempDir::new();
        let path = dir.0.join("data.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }
}
