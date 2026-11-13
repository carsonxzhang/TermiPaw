// 界面能调用的后端接口：不再接受本地路径、不能指定要信任的密钥、不能直接弹文件对话框。
// 这里模拟的是界面被攻破后会做的事，所以直接调用底层的 invoke，而不是点界面。

const call = (app, cmd, args = {}) =>
  app.js(`(async () => {
    const internals = window.__TAURI_INTERNALS__;
    const args = ${JSON.stringify(args)};
    // 需要进度通道的命令：随便注册一个回调
    if (args.onProgress === "CHANNEL") args.onProgress = "__CHANNEL__:" + internals.transformCallback(() => {});
    try {
      await internals.invoke(${JSON.stringify(cmd)}, args);
      return "ok";
    } catch (e) {
      // 后端的错误是代码和参数（见 src-tauri/src/i18n.rs），插件自己的错误是文字
      return typeof e === "string" ? e : (e?.code ?? JSON.stringify(e));
    }
  })()`);

export async function securitySuite(app, { check }) {
  const base = { sessionId: "none", transferId: "t", remote: "/x", overwrite: true, onProgress: "CHANNEL" };

  // ---- 上传和下载只认令牌 ----
  const oldStyle = await call(app, "sftp_upload", { ...base, local: "C:\\Windows\\win.ini" });
  check("上传：旧的传路径方式被拒绝", oldStyle !== "ok" && /localToken/.test(oldStyle), oldStyle);

  const asToken = await call(app, "sftp_upload", { ...base, localToken: "C:\\Windows\\win.ini" });
  check("上传：把路径当令牌传被拒绝", asToken === "grant.invalid", asToken);

  const download = await call(app, "sftp_download", { sessionId: "none", transferId: "t", remote: "/x", localToken: "C:\\Users\\Public\\overwrite-me.txt", onProgress: "CHANNEL" });
  check("下载：把路径当令牌传被拒绝", download === "grant.invalid", download);

  // ---- 不能让后端信任没出示过的密钥 ----
  const withKey = await call(app, "known_hosts_trust", { host: "example.com", port: 22, key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" });
  check("指纹：没有待确认的指纹时不能信任", withKey === "knownHosts.noPending", withKey);

  // ---- 不能直接弹文件对话框或读写文件 ----
  for (const cmd of ["plugin:dialog|open", "plugin:dialog|save", "plugin:fs|read_file", "plugin:opener|open_url", "plugin:opener|open_path"]) {
    const result = await call(app, cmd, { options: {}, path: "C:\\Windows\\win.ini", url: "https://example.com" });
    check(`界面不能直接调用 ${cmd}`, result !== "ok" && /not allowed|not found|Command|permission/i.test(result), result);
  }

  // ---- 链接只放行 http 和 https ----
  for (const url of ["file:///C:/Windows/System32/calc.exe", "ms-settings:privacy", "javascript:alert(1)", "C:\\Windows\\notepad.exe"]) {
    const result = await call(app, "open_url", { url });
    check(`open_url 拒绝 ${url}`, result !== "ok", result);
  }

  // ---- 调试用的模拟拖拽在界面里能用（调试版），发布版会拒绝（见 release 检查）----
}
