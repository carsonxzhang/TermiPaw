//! 保险库的运行状态：有没有开启、解锁了没有、密码存到哪里。设计见 `docs/VAULT.md`。
//!
//! 内存里只留数据密钥，内容每次用时从文件解密，所以两个 TermiPaw 同时开着也总是基于最新内容修改。
//! 没有任何命令把解密后的密码交给界面。

use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::Zeroizing;

use super::{
    format::{check_new_password, Contents, DataKey, OpenError, VaultFile, DEFAULT_IDLE_MINUTES, IDLE_CHOICES},
};
use crate::{
    error::{AppError, AppResult},
    i18n::{self, t, Text},
    store::{move_to_backup, read_with_retry, write_atomic, Store},
};
/// 多久检查一次要不要自动锁定
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// 两次检查之间的墙上时间差这么多，说明电脑睡眠过。系统通知没收到时靠这个兜底
const SLEEP_GAP: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
enum Mode {
    Off,
    On { encrypt_metadata: bool, has_recovery: bool },
    /// 文件读不了或解析不了。不能当作没开启：否则加密的主机信息会被当成不存在，新的内容写进明文文件
    Broken { message: Text, can_reset: bool },
}

impl Mode {
    fn of(file: &VaultFile) -> Self {
        Self::On { encrypt_metadata: file.encrypt_metadata(), has_recovery: file.has_recovery() }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    enabled: bool,
    locked: bool,
    encrypt_metadata: bool,
    has_recovery: bool,
    /// 文件有问题时的说明
    problem: Option<Text>,
    can_reset: bool,
    idle_minutes: u32,
}

/// 用户的操作时间。检查线程只读这里，不用抢别的锁
struct Idle {
    minutes: AtomicU64,
    last_activity: Mutex<Instant>,
    last_check: Mutex<SystemTime>,
}

pub struct Vault {
    path: PathBuf,
    lock_path: PathBuf,
    mode: Mutex<Mode>,
    key: Mutex<Option<DataKey>>,
    /// 派生要占用几百 MiB 内存，一次只做一个
    kdf_gate: Mutex<()>,
    /// 锁定过多少次。派生要半秒左右，这期间系统可能锁屏了，那么派生出来的密钥不能留下
    lock_count: AtomicU64,
    idle: Idle,
}

/// `what` 是用户输入的是什么，例如 `vault.what.password`
fn locked_error(e: OpenError, what: &'static str) -> AppError {
    match e {
        OpenError::WrongSecret => t("vault.wrongSecret").arg("what", t(what)).into(),
        other => other.text().into(),
    }
}

impl Vault {
    pub fn load(path: PathBuf) -> Self {
        let mode = match read_with_retry(&path) {
            Ok(None) => Mode::Off,
            Ok(Some(bytes)) => match VaultFile::parse(&bytes) {
                Ok(file) => Mode::of(&file),
                Err(OpenError::TooNew) => Mode::Broken { message: OpenError::TooNew.text(), can_reset: false },
                Err(e) => Mode::Broken { message: e.text(), can_reset: true },
            },
            Err(e) => Mode::Broken { message: t("vault.readFailed").detail(e), can_reset: false },
        };
        let lock_path = path.with_extension("lock");
        Self {
            path,
            lock_path,
            mode: Mutex::new(mode),
            key: Mutex::new(None),
            kdf_gate: Mutex::new(()),
            lock_count: AtomicU64::new(0),
            idle: Idle { minutes: AtomicU64::new(u64::from(DEFAULT_IDLE_MINUTES)), last_activity: Mutex::new(Instant::now()), last_check: Mutex::new(SystemTime::now()) },
        }
    }

    fn set_mode(&self, mode: Mode) {
        *self.mode.lock().unwrap() = mode;
    }

    fn mode(&self) -> Mode {
        self.mode.lock().unwrap().clone()
    }

    pub fn is_on(&self) -> bool {
        !matches!(self.mode(), Mode::Off)
    }

    pub fn is_unlocked(&self) -> bool {
        self.key.lock().unwrap().is_some()
    }

    /// 主机信息不在明文文件里（或者判断不了在不在）
    pub fn metadata_protected(&self) -> bool {
        matches!(self.mode(), Mode::On { encrypt_metadata: true, .. } | Mode::Broken { .. })
    }

    /// 主机信息现在读不到
    pub fn metadata_locked(&self) -> bool {
        self.metadata_protected() && !self.is_unlocked()
    }

    /// 主机信息应该写进保险库
    pub fn encrypts_metadata(&self) -> bool {
        matches!(self.mode(), Mode::On { encrypt_metadata: true, .. })
    }

    pub fn status(&self) -> VaultStatus {
        let mode = self.mode();
        let unlocked = self.is_unlocked();
        let minutes = self.idle.minutes.load(Ordering::Relaxed) as u32;
        let base = VaultStatus { enabled: false, locked: false, encrypt_metadata: false, has_recovery: false, problem: None, can_reset: false, idle_minutes: minutes };
        match mode {
            Mode::Off => base,
            Mode::On { encrypt_metadata, has_recovery } => VaultStatus { enabled: true, locked: !unlocked, encrypt_metadata, has_recovery, can_reset: true, ..base },
            Mode::Broken { message, can_reset } => VaultStatus { enabled: true, locked: true, problem: Some(message), can_reset, ..base },
        }
    }

    // ---------- 文件 ----------

    /// 文件锁，防止两个进程同时写。离开作用域时释放
    fn file_lock(&self) -> AppResult<fs::File> {
        let file = fs::OpenOptions::new().create(true).truncate(false).write(true).open(&self.lock_path)?;
        file.lock()?;
        Ok(file)
    }

    fn read_file(&self) -> AppResult<VaultFile> {
        let Some(bytes) = read_with_retry(&self.path)? else {
            // 开着的时候文件没了，只可能是别的进程关掉了保险库，或者被手动删除
            let message = t("vault.fileGone");
            self.set_mode(Mode::Broken { message: message.clone(), can_reset: false });
            return Err(AppError::Message(message));
        };
        VaultFile::parse(&bytes).map_err(|e| {
            let message = e.text();
            self.set_mode(Mode::Broken { message: message.clone(), can_reset: !matches!(e, OpenError::TooNew) });
            AppError::Message(message)
        })
    }

    fn write_file(&self, file: &VaultFile) -> AppResult<()> {
        write_atomic(&self.path, &file.to_bytes().map_err(AppError::from)?)?;
        self.set_mode(Mode::of(file));
        Ok(())
    }

