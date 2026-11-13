//! 主密码保险库，设计见 `docs/VAULT.md`。
//!
//! - `format`：文件格式、密钥派生和加解密。不接触界面和系统
//! - `state`：运行状态、给界面的命令、自动锁定

mod format;
// 命令要在 lib.rs 里按路径登记
pub mod state;

pub use format::Contents;
pub use state::Vault;
