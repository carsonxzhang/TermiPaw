//! 端到端测试用的 SSH Agent：在单独的命名管道上提供服务，不碰系统的 Agent。
//!
//! 用法：`test_agent <管道名> [私钥文件...]`，准备好后输出一行 `ready`。

#[cfg(windows)]
#[tokio::main]
async fn main() {
    use russh::keys::{
        agent::{client::AgentClient, server::serve},
        load_secret_key,
    };
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut args = std::env::args().skip(1);
    let pipe = args.next().expect("缺少管道名");

    // 接受一个连接之前先创建下一个实例，这样客户端随时都连得上
    let first = ServerOptions::new().first_pipe_instance(true).create(&pipe).expect("无法创建管道");
    let name = pipe.clone();
    let connections = Box::pin(futures::stream::unfold(first, move |server| {
        let name = name.clone();
        async move {
            server.connect().await.ok()?;
            let next = ServerOptions::new().create(&name).ok()?;
            Some((Ok(server), next))
        }
    }));
    tokio::spawn(serve(connections, ()));

    let mut client = AgentClient::connect_named_pipe(&pipe).await.expect("无法连接管道");
    for path in args {
        let key = load_secret_key(&path, None).expect("无法读取私钥");
        client.add_identity(&key, &[]).await.expect("无法加入私钥");
    }
    println!("ready");
    std::future::pending::<()>().await;
}

#[cfg(not(windows))]
fn main() {
    eprintln!("这个测试工具只支持 Windows");
}
