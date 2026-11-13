//! 绿色版：所有数据都放在程序旁边的 `TermiPaw_Data\` 里，不写 `%APPDATA%`、`%LOCALAPPDATA%` 和系统临时目录。
//! 设计见 docs/PORTABLE.md。

use std::{
    fs,
    path::{Path, PathBuf},
};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::i18n;

pub struct Paths {
    /// 主机、指纹、保险库等文件，也是编辑用的临时目录（`editing\`）所在的位置
    pub data: PathBuf,
    /// WebView2 的用户数据目录。界面里的设置（语言、主题等）也存在这里
    pub webview: PathBuf,
    /// 用户自己的 OpenSSH `known_hosts`，只读
    pub openssh_known_hosts: Option<PathBuf>,
}

/// 数据目录用不了，给用户看的说明
pub struct Problem {
    pub dir: PathBuf,
    pub reason: String,
}

/// 数据目录的名字带上程序名：exe 常放在桌面或“下载”里，一个叫 `data` 的文件夹看不出是谁的，容易被当成垃圾删掉
pub const DATA_DIR_NAME: &str = "TermiPaw_Data";

/// 程序旁边的数据目录
pub fn data_dir_beside(exe: &Path) -> PathBuf {
    exe.parent().unwrap_or_else(|| Path::new(".")).join(DATA_DIR_NAME)
}

/// 确认能在这个目录里写文件。写不进去时要明确告诉用户，不能悄悄换个地方存
pub fn ensure_writable(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let probe = dir.join(format!(".write-test-{}", std::process::id()));
    fs::write(&probe, b"")?;
    fs::remove_file(&probe)
}

pub fn resolve() -> Result<Paths, Problem> {
    // 调试版可以把数据目录指向别处，端到端测试不会碰到真实配置
    let (data, openssh_known_hosts) = match std::env::var_os("TERMIPAW_DATA_DIR").filter(|_| cfg!(debug_assertions)) {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            let openssh = dir.join("openssh_known_hosts");
            (dir, Some(openssh))
        }
        None => {
            let exe = std::env::current_exe().map_err(|e| Problem { dir: PathBuf::new(), reason: e.to_string() })?;
            (data_dir_beside(&exe), dirs::home_dir().map(|home| home.join(".ssh").join("known_hosts")))
        }
    };
    ensure_writable(&data).map_err(|e| Problem { dir: data.clone(), reason: e.to_string() })?;
    Ok(Paths { webview: data.join("webview"), data, openssh_known_hosts })
}

/// 弹出系统对话框说明原因。这时窗口还没有，界面也还没告诉后端用什么语言，所以按系统的语言显示
pub fn show_startup_error(app: &AppHandle, problem: &Problem) {
    let text = i18n::startup_error(i18n::system_language(), &problem.dir.display().to_string(), &problem.reason);
    app.dialog().message(text).title("TermiPaw").kind(MessageDialogKind::Error).blocking_show();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!("termipaw-portable-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn the_data_folder_sits_next_to_the_program() {
        assert_eq!(data_dir_beside(Path::new(r"D:\tools\termipaw.exe")), PathBuf::from(r"D:\tools\TermiPaw_Data"));
        assert_eq!(data_dir_beside(Path::new("termipaw.exe")), PathBuf::from("TermiPaw_Data"));
    }

    #[test]
    fn a_writable_folder_is_created_and_the_probe_file_is_removed() {
        let dir = temp().join("data");
        ensure_writable(&dir).unwrap();
        assert!(dir.is_dir());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "测试用的文件要删掉");
        // 已经存在时也可以
        ensure_writable(&dir).unwrap();
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn a_folder_that_cannot_be_used_is_reported() {
        let base = temp();
        fs::create_dir_all(&base).unwrap();
        // 同名的是文件，建不了目录
        fs::write(base.join("data"), "x").unwrap();
        assert!(ensure_writable(&base.join("data")).is_err());
        let _ = fs::remove_dir_all(&base);
    }
}
