//! 主密码保险库的文件格式和加解密。设计见 `docs/VAULT.md`。
//!
//! 主密码或恢复密钥派生出包装密钥，解开随机的数据密钥，内容只由数据密钥加密。
//! 这个模块只处理字节和格式，不碰界面，也不读写文件。

use std::collections::{BTreeMap, BTreeSet};

use argon2::{Algorithm, Argon2, Params, Version};
use base64ct::{Base64, Encoding};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use crate::{
    error::raw,
    i18n::{t, Text},
    store::Host,
};

const FORMAT: &str = "termipaw-vault";
const FORMAT_VERSION: u32 = 1;
const KDF_NAME: &str = "argon2id";
/// Argon2 的 0x13 版
const KDF_VERSION: u32 = 19;

const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;

/// 主密码至少多少个字符（规范化后的 Unicode 字符数）
pub const MIN_PASSWORD_CHARS: usize = 8;

/// 读取文件时允许的参数范围。太小说明不是本程序写的，太大会耗尽内存
const MIN_MEMORY_KIB: u32 = 64 * 1024;
const MAX_MEMORY_KIB: u32 = 1024 * 1024;
const MAX_ITERATIONS: u32 = 10;
const MAX_PARALLELISM: u32 = 4;

/// 数据密钥。离开作用域时清零
pub type DataKey = Zeroizing<[u8; KEY_LEN]>;

/// 文件读不了或解不开的原因
#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// 主密码或恢复密钥不对，或者文件被改动过。两者区分不了
    WrongSecret,
    /// 文件内容不符合格式，或者内容解不开
    Damaged(Text),
    /// 比这个程序新的版本写的
    TooNew,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.text())
    }
}

impl OpenError {
    /// 给用户看的说明
    pub fn text(&self) -> Text {
        match self {
            Self::WrongSecret => t("vault.wrongSecret").arg("what", t("vault.what.password")),
            Self::Damaged(why) => t("vault.damaged").arg("why", why.clone()),
            Self::TooNew => t("vault.tooNew"),
        }
    }
}

/// 单元测试要成百上千次派生，用低成本的参数。程序本身（包括调试版）永远用真实参数
fn weak_kdf_allowed() -> bool {
    cfg!(test)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kdf {
    name: String,
    version: u32,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
}

impl Kdf {
    /// 依据见 `docs/VAULT.md` 第 3 节的实测
    pub fn standard() -> Self {
        Self { name: KDF_NAME.into(), version: KDF_VERSION, memory_kib: 256 * 1024, iterations: 3, parallelism: 1 }
    }

    fn for_new_data() -> Self {
        if weak_kdf_allowed() {
            Self { memory_kib: 64, iterations: 1, ..Self::standard() }
        } else {
            Self::standard()
        }
    }

    /// 比 `other` 弱：解锁成功后要升级
    fn weaker_than(&self, other: &Self) -> bool {
        self.memory_kib < other.memory_kib || self.iterations < other.iterations
    }

    fn check(&self, min_memory_kib: u32) -> Result<(), OpenError> {
        let bad = |what: &'static str| Err(OpenError::Damaged(t("vault.why.kdfParam").arg("what", t(what))));
        if self.name != KDF_NAME || self.version != KDF_VERSION {
            return bad("vault.kdf.algorithm");
        }
        if self.memory_kib < min_memory_kib || self.memory_kib > MAX_MEMORY_KIB {
            return bad("vault.kdf.memory");
        }
        if self.iterations == 0 || self.iterations > MAX_ITERATIONS {
            return bad("vault.kdf.iterations");
        }
        if self.parallelism == 0 || self.parallelism > MAX_PARALLELISM {
            return bad("vault.kdf.parallelism");
        }
        Ok(())
    }

    fn derive(&self, secret: &[u8], salt: &[u8]) -> Result<DataKey, OpenError> {
        let params = Params::new(self.memory_kib, self.iterations, self.parallelism, Some(KEY_LEN)).map_err(|e| OpenError::Damaged(t("vault.why.kdfParam").arg("what", e.to_string())))?;
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(secret, salt, out.as_mut())
            .map_err(|e| OpenError::Damaged(t("vault.why.kdfFailed").detail(e)))?;
        Ok(out)
    }
}

/// 不去掉首尾空格。规范化是因为同样的文字在不同系统和输入法下字节可能不同，这一步是格式的一部分
fn normalize_password(password: &str) -> Zeroizing<String> {
    Zeroizing::new(password.nfc().collect())
}

/// 主密码是否够长。返回给用户看的说明
pub fn check_new_password(password: &str) -> Result<(), Text> {
    if normalize_password(password).chars().count() < MIN_PASSWORD_CHARS {
        return Err(t("vault.passwordTooShort").arg("min", MIN_PASSWORD_CHARS));
    }
    Ok(())
}

fn random<const N: usize>() -> Result<[u8; N], Text> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| t("vault.randomFailed").detail(e))?;
    Ok(buf)
}

