//! 绿色版的更新：把下载并校验过的新程序换到自己的位置，再重新启动自己。设计见 docs/PORTABLE.md。
//!
//! Windows 不允许覆盖正在运行的程序，但允许改名。所以先把自己改名为 `TermiPaw.exe.old`，
//! 再把新程序改名到原来的位置。哪一步失败都改回去，什么都不变。

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use base64ct::{Base64, Encoding};

use crate::portable;

/// 新程序启动时带的参数，值是旧进程的进程号：先等旧进程退出，再创建窗口
const AFTER_UPDATE_ARG: &str = "--after-update=";
/// 比这小的肯定不是我们的程序。发布时打错包（比如打成了说明文件）会在这里被拦下
const MIN_SIZE: usize = 1 << 20;
/// 新程序稳定运行这么久之后，才删掉旧版本的备份
const OLD_CLEANUP_DELAY: Duration = Duration::from_secs(60);
const WAIT_FOR_OLD_PROCESS: Duration = Duration::from_secs(15);

/// 发布时用的文件名，每个版本都一样，用户建的快捷方式在手动换新版本后也不会失效。
/// 签名里记着被签名的文件名，必须是这个
pub const RELEASE_FILE_NAME: &str = "TermiPaw.exe";

/// 签名的可信注释里某一项的值（`file:`、`version:`）。注释被签名覆盖，签名校验通过之后读它才可信
fn signed_field(signature: &str, key: &str) -> Option<String> {
    let text = String::from_utf8(Base64::decode_vec(signature.trim()).ok()?).ok()?;
    let comment = text.lines().find_map(|line| line.strip_prefix("trusted comment: "))?;
    comment.split('\t').find_map(|field| field.strip_prefix(key)?.strip_prefix(':')).map(str::to_owned)
}

/// 签名是给这个版本的发布文件签的，不是别的文件。
/// 防止把同一把密钥签过名的别的文件（比如以前的安装程序）当成新版本发出来。文件名里没有版本号，
/// 所以版本号也要核对（更新插件的 `requireSignedVersion` 已经核对过一次，这里再确认）
pub fn signed_for_this_release(signature: &str, version: &str) -> bool {
    signed_field(signature, "file").as_deref() == Some(RELEASE_FILE_NAME)
        && signed_field(signature, "version").as_deref() == Some(version.trim_start_matches('v'))
}

/// 是不是 64 位的 Windows 程序，而且不是太小
pub fn looks_like_our_program(bytes: &[u8]) -> bool {
    fn is_x64_pe(bytes: &[u8]) -> Option<bool> {
        let header = u32::from_le_bytes(bytes.get(0x3c..0x40)?.try_into().ok()?) as usize;
        Some(bytes.get(header..header.checked_add(4)?)? == b"PE\0\0" && bytes.get(header + 4..header + 6)? == [0x64, 0x86])
    }
    bytes.len() >= MIN_SIZE && bytes.starts_with(b"MZ") && is_x64_pe(bytes) == Some(true)
}

fn sibling(exe: &Path, suffix: &str) -> PathBuf {
    let mut name = exe.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    exe.with_file_name(name)
}

fn new_path(exe: &Path) -> PathBuf {
    sibling(exe, ".new")
}

pub fn old_path(exe: &Path) -> PathBuf {
    sibling(exe, ".old")
}

/// 更新前先确认程序所在的文件夹能写入，不然白白下载一遍
pub fn ensure_folder_writable(exe: &Path) -> Result<(), String> {
    let dir = exe.parent().ok_or("no folder")?;
    portable::ensure_writable(dir).map_err(|e| e.to_string())
}

/// 从编译输出目录（`target\debug`、`target\release`）里运行的程序不换自己：
/// 那是开发时的程序，换掉它没有意义，还会把刚编译好的东西盖掉
pub fn in_build_folder(exe: &Path) -> bool {
    let parts: Vec<_> = exe.components().map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase()).collect();
    parts.windows(2).any(|w| w[0] == "target" && (w[1] == "debug" || w[1] == "release"))
}

/// 把新程序写成 `.new`，核对写进去的和要写的一样，再换到位。`rename` 是参数，测试用来模拟失败
fn replace_with(exe: &Path, bytes: &[u8], rename: impl Fn(&Path, &Path) -> io::Result<()>) -> io::Result<()> {
    let (new, old) = (new_path(exe), old_path(exe));
    let written = (|| {
        let mut file = fs::File::create(&new)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if fs::read(&new)? != bytes {
            return Err(io::Error::other("the file written differs from the one downloaded"));
        }
        Ok(())
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&new);
        return Err(e);
    }
    // 上一次更新留下的备份，已经没用了
    if old.exists() {
        fs::remove_file(&old).inspect_err(|_| drop(fs::remove_file(&new)))?;
    }
    rename(exe, &old).inspect_err(|_| drop(fs::remove_file(&new)))?;
    if let Err(e) = rename(&new, exe) {
        // 改回去：这时 `exe` 的位置是空的
        let _ = rename(&old, exe);
        let _ = fs::remove_file(&new);
        return Err(e);
    }
    Ok(())
}

