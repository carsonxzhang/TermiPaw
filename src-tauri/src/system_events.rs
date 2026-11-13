//! 系统锁屏和电脑睡眠时立刻锁定保险库。睡眠要在内存被写进休眠文件之前处理，所以不能靠定时检查。

#[cfg(windows)]
pub fn watch(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use tauri::{AppHandle, Manager};
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION},
        UI::{
            Shell::{DefSubclassProc, SetWindowSubclass},
            WindowsAndMessaging::{PBT_APMSUSPEND, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WTS_CONSOLE_DISCONNECT, WTS_REMOTE_DISCONNECT, WTS_SESSION_LOCK},
        },
    };

    unsafe extern "system" fn on_message(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, data: usize) -> LRESULT {
        let event = wparam as u32;
        let lock = match message {
            WM_WTSSESSION_CHANGE => matches!(event, WTS_SESSION_LOCK | WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT),
            WM_POWERBROADCAST => event == PBT_APMSUSPEND,
            _ => false,
        };
        if lock {
            // SAFETY: `data` 来自下面的 Box::into_raw，从不释放，窗口存在期间一直有效
            let app = unsafe { &*(data as *const AppHandle) };
            crate::vault::state::lock_and_notify(app);
        }
        // SAFETY: 参数原样转交，这是子类化窗口过程的固定写法
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    let hwnd = window.hwnd()?.0 as HWND;
    // 窗口过程一直用到进程结束，这点内存不用释放
    let data = Box::into_raw(Box::new(window.app_handle().clone())) as usize;
    // SAFETY: `hwnd` 是主窗口的有效句柄，这里在创建它的主线程上；`on_message` 和 `data` 在窗口存在期间一直有效
    let ok = unsafe { SetWindowSubclass(hwnd, Some(on_message), 1, data) != 0 && WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) != 0 };
    if !ok {
        // 收不到系统通知时，空闲检查和睡眠后的兜底还在
        eprintln!("failed to register for session lock notifications");
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn watch(_window: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}