pub fn new_data_key() -> Result<DataKey, Text> {
    Ok(Zeroizing::new(random::<KEY_LEN>()?))
}

// ---------- 恢复密钥 ----------

/// Crockford Base32：没有 I、L、O、U，读写时不容易看错
const RECOVERY_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_BYTES: usize = 16;
/// 128 位需要 26 个字符（前面补 2 个零位）
const RECOVERY_CHARS: usize = 26;

/// 新的恢复密钥。返回 `(原始字节, 显示给用户的文字)`
fn new_recovery_key() -> Result<(Zeroizing<[u8; RECOVERY_BYTES]>, Zeroizing<String>), Text> {
    let bytes = Zeroizing::new(random::<RECOVERY_BYTES>()?);
    let text = format_recovery_key(&bytes);
    Ok((bytes, text))
}

fn format_recovery_key(bytes: &[u8; RECOVERY_BYTES]) -> Zeroizing<String> {
    let value = Zeroizing::new(u128::from_be_bytes(*bytes));
    let mut text = Zeroizing::new(String::with_capacity(RECOVERY_CHARS + 6));
    for i in 0..RECOVERY_CHARS {
        if i > 0 && i % 4 == 2 {
            text.push('-');
        }
        // 第一个字符只有 3 位有效：128 = 3 + 25 * 5
        let shift = (RECOVERY_CHARS - 1 - i) * 5;
        text.push(RECOVERY_ALPHABET[((*value >> shift) & 31) as usize] as char);
    }
    text
}

/// 输入时不分大小写，忽略分隔符和空格，容忍 Crockford 规定的易混字符
fn parse_recovery_key(text: &str) -> Option<Zeroizing<[u8; RECOVERY_BYTES]>> {
    let mut value = Zeroizing::new(0u128);
    let mut count = 0;
    for c in text.chars() {
        if c == '-' || c.is_whitespace() {
            continue;
        }
        let c = match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            c => c,
        };
        let digit = RECOVERY_ALPHABET.iter().position(|&a| a as char == c)? as u128;
        count += 1;
        if count > RECOVERY_CHARS || (count == 1 && digit > 7) {
            return None;
        }
        *value = (*value << 5) | digit;
    }
    (count == RECOVERY_CHARS).then(|| Zeroizing::new(value.to_be_bytes()))
}

// ---------- 文件 ----------

