//! 打开终端里点击的链接。只允许 http / https，交给系统默认浏览器。

use tauri::{AppHandle, Url};
use tauri_plugin_opener::OpenerExt;

use crate::{error::AppResult, i18n::t};

/// 终端输出是不可信的（服务器想显示什么都可以），所以链接要严格限制：
/// `file:`、`ms-settings:`、`javascript:`、自定义协议等一律不打开。
fn validate_link(raw: &str) -> AppResult<Url> {
    let url = Url::parse(raw.trim()).map_err(|_| t("link.invalid"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(t("link.scheme").into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(t("link.noHost").into());
    }
    Ok(url)
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> AppResult<()> {
    let url = validate_link(&url)?;
    // 端到端测试不能真的打开浏览器：调试版指定了测试数据目录时，只把地址记到 opened-links.txt
    if let Some(dir) = std::env::var_os("TERMIPAW_DATA_DIR").filter(|_| cfg!(debug_assertions)) {
        use std::io::Write;
        let mut log = std::fs::OpenOptions::new().create(true).append(true).open(std::path::Path::new(&dir).join("opened-links.txt"))?;
        writeln!(log, "{url}")?;
        return Ok(());
    }
    // 用解析后的规范形式打开，原文里夹带的空白和换行不会传给系统
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| t("link.openFailed").detail(e).into())
}

#[cfg(test)]
mod tests {
    use super::validate_link;

    #[test]
    fn web_links_are_allowed() {
        for ok in ["http://example.com", "https://example.com/a?b=c#d", "HTTPS://EXAMPLE.COM", "  https://example.com  ", "http://127.0.0.1:8080/x"] {
            assert!(validate_link(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn everything_else_is_refused() {
        for bad in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "ftp://example.com",
            "mailto:a@example.com",
            "tel:123",
            "data:text/html,<script>1</script>",
            "\\\\server\\share",
            "C:\\Windows\\notepad.exe",
            "http://",
            "example.com",
            "",
        ] {
            assert!(validate_link(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_normalized_form_is_what_gets_opened() {
        // URL 解析会去掉夹在中间的换行和制表符，传给系统的是解析后的结果
        let url = validate_link("http://exa\nmple.com/pa\tth").unwrap();
        assert_eq!(url.as_str(), "http://example.com/path");
        // 多写的斜杠会被解析器吞掉，把后面当作主机名，仍然是普通的 https 链接
        assert_eq!(validate_link("https:///path").unwrap().as_str(), "https://path/");
    }
}
