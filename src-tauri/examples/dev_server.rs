//! 本地开发用 SSH / SFTP 服务器：无需真实服务器即可体验与调试 TermiPaw。
//!
//!   cargo run --example dev_server
//!
//! 监听 127.0.0.1:2222，任意用户名 + 密码 `demo` 登录。用户名 `hang` 的认证永远不返回，用于测试超时。
//! - Shell：一个简易演示 Shell（help / ls / cd / cat / colors …），不会执行真实命令
//! - SFTP：真实读写，但被限制在系统临时目录下的 `termipaw-dev-server` 沙箱中
//!
//! 测试用的命令（不在 help 里）：`rawhex` 原样输出字节、`altscreen on|off` 进出全屏模式、
//! `askpw` 模拟等待密码、`integrate off` 让提示符不再上报、`integrate never|any` 让集成的那行命令不起作用或恢复。输入 Shell 集成的那行命令后，提示符会像真实 Shell 一样上报目录和状态。
//! 环境变量 `TERMIPAW_SFTP_FAKE_NAMES`（JSON 数组，元素为 `[名字, 是否目录]`）让主目录多出这些条目，模拟恶意服务器。

#[path = "../testing/sftp_sandbox.rs"]
mod sftp_sandbox;

use std::{
    collections::HashMap,
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

use russh::{
    keys::{ssh_key::LineEnding, Algorithm, PrivateKey},
    server::{Auth, Msg, Server as _, Session},
    Channel, ChannelId, Pty,
};
use sftp_sandbox::{normalize, Faults, SandboxSftp};

const HOME: &str = "/home/demo";

fn real(root: &Path, vpath: &str) -> PathBuf {
    sftp_sandbox::real(root, HOME, vpath)
}

// ---------- 演示 Shell ----------

struct Shell {
    line: String,
    cwd: String,
    /// 开启了 Shell 集成：提示符上报目录和状态
    integrated: bool,
    /// 模拟 bash、zsh 以外的 Shell：集成的那行命令不起作用（`integrate never`）
    unsupported: bool,
    /// 正在等待输入密码（`askpw`）：不回显，下一行写进 askpw.log
    asking: bool,
    /// 这一行收到的原始字节，`echohex` 用来检查界面按什么编码发送
    raw: Vec<u8>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2).filter_map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()).collect()
}