    fn current_key(&self) -> AppResult<DataKey> {
        self.key.lock().unwrap().clone().ok_or_else(AppError::vault_locked)
    }

    /// 解不开通常是另一个窗口换了数据密钥：这边的密钥没用了，转为锁定，要求重新解锁
    fn contents_with(&self, file: &VaultFile, key: &DataKey) -> AppResult<Contents> {
        file.contents(key).map_err(|e| match e {
            OpenError::WrongSecret => {
                *self.key.lock().unwrap() = None;
                AppError::vault_locked()
            }
            other => other.text().into(),
        })
    }

    /// 读最新内容，修改，写回。没解锁时报错，所以任何路径都不可能用空内容覆盖文件
    pub fn update<T>(&self, f: impl FnOnce(&mut Contents) -> T) -> AppResult<T> {
        let key = self.current_key()?;
        let _lock = self.file_lock()?;
        let mut file = self.read_file()?;
        let mut contents = self.contents_with(&file, &key)?;
        let result = f(&mut contents);
        file.seal(&key, &contents).map_err(AppError::from)?;
        self.write_file(&file)?;
        Ok(result)
    }

    pub fn read(&self) -> AppResult<Contents> {
        let key = self.current_key()?;
        let file = self.read_file()?;
        self.contents_with(&file, &key)
    }

    // ---------- 密码 ----------

    /// `saved` 表示主机记录里写着保存过。没保存过的主机锁定时也不用解锁
    pub fn secret_get(&self, id: &str, saved: bool) -> AppResult<Option<Zeroizing<String>>> {
        match self.mode() {
            // 没开保险库就没有保存的密码，让用户手动输入
            Mode::Off => Ok(None),
            _ if !self.is_unlocked() && !saved => Ok(None),
            _ => {
                let mut contents = self.read()?;
                Ok(contents.secrets.remove(id))
            }
        }
    }

    pub fn secret_set(&self, id: &str, secret: &str) -> AppResult<()> {
        match self.mode() {
            // 密码只能存进保险库。界面不会让用户走到这里，这是后端自己的底线
            Mode::Off => Err(t("vault.needed").into()),
            _ => self.update(|c| {
                c.secrets.insert(id.to_string(), Zeroizing::new(secret.to_string()));
            }),
        }
    }

    /// `saved` 同 `secret_get`。保存过却锁着时报错：否则密码会成为保险库里的孤儿记录
    pub fn secret_delete(&self, id: &str, saved: bool) -> AppResult<()> {
        match self.mode() {
            Mode::Off => Ok(()),
            _ if !self.is_unlocked() && !saved => Ok(()),
            _ => {
                if self.read()?.secrets.contains_key(id) {
                    self.update(|c| {
                        c.secrets.remove(id);
                    })?;
                }
                Ok(())
            }
        }
    }

    // ---------- 解锁和锁定 ----------

    fn locks_so_far(&self) -> u64 {
        self.lock_count.load(Ordering::SeqCst)
    }

    /// 记下数据密钥。`started` 是开始派生时的锁定次数：这期间锁定过就不记，返回 `false`
    fn remember(&self, key: DataKey, contents: &Contents, started: u64) -> bool {
        let mut slot = self.key.lock().unwrap();
        if self.locks_so_far() != started {
            return false;
        }
        *slot = Some(key);
        self.idle.minutes.store(u64::from(contents.idle_minutes), Ordering::Relaxed);
        self.touch();
        true
    }

    pub fn unlock(&self, password: &str) -> AppResult<Contents> {
        let started = self.locks_so_far();
        let _gate = self.kdf_gate.lock().unwrap();
        let file = self.read_file()?;
        let key = file.open_with_password(password).map_err(|e| locked_error(e, "vault.what.password"))?;
        let contents = file.contents(&key).map_err(|e| AppError::from(OpenError::Damaged(t("vault.why.cannotDecrypt").arg("detail", e.text())).text()))?;
        self.upgrade_password_slot(password, &key);
        self.set_mode(Mode::of(&file));
        if !self.remember(key, &contents, started) {
            return Err(AppError::vault_locked());
        }
        Ok(contents)
    }

    /// 参数升级失败不影响解锁，下次再试
    fn upgrade_password_slot(&self, password: &str, key: &DataKey) {
        let upgrade = || -> AppResult<()> {
            let _lock = self.file_lock()?;
            let mut file = self.read_file()?;
            if file.upgrade_password_slot(password, key).map_err(AppError::from)? {
                self.write_file(&file)?;
            }
            Ok(())
        };
        if let Err(e) = upgrade() {
            eprintln!("failed to upgrade the vault parameters: {e}");
        }
    }

    pub fn lock(&self) {
        let mut slot = self.key.lock().unwrap();
        self.lock_count.fetch_add(1, Ordering::SeqCst);
        *slot = None;
    }

    // ---------- 开启、关闭、修改 ----------

    /// 写入新的保险库并读回核对，核对通过才算成功，否则删掉写入的文件
    pub fn create(&self, password: &str, recovery: bool, contents: Contents) -> AppResult<Option<Zeroizing<String>>> {
        check_new_password(password).map_err(AppError::from)?;
        let started = self.locks_so_far();
        let _gate = self.kdf_gate.lock().unwrap();
        let _lock = self.file_lock()?;
        if self.path.exists() {
            return Err(t("vault.alreadyOn").into());
        }
        let (file, key, text) = VaultFile::create(password, recovery, false, &contents).map_err(AppError::from)?;
        write_atomic(&self.path, &file.to_bytes().map_err(AppError::from)?)?;

        let verified = (|| -> AppResult<()> {
            let bytes = read_with_retry(&self.path)?.ok_or_else(|| t("vault.writtenMissing"))?;
            let reread = VaultFile::parse(&bytes).map_err(|e| AppError::from(e.text()))?;
            let key = reread.open_with_password(password).map_err(|e| AppError::from(e.text()))?;
            let back = reread.contents(&key).map_err(|e| AppError::from(e.text()))?;
            let same = back.secrets.len() == contents.secrets.len() && back.secrets.iter().all(|(id, s)| contents.secrets.get(id).is_some_and(|x| x.as_str() == s.as_str()));
            if same {
                Ok(())
            } else {
                Err(t("vault.verifyMismatch").into())
            }
        })();
        if let Err(e) = verified {
            let _ = fs::remove_file(&self.path);
            return Err(t("vault.verifyFailed").arg("detail", e.text()).into());
        }

        self.set_mode(Mode::of(&file));
        self.remember(key, &contents, started);
        Ok(text)
    }

