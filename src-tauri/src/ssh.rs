//! SSH 连接、认证、主机指纹校验与交互式终端通道。

use std::{
    borrow::Cow,
    collections::HashMap,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use russh::{
    client,
    keys::{self, Algorithm, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate},
    Channel as SshChannel, ChannelMsg, Disconnect, Preferred,
};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Emitter, Manager, State,
};
use tokio::{io::AsyncWriteExt, sync::mpsc};
use zeroize::Zeroizing;

use crate::{
    agent,
    error::{AppError, AppResult},
    i18n::{t, Text},
    store::{AuthMethod, KeyCheck, KnownHosts, ServerTemps, Store},
};

/// 建立连接和完成握手的时限
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 认证和打开终端每一步的时限。服务器握手后不再响应时，不能让连接一直卡住
const STEP_TIMEOUT: Duration = Duration::from_secs(30);
/// 已发给界面、还没确认处理完的终端输出上限
const OUTPUT_WINDOW: usize = 1 << 20;
/// 合并后一条消息的大小。实际可能略大：最后一块是整块加进去的
const OUTPUT_BATCH: usize = 64 << 10;

// ---------- 主机指纹校验 ----------

pub struct Client {
    host: String,
    port: u16,
    known: Arc<KnownHosts>,
    /// 校验失败时记录原因，连接失败后转换成结构化错误返回前端
    issue: Arc<Mutex<Option<AppError>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        // 证书形式的主机密钥：按其中的公钥做指纹校验
        let owned;
        let key: &PublicKey = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            PublicKeyOrCertificate::Certificate(cert) => {
                owned = PublicKey::from(cert.public_key().clone());
                &owned
            }
        };
        let check = self.known.check(&self.host, self.port, key);
        let (host, port) = (self.host.clone(), self.port);
        let key_type = key.algorithm().to_string();
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let issue = match check {
            KeyCheck::Trusted => return Ok(true),
            KeyCheck::Locked => AppError::vault_locked(),
            KeyCheck::Blocked { text, can_reset } => AppError::KnownHostsBlocked { text, can_reset },
            KeyCheck::Changed => {
                self.known.stage(&host, port, key);
                AppError::HostKeyChanged { host, port, key_type, fingerprint }
            }
            KeyCheck::Unknown => {
                self.known.stage(&host, port, key);
                AppError::UnknownHostKey { host, port, key_type, fingerprint }
            }
        };
        *self.issue.lock().unwrap() = Some(issue);
        Ok(false)
    }
}

// ---------- 会话 ----------

enum ShellCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    /// 界面处理完了这么多字节的输出
    Ack(usize),
    Close,
}

pub struct Session {
    pub handle: client::Handle<Client>,
    tx: mpsc::UnboundedSender<ShellCmd>,
    pub sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
    pub temps: ServerTemps,
}

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Arc<Session>>>);

