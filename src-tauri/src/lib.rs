mod agent;
mod edit;
mod error;
mod files;
mod i18n;
mod links;
mod portable;
mod selfupdate;
mod sftp;
mod ssh;
mod store;
mod system_events;
mod tree;
mod updater;
mod vault;

#[cfg(test)]
#[path = "../testing/sftp_sandbox.rs"]
mod sftp_sandbox;

use tauri::{webview::NewWindowResponse, Manager, Url, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// 界面自己的地址。窗口只允许停留在这里，不能跳转到别处，也不能弹出新窗口：
/// 界面里没有任何需要这样做的功能，出现了就说明有问题。
fn is_app_url(url: &Url, dev: bool) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            // 开发服务器只在调试版里允许
            Some("localhost") => dev,
            _ => false,
        },
        _ => false,
    }
}

/// 按 `tauri.conf.json` 里的配置创建主窗口（配置里设了 `create: false`），并加上导航限制。
/// WebView2 的用户数据放进 `webview_dir`，不然它默认写到 `%LOCALAPPDATA%`
fn create_main_window(app: &tauri::App, webview_dir: std::path::PathBuf) -> tauri::Result<WebviewWindow> {
    // 系统里设了这个环境变量时，WebView2 会优先用它，界面数据就不在程序旁边了。
    // 发布版忽略它（只对本进程，不改系统）；调试版保留，端到端测试靠它隔离数据
    if !cfg!(debug_assertions) {
        std::env::remove_var("WEBVIEW2_USER_DATA_FOLDER");
    }
    let config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .expect("tauri.conf.json 里没有窗口配置");
    let window = WebviewWindowBuilder::from_config(app.handle(), &config)?
        .data_directory(webview_dir)
        .on_navigation(|url| is_app_url(url, cfg!(debug_assertions)))
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .build()?;

    // 拖进窗口的文件在后端换成令牌，界面拿不到路径
    let handle = app.handle().clone();
    window.on_window_event(move |event| match event {
        WindowEvent::DragDrop(drag) => files::handle_drag_drop(&handle, drag),
        // 已经传回服务器的临时文件不留在电脑上
        WindowEvent::Destroyed => handle.state::<edit::Edits>().stop_all(),
        _ => {}
    });
    Ok(window)
}

/// 按配置的默认尺寸打开窗口；屏幕放不下时缩小到可用区域的 90%，并在可用区域内居中。
fn fit_to_screen(window: &WebviewWindow, width: f64, height: f64) -> tauri::Result<()> {
    use tauri::{PhysicalPosition, PhysicalSize};

    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let fit = |wanted: f64, available: u32| {
        let wanted = wanted * scale;
        let available = f64::from(available);
        (if wanted <= available { wanted } else { available * 0.9 }) as u32
    };
    let (w, h) = (fit(width, area.size.width), fit(height, area.size.height));

    window.set_size(PhysicalSize::new(w, h))?;
    window.set_position(PhysicalPosition::new(
        area.position.x + (area.size.width.saturating_sub(w) / 2) as i32,
        area.position.y + (area.size.height.saturating_sub(h) / 2) as i32,
    ))
}

pub fn run() {
    tauri::Builder::default()
        // 插件自带的命令没有开放给界面（见 capabilities），更新都走 updater.rs 里的命令
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::Updates::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // 链接统一经 `links::open_url` 打开。关掉插件自带的“点击页面里的链接就打开”脚本
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(ssh::Sessions::default())
        .manage(sftp::Transfers::default())
        .manage(files::Grants::default())
        .manage(edit::Edits::default())
        .setup(|app| {
            // 数据放在程序旁边。放不下就明说，不偷偷换地方（见 portable.rs）
            let paths = match portable::resolve() {
                Ok(paths) => paths,
                Err(problem) => {
                    portable::show_startup_error(app.handle(), &problem);
                    std::process::exit(1);
                }
            };
            // 更新后重新启动的：旧进程还没退出时，它占着 WebView2 的数据目录，要先等它退出
            if let Some(pid) = selfupdate::after_update_pid(std::env::args()) {
                selfupdate::wait_for_exit(pid);
            }
            selfupdate::clean_up_old_later();
            let (dir, openssh_known_hosts) = (paths.data, paths.openssh_known_hosts);
            app.manage(store::Store::new(dir, openssh_known_hosts));
            vault::state::start_idle_timer(app.handle().clone());
            edit::clean_old_work_dirs(app.handle());

            // 窗口初始隐藏（见 tauri.conf.json），调整好尺寸再显示，避免启动时跳动
            let window = create_main_window(app, paths.webview)?;
            system_events::watch(&window)?;
            let size = app.config().app.windows.first().map(|c| (c.width, c.height));
            if let Some((width, height)) = size {
                if let Err(e) = fit_to_screen(&window, width, height) {
                    eprintln!("调整窗口尺寸失败：{e}");
                }
            }
            window.show()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            i18n::set_language,
            links::open_url,
            files::pick_upload_files,
            files::pick_upload_folder,
            files::pick_download_folder,
            files::pick_save_location,
            files::pick_key_file,
            files::save_terminal_output,
            files::debug_drop,
            store::hosts_list,
            store::hosts_save,
            store::hosts_delete,
            store::known_hosts_trust,
            store::known_hosts_reset,
            store::store_take_issues,
            vault::state::vault_status,
            vault::state::vault_enable,
            vault::state::vault_unlock,
            vault::state::vault_recover,
            vault::state::vault_change_password,
            vault::state::vault_disable,
            vault::state::vault_lock,
            vault::state::vault_touch,
            vault::state::vault_set_idle,
            vault::state::vault_set_encrypt_metadata,
            vault::state::vault_delete_old_backups,
            vault::state::vault_reset,
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_write_bytes,
            ssh::ssh_resize,
            ssh::ssh_ack,
            ssh::ssh_close,
            ssh::ssh_hostname,
            sftp::sftp_realpath,
            sftp::sftp_list,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_remove,
            sftp::sftp_upload,
            sftp::sftp_download,
            sftp::sftp_download_dir,
            sftp::sftp_cancel,
            edit::edit_open,
            edit::edit_upload,
            edit::edit_attach,
            edit::edit_reopen,
            edit::edit_stop,
            edit::editor_get,
            edit::editor_pick,
            updater::update_status,
            updater::update_check,
            updater::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TermiPaw");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(url: &str, dev: bool) -> bool {
        is_app_url(&Url::parse(url).unwrap(), dev)
    }

    #[test]
    fn the_window_may_only_stay_on_the_app_itself() {
        assert!(allowed("http://tauri.localhost/", false));
        assert!(allowed("https://tauri.localhost/index.html", false));
        assert!(allowed("tauri://localhost/", false));
        for other in [
            "https://example.com",
            "http://tauri.localhost.evil.com/",
            "http://evil.com/tauri.localhost",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:blank",
            "http://127.0.0.1:1420/",
        ] {
            assert!(!allowed(other, true), "{other}");
        }
    }

    #[test]
    fn the_dev_server_is_only_allowed_in_debug_builds() {
        assert!(allowed("http://localhost:1420/", true));
        assert!(!allowed("http://localhost:1420/", false));
    }
}