    /// 换数据密钥和全部解锁方式。旧主密码、旧恢复密钥和旧文件都解不开之后的内容
    pub fn change_password(&self, current: &str, new: &str, recovery: bool) -> AppResult<Option<Zeroizing<String>>> {
        check_new_password(new).map_err(AppError::from)?;
        let started = self.locks_so_far();
        let _gate = self.kdf_gate.lock().unwrap();
        let _lock = self.file_lock()?;
        let mut file = self.read_file()?;
        let key = file.open_with_password(current).map_err(|e| locked_error(e, "vault.what.currentPassword"))?;
        let contents = file.contents(&key).map_err(|e| AppError::from(e.text()))?;
        self.rekey(&mut file, new, recovery, &contents, started)
    }

    /// 用恢复密钥解锁并设置新主密码。一次完成，不会停在“解锁了但密码还是旧的”
    pub fn recover(&self, recovery_key: &str, new: &str) -> AppResult<(Contents, Option<Zeroizing<String>>)> {
        check_new_password(new).map_err(AppError::from)?;
        let started = self.locks_so_far();
        let _gate = self.kdf_gate.lock().unwrap();
        let _lock = self.file_lock()?;
        let mut file = self.read_file()?;
        let key = file.open_with_recovery(recovery_key).map_err(|e| locked_error(e, "vault.what.recoveryKey"))?;
        let contents = file.contents(&key).map_err(|e| AppError::from(e.text()))?;
        let text = self.rekey(&mut file, new, true, &contents, started)?;
        Ok((contents, text))
    }

    fn rekey(&self, file: &mut VaultFile, new: &str, recovery: bool, contents: &Contents, started: u64) -> AppResult<Option<Zeroizing<String>>> {
        let (key, text) = file.rekey(new, recovery, contents).map_err(AppError::from)?;
        self.write_file(file)?;
        // 这期间锁定过的话旧密钥已经清掉了，新的也不留。新主密码已经生效，恢复密钥照常返回
        self.remember(key, contents, started);
        Ok(text)
    }

    /// 改“加密主机信息”的开关，同时修改内容
    pub fn set_encrypt_metadata(&self, on: bool, f: impl FnOnce(&mut Contents)) -> AppResult<()> {
        let key = self.current_key()?;
        let _lock = self.file_lock()?;
        let mut file = self.read_file()?;
        let mut contents = self.contents_with(&file, &key)?;
        f(&mut contents);
        file.set_encrypt_metadata(on, &key, &contents).map_err(AppError::from)?;
        self.write_file(&file)
    }

    pub fn check_password(&self, password: &str) -> AppResult<Contents> {
        let _gate = self.kdf_gate.lock().unwrap();
        let file = self.read_file()?;
        let key = file.open_with_password(password).map_err(|e| locked_error(e, "vault.what.password"))?;
        file.contents(&key).map_err(|e| AppError::from(e.text()))
    }

    /// 所有内容都已经搬走、核对过之后才调用
    pub fn remove_file(&self) -> AppResult<()> {
        let _lock = self.file_lock()?;
        fs::remove_file(&self.path)?;
        *self.key.lock().unwrap() = None;
        self.set_mode(Mode::Off);
        drop(_lock);
        let _ = fs::remove_file(&self.lock_path);
        Ok(())
    }

    /// 忘记主密码时的最后手段。文件移到带时间戳的备份，之后想起主密码还能用
    pub fn reset(&self) -> AppResult<PathBuf> {
        if let Mode::Broken { can_reset: false, message } = self.mode() {
            return Err(AppError::Message(message));
        }
        let _lock = self.file_lock()?;
        let backup = move_to_backup(&self.path)?;
        *self.key.lock().unwrap() = None;
        self.set_mode(Mode::Off);
        drop(_lock);
        let _ = fs::remove_file(&self.lock_path);
        Ok(backup)
    }

    // ---------- 自动锁定 ----------

    pub fn touch(&self) {
        *self.idle.last_activity.lock().unwrap() = Instant::now();
    }

    pub fn set_idle_minutes(&self, minutes: u32) -> AppResult<()> {
        if !IDLE_CHOICES.contains(&minutes) {
            return Err(t("vault.idleOutOfRange").into());
        }
        self.update(|c| c.idle_minutes = minutes)?;
        self.idle.minutes.store(u64::from(minutes), Ordering::Relaxed);
        self.touch();
        Ok(())
    }

    fn idle_limit(&self) -> Option<Duration> {
        // 调试版可以用秒代替分钟，测试不用真的等
        if cfg!(debug_assertions) {
            if let Some(seconds) = std::env::var("TERMIPAW_TEST_IDLE_SECONDS").ok().and_then(|s| s.parse().ok()) {
                return Some(Duration::from_secs(seconds));
            }
        }
        match self.idle.minutes.load(Ordering::Relaxed) {
            0 => None,
            minutes => Some(Duration::from_secs(minutes * 60)),
        }
    }

    /// 该不该因为空闲或睡眠而锁定。`now` 是墙上时间：`Instant` 在睡眠期间不一定走
    fn should_lock(&self, now: SystemTime, clock: Instant) -> bool {
        let previous = std::mem::replace(&mut *self.idle.last_check.lock().unwrap(), now);
        if !self.is_unlocked() {
            return false;
        }
        if now.duration_since(previous).is_ok_and(|gap| gap >= SLEEP_GAP) {
            return true;
        }
        self.idle_limit().is_some_and(|limit| clock.saturating_duration_since(*self.idle.last_activity.lock().unwrap()) >= limit)
    }
}

// ---------- 命令 ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableReport {
    /// 只显示这一次
    recovery_key: Option<String>,
    /// 标记了“已保存密码”但其实没有的主机名
    missing: Vec<String>,
    /// 还留着明文主机信息的旧备份
    old_backups: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRecoveryKey {
    recovery_key: Option<String>,
}

async fn blocking<T: Send + 'static>(app: AppHandle, f: impl FnOnce(&Store) -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(move || f(&app.state::<Store>())).await.map_err(|e| t("task.failed").detail(e))?
}

fn shown(text: Option<Zeroizing<String>>) -> Option<String> {
    text.map(|t| t.to_string())
}