impl Sessions {
    pub fn get(&self, id: &str) -> AppResult<Arc<Session>> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| t("ssh.noSession").into())
    }

    fn remove(&self, id: &str) -> Option<Arc<Session>> {
        self.0.lock().unwrap().remove(id)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectTarget {
    pub host_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub key_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    session_id: String,
    /// 连接成功，但有需要告诉用户的问题（如密码没有保存成功）
    warnings: Vec<Text>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedEvent {
    session_id: String,
    reason: Text,
    /// 连接意外断开，可以自动重连。用户或远程 Shell 主动结束时为假
    lost: bool,
}

fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => PathBuf::from(path),
    }
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn authenticate(
    handle: &mut client::Handle<Client>,
    target: &ConnectTarget,
    secret: Option<&str>,
) -> AppResult<()> {
    let user = target.username.as_str();
    match target.auth {
        AuthMethod::Password => {
            let Some(pw) = secret else {
                return Err(AppError::SecretRequired(t("ssh.passwordRequired")));
            };
            if !handle.authenticate_password(user, pw).await?.success() {
                return Err(AppError::AuthFailed(t("ssh.wrongPassword")));
            }
        }
        AuthMethod::Key => {
            let path = target
                .key_path
                .as_deref()
                .filter(|p| !p.trim().is_empty())
                .ok_or_else(|| t("ssh.noKeyFile"))?;
            let key = match keys::load_secret_key(expand_home(path), secret) {
                Ok(k) => k,
                Err(keys::Error::IO(e)) => return Err(t("ssh.keyReadFailed").detail(e).into()),
                Err(keys::Error::KeyIsEncrypted) if secret.is_none() => {
                    return Err(AppError::SecretRequired(t("ssh.passphraseRequired")))
                }
                Err(e) if secret.is_some() => {
                    return Err(AppError::AuthFailed(t("ssh.wrongPassphrase").detail(e)))
                }
                Err(e) => return Err(t("ssh.keyParseFailed").detail(e).into()),
            };
            let hash = if matches!(key.algorithm(), Algorithm::Rsa { .. }) {
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                // 没有 SHA-2 可用时只能用 SHA-1 签名，不支持
                if hash.is_none() {
                    return Err(t("ssh.rsaSha1Only").into());
                }
                hash
            } else {
                None
            };
            let ok = handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
                .success();
            if !ok {
                return Err(AppError::AuthFailed(t("ssh.keyRejected")));
            }
        }
        AuthMethod::Agent => agent::authenticate(handle, user).await?,
    }
    Ok(())
}

/// `what` 是哪一步，例如 `ssh.stepAuth`
async fn with_timeout<T>(limit: Duration, what: &'static str, step: impl Future<Output = AppResult<T>>) -> AppResult<T> {
    match tokio::time::timeout(limit, step).await {
        Ok(result) => result,
        Err(_) => Err(t("ssh.stepTimeout").arg("what", t(what)).arg("seconds", limit.as_secs()).into()),
    }
}

/// 不接受 SHA-1 的 `ssh-rsa`，其他算法用 russh 的默认列表
fn preferred_algorithms() -> Preferred {
    let key = Preferred::DEFAULT.key.iter().filter(|a| !matches!(a, Algorithm::Rsa { hash: None })).cloned().collect();
    Preferred { key: Cow::Owned(key), ..Preferred::DEFAULT }
}

fn connect_error(e: russh::Error) -> AppError {
    match &e {
        russh::Error::NoCommonAlgo { theirs, .. } if theirs.iter().any(|a| a == "ssh-rsa") => {
            t("ssh.hostKeySha1Only").into()
        }
        russh::Error::NoCommonAlgo { kind, theirs, .. } => {
            t("ssh.noCommonAlgorithms").arg("kind", format!("{kind:?}")).arg("offered", theirs.join(", ")).into()
        }
        _ => e.into(),
    }
}

/// 建立连接并校验主机指纹
async fn connect_verified(known: Arc<KnownHosts>, target: &ConnectTarget) -> AppResult<client::Handle<Client>> {
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        // 网络断了但没有收到任何通知时（比如路由器掉线），靠这个发现，最多一分钟左右
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        preferred: preferred_algorithms(),
        ..Default::default()
    });
    let issue = Arc::new(Mutex::new(None));
    let handler = Client {
        host: target.host.clone(),
        port: target.port,
        known,
        issue: issue.clone(),
    };

    let addr = (target.host.as_str(), target.port);
    match tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, addr, handler)).await {
        Err(_) => Err(t("ssh.connectTimeout").arg("seconds", CONNECT_TIMEOUT.as_secs()).into()),
        Ok(Err(e)) => Err(issue.lock().unwrap().take().unwrap_or_else(|| connect_error(e))),
        Ok(Ok(h)) => Ok(h),
    }
}

/// 建立连接，校验主机指纹并完成认证
async fn connect_and_authenticate(
    known: Arc<KnownHosts>,
    target: &ConnectTarget,
    secret: Option<&str>,
    step_timeout: Duration,
) -> AppResult<client::Handle<Client>> {
    let mut handle = connect_verified(known, target).await?;
    with_timeout(step_timeout, "ssh.stepAuth", authenticate(&mut handle, target, secret)).await?;
    Ok(handle)
}

