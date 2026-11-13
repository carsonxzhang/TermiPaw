use russh_sftp::client::error::Error as SftpError;
use serde::Serialize;

use crate::i18n::{t, Text};

/// 返回给前端的结构化错误。`kind` 决定前端如何处理（弹出指纹确认、要求输入密码等）。
/// 给用户看的文字都是 `Text`，由界面按当前语言翻译
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppError {
    Message(Text),
    /// 首次连接：需要用户确认主机指纹
    #[serde(rename_all = "camelCase")]
    UnknownHostKey {
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
    },
    /// 主机指纹与记录不一致：可能遭遇中间人攻击
    #[serde(rename_all = "camelCase")]
    HostKeyChanged {
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
    },
    /// 指纹记录不可用，无法判断服务器是否可信。`can_reset` 表示可以备份并重置记录
    #[serde(rename_all = "camelCase")]
    KnownHostsBlocked {
        #[serde(flatten)]
        text: Text,
        can_reset: bool,
    },
    /// 缺少密码 / 私钥口令
    SecretRequired(Text),
    AuthFailed(Text),
    /// 这件事要先解锁保险库
    VaultLocked(Text),
}

impl AppError {
    pub fn vault_locked() -> Self {
        Self::VaultLocked(t("vault.locked"))
    }

    /// 给用户看的那句话。指纹的两种情况由界面单独处理，这里给一句概括
    pub fn text(&self) -> Text {
        match self {
            Self::Message(text) | Self::KnownHostsBlocked { text, .. } | Self::SecretRequired(text) | Self::AuthFailed(text) | Self::VaultLocked(text) => text.clone(),
            Self::UnknownHostKey { fingerprint, .. } | Self::HostKeyChanged { fingerprint, .. } => t("hostKey.failed").arg("fingerprint", fingerprint.as_str()),
        }
    }

    /// 判断是哪一种错误时用代码，不看文字
    pub fn code(&self) -> &'static str {
        match self {
            Self::Message(text) | Self::KnownHostsBlocked { text, .. } | Self::SecretRequired(text) | Self::AuthFailed(text) | Self::VaultLocked(text) => text.code,
            Self::UnknownHostKey { .. } | Self::HostKeyChanged { .. } => "hostKey.failed",
        }
    }
}

impl From<Text> for AppError {
    fn from(text: Text) -> Self {
        Self::Message(text)
    }
}

/// 只用于日志和测试
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.text())
    }
}

/// 依赖库的错误说明原样显示（多为英文）
pub fn raw(e: impl std::fmt::Display) -> Text {
    t("raw").detail(e)
}

macro_rules! impl_from {
    ($($t:ty),* $(,)?) => {
        $(impl From<$t> for AppError {
            fn from(e: $t) -> Self {
                AppError::Message(raw(e))
            }
        })*
    };
}

/// SFTP 库的内部错误换成用户看得懂的说明。服务器返回的状态（如权限不足）原样保留
fn sftp_error_text(e: &SftpError) -> Text {
    match e {
        // 连接断开时，SFTP 库只知道自己的内部通道关闭了
        SftpError::UnexpectedBehavior(m)
            if m == "sender dropped" || m == "session closed" || m.starts_with("SendError") || m.starts_with("RecvError") =>
        {
            t("ssh.connectionLost")
        }
        SftpError::Timeout => t("sftp.timeout"),
        _ => raw(e),
    }
}

impl From<SftpError> for AppError {
    fn from(e: SftpError) -> Self {
        AppError::Message(sftp_error_text(&e))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        // 远程文件的读写错误是包在 io::Error 里的 SFTP 错误
        match e.get_ref().and_then(|inner| inner.downcast_ref::<SftpError>()) {
            Some(sftp) => AppError::Message(sftp_error_text(sftp)),
            None => AppError::Message(raw(e)),
        }
    }
}

impl_from!(
    russh::Error,
    russh::keys::Error,
    serde_json::Error,
    tauri::Error,
);

pub type AppResult<T> = Result<T, AppError>;
