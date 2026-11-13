fn main() {
    // tauri-build 不会因图标变化而重新生成 exe 资源，否则换图标后 exe 和任务栏仍是旧图标
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