/// 建立连接并打开交互式终端。终端输出通过 `on_data` 以二进制流推送到前端。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    app: AppHandle,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    target: ConnectTarget,
    secret: Option<String>,
    remember: bool,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> AppResult<ConnectResult> {
    // 密码和口令用完就清零（只覆盖本程序自己持有的副本，russh 和 IPC 里的拷贝管不到）
    let typed_secret: Option<Zeroizing<String>> = secret.filter(|s| !s.is_empty()).map(Zeroizing::new);
    if store.vault.metadata_locked() {
        return Err(AppError::vault_locked());
    }
    let secret = match &typed_secret {
        Some(typed) => Some(typed.clone()),
        None => store.saved_secret(&target)?,
    };

    let handle = connect_and_authenticate(store.known.clone(), &target, secret.as_ref().map(|s| s.as_str()), STEP_TIMEOUT).await?;

    // 认证成功后再保存用户新输入的密码。保存失败不影响已经建立的连接，只提示用户
    let mut warnings = Vec::new();
    if let Some(id) = target.host_id.as_deref() {
        // 目标和保存的主机对不上时（比如主机改过地址，这是旧的会话）不能把这个密码记到那台主机名下
        let saved = match typed_secret.as_deref().filter(|_| remember && store.target_is_saved_host(&target)) {
            Some(s) => match store.vault.secret_set(id, s) {
                Ok(()) => true,
                Err(e) => {
                    warnings.push(t("ssh.saveSecretFailed").arg("detail", e.text()));
                    false
                }
            },
            None => false,
        };
        let updated = store.update(id, |h| {
            h.last_connected = Some(now_ts());
            h.save_secret |= saved;
        });
        if let Err(e) = updated {
            warnings.push(t("ssh.updateHostFailed").arg("detail", e.text()));
        }
    }

    let open_shell = async {
        let channel = handle.channel_open_session().await?;
        channel.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await?;
        channel.request_shell(false).await?;
        Ok(channel)
    };
    let channel = with_timeout(STEP_TIMEOUT, "ssh.stepShell", open_shell).await?;

    let (tx, rx) = mpsc::unbounded_channel();
    let id = uuid::Uuid::new_v4().to_string();
    sessions.0.lock().unwrap().insert(
        id.clone(),
        Arc::new(Session {
            handle,
            tx,
            sftp: Default::default(),
            temps: store.server_temps(&target.username, &target.host, target.port),
        }),
    );

    let session_id = id.clone();
    tokio::spawn(async move {
        let reason = run_shell(channel, rx, move |data| {
            let _ = on_data.send(InvokeResponseBody::Raw(data));
        })
        .await;

        if let Some(s) = app.state::<Sessions>().remove(&session_id) {
            let _ = s.handle.disconnect(Disconnect::ByApplication, "", "en").await;
        }
        let lost = reason.code == "ssh.connectionLost";
        let _ = app.emit("ssh-closed", ClosedEvent { session_id, reason, lost });
    });

    Ok(ConnectResult { session_id: id, warnings })
}

/// 终端通道的收发循环。输出交给 `on_output`，返回结束原因。
///
/// 输入由单独的任务发送：对端的接收窗口用完时，发送会一直等待。如果在同一个循环里等，
/// 就没人读取输出；而服务器在输出发不出去时也不再读取输入（粘贴很大的内容再被回显时就是这样），
/// 双方互相等待，终端卡死。
///
/// 输出按“信用”发送：已发给界面、但界面还没确认处理完的字节超过 `OUTPUT_WINDOW` 就不再读取，
/// 服务器随之放慢。上限由后端保证，界面再忙也不会积压更多。
async fn run_shell(
    channel: SshChannel<client::Msg>,
    mut rx: mpsc::UnboundedReceiver<ShellCmd>,
    on_output: impl Fn(Vec<u8>),
) -> Text {
    let (mut read, write) = channel.split();
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let mut writer = Box::pin(write.make_writer());
    let input_task = tokio::spawn(async move {
        while let Some(data) = input_rx.recv().await {
            if writer.write_all(&data).await.is_err() || writer.flush().await.is_err() {
                return;
            }
        }
    });

    let mut unacked = 0usize;
    let mut exit_code = None;
    let mut exit_signal = None;
    // 合并输出时读到的非数据消息，下一轮处理
    let mut held = None;
    let reason = 'session: loop {
        let msg = match held.take() {
            Some(msg) => msg,
            None => tokio::select! {
                cmd = rx.recv() => {
                    match cmd {
                        Some(ShellCmd::Data(d)) => {
                            if input_tx.send(d).is_err() {
                                break 'session t("ssh.connectionLost");
                            }
                        }
                        Some(ShellCmd::Resize(c, r)) => {
                            let _ = write.window_change(c, r, 0, 0).await;
                        }
                        Some(ShellCmd::Ack(n)) => unacked = unacked.saturating_sub(n),
                        Some(ShellCmd::Close) | None => {
                            // 不读取时通道的缓冲可能是满的，关闭请求发不出去，所以设时限
                            let _ = tokio::time::timeout(Duration::from_secs(2), write.close()).await;
                            break 'session t("ssh.sessionClosed");
                        }
                    }
                    continue;
                }
                msg = read.wait(), if unacked < OUTPUT_WINDOW => msg,
            },
        };
        let msg_was_close = matches!(msg, Some(ChannelMsg::Close));
        match msg {
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                // 把已经到达的小块合并成一条消息：真实的 sshd 每次只发约 4 KB，逐条发给界面开销很大。
                // 时限为零，没有更多数据就立即发送，不增加交互延迟
                let mut batch = data.to_vec();
                while batch.len() < OUTPUT_BATCH {
                    match tokio::time::timeout(Duration::ZERO, read.wait()).await {
                        Ok(Some(ChannelMsg::Data { data })) | Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                            batch.extend_from_slice(&data);
                        }
                        Ok(other) => {
                            held = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                unacked += batch.len();
                on_output(batch);
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
            Some(ChannelMsg::ExitSignal { signal_name, .. }) => exit_signal = Some(signal_name),
            Some(ChannelMsg::Close) | None => {
                break 'session match (exit_code, &exit_signal, &msg_was_close) {
                    (Some(c), _, _) => t("ssh.shellExited").arg("code", c),
                    (None, Some(signal), _) => t("ssh.shellSignal").arg("signal", format!("{signal:?}")),
                    (None, None, true) => t("ssh.serverClosed"),
                    (None, None, false) => t("ssh.connectionLost"),
                };
            }
            _ => {}
        }
    };
    input_task.abort();
    reason
}

