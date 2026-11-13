//! 端到端测试用的“编辑器”：把收到的文件路径记下来就退出，由测试脚本改文件来模拟保存。
//! 这样测试走的是真实的启动流程，又不会弹出真正的编辑器。

use std::io::Write;

fn main() {
    let (Some(log), Some(path)) = (std::env::var_os("TERMIPAW_FAKE_EDITOR_LOG"), std::env::args().nth(1)) else {
        std::process::exit(2);
    };
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(log).expect("打不开记录文件");
    writeln!(file, "{path}").expect("写不了记录文件");
}