/// 和 Shell 集成脚本一样，除了安全字符全部百分号编码
fn percent_encode(path: &str) -> String {
    path.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"/._~-".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// `cd` 的参数：去掉单引号，还原其中转义的单引号
fn unquote(arg: &str) -> String {
    match arg.strip_prefix('\'').and_then(|a| a.strip_suffix('\'')) {
        Some(inner) => inner.replace("'\\''", "'"),
        None => arg.to_string(),
    }
}

impl Shell {
    fn prompt(&self) -> String {
        let dir = if self.cwd == HOME { "~".to_string() } else { self.cwd.clone() };
        let report = if self.integrated {
            format!("\x1b]7;file://termipaw{}\x1b\\\x1b]133;A\x1b\\", percent_encode(&self.cwd))
        } else {
            String::new()
        };
        format!("{report}\x1b[1;32mdemo@termipaw\x1b[0m:\x1b[1;34m{dir}\x1b[0m$ ")
    }

    /// 执行一行命令，返回输出；`None` 表示退出
    fn run(&mut self, root: &Path, line: &str) -> Option<String> {
        // Shell 集成的那行命令：这个 Shell 看不懂，但效果照样模拟
        if line.contains("__tp_cwd") {
            self.integrated = !self.unsupported;
            return Some(String::new());
        }
        let mut args = line.split_whitespace();
        let cmd = args.next().unwrap_or("");
        let rest: Vec<&str> = args.collect();
        let mark = if self.integrated && !line.is_empty() { "\x1b]133;C\x1b\\" } else { "" };
        let out = match cmd {
            "" => String::new(),
            "rawhex" => String::from_utf8_lossy(&unhex(&rest.concat())).into_owned(),
            "integrate" if rest.first() == Some(&"off") => {
                self.integrated = false;
                String::new()
            }
            "integrate" if matches!(rest.first(), Some(&"never" | &"any")) => {
                self.unsupported = rest.first() == Some(&"never");
                String::new()
            }
            "altscreen" => if rest.first() == Some(&"on") { "\x1b[?1049h".into() } else { "\x1b[?1049l".into() },
            "askpw" => {
                self.asking = true;
                return Some(format!("{mark}Password: "));
            }
            "exit" | "logout" => return None,
            "help" => "可用命令：help ls cd pwd cat echo whoami uname date colors clear exit\r\n\
                       这是 TermiPaw 内置的演示服务器，SFTP 面板可真实上传 / 下载文件。\r\n"
                .into(),
            "pwd" => format!("{}\r\n", self.cwd),
            "whoami" => "demo\r\n".into(),
            "uname" => "TermiPaw dev-server x86_64\r\n".into(),
            "echo" => format!("{}\r\n", rest.join(" ")),
            "clear" => "\x1b[2J\x1b[H".into(),
            "date" => format!(
                "{} (unix)\r\n",
                std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
            ),
            "cd" => {
                let arg = unquote(line.trim_start_matches("cd").trim());
                let arg = if arg.is_empty() { HOME.to_string() } else { arg.replace('~', HOME) };
                let target = normalize(&self.cwd, &arg);
                if real(root, &target).is_dir() {
                    self.cwd = target;
                    String::new()
                } else {
                    format!("cd: {arg}: 没有那个目录\r\n")
                }
            }
            "ls" | "ll" => {
                let dir = normalize(&self.cwd, rest.iter().find(|a| !a.starts_with('-')).copied().unwrap_or("."));
                match fs::read_dir(real(root, &dir)) {
                    Ok(rd) => {
                        let mut names: Vec<(String, bool)> = rd
                            .flatten()
                            .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path().is_dir()))
                            .collect();
                        names.sort();
                        let items: Vec<String> = names
                            .into_iter()
                            .map(|(n, d)| if d { format!("\x1b[1;34m{n}/\x1b[0m") } else { n })
                            .collect();
                        if items.is_empty() { String::new() } else { format!("{}\r\n", items.join("  ")) }
                    }
                    Err(_) => format!("ls: 无法访问 '{dir}'\r\n"),
                }
            }
            "cat" => match rest.first() {
                Some(f) => match fs::read_to_string(real(root, &normalize(&self.cwd, f))) {
                    Ok(s) => s.replace('\n', "\r\n"),
                    Err(_) => format!("cat: {f}: 没有那个文件\r\n"),
                },
                None => String::new(),
            },
            "colors" => {
                let mut s = String::new();
                for i in 0..16 {
                    s.push_str(&format!("\x1b[48;5;{i}m  {i:>2}  \x1b[0m"));
                    if i == 7 {
                        s.push_str("\r\n");
                    }
                }
                s.push_str("\r\n");
                for i in 0..36 {
                    let (r, g, b) = (255 - i * 7, 80 + i * 4, 120 + i * 3);
                    s.push_str(&format!("\x1b[48;2;{r};{g};{b}m \x1b[0m"));
                }
                s.push_str("  24-bit 真彩色\r\n");
                s
            }
            other => format!("{other}: 命令未找到（输入 help 查看可用命令）\r\n"),
        };
        Some(format!("{mark}{out}"))
    }
}

// ---------- SSH 服务端 ----------

#[derive(Clone)]
struct Server {
    root: PathBuf,
}

impl russh::server::Server for Server {
    type Handler = Client;
    fn new_client(&mut self, addr: Option<SocketAddr>) -> Client {
        println!("新连接：{addr:?}");
        Client { root: self.root.clone(), channels: HashMap::new(), shells: HashMap::new() }
    }
}

struct Client {
    root: PathBuf,
    channels: HashMap<ChannelId, Channel<Msg>>,
    shells: HashMap<ChannelId, Shell>,
}