#[tauri::command]
pub fn ssh_write(sessions: State<'_, Sessions>, session_id: String, data: String) -> AppResult<()> {
    let _ = sessions.get(&session_id)?.tx.send(ShellCmd::Data(data.into_bytes()));
    Ok(())
}

/// 服务器不用 UTF-8 时的输入：界面已经按服务器的编码转换好了
#[tauri::command]
pub fn ssh_write_bytes(sessions: State<'_, Sessions>, session_id: String, data: Vec<u8>) -> AppResult<()> {
    let _ = sessions.get(&session_id)?.tx.send(ShellCmd::Data(data));
    Ok(())
}

#[tauri::command]
pub fn ssh_resize(sessions: State<'_, Sessions>, session_id: String, cols: u32, rows: u32) -> AppResult<()> {
    let _ = sessions.get(&session_id)?.tx.send(ShellCmd::Resize(cols, rows));
    Ok(())
}

/// 界面处理完了这么多字节的输出，后端可以继续读取
#[tauri::command]
pub fn ssh_ack(sessions: State<'_, Sessions>, session_id: String, bytes: usize) -> AppResult<()> {
    let _ = sessions.get(&session_id)?.tx.send(ShellCmd::Ack(bytes));
    Ok(())
}

/// 这个连接所在机器的名字。用单独的通道运行 `uname -n`，不经过终端。
/// 服务器不允许运行命令、超时或者结果不像主机名时返回 `None`。
#[tauri::command]
pub async fn ssh_hostname(sessions: State<'_, Sessions>, session_id: String) -> AppResult<Option<String>> {
    let session = sessions.get(&session_id)?;
    let query = async {
        let mut channel = session.handle.channel_open_session().await?;
        channel.exec(true, "uname -n").await?;
        let mut output = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } if output.len() < 512 => output.extend_from_slice(&data),
                ChannelMsg::Failure | ChannelMsg::Close | ChannelMsg::Eof => break,
                _ => {}
            }
        }
        let _ = channel.close().await;
        Ok::<_, AppError>(output)
    };
    let output = tokio::time::timeout(Duration::from_secs(5), query).await;
    Ok(match output {
        Ok(Ok(output)) => hostname_from_output(&output),
        _ => None,
    })
}

fn hostname_from_output(output: &[u8]) -> Option<String> {
    let name = std::str::from_utf8(output).ok()?.trim();
    let valid = !name.is_empty() && name.len() <= 255 && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
    valid.then(|| name.to_string())
}