#[tauri::command]
pub fn vault_status(store: State<'_, Store>) -> VaultStatus {
    store.vault.status()
}

#[tauri::command]
pub async fn vault_enable(app: AppHandle, password: String, recovery: bool, encrypt_metadata: bool) -> AppResult<EnableReport> {
    let password = Zeroizing::new(password);
    blocking(app, move |store| {
        let (key, missing) = store.enable_vault(&password, recovery, encrypt_metadata)?;
        Ok(EnableReport { recovery_key: shown(key), missing, old_backups: store.old_backups() })
    })
    .await
}

#[tauri::command]
pub async fn vault_unlock(app: AppHandle, password: String) -> AppResult<VaultStatus> {
    let password = Zeroizing::new(password);
    blocking(app, move |store| {
        let contents = store.vault.unlock(&password)?;
        store.after_unlock(contents);
        Ok(store.vault.status())
    })
    .await
}

#[tauri::command]
pub async fn vault_recover(app: AppHandle, recovery_key: String, new_password: String) -> AppResult<NewRecoveryKey> {
    let (recovery_key, new_password) = (Zeroizing::new(recovery_key), Zeroizing::new(new_password));
    blocking(app, move |store| {
        let (contents, key) = store.vault.recover(&recovery_key, &new_password)?;
        store.after_unlock(contents);
        Ok(NewRecoveryKey { recovery_key: shown(key) })
    })
    .await
}

#[tauri::command]
pub async fn vault_change_password(app: AppHandle, current: String, new_password: String, recovery: bool) -> AppResult<NewRecoveryKey> {
    let (current, new_password) = (Zeroizing::new(current), Zeroizing::new(new_password));
    blocking(app, move |store| Ok(NewRecoveryKey { recovery_key: shown(store.vault.change_password(&current, &new_password, recovery)?) })).await
}

#[tauri::command]
pub async fn vault_disable(app: AppHandle, password: String) -> AppResult<()> {
    let password = Zeroizing::new(password);
    blocking(app, move |store| store.disable_vault(&password)).await
}

#[tauri::command]
pub fn vault_lock(store: State<'_, Store>) -> VaultStatus {
    store.lock_vault();
    store.vault.status()
}

/// 用户有操作。界面限制了调用频率
#[tauri::command]
pub fn vault_touch(store: State<'_, Store>) {
    store.vault.touch();
}

#[tauri::command]
pub fn vault_set_idle(store: State<'_, Store>, minutes: u32) -> AppResult<VaultStatus> {
    store.vault.set_idle_minutes(minutes)?;
    Ok(store.vault.status())
}

#[tauri::command]
pub fn vault_set_encrypt_metadata(store: State<'_, Store>, on: bool) -> AppResult<Vec<String>> {
    store.set_encrypt_metadata(on)?;
    Ok(if on { store.old_backups() } else { Vec::new() })
}

/// 删除旧备份。要删哪些由后端决定，界面不能指定路径
#[tauri::command]
pub fn vault_delete_old_backups(store: State<'_, Store>) -> AppResult<()> {
    store.delete_old_backups()
}

/// 放弃保险库里的内容。`confirm` 是用户输入的确认文字
#[tauri::command]
pub fn vault_reset(store: State<'_, Store>, confirm: String) -> AppResult<String> {
    // 确认词按当前语言由后端决定，界面传来什么都不能替用户跳过
    let word = i18n::reset_word();
    if confirm != word {
        return Err(t("vault.resetConfirm").arg("word", word).into());
    }
    Ok(store.reset_vault()?.to_string_lossy().into_owned())
}

/// 锁定并通知界面。系统事件和空闲检查都走这里
pub fn lock_and_notify(app: &AppHandle) {
    let store = app.state::<Store>();
    if store.vault.is_unlocked() {
        store.lock_vault();
        let _ = app.emit("vault-locked", ());
    }
}