pub fn replace_exe(exe: &Path, bytes: &[u8]) -> io::Result<()> {
    replace_with(exe, bytes, |from, to| fs::rename(from, to))
}

/// 启动新程序。它会等这个进程退出之后才创建窗口
pub fn start_again(exe: &Path) -> io::Result<()> {
    let mut command = Command::new(exe);
    command.arg(format!("{AFTER_UPDATE_ARG}{}", std::process::id()));
    if let Some(dir) = exe.parent() {
        command.current_dir(dir);
    }
    command.spawn().map(drop)
}

/// 启动参数里的“更新前的进程号”
pub fn after_update_pid(args: impl IntoIterator<Item = String>) -> Option<u32> {
    args.into_iter().find_map(|arg| arg.strip_prefix(AFTER_UPDATE_ARG)?.parse().ok())
}

/// 等旧进程退出。它退出之前，WebView2 的数据目录还被它占着。进程已经不在了就立刻返回
#[cfg(windows)]
pub fn wait_for_exit(pid: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    // SAFETY: 只用句柄等待，用完就关
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return;
        }
        WaitForSingleObject(handle, WAIT_FOR_OLD_PROCESS.as_millis() as u32);
        CloseHandle(handle);
    }
}

#[cfg(not(windows))]
pub fn wait_for_exit(_pid: u32) {}