#[tauri::command]
pub fn ssh_close(sessions: State<'_, Sessions>, session_id: String) {
    if let Ok(s) = sessions.get(&session_id) {
        let _ = s.tx.send(ShellCmd::Close);
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        future::pending,
        sync::atomic::{AtomicUsize, Ordering},
        time::Instant,
    };

    use russh::{
        kex,
        keys::{
            agent::{
                client::AgentClient,
                server::{serve, Agent as AgentPolicy, MessageType},
            },
            ssh_key::LineEnding,
            EcdsaCurve, PrivateKey,
        },
        server::{self, Auth},
    };
    use tokio::net::TcpListener;

    use super::*;
    use crate::store::Store;

    const PASSWORD: &str = "correct horse";
    const HANG_USER: &str = "hang";

    struct TestHandler;

    impl server::Handler for TestHandler {
        type Error = russh::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
            if user == HANG_USER {
                pending::<()>().await;
            }
            Ok(if password == PASSWORD { Auth::Accept } else { Auth::reject() })
        }

        async fn auth_publickey(&mut self, _user: &str, key: server::VerifiedPublicKey<'_>) -> Result<Auth, Self::Error> {
            Ok(if key.public_key.algorithm() == Algorithm::Ed25519 { Auth::Accept } else { Auth::reject() })
        }
    }

    /// 不再接收输入、但持续输出的服务器。
    ///
    /// 真实的 sshd 在输出发不出去时会停止读取输入（比如粘贴很大的内容后又被回显回来），
    /// 此时客户端的发送会一直等待。这里直接让服务器几乎不再补充接收窗口来达到同样的状态。
    struct SlowReaderHandler {
        handle: Option<server::Handle>,
        output_bytes: usize,
    }

    impl server::Handler for SlowReaderHandler {
        type Error = russh::Error;

        async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: SshChannel<server::Msg>,
            reply: server::ChannelOpenHandle,
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            self.handle = Some(session.handle());
            reply.accept().await;
            Ok(())
        }

        #[allow(clippy::too_many_arguments)]
        async fn pty_request(
            &mut self,
            channel: russh::ChannelId,
            _term: &str,
            _cols: u32,
            _rows: u32,
            _pw: u32,
            _ph: u32,
            _modes: &[(russh::Pty, u32)],
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            Ok(())
        }

        async fn shell_request(&mut self, channel: russh::ChannelId, session: &mut server::Session) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            let handle = self.handle.clone().expect("已打开会话");
            let total = self.output_bytes;
            tokio::spawn(async move {
                let chunk = vec![b'o'; 16 * 1024];
                let mut sent = 0;
                while sent < total {
                    // 会等待客户端的接收窗口
                    if handle.data(channel, chunk.clone()).await.is_err() {
                        return;
                    }
                    sent += chunk.len();
                }
            });
            Ok(())
        }

        fn adjust_window(&mut self, _channel: russh::ChannelId, _current: u32) -> u32 {
            2
        }
    }

    async fn start_slow_reader_server(key: PrivateKey, output_bytes: usize) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // russh 的收发循环每轮都会等缓冲写进 TCP。两端都是 russh 时，如果同时往对方塞几 MB，
        // 两边都卡在写上谁也不读，就会死锁（真实的 OpenSSH 不会）。窗口调小，让在途的输入放得进 TCP 缓冲
        let config = Arc::new(server::Config { keys: vec![key], window_size: 64 * 1024, ..Default::default() });
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let config = config.clone();
                tokio::spawn(async move {
                    let handler = SlowReaderHandler { handle: None, output_bytes };
                    if let Ok(session) = server::run_stream(config, stream, handler).await {
                        let _ = session.await;
                    }
                });
            }
        });
        port
    }
    fn host_key() -> PrivateKey {
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
    }

    /// 启动只做认证的服务器，返回端口
    async fn start_server(key: PrivateKey) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let config = config.clone();
                tokio::spawn(async move {
                    if let Ok(session) = server::run_stream(config, stream, TestHandler).await {
                        let _ = session.await;
                    }
                });
            }
        });
        port
    }

    struct Env {
        dir: PathBuf,
        store: Store,
    }

    impl Env {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("termipaw-ssh-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            let store = Store::new(dir.clone(), None);
            Self { dir, store }
        }

        fn known(&self) -> Arc<KnownHosts> {
            self.store.known.clone()
        }

        async fn connect(&self, target: &ConnectTarget, secret: Option<&str>) -> AppResult<client::Handle<Client>> {
            connect_and_authenticate(self.known(), target, secret, Duration::from_secs(5)).await
        }

        /// 接受服务器当前的指纹
        async fn trust(&self, target: &ConnectTarget) {
            match self.connect(target, None).await.err() {
                Some(AppError::UnknownHostKey { host, port, .. }) => self.store.known.trust_pending(&host, port).unwrap(),
                other => panic!("应该要求确认指纹：{other:?}"),
            }
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn target(port: u16, user: &str) -> ConnectTarget {
        ConnectTarget {
            host_id: None,
            host: "127.0.0.1".into(),
            port,
            username: user.into(),
            auth: AuthMethod::Password,
            key_path: None,
        }
    }

    #[tokio::test]
    async fn first_connection_asks_to_verify_the_host_key() {
        let env = Env::new();
        let t = target(start_server(host_key()).await, "u");
        match env.connect(&t, Some(PASSWORD)).await.err() {
            Some(AppError::UnknownHostKey { fingerprint, key_type, .. }) => {
                assert!(fingerprint.starts_with("SHA256:"), "{fingerprint}");
                assert_eq!(key_type, "ssh-ed25519");
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn trusted_host_connects_with_the_right_password() {
        let env = Env::new();
        let t = target(start_server(host_key()).await, "u");
        env.trust(&t).await;
        env.connect(&t, Some(PASSWORD)).await.map(|_| ()).unwrap();
    }

    #[tokio::test]
    async fn changed_host_key_is_refused() {
        let env = Env::new();
        let listener_key = host_key();
        let t = target(start_server(listener_key).await, "u");
        env.trust(&t).await;

        // 同一地址换了主机密钥：把记录改成另一把密钥来模拟
        env.store.known.stage("127.0.0.1", t.port, host_key().public_key());
        env.store.known.trust_pending("127.0.0.1", t.port).unwrap();
        assert!(matches!(env.connect(&t, Some(PASSWORD)).await.err(), Some(AppError::HostKeyChanged { .. })));
    }

    /// 校验失败时不能把密码发给服务器：认证发生在指纹校验之后
    #[tokio::test]
    async fn untrusted_host_never_reaches_authentication() {
        let env = Env::new();
        let t = target(start_server(host_key()).await, HANG_USER);
        // 服务器在 hang 用户认证时永远不返回；如果走到了认证，这里会超时而不是报指纹问题
        assert!(matches!(env.connect(&t, Some(PASSWORD)).await.err(), Some(AppError::UnknownHostKey { .. })));
    }

    #[tokio::test]
    async fn corrupt_known_hosts_blocks_the_connection() {
        let dir = std::env::temp_dir().join(format!("termipaw-ssh-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("known_hosts.json"), "broken").unwrap();
        let store = Store::new(dir.clone(), None);
        let t = target(start_server(host_key()).await, "u");
        let result = connect_and_authenticate(store.known.clone(), &t, Some(PASSWORD), Duration::from_secs(5)).await;
        assert!(matches!(result.err(), Some(AppError::KnownHostsBlocked { can_reset: true, .. })));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn wrong_or_missing_password_is_reported() {
        let env = Env::new();
        let t = target(start_server(host_key()).await, "u");
        env.trust(&t).await;
        assert!(matches!(env.connect(&t, Some("wrong")).await.err(), Some(AppError::AuthFailed { .. })));
        assert!(matches!(env.connect(&t, None).await.err(), Some(AppError::SecretRequired { .. })));
    }

    #[tokio::test]
    async fn stalled_authentication_times_out() {
        let env = Env::new();
        let t = target(start_server(host_key()).await, HANG_USER);
        env.trust(&t).await;
        let started = Instant::now();
        let result = connect_and_authenticate(env.known(), &t, Some(PASSWORD), Duration::from_millis(300)).await;
        match result.err() {
            Some(e @ AppError::Message(_)) => assert!(e.code() == "ssh.stepTimeout" && e.to_string().contains("what=ssh.stepAuth"), "{e}"),
            other => panic!("{other:?}"),
        }
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn private_key_login_with_and_without_passphrase() {
        let env = Env::new();
        let port = start_server(host_key()).await;
        let mut t = target(port, "u");
        env.trust(&t).await;
        t.auth = AuthMethod::Key;

        // 没有设置私钥
        assert!(matches!(env.connect(&t, None).await.err(), Some(AppError::Message { .. })));

        // 未加密的私钥
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let plain = env.dir.join("id_plain");
        fs::write(&plain, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
        t.key_path = Some(plain.to_string_lossy().into_owned());
        env.connect(&t, None).await.map(|_| ()).unwrap();

        // 加密的私钥
        let encrypted = key.encrypt(&mut rand::rng(), "passphrase").unwrap();
        let locked = env.dir.join("id_locked");
        fs::write(&locked, encrypted.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
        t.key_path = Some(locked.to_string_lossy().into_owned());
        assert!(matches!(env.connect(&t, None).await.err(), Some(AppError::SecretRequired { .. })));
        assert!(matches!(env.connect(&t, Some("wrong")).await.err(), Some(AppError::AuthFailed { .. })));
        env.connect(&t, Some("passphrase")).await.map(|_| ()).unwrap();

        // 服务器拒绝的私钥
        let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 }).unwrap();
        let rejected = env.dir.join("id_rejected");
        fs::write(&rejected, other.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
        t.key_path = Some(rejected.to_string_lossy().into_owned());
        assert!(matches!(env.connect(&t, None).await.err(), Some(AppError::AuthFailed { .. })));
    }

    #[test]
    fn sha1_rsa_is_never_offered() {
        let p = preferred_algorithms();
        assert!(!p.key.contains(&Algorithm::Rsa { hash: None }));
        // 其他 RSA 算法不受影响
        assert!(p.key.contains(&Algorithm::Rsa { hash: Some(HashAlg::Sha256) }));
        // strict KEX 的声明还在（防 Terrapin 攻击）
        assert!(p.kex.contains(&kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT));
    }

    #[test]
    fn missing_common_algorithm_explains_what_to_do() {
        let error = |theirs: &[&str]| {
            let e = russh::Error::NoCommonAlgo {
                kind: russh::AlgorithmKind::Key,
                ours: vec![],
                theirs: theirs.iter().map(|s| s.to_string()).collect(),
            };
            connect_error(e).to_string()
        };
        assert!(error(&["ssh-rsa"]).starts_with("ssh.hostKeySha1Only"));
        assert!(error(&["ssh-dss"]).contains("ssh-dss"));
    }

    // ---------- SSH Agent ----------

    /// 服务器只接受 Ed25519（见 `TestHandler`）
    async fn agent_holding<A: AgentPolicy + Sync>(keys: &[PrivateKey], policy: A) -> agent::DynAgent {
        let (client_side, server_side) = tokio::io::duplex(1 << 16);
        tokio::spawn(serve(futures::stream::iter([Ok(server_side)]), policy));
        let mut client = AgentClient::connect(client_side).dynamic();
        for key in keys {
            client.add_identity(key, &[]).await.unwrap();
        }
        client
    }

    async fn agent_login(env: &Env, port: u16, agents: Vec<agent::DynAgent>) -> AppResult<()> {
        let t = target(port, "u");
        if let Err(AppError::UnknownHostKey { .. }) = connect_verified(env.known(), &t).await {
            env.store.known.trust_pending("127.0.0.1", port).unwrap();
        }
        let mut handle = connect_verified(env.known(), &t).await?;
        agent::authenticate_with(&mut handle, "u", agents).await
    }

    fn random_key(algorithm: Algorithm) -> PrivateKey {
        PrivateKey::random(&mut rand::rng(), algorithm).unwrap()
    }

    fn ecdsa_key() -> PrivateKey {
        random_key(Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 })
    }

    #[tokio::test]
    async fn agent_login_tries_keys_until_one_is_accepted() {
        let env = Env::new();
        let port = start_server(host_key()).await;
        let agent = agent_holding(&[ecdsa_key(), random_key(Algorithm::Ed25519)], ()).await;
        agent_login(&env, port, vec![agent]).await.unwrap();
    }

    #[tokio::test]
    async fn agent_login_falls_through_to_the_next_agent() {
        let env = Env::new();
        let port = start_server(host_key()).await;
        let first = agent_holding(&[ecdsa_key()], ()).await;
        let second = agent_holding(&[random_key(Algorithm::Ed25519)], ()).await;
        agent_login(&env, port, vec![first, second]).await.unwrap();
    }

    #[tokio::test]
    async fn agent_login_explains_each_failure() {
        let env = Env::new();
        let port = start_server(host_key()).await;

        let error = agent_login(&env, port, vec![]).await.unwrap_err().to_string();
        assert!(error.starts_with("agent.notRunning"), "{error}");

        let empty = agent_holding(&[], ()).await;
        let error = agent_login(&env, port, vec![empty]).await.unwrap_err().to_string();
        assert!(error.starts_with("agent.empty"), "{error}");

        let rejected = agent_holding(&[ecdsa_key(), ecdsa_key()], ()).await;
        match agent_login(&env, port, vec![rejected]).await.unwrap_err() {
            AppError::AuthFailed(text) => assert_eq!(text, t("agent.allRejected").arg("count", 2usize)),
            other => panic!("{other:?}"),
        }
    }

    #[derive(Clone)]
    struct RefusesToSign;

    impl AgentPolicy for RefusesToSign {
        async fn confirm_request(&self, msg: MessageType) -> bool {
            !matches!(msg, MessageType::Sign)
        }
    }

    #[tokio::test]
    async fn agent_refusing_to_sign_is_reported() {
        let env = Env::new();
        let port = start_server(host_key()).await;
        let refusing = agent_holding(&[random_key(Algorithm::Ed25519)], RefusesToSign).await;
        match agent_login(&env, port, vec![refusing]).await.unwrap_err() {
            AppError::AuthFailed(text) => assert_eq!(text.code, "agent.signFailed", "{text}"),
            other => panic!("{other:?}"),
        }
    }

    /// 一个 Agent 拒绝签名时，后面的 Agent 还能接着试
    #[tokio::test]
    async fn agent_refusing_to_sign_does_not_stop_the_next_agent() {
        let env = Env::new();
        let port = start_server(host_key()).await;
        let refusing = agent_holding(&[random_key(Algorithm::Ed25519)], RefusesToSign).await;
        let working = agent_holding(&[random_key(Algorithm::Ed25519)], ()).await;
        agent_login(&env, port, vec![refusing, working]).await.unwrap();
    }

    /// 打开终端并交给 `run_shell`，返回命令发送端、已收到的输出字节数和任务。
    /// `auto_ack` 模拟界面收到就处理完；否则要由测试自己发确认。
    async fn open_shell_task(env: &Env, port: u16, auto_ack: bool) -> (mpsc::UnboundedSender<ShellCmd>, Arc<AtomicUsize>, tokio::task::JoinHandle<Text>) {
        let t = target(port, "u");
        env.trust(&t).await;
        let handle = env.connect(&t, Some("any")).await.unwrap();
        let channel = handle.channel_open_session().await.unwrap();
        channel.request_pty(false, "xterm", 80, 24, 0, 0, &[]).await.unwrap();
        channel.request_shell(false).await.unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let received = Arc::new(AtomicUsize::new(0));
        let counter = received.clone();
        let acks = tx.clone();
        let task = tokio::spawn(async move {
            let _keep_connection_open = handle;
            run_shell(channel, rx, move |d| {
                counter.fetch_add(d.len(), Ordering::SeqCst);
                if auto_ack {
                    let _ = acks.send(ShellCmd::Ack(d.len()));
                }
            })
            .await
        });
        (tx, received, task)
    }

    /// 发送被卡住（服务器不再接收输入）时，仍然要继续读取输出，否则终端会卡死
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn output_keeps_flowing_while_a_large_paste_is_blocked() {
        const PASTE: usize = 16 << 20;
        const OUTPUT: usize = 8 << 20;
        let env = Env::new();
        let (tx, received, task) = open_shell_task(&env, start_slow_reader_server(host_key(), OUTPUT).await, true).await;

        tx.send(ShellCmd::Data(vec![b'x'; PASTE])).unwrap();
        let all_output = tokio::time::timeout(Duration::from_secs(30), async {
            while received.load(Ordering::SeqCst) < OUTPUT {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(all_output.is_ok(), "粘贴后卡住了：只收到 {} / {OUTPUT} 字节的输出", received.load(Ordering::SeqCst));

        // 发送还卡着时，关闭会话也要能及时完成
        tx.send(ShellCmd::Close).unwrap();
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap(), t("ssh.sessionClosed"));
    }

    /// 界面不确认，后端读到上限就停；确认后继续；停着的时候关闭会话不会卡住
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn unacknowledged_output_is_bounded_and_acks_resume_it() {
        const OUTPUT: usize = 24 << 20;
        let env = Env::new();
        let (tx, received, task) = open_shell_task(&env, start_slow_reader_server(host_key(), OUTPUT).await, false).await;

        tokio::time::sleep(Duration::from_millis(800)).await;
        let stalled = received.load(Ordering::SeqCst);
        assert!(stalled > 0, "应该先收到一些输出");
        assert!(stalled <= OUTPUT_WINDOW + 2 * OUTPUT_BATCH, "没有确认时积压了 {stalled} 字节");
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(received.load(Ordering::SeqCst), stalled, "到上限后还在读取");

        let mut acked = 0;
        let all = tokio::time::timeout(Duration::from_secs(30), async {
            while received.load(Ordering::SeqCst) < OUTPUT {
                let now = received.load(Ordering::SeqCst);
                if now > acked {
                    tx.send(ShellCmd::Ack(now - acked)).unwrap();
                    acked = now;
                }
                assert!(now - acked <= OUTPUT_WINDOW + 2 * OUTPUT_BATCH);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(all.is_ok(), "确认后没有继续收到输出：{} / {OUTPUT}", received.load(Ordering::SeqCst));
        tx.send(ShellCmd::Close).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();

        // 停在上限时直接关闭
        let (tx, received, task) = open_shell_task(&env, start_slow_reader_server(host_key(), OUTPUT).await, false).await;
        tokio::time::sleep(Duration::from_millis(800)).await;
        let stalled_at = received.load(Ordering::SeqCst);
        tx.send(ShellCmd::Close).unwrap();
        let reason = tokio::time::timeout(Duration::from_secs(5), task).await.expect("停在上限时关闭会话卡住了").unwrap();
        assert_eq!(reason, t("ssh.sessionClosed"));
        assert!(stalled_at < OUTPUT);
    }

    /// 小块输出会被合并，但总量不能少（内容和顺序由端到端测试校验）
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn merged_output_keeps_every_byte() {
        let env = Env::new();
        let (tx, received, task) = open_shell_task(&env, start_slow_reader_server(host_key(), 4 << 20).await, true).await;
        let got_all = tokio::time::timeout(Duration::from_secs(20), async {
            while received.load(Ordering::SeqCst) < 4 << 20 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(got_all.is_ok(), "{}", received.load(Ordering::SeqCst));
        assert_eq!(received.load(Ordering::SeqCst), 4 << 20);
        tx.send(ShellCmd::Close).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
    }
}