impl russh::server::Handler for Client {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        println!("登录尝试：{user}");
        if user == "hang" {
            std::future::pending::<()>().await;
        }
        Ok(if password == "demo" { Auth::Accept } else { Auth::reject() })
    }

    /// 任何私钥都接受：测试不需要输入密码的连接（比如自动重连）时用
    async fn auth_publickey(&mut self, _user: &str, _key: russh::server::VerifiedPublicKey<'_>) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _cols: u32,
        _rows: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        // TERMIPAW_DEV_INTEGRATED：一开始就有集成，相当于写进了 .bashrc
        let integrated = std::env::var_os("TERMIPAW_DEV_INTEGRATED").is_some();
        let shell = Shell { line: String::new(), cwd: HOME.into(), integrated, unsupported: false, asking: false, raw: Vec::new() };
        let banner = format!(
            "\x1b[1;36m欢迎使用 TermiPaw 演示服务器\x1b[0m\r\n输入 \x1b[33mhelp\x1b[0m 查看命令，按 \x1b[33mCtrl+Shift+E\x1b[0m 打开文件面板。\r\n\r\n{}",
            shell.prompt()
        );
        session.data(channel, banner.into_bytes())?;
        self.shells.insert(channel, shell);
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        let root = self.root.clone();
        let Some(shell) = self.shells.get_mut(&channel) else { return Ok(()) };
        let mut out: Vec<u8> = Vec::new();
        let mut flood = None;
        if !shell.asking {
            shell.raw.extend_from_slice(data);
        }
        for ch in String::from_utf8_lossy(data).chars() {
            match ch {
                '\r' | '\n' if shell.asking => {
                    shell.asking = false;
                    let answer = std::mem::take(&mut shell.line);
                    let log = real(&root, &format!("{HOME}/askpw.log"));
                    let _ = fs::write(log, answer);
                    out.extend_from_slice(b"\r\n");
                    out.extend_from_slice(shell.prompt().as_bytes());
                }
                c if shell.asking => {
                    if !c.is_control() {
                        shell.line.push(c);
                    }
                }
                '\r' | '\n' => {
                    out.extend_from_slice(b"\r\n");
                    let line = std::mem::take(&mut shell.line);
                    let mut raw = std::mem::take(&mut shell.raw);
                    raw.truncate(raw.iter().position(|b| *b == b'\r' || *b == b'\n').unwrap_or(raw.len()));
                    // rawbytes <十六进制>：原样输出这些字节；echohex <内容>：显示收到的原始字节
                    if let Some(bytes) = line.trim().strip_prefix("rawbytes ") {
                        out.extend_from_slice(&unhex(bytes.trim()));
                        out.extend_from_slice(format!("\r\n{}", shell.prompt()).as_bytes());
                        continue;
                    }
                    if raw.starts_with(b"echohex ") {
                        out.extend_from_slice(format!("HEX:{}\r\n{}", hex(&raw[8..]), shell.prompt()).as_bytes());
                        continue;
                    }
                    // flood <MB>：按 SSH 窗口持续输出指定大小的文本，用来测试终端的流控
                    if let Some(mb) = line.trim().strip_prefix("flood ").and_then(|n| n.parse::<usize>().ok()) {
                        flood = Some((mb, shell.prompt()));
                        continue;
                    }
                    match shell.run(&root, line.trim()) {
                        Some(o) => {
                            out.extend_from_slice(o.as_bytes());
                            if !shell.asking {
                                out.extend_from_slice(shell.prompt().as_bytes());
                            }
                        }
                        None => {
                            out.extend_from_slice(b"logout\r\n");
                            session.data(channel, out)?;
                            session.exit_status_request(channel, 0)?;
                            session.eof(channel)?;
                            session.close(channel)?;
                            self.shells.remove(&channel);
                            return Ok(());
                        }
                    }
                }
                '\x7f' | '\x08' => {
                    if shell.line.pop().is_some() {
                        out.extend_from_slice(b"\x08 \x08");
                    }
                }
                '\x03' => {
                    shell.line.clear();
                    shell.raw.clear();
                    out.extend_from_slice(b"^C\r\n");
                    out.extend_from_slice(shell.prompt().as_bytes());
                }
                c if !c.is_control() => {
                    shell.line.push(c);
                    out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
                }
                _ => {} // 忽略方向键等转义序列
            }
        }
        session.data(channel, out)?;
        if let Some((mb, prompt)) = flood {
            let handle = session.handle();
            tokio::spawn(async move {
                let line = "abcdefghij".repeat(7);
                let (mut sent, mut n) = (0, 0u64);
                while sent < mb << 20 {
                    let mut chunk = String::with_capacity(32 * 1024);
                    while chunk.len() + 81 <= 32 * 1024 {
                        chunk.push_str(&format!("{n:08} {line}\r\n"));
                        n += 1;
                    }
                    sent += chunk.len();
                    // 会等待客户端的接收窗口
                    if handle.data(channel, chunk.into_bytes()).await.is_err() {
                        return;
                    }
                }
                let _ = handle.data(channel, format!("FLOOD-DONE {n}\r\n{prompt}").into_bytes()).await;
            });
        }
        Ok(())
    }

    /// 只认文件面板查询主机名用的那条命令
    async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        if data != b"uname -n" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        session.data(channel, b"termipaw\n".to_vec())?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    async fn subsystem_request(&mut self, channel: ChannelId, name: &str, session: &mut Session) -> Result<(), Self::Error> {
        match (name, self.channels.remove(&channel)) {
            ("sftp", Some(ch)) => {
                session.channel_success(channel)?;
                // 测试用：让每次写入慢一点，方便观察排队和取消
                let write_delay = std::env::var("TERMIPAW_SFTP_WRITE_DELAY_MS").ok().and_then(|v| v.parse().ok()).map(std::time::Duration::from_millis);
                let mut fake_entries = HashMap::new();
                if let Some(names) = std::env::var("TERMIPAW_SFTP_FAKE_NAMES").ok().and_then(|v| serde_json::from_str(&v).ok()) {
                    fake_entries.insert(HOME.to_string(), names);
                }
                let faults = Faults { write_delay, fake_entries, ..Default::default() };
                let sftp = SandboxSftp::new(self.root.clone(), HOME, Arc::new(Mutex::new(faults)));
                russh_sftp::server::run(ch.into_stream(), sftp).await;
            }
            _ => session.channel_failure(channel)?,
        }
        Ok(())
    }
}