mod base64_field {
    use super::*;
    use serde::{de::Error, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&Base64::encode_string(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        Base64::decode_vec(&text).map_err(D::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlotType {
    Password,
    Recovery,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Slot {
    #[serde(rename = "type")]
    kind: SlotType,
    kdf: Kdf,
    #[serde(with = "base64_field")]
    salt: Vec<u8>,
    #[serde(with = "base64_field")]
    nonce: Vec<u8>,
    #[serde(with = "base64_field")]
    wrapped_key: Vec<u8>,
}

/// 把长度也写进去，不同字段的内容不可能拼出同样的字节
fn push_field(out: &mut Vec<u8>, field: &[u8]) {
    out.extend_from_slice(&(field.len() as u64).to_be_bytes());
    out.extend_from_slice(field);
}

impl Slot {
    /// 附加认证数据。不靠重新序列化 JSON，改任何一项都会解密失败
    fn aad(kind: SlotType, kdf: &Kdf, salt: &[u8]) -> Vec<u8> {
        let mut aad = Vec::new();
        push_field(&mut aad, b"termipaw-vault-slot-v1");
        push_field(&mut aad, match kind {
            SlotType::Password => b"password",
            SlotType::Recovery => b"recovery",
        });
        push_field(&mut aad, kdf.name.as_bytes());
        for n in [kdf.version, kdf.memory_kib, kdf.iterations, kdf.parallelism] {
            push_field(&mut aad, &n.to_be_bytes());
        }
        push_field(&mut aad, salt);
        aad
    }

    fn seal(kind: SlotType, secret: &[u8], key: &DataKey) -> Result<Self, Text> {
        let kdf = Kdf::for_new_data();
        let salt = random::<SALT_LEN>()?;
        let nonce = random::<NONCE_LEN>()?;
        let wrapping = kdf.derive(secret, &salt).map_err(|e| e.text())?;
        let wrapped_key = encrypt(&wrapping, &nonce, key.as_slice(), &Self::aad(kind, &kdf, &salt))?;
        Ok(Self { kind, kdf, salt: salt.to_vec(), nonce: nonce.to_vec(), wrapped_key })
    }

    fn open(&self, secret: &[u8]) -> Result<DataKey, OpenError> {
        let wrapping = self.kdf.derive(secret, &self.salt)?;
        let aad = Self::aad(self.kind, &self.kdf, &self.salt);
        let plain = decrypt(&wrapping, &self.nonce, &self.wrapped_key, &aad).ok_or(OpenError::WrongSecret)?;
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        if plain.len() != KEY_LEN {
            return Err(OpenError::Damaged(t("vault.why.keyLength")));
        }
        key.copy_from_slice(&plain);
        Ok(key)
    }
}

fn encrypt(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], msg: &[u8], aad: &[u8]) -> Result<Vec<u8>, Text> {
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher.encrypt(&XNonce::from(*nonce), Payload { msg, aad }).map_err(|_| t("vault.encryptFailed"))
}

fn decrypt(key: &[u8; KEY_LEN], nonce: &[u8], ciphertext: &[u8], aad: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    let nonce: [u8; NONCE_LEN] = nonce.try_into().ok()?;
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher.decrypt(&XNonce::from(nonce), Payload { msg: ciphertext, aad }).ok().map(Zeroizing::new)
}

/// 保险库里的内容
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contents {
    /// 主机 id -> 密码或私钥口令
    pub secrets: BTreeMap<String, Zeroizing<String>>,
    /// 空闲多少分钟后自动锁定，0 表示从不。放在这里是为了不被界面以外的东西悄悄改掉
    #[serde(default = "default_idle_minutes")]
    pub idle_minutes: u32,
    /// 下面三项只在开启“加密主机信息”时有内容
    #[serde(default)]
    pub hosts: Option<Vec<Host>>,
    #[serde(default)]
    pub known_hosts: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub upload_temps: Option<BTreeMap<String, BTreeSet<String>>>,
}

fn default_idle_minutes() -> u32 {
    DEFAULT_IDLE_MINUTES
}

pub const DEFAULT_IDLE_MINUTES: u32 = 15;
pub const IDLE_CHOICES: [u32; 5] = [5, 15, 30, 60, 0];

impl Contents {
    pub fn new() -> Self {
        Self { idle_minutes: DEFAULT_IDLE_MINUTES, ..Self::default() }
    }
}

/// `vault.json` 的内容。没解开时只有这些可以看
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFile {
    format: String,
    version: u32,
    revision: u64,
    encrypt_metadata: bool,
    slots: Vec<Slot>,
    #[serde(with = "base64_field")]
    nonce: Vec<u8>,
    #[serde(with = "base64_field")]
    ciphertext: Vec<u8>,
}

fn data_aad(revision: u64, encrypt_metadata: bool) -> Vec<u8> {
    let mut aad = Vec::new();
    push_field(&mut aad, b"termipaw-vault-data-v1");
    push_field(&mut aad, &revision.to_be_bytes());
    push_field(&mut aad, &[u8::from(encrypt_metadata)]);
    aad
}

impl VaultFile {
    /// 新建。`recovery` 为真时同时生成恢复密钥，返回给用户的文字只有这一次
    pub fn create(password: &str, recovery: bool, encrypt_metadata: bool, contents: &Contents) -> Result<(Self, DataKey, Option<Zeroizing<String>>), Text> {
        let key = new_data_key()?;
        let (slots, text) = Self::new_slots(password, recovery, &key)?;
        let mut file = Self { format: FORMAT.into(), version: FORMAT_VERSION, revision: 0, encrypt_metadata, slots, nonce: Vec::new(), ciphertext: Vec::new() };
        file.seal(&key, contents)?;
        Ok((file, key, text))
    }

    fn new_slots(password: &str, recovery: bool, key: &DataKey) -> Result<(Vec<Slot>, Option<Zeroizing<String>>), Text> {
        let normalized = normalize_password(password);
        let mut slots = vec![Slot::seal(SlotType::Password, normalized.as_bytes(), key)?];
        let mut text = None;
        if recovery {
            let (bytes, shown) = new_recovery_key()?;
            slots.push(Slot::seal(SlotType::Recovery, bytes.as_slice(), key)?);
            text = Some(shown);
        }
        Ok((slots, text))
    }

    /// 换数据密钥和全部槽位，重新加密内容。旧主密码和旧恢复密钥都失效。返回新的数据密钥和恢复密钥
    pub fn rekey(&mut self, password: &str, recovery: bool, contents: &Contents) -> Result<(DataKey, Option<Zeroizing<String>>), Text> {
        let key = new_data_key()?;
        let (slots, text) = Self::new_slots(password, recovery, &key)?;
        self.slots = slots;
        self.seal(&key, contents)?;
        Ok((key, text))
    }

    /// 解析并检查文件。这一步不需要主密码
    pub fn parse(bytes: &[u8]) -> Result<Self, OpenError> {
        // 先看头部：新版本的文件结构可能不一样，不能报成损坏
        #[derive(Deserialize)]
        struct Head {
            format: String,
            version: u32,
        }
        let head: Head = serde_json::from_slice(bytes).map_err(|_| OpenError::Damaged(t("vault.why.unparsable")))?;
        if head.format != FORMAT {
            return Err(OpenError::Damaged(t("vault.why.notVault")));
        }
        if head.version > FORMAT_VERSION {
            return Err(OpenError::TooNew);
        }
        let file: Self = serde_json::from_slice(bytes).map_err(|_| OpenError::Damaged(t("vault.why.unparsable")))?;
        let min_memory = if weak_kdf_allowed() { 8 } else { MIN_MEMORY_KIB };
        file.check(min_memory)?;
        Ok(file)
    }

    fn check(&self, min_memory_kib: u32) -> Result<(), OpenError> {
        let count = |kind| self.slots.iter().filter(|s| s.kind == kind).count();
        if count(SlotType::Password) != 1 || count(SlotType::Recovery) > 1 {
            return Err(OpenError::Damaged(t("vault.why.badSlot")));
        }
        for slot in &self.slots {
            slot.kdf.check(min_memory_kib)?;
            if slot.salt.len() != SALT_LEN || slot.nonce.len() != NONCE_LEN || slot.wrapped_key.len() != KEY_LEN + TAG_LEN {
                return Err(OpenError::Damaged(t("vault.why.slotLength")));
            }
        }
        if self.nonce.len() != NONCE_LEN || self.ciphertext.len() < TAG_LEN {
            return Err(OpenError::Damaged(t("vault.why.contentLength")));
        }
        Ok(())
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, Text> {
        serde_json::to_vec_pretty(self).map_err(raw)
    }

    pub fn encrypt_metadata(&self) -> bool {
        self.encrypt_metadata
    }

    pub fn has_recovery(&self) -> bool {
        self.slots.iter().any(|s| s.kind == SlotType::Recovery)
    }

    fn slot(&self, kind: SlotType) -> Option<&Slot> {
        self.slots.iter().find(|s| s.kind == kind)
    }

    pub fn open_with_password(&self, password: &str) -> Result<DataKey, OpenError> {
        let slot = self.slot(SlotType::Password).ok_or(OpenError::WrongSecret)?;
        slot.open(normalize_password(password).as_bytes())
    }

    pub fn open_with_recovery(&self, text: &str) -> Result<DataKey, OpenError> {
        let slot = self.slot(SlotType::Recovery).ok_or(OpenError::WrongSecret)?;
        let bytes = parse_recovery_key(text).ok_or(OpenError::WrongSecret)?;
        slot.open(bytes.as_slice())
    }

    /// 主密码槽位的参数低于现在的默认值时重新包装。恢复密钥不在程序手里，那个槽位升级不了
    pub fn upgrade_password_slot(&mut self, password: &str, key: &DataKey) -> Result<bool, Text> {
        let Some(index) = self.slots.iter().position(|s| s.kind == SlotType::Password) else { return Ok(false) };
        if !self.slots[index].kdf.weaker_than(&Kdf::for_new_data()) {
            return Ok(false);
        }
        self.slots[index] = Slot::seal(SlotType::Password, normalize_password(password).as_bytes(), key)?;
        Ok(true)
    }

    pub fn contents(&self, key: &DataKey) -> Result<Contents, OpenError> {
        let aad = data_aad(self.revision, self.encrypt_metadata);
        let plain = decrypt(key, &self.nonce, &self.ciphertext, &aad).ok_or(OpenError::WrongSecret)?;
        serde_json::from_slice(&plain).map_err(|_| OpenError::Damaged(t("vault.why.unparsable")))
    }

    /// 写入新内容。每次都用新的 nonce，`revision` 加一
    pub fn seal(&mut self, key: &DataKey, contents: &Contents) -> Result<(), Text> {
        let plain = Zeroizing::new(serde_json::to_vec(contents).map_err(raw)?);
        let revision = self.revision + 1;
        let nonce = random::<NONCE_LEN>()?;
        self.ciphertext = encrypt(key, &nonce, &plain, &data_aad(revision, self.encrypt_metadata))?;
        self.nonce = nonce.to_vec();
        self.revision = revision;
        Ok(())
    }

    /// 改“加密主机信息”的开关。这个开关受认证保护，所以要同时重新加密内容
    pub fn set_encrypt_metadata(&mut self, on: bool, key: &DataKey, contents: &Contents) -> Result<(), Text> {
        self.encrypt_metadata = on;
        self.seal(key, contents)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::AuthMethod;
    use rand::RngExt;

    const PASSWORD: &str = "correct horse battery";
    /// 提交在仓库里的 v1 样本。里面没有真实数据，主密码和恢复密钥就写在这里
    const FIXTURE: &[u8] = include_bytes!("../../testing/vault_v1.json");
    const FIXTURE_PASSWORD: &str = "fixture password 主密码";
    const FIXTURE_RECOVERY: &str = "1J7G-WQ5T-M8KX-2BHP-9SDV-4EN3-RZ";

    fn sample() -> Contents {
        let mut c = Contents::new();
        c.secrets.insert("host-1".into(), Zeroizing::new("hunter2".into()));
        c
    }

    fn new_file(recovery: bool) -> (VaultFile, DataKey, Option<Zeroizing<String>>) {
        VaultFile::create(PASSWORD, recovery, false, &sample()).unwrap()
    }

    /// 生成格式样本。格式确定后只运行一次：`cargo test print_fixture -- --ignored --nocapture`
    #[test]
    #[ignore = "只在生成样本时运行"]
    fn print_fixture() {
        let mut c = Contents::new();
        c.secrets.insert("fixture-host".into(), Zeroizing::new("fixture secret 密码".into()));
        c.idle_minutes = 30;
        c.hosts = Some(vec![Host {
            id: "fixture-host".into(),
            name: "样本".into(),
            group: "组".into(),
            host: "example.com".into(),
            port: 2222,
            username: "demo".into(),
            auth: AuthMethod::Password,
            key_path: None,
            save_secret: true,
            last_connected: Some(1),
            encoding: Some("gb18030".into()),
        }]);
        c.known_hosts = Some(BTreeMap::from([("example.com:2222".to_string(), "ssh-ed25519 AAAA".to_string())]));
        c.upload_temps = Some(BTreeMap::from([("demo@example.com:2222".to_string(), BTreeSet::from(["/tmp/.termipaw-x.part".to_string()]))]));

        let key = new_data_key().unwrap();
        let bytes = parse_recovery_key(FIXTURE_RECOVERY).unwrap();
        let kdf_slot = |kind, secret: &[u8]| {
            let kdf = Kdf::standard();
            let salt = random::<SALT_LEN>().unwrap();
            let nonce = random::<NONCE_LEN>().unwrap();
            let wrapping = kdf.derive(secret, &salt).unwrap();
            let wrapped_key = encrypt(&wrapping, &nonce, key.as_slice(), &Slot::aad(kind, &kdf, &salt)).unwrap();
            Slot { kind, kdf, salt: salt.to_vec(), nonce: nonce.to_vec(), wrapped_key }
        };
        let slots = vec![kdf_slot(SlotType::Password, normalize_password(FIXTURE_PASSWORD).as_bytes()), kdf_slot(SlotType::Recovery, bytes.as_slice())];
        let mut file = VaultFile { format: FORMAT.into(), version: FORMAT_VERSION, revision: 16, encrypt_metadata: true, slots, nonce: Vec::new(), ciphertext: Vec::new() };
        file.seal(&key, &c).unwrap();
        println!("{}", String::from_utf8(file.to_bytes().unwrap()).unwrap());
    }

    /// 这个样本永远要能解开。失败说明格式被无意改动了：不要改样本，要改代码
    #[test]
    fn the_committed_v1_sample_can_always_be_opened() {
        let file = VaultFile::parse(FIXTURE).unwrap();
        assert_eq!(file.revision, 17);
        assert!(file.encrypt_metadata());
        assert!(file.has_recovery());
        for slot in &file.slots {
            assert_eq!(slot.kdf, Kdf::standard());
        }
        // 真实参数也必须满足 release 版的范围
        file.check(MIN_MEMORY_KIB).unwrap();

        let key = file.open_with_password(FIXTURE_PASSWORD).unwrap();
        assert_eq!(file.open_with_recovery(FIXTURE_RECOVERY).unwrap(), key);
        let c = file.contents(&key).unwrap();
        assert_eq!(c.secrets["fixture-host"].as_str(), "fixture secret 密码");
        // 样本里还带着旧版本的 keyringCleanup 字段，读取时忽略它，不影响其余内容
        assert_eq!(c.idle_minutes, 30);
        let hosts = c.hosts.unwrap();
        assert_eq!((hosts[0].host.as_str(), hosts[0].port, hosts[0].auth), ("example.com", 2222, AuthMethod::Password));
        assert_eq!(c.known_hosts.unwrap()["example.com:2222"], "ssh-ed25519 AAAA");
        assert!(c.upload_temps.unwrap()["demo@example.com:2222"].contains("/tmp/.termipaw-x.part"));
    }

    #[test]
    fn the_right_password_opens_it_and_the_wrong_one_does_not() {
        let (file, key, _) = new_file(false);
        let reread = VaultFile::parse(&file.to_bytes().unwrap()).unwrap();
        assert_eq!(reread.open_with_password(PASSWORD).unwrap(), key);
        assert_eq!(reread.contents(&key).unwrap().secrets["host-1"].as_str(), "hunter2");
        assert_eq!(reread.open_with_password("correct horse battery ").unwrap_err(), OpenError::WrongSecret);
        assert_eq!(reread.open_with_password("").unwrap_err(), OpenError::WrongSecret);
    }

    #[test]
    fn nfc_and_nfd_forms_of_a_password_are_the_same() {
        let nfc = "caf\u{e9} au lait pass";
        let nfd = "cafe\u{301} au lait pass";
        assert_ne!(nfc.as_bytes(), nfd.as_bytes());
        let (file, key, _) = VaultFile::create(nfc, false, false, &sample()).unwrap();
        assert_eq!(file.open_with_password(nfd).unwrap(), key);
    }

    #[test]
    fn password_rules_count_characters_not_bytes() {
        assert!(check_new_password("short").is_err());
        assert!(check_new_password("1234567").is_err());
        assert!(check_new_password("12345678").is_ok());
        assert!(check_new_password("这是一个足够长的中文主密码").is_ok());
        assert!(check_new_password("八个汉字的主密码").is_ok());
        assert!(check_new_password("中文太短了").is_err());
        // 组合字符规范化后算一个字符
        assert!(check_new_password(&"e\u{301}".repeat(7)).is_err());
    }

    #[test]
    fn a_recovery_key_opens_it_and_tolerates_how_it_is_typed() {
        let (file, key, text) = new_file(true);
        let text = text.unwrap();
        assert_eq!(text.chars().filter(|c| *c != '-').count(), RECOVERY_CHARS);
        assert_eq!(file.open_with_recovery(&text).unwrap(), key);
        assert_eq!(file.open_with_recovery(&text.to_lowercase()).unwrap(), key);
        assert_eq!(file.open_with_recovery(&format!("  {} ", text.replace('-', " "))).unwrap(), key);
        // 恢复密钥不能当主密码用，反过来也不行
        assert_eq!(file.open_with_password(&text).unwrap_err(), OpenError::WrongSecret);
        assert_eq!(file.open_with_recovery(PASSWORD).unwrap_err(), OpenError::WrongSecret);
    }

    #[test]
    fn without_a_recovery_slot_no_recovery_key_works() {
        let (file, _, text) = new_file(false);
        assert!(text.is_none());
        assert!(!file.has_recovery());
        assert_eq!(file.open_with_recovery("00000000000000000000000000").unwrap_err(), OpenError::WrongSecret);
    }

    #[test]
    fn recovery_key_encoding_round_trips_every_kind_of_value() {
        for bytes in [[0u8; 16], [0xff; 16], [0x80; 16], [1; 16]] {
            let text = format_recovery_key(&bytes);
            assert_eq!(*parse_recovery_key(&text).unwrap(), bytes, "{}", text.as_str());
        }
        let mut rng = rand::rng();
        for _ in 0..2000 {
            let bytes: [u8; 16] = rng.random();
            assert_eq!(*parse_recovery_key(&format_recovery_key(&bytes)).unwrap(), bytes);
        }
        // 易混字符
        assert_eq!(parse_recovery_key("OIL00000000000000000000000"), parse_recovery_key("01100000000000000000000000"));
        // 长度、字符和溢出
        for bad in ["", "0", &"0".repeat(25), &"0".repeat(27), &format!("U{}", "0".repeat(25)), &format!("8{}", "0".repeat(25)), &format!("Z{}", "0".repeat(25)), "中文中文中文中文中文中文中文中文中文中文中文中文中文"] {
            assert!(parse_recovery_key(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn every_write_uses_a_new_nonce_and_a_higher_revision() {
        let (mut file, key, _) = new_file(false);
        let before = (file.revision, file.nonce.clone(), file.ciphertext.clone());
        file.seal(&key, &sample()).unwrap();
        assert_eq!(file.revision, before.0 + 1);
        assert_ne!(file.nonce, before.1);
        assert_ne!(file.ciphertext, before.2);
        assert_eq!(file.contents(&key).unwrap().secrets["host-1"].as_str(), "hunter2");
    }

    #[test]
    fn rekeying_makes_the_old_password_key_and_recovery_key_useless() {
        let (mut file, old_key, old_recovery) = new_file(true);
        let old_file = file.clone();
        let (new_key, new_recovery) = file.rekey("a brand new master password", true, &sample()).unwrap();
        assert_ne!(new_key, old_key);
        assert_eq!(file.open_with_password(PASSWORD).unwrap_err(), OpenError::WrongSecret);
        assert_eq!(file.open_with_recovery(&old_recovery.unwrap()).unwrap_err(), OpenError::WrongSecret);
        assert_eq!(file.open_with_password("a brand new master password").unwrap(), new_key);
        assert_eq!(file.open_with_recovery(&new_recovery.unwrap()).unwrap(), new_key);
        assert_eq!(file.contents(&old_key).err(), Some(OpenError::WrongSecret));
        // 留着旧文件和旧密钥也解不开新内容
        assert!(old_file.open_with_password(PASSWORD).is_ok());
        assert_eq!(file.contents(&old_file.open_with_password(PASSWORD).unwrap()).err(), Some(OpenError::WrongSecret));
    }

    #[test]
    fn weak_slots_are_upgraded_and_good_ones_are_left_alone() {
        let (mut file, key, _) = new_file(false);
        assert!(!file.upgrade_password_slot(PASSWORD, &key).unwrap());
        file.slots[0] = {
            let kdf = Kdf { memory_kib: 16, ..Kdf::for_new_data() };
            let salt = random::<SALT_LEN>().unwrap();
            let nonce = random::<NONCE_LEN>().unwrap();
            let wrapping = kdf.derive(normalize_password(PASSWORD).as_bytes(), &salt).unwrap();
            let wrapped_key = encrypt(&wrapping, &nonce, key.as_slice(), &Slot::aad(SlotType::Password, &kdf, &salt)).unwrap();
            Slot { kind: SlotType::Password, kdf, salt: salt.to_vec(), nonce: nonce.to_vec(), wrapped_key }
        };
        assert_eq!(file.open_with_password(PASSWORD).unwrap(), key);
        assert!(file.upgrade_password_slot(PASSWORD, &key).unwrap());
        assert_eq!(file.slots[0].kdf, Kdf::for_new_data());
        assert_eq!(file.open_with_password(PASSWORD).unwrap(), key);
    }

    /// release 版的范围。调试版放宽的只有下限，上限不变
    #[test]
    fn kdf_limits_refuse_weak_and_oversized_parameters() {
        let ok = Kdf::standard();
        ok.check(MIN_MEMORY_KIB).unwrap();
        for bad in [
            Kdf { memory_kib: MIN_MEMORY_KIB - 1, ..ok.clone() },
            Kdf { memory_kib: MAX_MEMORY_KIB + 1, ..ok.clone() },
            Kdf { memory_kib: u32::MAX, ..ok.clone() },
            Kdf { iterations: 0, ..ok.clone() },
            Kdf { iterations: MAX_ITERATIONS + 1, ..ok.clone() },
            Kdf { parallelism: 0, ..ok.clone() },
            Kdf { parallelism: MAX_PARALLELISM + 1, ..ok.clone() },
            Kdf { name: "argon2i".into(), ..ok.clone() },
            Kdf { version: 16, ..ok.clone() },
        ] {
            assert!(matches!(bad.check(MIN_MEMORY_KIB), Err(OpenError::Damaged(_))), "{bad:?}");
        }
    }

    /// 改了任何一项都只能报错，不能解出错误的内容
    #[test]
    fn tampering_with_any_authenticated_field_is_detected() {
        let (file, key, recovery) = new_file(true);
        let recovery = recovery.unwrap();
        let attempt = |f: &VaultFile| -> Result<(), OpenError> {
            let k1 = f.open_with_password(PASSWORD)?;
            let k2 = f.open_with_recovery(&recovery)?;
            assert_eq!(k1, key);
            assert_eq!(k2, key);
            f.contents(&k1).map(|_| ())
        };
        attempt(&file).unwrap();

        let flip = |bytes: &mut Vec<u8>, i: usize| bytes[i] ^= 1;
        type Tamper = Box<dyn Fn(&mut VaultFile)>;
        let mut cases: Vec<Tamper> = vec![
            Box::new(|f| f.revision += 1),
            Box::new(|f| f.encrypt_metadata = !f.encrypt_metadata),
            Box::new(|f| f.slots[0].kdf.iterations += 1),
            Box::new(|f| f.slots[0].kdf.memory_kib += 8),
            Box::new(|f| f.slots[1].kdf.iterations += 1),
            // 互换两个槽位的类型：主密码不能解开恢复密钥的槽位
            Box::new(|f| {
                f.slots[0].kind = SlotType::Recovery;
                f.slots[1].kind = SlotType::Password;
            }),
        ];
        for slot in 0..2 {
            cases.push(Box::new(move |f| flip(&mut f.slots[slot].salt, 3)));
            cases.push(Box::new(move |f| flip(&mut f.slots[slot].nonce, 3)));
            cases.push(Box::new(move |f| flip(&mut f.slots[slot].wrapped_key, 3)));
        }
        cases.push(Box::new(move |f| flip(&mut f.nonce, 3)));
        cases.push(Box::new(move |f| flip(&mut f.ciphertext, 3)));

        for (i, case) in cases.iter().enumerate() {
            let mut bad = file.clone();
            case(&mut bad);
            assert_eq!(attempt(&bad).unwrap_err(), OpenError::WrongSecret, "第 {i} 项");
        }
    }

    /// 逐字节改文件：可以解析失败，也可以解锁失败，就是不能崩溃或者解出别的内容
    #[test]
    fn corrupting_any_byte_never_yields_wrong_contents() {
        let (file, key, _) = new_file(false);
        let bytes = file.to_bytes().unwrap();
        let mut rng = rand::rng();
        for i in 0..bytes.len() {
            let mut bad = bytes.clone();
            bad[i] ^= 1 << rng.random_range(0..8);
            let Ok(parsed) = VaultFile::parse(&bad) else { continue };
            // 同一个字段的 JSON 空白或大小写可能改了也不影响含义，只要内容还是对的就行
            if let Ok(k) = parsed.open_with_password(PASSWORD) {
                assert_eq!(k, key);
                if let Ok(c) = parsed.contents(&k) {
                    assert_eq!(c.secrets["host-1"].as_str(), "hunter2");
                }
            }
        }
    }

    #[test]
    fn random_garbage_is_refused_without_a_panic() {
        let mut rng = rand::rng();
        for _ in 0..3000 {
            let len = rng.random_range(0..600);
            let bytes: Vec<u8> = (0..len).map(|_| rng.random()).collect();
            assert!(VaultFile::parse(&bytes).is_err());
        }
        for bad in [
            &b"{}"[..],
            b"[]",
            b"null",
            br#"{"format":"other","version":1}"#,
            br#"{"format":"termipaw-vault"}"#,
            br#"{"format":"termipaw-vault","version":1}"#,
            br#"{"format":"termipaw-vault","version":1,"revision":1,"encryptMetadata":false,"slots":[],"nonce":"","ciphertext":""}"#,
        ] {
            assert!(matches!(VaultFile::parse(bad), Err(OpenError::Damaged(_))), "{}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn a_file_from_a_newer_version_is_refused_but_not_called_damaged() {
        assert_eq!(VaultFile::parse(br#"{"format":"termipaw-vault","version":2,"whatever":true}"#).unwrap_err(), OpenError::TooNew);
    }

    #[test]
    fn slot_counts_and_lengths_are_checked() {
        let (file, _, _) = new_file(true);
        let reparse = |f: &VaultFile| VaultFile::parse(&f.to_bytes().unwrap()).err();

        let mut none = file.clone();
        none.slots.retain(|s| s.kind != SlotType::Password);
        assert!(matches!(reparse(&none), Some(OpenError::Damaged(_))));

        let mut two = file.clone();
        two.slots.push(two.slots[0].clone());
        assert!(matches!(reparse(&two), Some(OpenError::Damaged(_))));

        let mut short_salt = file.clone();
        short_salt.slots[0].salt.pop();
        assert!(matches!(reparse(&short_salt), Some(OpenError::Damaged(_))));

        let mut short_text = file.clone();
        short_text.ciphertext.truncate(TAG_LEN - 1);
        assert!(matches!(reparse(&short_text), Some(OpenError::Damaged(_))));
    }

    /// 文件里不能有明文
    #[test]
    fn secrets_never_appear_in_the_file() {
        let (file, _, recovery) = new_file(true);
        let text = String::from_utf8(file.to_bytes().unwrap()).unwrap();
        assert!(!text.contains("hunter2"));
        assert!(!text.contains("host-1"));
        assert!(!text.contains(PASSWORD));
        assert!(!text.contains(recovery.unwrap().as_str()));
    }
}