/// 新版本稳定运行一会儿之后，删掉旧版本的备份。刚启动就崩溃的话备份还在，用户可以手动改回来
pub fn clean_up_old_later() {
    let Ok(exe) = std::env::current_exe() else { return };
    let old = old_path(&exe);
    if !old.exists() {
        return;
    }
    // 端到端测试不能等一分钟，调试版可以缩短
    let delay = std::env::var("TERMIPAW_TEST_OLD_CLEANUP_SECONDS").ok().filter(|_| cfg!(debug_assertions)).and_then(|s| s.parse().ok()).map_or(OLD_CLEANUP_DELAY, Duration::from_secs);
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let _ = fs::remove_file(old);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("termipaw-selfupdate-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn signature_with(comment: &str) -> String {
        Base64::encode_string(format!("untrusted comment: signature from tauri secret key\nRUTfakefakefake\ntrusted comment: {comment}\nfakeglobalsignature\n").as_bytes())
    }

    #[test]
    fn the_release_file_has_a_fixed_name() {
        assert_eq!(RELEASE_FILE_NAME, "TermiPaw.exe");
    }

    #[test]
    fn only_a_signature_made_for_this_releases_file_is_accepted() {
        let good = signature_with("timestamp:1\tfile:TermiPaw.exe\tversion:9.9.9");
        assert!(signed_for_this_release(&good, "9.9.9"));
        assert!(signed_for_this_release(&good, "v9.9.9"));
        // 同一把密钥签过的别的文件
        assert!(!signed_for_this_release(&signature_with("timestamp:1\tfile:TermiPaw_9.9.9_x64-setup.exe\tversion:9.9.9"), "9.9.9"));
        assert!(!signed_for_this_release(&signature_with("timestamp:1\tfile:TermiPaw_9.9.9_x64.exe\tversion:9.9.9"), "9.9.9"));
        assert!(!signed_for_this_release(&signature_with("timestamp:1\tversion:9.9.9"), "9.9.9"));
        // 文件名一样，但签的是别的版本，或者没有记版本号
        assert!(!signed_for_this_release(&signature_with("timestamp:1\tfile:TermiPaw.exe\tversion:0.5.0"), "9.9.9"));
        assert!(!signed_for_this_release(&signature_with("timestamp:1\tfile:TermiPaw.exe\tversion:9.9.90"), "9.9.9"));
        assert!(!signed_for_this_release(&signature_with("timestamp:1\tfile:TermiPaw.exe"), "9.9.9"));
        // 只认完整的项名：`filename:` 不是 `file:`
        assert!(!signed_for_this_release(&signature_with("timestamp:1\tfilename:TermiPaw.exe\tversion:9.9.9"), "9.9.9"));
        // 注释只认以 trusted comment 开头的那一行，签名正文里长得像也不算
        assert!(!signed_for_this_release(&Base64::encode_string(b"untrusted comment: file:TermiPaw.exe\tversion:9.9.9\nsig\n"), "9.9.9"));
        assert!(!signed_for_this_release("不是 base64！", "9.9.9"));
        assert!(!signed_for_this_release("", "9.9.9"));
    }

    fn fake_exe(machine: [u8; 2], size: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; size];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        bytes[0x84..0x86].copy_from_slice(&machine);
        bytes
    }

    #[test]
    fn only_a_64_bit_windows_program_of_a_sensible_size_is_accepted() {
        assert!(looks_like_our_program(&fake_exe([0x64, 0x86], MIN_SIZE)));
        assert!(!looks_like_our_program(&fake_exe([0x64, 0xaa], MIN_SIZE)), "ARM64");
        assert!(!looks_like_our_program(&fake_exe([0x4c, 0x01], MIN_SIZE)), "32 位");
        assert!(!looks_like_our_program(&fake_exe([0x64, 0x86], MIN_SIZE - 1)), "太小");
        let mut no_mz = fake_exe([0x64, 0x86], MIN_SIZE);
        no_mz[0] = b'X';
        assert!(!looks_like_our_program(&no_mz));
        let mut no_pe = fake_exe([0x64, 0x86], MIN_SIZE);
        no_pe[0x80] = b'X';
        assert!(!looks_like_our_program(&no_pe));
        let mut far = fake_exe([0x64, 0x86], MIN_SIZE);
        far[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(!looks_like_our_program(&far), "头的位置在文件外面，不能越界");
        assert!(!looks_like_our_program("这是一份说明文件".repeat(200_000).as_bytes()));
        assert!(!looks_like_our_program(&[]));
    }

    #[test]
    fn programs_in_a_build_folder_do_not_replace_themselves() {
        assert!(in_build_folder(Path::new(r"D:\code\TermiPaw\src-tauri\target\debug\termipaw.exe")));
        assert!(in_build_folder(Path::new(r"D:\code\target\release\termipaw.exe")));
        assert!(in_build_folder(Path::new(r"D:\code\TARGET\Debug\termipaw.exe")));
        assert!(!in_build_folder(Path::new(r"D:\tools\TermiPaw\termipaw.exe")));
        assert!(!in_build_folder(Path::new(r"D:\my target\debug\termipaw.exe")));
        assert!(!in_build_folder(Path::new(r"D:\target\tools\termipaw.exe")));
    }

    #[test]
    fn the_new_program_takes_the_place_and_the_old_one_is_kept() {
        let dir = temp();
        let exe = dir.join("tp.exe");
        fs::write(&exe, b"old program").unwrap();
        replace_exe(&exe, b"new program").unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"new program");
        assert_eq!(fs::read(old_path(&exe)).unwrap(), b"old program");
        assert!(!new_path(&exe).exists());

        // 上一次的备份换成这一次的
        replace_exe(&exe, b"newer program").unwrap();
        assert_eq!(fs::read(old_path(&exe)).unwrap(), b"new program");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn if_the_second_rename_fails_the_old_program_is_put_back() {
        let dir = temp();
        let exe = dir.join("tp.exe");
        fs::write(&exe, b"old program").unwrap();
        let calls = Cell::new(0);
        let result = replace_with(&exe, b"new program", |from, to| {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                return Err(io::Error::other("simulated"));
            }
            fs::rename(from, to)
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&exe).unwrap(), b"old program", "原来的程序还在原位");
        assert!(!new_path(&exe).exists() && !old_path(&exe).exists(), "不留下半成品");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn if_the_first_rename_fails_nothing_changes() {
        let dir = temp();
        let exe = dir.join("tp.exe");
        fs::write(&exe, b"old program").unwrap();
        assert!(replace_with(&exe, b"new program", |_, _| Err(io::Error::other("simulated"))).is_err());
        assert_eq!(fs::read(&exe).unwrap(), b"old program");
        assert!(!new_path(&exe).exists() && !old_path(&exe).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn if_the_new_file_cannot_be_written_nothing_changes() {
        let dir = temp();
        let exe = dir.join("tp.exe");
        fs::write(&exe, b"old program").unwrap();
        // 同名的是目录，写不进去
        fs::create_dir(new_path(&exe)).unwrap();
        assert!(replace_exe(&exe, b"new program").is_err());
        assert_eq!(fs::read(&exe).unwrap(), b"old program");
        assert!(!old_path(&exe).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_process_to_wait_for_comes_from_the_start_up_arguments() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(after_update_pid(args(&["termipaw.exe", "--after-update=4242"])), Some(4242));
        assert_eq!(after_update_pid(args(&["termipaw.exe"])), None);
        assert_eq!(after_update_pid(args(&["termipaw.exe", "--after-update=abc"])), None);
        assert_eq!(after_update_pid(args(&["termipaw.exe", "--after-update="])), None);
        assert_eq!(after_update_pid(args(&["termipaw.exe", "--after-update=-1"])), None);
    }
}