fn host_key(dir: &Path) -> PrivateKey {
    let path = dir.join("host_ed25519");
    if let Ok(k) = russh::keys::load_secret_key(&path, None) {
        return k;
    }
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("生成主机密钥失败");
    fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
    key
}

#[tokio::main]
async fn main() {
    let base = std::env::temp_dir().join("termipaw-dev-server");
    let root = base.join("root");
    let home = root.join(HOME.trim_start_matches('/'));
    fs::create_dir_all(home.join("projects")).unwrap();
    fs::create_dir_all(root.join("var/log")).unwrap();
    let readme = home.join("README.txt");
    if !readme.exists() {
        fs::write(&readme, "这是 TermiPaw 演示服务器的沙箱目录。\n可以随意上传、下载、重命名和删除文件。\n").unwrap();
        fs::write(home.join("projects/hello.sh"), "#!/bin/sh\necho hello from termipaw\n").unwrap();
        fs::write(root.join("var/log/app.log"), "[info] dev server started\n").unwrap();
    }

    let config = russh::server::Config {
        auth_rejection_time: std::time::Duration::from_millis(300),
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        keys: vec![host_key(&base)],
        ..Default::default()
    };
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(2222);
    println!("TermiPaw 开发服务器已启动：127.0.0.1:{port}");
    println!("  用户名任意，密码：demo");
    println!("  SFTP 沙箱：{}", root.display());
    Server { root }
        .run_on_address(Arc::new(config), ("127.0.0.1", port))
        .await
        .unwrap();
}
