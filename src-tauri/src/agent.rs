//! 用 ssh-agent / Pageant 里的私钥登录。私钥不离开 Agent，这里只转发签名请求。

use russh::{
    client,
    keys::{
        agent::{
            client::{AgentClient, AgentStream},
            AgentIdentity,
        },
        Algorithm,
    },
};

use crate::{
    error::{AppError, AppResult},
    i18n::t,
    ssh::Client,
};

pub type DynAgent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

/// 调试版可以指定一个单独的管道，端到端测试不会碰到系统的 Agent
#[cfg(windows)]
fn test_pipe() -> Option<std::ffi::OsString> {
    std::env::var_os("TERMIPAW_AGENT_PIPE").filter(|_| cfg!(debug_assertions))
}

/// 连接系统里所有可用的 Agent，没有运行的就跳过
#[cfg(windows)]
async fn connect_agents() -> Vec<DynAgent> {
    if let Some(pipe) = test_pipe() {
        return AgentClient::connect_named_pipe(pipe).await.map(|a| a.dynamic()).into_iter().collect();
    }
    let mut agents = Vec::new();
    if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        agents.push(agent.dynamic());
    }
    if let Ok(agent) = AgentClient::connect_pageant().await {
        agents.push(agent.dynamic());
    }
    agents
}

#[cfg(unix)]
async fn connect_agents() -> Vec<DynAgent> {
    AgentClient::connect_env().await.map(|a| a.dynamic()).into_iter().collect()
}

pub async fn authenticate(handle: &mut client::Handle<Client>, user: &str) -> AppResult<()> {
    authenticate_with(handle, user, connect_agents().await).await
}

/// 依次尝试各个 Agent 里的私钥，第一把被接受就结束
pub async fn authenticate_with(handle: &mut client::Handle<Client>, user: &str, agents: Vec<DynAgent>) -> AppResult<()> {
    let mut reachable = false;
    let mut offered = 0usize;
    let mut skipped_sha1 = 0;
    let mut sign_error = None;

    for mut agent in agents {
        // Pageant 没有运行时要到这一步才会失败
        let Ok(identities) = agent.request_identities().await else {
            continue;
        };
        reachable = true;
        for identity in identities {
            let hash = if matches!(identity.public_key().algorithm(), Algorithm::Rsa { .. }) {
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                // 没有 SHA-2 可用时只能用 SHA-1 签名，不支持，跳过这把
                if hash.is_none() {
                    skipped_sha1 += 1;
                    continue;
                }
                hash
            } else {
                None
            };
            offered += 1;
            let result = match identity {
                AgentIdentity::PublicKey { key, .. } => handle.authenticate_publickey_with(user, key, hash, &mut agent).await,
                AgentIdentity::Certificate { certificate, .. } => handle.authenticate_certificate_with(user, certificate, hash, &mut agent).await,
            };
            match result {
                Ok(r) if r.success() => return Ok(()),
                Ok(_) => {}
                // Agent 拒绝签名（比如用户没有确认）时，继续试下一把
                Err(e) => sign_error = Some(e.to_string()),
            }
            if handle.is_closed() {
                return Err(AppError::AuthFailed(t("agent.tooManyTries").arg("offered", offered)));
            }
        }
    }

    Err(match (reachable, offered, skipped_sha1, sign_error) {
        (false, ..) => t("agent.notRunning").into(),
        (_, 0, 0, _) => t("agent.empty").into(),
        (_, 0, _, _) => t("agent.onlySha1").into(),
        (_, _, _, Some(e)) => AppError::AuthFailed(t("agent.signFailed").detail(e)),
        (_, n, _, None) => AppError::AuthFailed(t("agent.allRejected").arg("count", n)),
    })
}