/// 定时检查空闲和睡眠
pub fn start_idle_timer(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 调试版测试用秒计时，检查也要跟上
        let interval = if cfg!(debug_assertions) && std::env::var_os("TERMIPAW_TEST_IDLE_SECONDS").is_some() { Duration::from_millis(500) } else { IDLE_CHECK_INTERVAL };
        loop {
            tokio::time::sleep(interval).await;
            if app.state::<Store>().vault.should_lock(SystemTime::now(), Instant::now()) {
                lock_and_notify(&app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::ConnectTarget;
    use crate::store::{AuthMethod, Host, KeyCheck};
    use russh::keys::{self, PublicKey};

    const PASSWORD: &str = "correct horse battery";

    struct Env {
        dir: PathBuf,
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    impl Env {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("termipaw-vault-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }

        /// 打开一次相当于启动一次程序
        fn open(&self) -> Store {
            Store::new(self.dir.clone(), None)
        }

        fn file(&self, name: &str) -> PathBuf {
            self.dir.join(name)
        }

        fn raw(&self, name: &str) -> String {
            fs::read_to_string(self.file(name)).unwrap()
        }
    }

    fn host(id: &str, save_secret: bool) -> Host {
        Host {
            id: id.into(),
            name: format!("name-{id}"),
            group: String::new(),
            host: format!("{id}.secret-host.example"),
            port: 22,
            username: "u".into(),
            auth: AuthMethod::Password,
            key_path: None,
            save_secret,
            last_connected: None,
            encoding: None,
        }
    }

    /// 没开保险库，两台主机。a 的记录里写着“已保存密码”，这种标记只可能是从旧版本带来的：其实没有
    fn seeded(env: &Env) -> Store {
        let store = env.open();
        store.save_hosts_for_test(vec![host("a", true), host("b", false)]);
        store
    }

    /// 开着保险库的两台主机：a 保存了密码 secret-a，b 没有。返回恢复密钥
    fn with_vault_keys(env: &Env, recovery: bool, encrypt_metadata: bool) -> (Store, Option<Zeroizing<String>>) {
        let store = env.open();
        store.save_hosts_for_test(vec![host("a", false), host("b", false)]);
        let (recovery_key, _) = store.enable_vault(PASSWORD, recovery, encrypt_metadata).map_err(|e| e.to_string()).unwrap();
        store.save_hosts_for_test(vec![host("a", true), host("b", false)]);
        store.vault.secret_set("a", "secret-a").map_err(|e| e.to_string()).unwrap();
        (store, recovery_key)
    }

    fn with_vault(env: &Env) -> Store {
        with_vault_keys(env, false, false).0
    }

    fn random_key() -> PublicKey {
        keys::PrivateKey::random(&mut rand::rng(), keys::Algorithm::Ed25519).unwrap().public_key().clone()
    }

    fn secret(store: &Store, id: &str, saved: bool) -> AppResult<Option<String>> {
        store.vault.secret_get(id, saved).map(|s| s.map(|s| s.to_string()))
    }

    fn is_locked_error<T>(r: AppResult<T>) -> bool {
        matches!(r, Err(AppError::VaultLocked { .. }))
    }

    fn unlock(store: &Store, password: &str) {
        let contents = store.vault.unlock(password).map_err(|e| e.to_string()).unwrap();
        store.after_unlock(contents);
    }

    // ---------- 保存的密码只给它所属的主机 ----------

    fn target_of(h: &Host) -> ConnectTarget {
        ConnectTarget { host_id: Some(h.id.clone()), host: h.host.clone(), port: h.port, username: h.username.clone(), auth: h.auth, key_path: h.key_path.clone() }
    }

    fn check_binding(store: &Store) {
        let saved = |t: &ConnectTarget| store.saved_secret(t).map_err(|e| e.to_string()).unwrap().map(|s| s.to_string());
        let right = target_of(&host("a", true));
        assert_eq!(saved(&right).as_deref(), Some("secret-a"));
        for wrong in [
            ConnectTarget { host: "attacker.example".into(), ..target_of(&host("a", true)) },
            ConnectTarget { port: 2222, ..target_of(&host("a", true)) },
            ConnectTarget { username: "root".into(), ..target_of(&host("a", true)) },
            ConnectTarget { auth: AuthMethod::Key, ..target_of(&host("a", true)) },
            ConnectTarget { key_path: Some("C:/other".into()), ..target_of(&host("a", true)) },
            ConnectTarget { auth: AuthMethod::Agent, ..target_of(&host("a", true)) },
            ConnectTarget { host_id: Some("not-a-host".into()), ..target_of(&host("a", true)) },
            ConnectTarget { host_id: None, ..target_of(&host("a", true)) },
        ] {
            assert_eq!(saved(&wrong), None, "{wrong:?}");
        }
    }

    #[test]
    fn a_saved_secret_only_goes_to_the_host_it_belongs_to() {
        let env = Env::new();
        let store = with_vault(&env);
        check_binding(&store);
        // 对不上的目标不用解锁，直接不给
        store.lock_vault();
        let mut wrong = target_of(&host("a", true));
        wrong.host = "attacker.example".into();
        assert!(store.saved_secret(&wrong).map_err(|e| e.to_string()).unwrap().is_none());
        assert!(is_locked_error(store.saved_secret(&target_of(&host("a", true)))));
    }
    // ---------- 锁定和解锁的竞争 ----------

    /// 派生要半秒左右。这期间系统锁屏了，派生出来的密钥不能留下，否则电脑唤醒后就是解锁状态
    #[test]
    fn a_lock_during_key_derivation_wins() {
        let env = Env::new();
        let store = seeded(&env);
        store.enable_vault(PASSWORD, false, false).map_err(|e| e.to_string()).unwrap();
        store.lock_vault();
        let vault = &store.vault;

        let started = vault.locks_so_far();
        vault.lock();
        assert!(!vault.remember(Zeroizing::new([7; 32]), &Contents::new(), started));
        assert!(!vault.is_unlocked());

        // 没有锁定过时照常
        let started = vault.locks_so_far();
        assert!(vault.remember(Zeroizing::new([7; 32]), &Contents::new(), started));
        assert!(vault.is_unlocked());
    }

    #[test]
    fn host_information_is_not_restored_if_locked_again_meanwhile() {
        let env = Env::new();
        let (store, key) = encrypted(&env);
        let contents = store.vault.read().map_err(|e| e.to_string()).unwrap();
        store.lock_vault();
        store.after_unlock(contents);
        assert!(store.hosts_for_test().is_empty());
        assert!(matches!(store.known.check("seen.secret-host.example", 22, &key), KeyCheck::Locked));
    }

    // ---------- 默认行为 ----------

    #[test]
    fn without_a_vault_no_password_can_be_saved() {
        let env = Env::new();
        let store = seeded(&env);
        assert!(!store.vault.status().enabled);
        // 记录里写着已保存也没有：用户得手动输入
        assert_eq!(secret(&store, "a", true).unwrap(), None);
        assert!(store.vault.secret_set("b", "secret-b").map_err(|e| e.to_string()).unwrap_err().contains("vault.needed"));
        assert_eq!(secret(&store, "b", true).unwrap(), None);
        store.vault.secret_delete("b", true).unwrap();
        assert!(!env.file("vault.json").exists());
        // 界面看到的主机也不再显示“已保存”
        assert!(store.visible_hosts().iter().all(|h| !h.save_secret));
        assert!(store.hosts_for_test()[0].save_secret, "文件里的记录没有动");
    }

    #[test]
    fn saving_a_host_with_a_password_stores_it_in_the_vault_when_there_is_one() {
        let env = Env::new();
        let store = with_vault(&env);
        store.save_host_with_secret_for_test(host("b", true), Some("secret-b")).map_err(|e| e.to_string()).unwrap();
        assert!(store.hosts_for_test().iter().find(|h| h.id == "b").unwrap().save_secret);
        assert_eq!(secret(&store, "b", true).unwrap().as_deref(), Some("secret-b"));
        assert!(!env.raw("vault.json").contains("secret-b"));
        // 取消“保存”：密码也从保险库里删掉
        store.save_host_with_secret_for_test(host("b", false), None).map_err(|e| e.to_string()).unwrap();
        assert_eq!(secret(&store, "b", true).unwrap(), None);
    }

    #[test]
    fn saving_a_host_with_a_password_is_refused_without_a_vault_and_the_stale_flag_is_dropped() {
        let env = Env::new();
        let store = seeded(&env);
        let err = store.save_host_with_secret_for_test(host("c", true), Some("typed")).map_err(|e| e.to_string()).unwrap_err();
        assert!(err.contains("vault.needed"), "{err}");
        assert_eq!(store.hosts_for_test().len(), 2, "没存下");
        // 没有新密码时，只是主机本身，标记去掉
        store.save_host_for_test(host("c", true)).map_err(|e| e.to_string()).unwrap();
        assert!(!store.hosts_for_test().iter().find(|h| h.id == "c").unwrap().save_secret);
    }
    // ---------- 开启 ----------

    #[test]
    fn enabling_starts_empty_and_a_secret_saved_afterwards_stays_in_the_vault() {
        let env = Env::new();
        let store = seeded(&env);
        let (recovery, missing) = store.enable_vault(PASSWORD, true, false).map_err(|e| e.to_string()).unwrap();
        assert!(recovery.is_some());
        // a 的“已保存”标记是旧版本留下的，其实没有：去掉标记，告诉用户
        assert_eq!(missing, ["name-a"]);
        assert!(!store.hosts_for_test()[0].save_secret);
        assert_eq!(secret(&store, "a", false).unwrap(), None);

        store.save_hosts_for_test(vec![host("a", true), host("b", false)]);
        store.vault.secret_set("a", "secret-a").unwrap();
        assert_eq!(secret(&store, "a", true).unwrap().as_deref(), Some("secret-a"));
        assert!(!env.raw("vault.json").contains("secret-a"));

        // 重新启动：默认是锁定的
        let store = env.open();
        let status = store.vault.status();
        assert!(status.enabled && status.locked && status.has_recovery);
        assert!(is_locked_error(secret(&store, "a", true)));
        // 没保存过密码的主机不用解锁
        assert_eq!(secret(&store, "b", false).unwrap(), None);
        unlock(&store, PASSWORD);
        assert_eq!(secret(&store, "a", true).unwrap().as_deref(), Some("secret-a"));
    }
    #[test]
    fn a_short_master_password_is_refused() {
        let env = Env::new();
        let store = seeded(&env);
        assert!(store.enable_vault("short12", false, false).is_err());
        assert!(!env.file("vault.json").exists());
        assert!(store.hosts_for_test()[0].save_secret, "没开成，记录不动");
    }
    // ---------- 关闭 ----------

    #[test]
    fn disabling_deletes_the_saved_secrets_and_removes_the_vault() {
        let env = Env::new();
        let (store, _) = with_vault_keys(&env, false, true);
        assert!(store.disable_vault("not the password at all").is_err());
        assert!(env.file("vault.json").exists());
        assert_eq!(secret(&store, "a", true).unwrap().as_deref(), Some("secret-a"));

        store.disable_vault(PASSWORD).map_err(|e| e.to_string()).unwrap();
        assert!(!env.file("vault.json").exists());
        assert!(!store.vault.status().enabled);
        assert_eq!(store.hosts_for_test().len(), 2);
        assert_eq!(secret(&store, "a", true).unwrap(), None, "密码跟着保险库一起没了");
        assert!(store.visible_hosts().iter().all(|h| !h.save_secret));

        let store = env.open();
        assert_eq!(store.hosts_for_test().len(), 2, "明文文件写回去了");
        assert_eq!(secret(&store, "a", true).unwrap(), None);
        assert!(!env.raw("hosts.json").is_empty());
    }
    /// 主机信息写不回明文文件时，保险库和里面的内容都不能丢
    #[test]
    fn a_failure_writing_the_plain_files_keeps_the_vault() {
        let env = Env::new();
        let (store, _) = with_vault_keys(&env, false, true);
        // 同名的是目录，明文文件写不进去
        fs::create_dir_all(env.file("hosts.json")).unwrap();
        assert!(store.disable_vault(PASSWORD).is_err());
        assert!(env.file("vault.json").exists());
        assert!(store.vault.status().enabled);
        assert_eq!(secret(&store, "a", true).unwrap().as_deref(), Some("secret-a"));
    }
    // ---------- 修改主密码和恢复 ----------

    #[test]
    fn changing_the_password_invalidates_the_old_one_and_the_old_recovery_key() {
        let env = Env::new();
        let (store, old_recovery) = with_vault_keys(&env, true, false);
        let new_recovery = store.vault.change_password(PASSWORD, "another long master password", true).map_err(|e| e.to_string()).unwrap();
        assert!(store.vault.change_password("wrong wrong wrong", "yet another password", true).is_err());
        assert!(store.vault.is_unlocked());
        assert_eq!(secret(&store, "a", true).unwrap().as_deref(), Some("secret-a"));

        let store = env.open();
        assert!(store.vault.unlock(PASSWORD).is_err());
        assert!(store.vault.recover(&old_recovery.unwrap(), "password from an old key").is_err());
        assert!(store.vault.recover("not a key", "password from no key").is_err());
        let (_, again) = store.vault.recover(&new_recovery.unwrap(), "password from the recovery key").map_err(|e| e.to_string()).unwrap();
        assert!(again.is_some(), "恢复后要发新的恢复密钥");
        assert_eq!(secret(&store, "a", true).unwrap().as_deref(), Some("secret-a"));

        let store = env.open();
        unlock(&store, "password from the recovery key");
        assert_eq!(secret(&store, "a", true).unwrap().as_deref(), Some("secret-a"));
    }
    // ---------- 重置 ----------

    #[test]
    fn resetting_keeps_a_backup_and_forgets_the_saved_secrets() {
        let env = Env::new();
        with_vault(&env);
        let store = env.open();
        let backup = store.reset_vault().map_err(|e| e.to_string()).unwrap();
        assert!(backup.exists());
        assert!(!env.file("vault.json").exists());
        assert!(!store.vault.status().enabled);
        assert!(!store.hosts_for_test()[0].save_secret, "密码没了，不能还显示已保存");
        // 备份还能用
        let file = VaultFile::parse(&fs::read(&backup).unwrap()).unwrap();
        assert!(file.open_with_password(PASSWORD).is_ok());
    }
    // ---------- 文件有问题 ----------

    #[test]
    fn a_damaged_vault_file_is_never_treated_as_no_vault() {
        let env = Env::new();
        with_vault(&env);
        fs::write(env.file("vault.json"), "broken").unwrap();
        let store = env.open();
        let status = store.vault.status();
        assert!(status.enabled && status.locked && status.can_reset);
        assert!(status.problem.is_some());
        assert!(store.vault.unlock(PASSWORD).is_err());
        assert!(is_locked_error(store.vault.secret_set("a", "new")));
        assert_eq!(env.raw("vault.json"), "broken");
    }

    #[test]
    fn a_vault_from_a_newer_version_cannot_be_reset_away() {
        let env = Env::new();
        fs::write(env.file("vault.json"), br#"{"format":"termipaw-vault","version":99}"#).unwrap();
        let store = env.open();
        assert!(!store.vault.status().can_reset);
        assert!(store.reset_vault().is_err());
        assert!(env.file("vault.json").exists());
    }

    // ---------- 加密主机信息 ----------

    fn encrypted(env: &Env) -> (Store, PublicKey) {
        let store = seeded(env);
        let key = random_key();
        store.known.stage("seen.secret-host.example", 22, &key);
        store.known.trust_pending("seen.secret-host.example", 22).map_err(|e| e.to_string()).unwrap();
        store.server_temps("u", "seen.secret-host.example", 22).begin("/tmp/.termipaw-x.part");
        store.enable_vault(PASSWORD, false, true).map_err(|e| e.to_string()).unwrap();
        (store, key)
    }

    #[test]
    fn host_information_leaves_the_plain_files_and_nothing_readable_remains() {
        let env = Env::new();
        let (_store, _) = encrypted(&env);
        for name in ["hosts.json", "known_hosts.json", "upload_temp_files.json"] {
            assert!(!env.file(name).exists(), "{name}");
        }
        assert!(!env.raw("vault.json").contains("secret-host"));
    }

    /// 锁定时内存里是空的，这时保存不能把空列表写回去
    #[test]
    fn saving_is_refused_while_locked_and_cannot_overwrite_hosts() {
        let env = Env::new();
        let (store, _) = encrypted(&env);
        store.lock_vault();
        let before = env.raw("vault.json");
        assert!(store.hosts_for_test().is_empty());
        assert!(is_locked_error(store.save_host_for_test(host("c", false))));
        assert!(is_locked_error(store.delete_host_for_test("a")));
        assert!(store.update("a", |h| h.name = "changed".into()).is_ok());
        assert_eq!(env.raw("vault.json"), before, "文件一个字节都没变");
        assert!(!env.file("hosts.json").exists());

        unlock(&store, PASSWORD);
        let hosts = store.hosts_for_test();
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].name, "name-a");

        store.save_host_for_test(host("c", false)).map_err(|e| e.to_string()).unwrap();
        let store = env.open();
        assert!(is_locked_error(store.save_host_for_test(host("d", false))));
        unlock(&store, PASSWORD);
        assert_eq!(store.hosts_for_test().len(), 3);
    }

    /// 读不到记录时必须是“无法判断”，不能当作首次连接，否则“指纹已变化”的警告就失效了
    #[test]
    fn host_key_checks_never_say_unknown_while_locked() {
        let env = Env::new();
        let (store, key) = encrypted(&env);
        assert!(matches!(store.known.check("seen.secret-host.example", 22, &key), KeyCheck::Trusted));
        assert!(matches!(store.known.check("seen.secret-host.example", 22, &random_key()), KeyCheck::Changed));

        store.lock_vault();
        for k in [&key, &random_key()] {
            assert!(matches!(store.known.check("seen.secret-host.example", 22, k), KeyCheck::Locked));
            assert!(matches!(store.known.check("never-seen.example", 22, k), KeyCheck::Locked));
        }
        // 锁定时也不能信任新的指纹
        store.known.stage("never-seen.example", 22, &key);
        assert!(is_locked_error(store.known.trust_pending("never-seen.example", 22)));

        // 刚启动还没解锁时也一样
        let store = env.open();
        assert!(matches!(store.known.check("seen.secret-host.example", 22, &key), KeyCheck::Locked));
        unlock(&store, PASSWORD);
        assert!(matches!(store.known.check("seen.secret-host.example", 22, &key), KeyCheck::Trusted));
        assert!(matches!(store.known.check("seen.secret-host.example", 22, &random_key()), KeyCheck::Changed));
        assert!(matches!(store.known.check("never-seen.example", 22, &key), KeyCheck::Unknown));
    }

    #[test]
    fn upload_records_wait_in_memory_while_locked() {
        let env = Env::new();
        let (store, _) = encrypted(&env);
        let temps = store.server_temps("u", "seen.secret-host.example", 22);
        store.lock_vault();
        let before = env.raw("vault.json");
        temps.begin("/tmp/.termipaw-locked.part");
        temps.finish("/tmp/.termipaw-locked.part", false);
        assert_eq!(env.raw("vault.json"), before);

        unlock(&store, PASSWORD);
        let saved = store.vault.read().map_err(|e| e.to_string()).unwrap().upload_temps.unwrap();
        assert!(saved["u@seen.secret-host.example:22"].contains("/tmp/.termipaw-locked.part"));
        assert!(saved["u@seen.secret-host.example:22"].contains("/tmp/.termipaw-x.part"));

        let store = env.open();
        unlock(&store, PASSWORD);
        assert_eq!(store.server_temps("u", "seen.secret-host.example", 22).leftovers().len(), 2);
    }

    /// 删除明文文件之前中断：解锁后以保险库为准，清掉残留
    #[test]
    fn leftover_plain_files_are_removed_after_unlocking() {
        let env = Env::new();
        let (store, _) = encrypted(&env);
        drop(store);
        fs::write(env.file("hosts.json"), serde_json::to_vec(&[host("stale", false)]).unwrap()).unwrap();
        let store = env.open();
        assert!(store.hosts_for_test().is_empty(), "锁定时不读明文文件");
        unlock(&store, PASSWORD);
        assert!(!env.file("hosts.json").exists());
        assert!(store.hosts_for_test().iter().all(|h| h.id != "stale"));
    }

    #[test]
    fn host_information_can_be_turned_off_again() {
        let env = Env::new();
        let (store, key) = encrypted(&env);
        store.set_encrypt_metadata(false).map_err(|e| e.to_string()).unwrap();
        assert!(env.raw("hosts.json").contains("secret-host"));
        assert!(env.raw("known_hosts.json").contains("secret-host"));
        assert!(env.raw("upload_temp_files.json").contains("secret-host"));
        let c = store.vault.read().map_err(|e| e.to_string()).unwrap();
        assert!(c.hosts.is_none() && c.known_hosts.is_none() && c.upload_temps.is_none());

        // 锁定时不再影响主机信息
        store.lock_vault();
        assert_eq!(store.hosts_for_test().len(), 2);
        assert!(matches!(store.known.check("seen.secret-host.example", 22, &key), KeyCheck::Trusted));

        let store = env.open();
        assert_eq!(store.hosts_for_test().len(), 2);
    }

    /// 重置后指纹没了，都按首次连接确认。这种情况下“未知”是对的，界面会说明
    #[test]
    fn resetting_an_encrypted_vault_starts_from_empty_host_information() {
        let env = Env::new();
        let (store, key) = encrypted(&env);
        drop(store);
        let store = env.open();
        store.reset_vault().map_err(|e| e.to_string()).unwrap();
        assert!(store.hosts_for_test().is_empty());
        assert!(matches!(store.known.check("seen.secret-host.example", 22, &key), KeyCheck::Unknown));
        store.save_host_for_test(host("new", false)).map_err(|e| e.to_string()).unwrap();
        assert!(env.file("hosts.json").exists());
    }

    #[test]
    fn old_plaintext_backups_are_listed_and_only_those_are_deleted() {
        let env = Env::new();
        for name in ["hosts.json.bak-1", "known_hosts.json.bak-2-1", "upload_temp_files.json.bak-3", "vault.json.bak-4", "other.txt"] {
            fs::write(env.file(name), "x").unwrap();
        }
        let store = seeded(&env);
        store.enable_vault(PASSWORD, false, true).map_err(|e| e.to_string()).unwrap();
        let mut listed = store.old_backups();
        listed.sort();
        assert_eq!(listed, ["hosts.json.bak-1", "known_hosts.json.bak-2-1", "upload_temp_files.json.bak-3"]);
        assert!(env.file("hosts.json.bak-1").exists(), "不自动删除");
        store.delete_old_backups().map_err(|e| e.to_string()).unwrap();
        assert!(store.old_backups().is_empty());
        assert!(env.file("vault.json.bak-4").exists());
        assert!(env.file("other.txt").exists());
    }

    // ---------- 删除保存过密码的主机 ----------

    #[test]
    fn deleting_a_host_with_a_saved_secret_needs_an_unlocked_vault() {
        let env = Env::new();
        let store = with_vault(&env);
        store.lock_vault();
        assert!(is_locked_error(store.delete_host_for_test("a")));
        assert_eq!(store.hosts_for_test().len(), 2);
        store.delete_host_for_test("b").map_err(|e| e.to_string()).unwrap();
        assert_eq!(store.hosts_for_test().len(), 1);

        unlock(&store, PASSWORD);
        store.delete_host_for_test("a").map_err(|e| e.to_string()).unwrap();
        assert!(store.vault.read().map_err(|e| e.to_string()).unwrap().secrets.is_empty());
    }

    // ---------- 两个实例 ----------

    /// 总是基于文件里的最新内容修改，交替写入不丢内容
    #[test]
    fn two_instances_writing_in_turn_lose_nothing() {
        let env = Env::new();
        let store = with_vault(&env);
        let other = env.open();
        unlock(&other, PASSWORD);
        for i in 0..5 {
            store.vault.secret_set(&format!("first-{i}"), "x").unwrap();
            other.vault.secret_set(&format!("second-{i}"), "y").unwrap();
        }
        let c = store.vault.read().map_err(|e| e.to_string()).unwrap();
        assert_eq!(c.secrets.len(), 11);
    }

    /// 另一个实例换了数据密钥：这边不能写，转为锁定，文件不变
    #[test]
    fn after_another_instance_changes_the_key_this_one_locks_instead_of_writing() {
        let env = Env::new();
        let store = seeded(&env);
        store.enable_vault(PASSWORD, false, false).map_err(|e| e.to_string()).unwrap();
        let other = env.open();
        unlock(&other, PASSWORD);
        other.vault.change_password(PASSWORD, "another long master password", false).map_err(|e| e.to_string()).unwrap();
        let before = env.raw("vault.json");

        assert!(is_locked_error(store.vault.secret_set("a", "stale")));
        assert!(!store.vault.is_unlocked());
        assert_eq!(env.raw("vault.json"), before);
        assert!(store.vault.unlock(PASSWORD).is_err());
        unlock(&store, "another long master password");
    }

    #[test]
    fn concurrent_writers_in_threads_lose_nothing() {
        let env = Env::new();
        let store = with_vault(&env);
        let other = env.open();
        unlock(&other, PASSWORD);
        std::thread::scope(|scope| {
            for (name, s) in [("x", &store), ("y", &other)] {
                scope.spawn(move || {
                    for i in 0..10 {
                        s.vault.secret_set(&format!("{name}-{i}"), "v").unwrap();
                    }
                });
            }
        });
        assert_eq!(store.vault.read().map_err(|e| e.to_string()).unwrap().secrets.len(), 21);
    }

    // ---------- 自动锁定 ----------

    #[test]
    fn idle_minutes_survive_a_restart_and_only_the_offered_choices_are_accepted() {
        let env = Env::new();
        let store = seeded(&env);
        assert_eq!(store.vault.status().idle_minutes, 15);
        store.enable_vault(PASSWORD, false, false).map_err(|e| e.to_string()).unwrap();
        assert_eq!(store.vault.status().idle_minutes, 15, "默认 15 分钟");
        for bad in [1, 10, 90] {
            assert!(store.vault.set_idle_minutes(bad).is_err());
        }
        store.vault.set_idle_minutes(60).unwrap();
        let store = env.open();
        unlock(&store, PASSWORD);
        assert_eq!(store.vault.status().idle_minutes, 60);
    }

    #[test]
    fn it_locks_after_being_idle_or_after_the_computer_slept() {
        let env = Env::new();
        let store = seeded(&env);
        let now = SystemTime::now();
        let later = |minutes: u64| Instant::now() + Duration::from_secs(minutes * 60);
        assert!(!store.vault.should_lock(now, later(100)), "没开启时不锁定");
        store.enable_vault(PASSWORD, false, false).map_err(|e| e.to_string()).unwrap();
        let vault = &store.vault;

        vault.touch();
        assert!(!vault.should_lock(now, Instant::now()));
        // 时间够了才锁定
        assert!(!vault.should_lock(now, later(14)));
        assert!(vault.should_lock(now, later(15)));
        // 有操作就重新计时
        vault.touch();
        assert!(!vault.should_lock(now, Instant::now()));

        // “从不”不按空闲锁定，但电脑睡眠过还是要锁
        vault.set_idle_minutes(0).unwrap();
        assert!(!vault.should_lock(now, later(24 * 60)));
        assert!(vault.should_lock(now + SLEEP_GAP, Instant::now()));
        // 时钟往回调不算
        assert!(!vault.should_lock(now, Instant::now()));

        // 锁定之后不用再锁
        vault.lock();
        assert!(!vault.should_lock(now + SLEEP_GAP * 2, later(100)));
    }
}
