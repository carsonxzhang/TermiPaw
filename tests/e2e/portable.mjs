// 绿色版：数据都在程序旁边的 TermiPaw_Data\，不碰 %APPDATA% 和 %LOCALAPPDATA% 下的 dev.termipaw.client，
// 程序所在的文件夹写不进去时有明确的提示。这里的程序是调试版的 exe 复制到临时文件夹里运行，一个开关都不设。

import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appExe, launchApp, removeDir, sleep, tempDir } from "./harness.mjs";

/** 目录里每个文件的路径、大小和修改时间，用来看有没有被动过 */
function snapshot(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const s = statSync(path);
        out.push(`${path}|${s.size}|${s.mtimeMs}`);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** 系统对话框的标题，读到后关掉。没有对话框时返回 null */
function readDialogTitle(pid) {
  const script = resolve("tests/e2e/dialog-title.ps1");
  return new Promise((done) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-AppPid", String(pid)], (err, stdout) => {
      if (err || !stdout.trim()) return done(null);
      done(String.fromCharCode(...stdout.trim().split(",").map(Number)));
    });
  });
}

export async function portableSuite({ check }) {
  const work = tempDir();
  const appData = join(process.env.APPDATA, "dev.termipaw.client");
  const localData = join(process.env.LOCALAPPDATA, "dev.termipaw.client");
  const before = { appData: snapshot(appData), localData: snapshot(localData) };
  let app;
  try {
    // ---- 数据都在程序旁边 ----
    const folder = join(work, "我的 TermiPaw");
    mkdirSync(folder);
    // 故意换个名字：数据位置只看程序在哪个文件夹，不看文件名
    const exe = join(folder, "tp-portable.exe");
    copyFileSync(appExe, exe);

    app = await launchApp(folder, {}, { exe, portable: true, lang: "en-US" });
    const data = join(folder, "TermiPaw_Data");
    check("数据目录在程序旁边", existsSync(data) && app.dataDir === data);
    check("没有留下写入测试用的文件", !readdirSync(data).some((n) => n.startsWith(".write-test")), readdirSync(data).join());
    check("界面数据在 TermiPaw_Data\\webview 里", await (async () => {
      for (let i = 0; i < 50; i++) {
        if (existsSync(join(data, "webview", "EBWebView"))) return true;
        await sleep(100);
      }
      return false;
    })());

    // 存一台主机、改一个界面设置，重启后都还在
    const host = { id: "p1", name: "portable-host", group: "", host: "127.0.0.1", port: 22, username: "demo", auth: "agent", saveSecret: false };
    const saved = await app.js(`window.__TAURI_INTERNALS__.invoke("hosts_save", { host: ${JSON.stringify(host)}, secret: null }).then(() => "ok", (e) => JSON.stringify(e))`);
    check("保存主机", saved === "ok", saved);
    check("主机文件在 data 里", existsSync(join(data, "hosts.json")) && readFileSync(join(data, "hosts.json"), "utf8").includes("portable-host"));
    await app.openMenu(0);
    await app.waitFor(`!!document.querySelector(".settings-language")`);
    await sleep(300);
    await app.js(`(() => { const s = document.querySelector(".settings-language"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "ja"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await sleep(500);
    await app.stop();
    await sleep(1500);

    app = await launchApp(folder, {}, { exe, portable: true, lang: "en-US" });
    check("重启后主机还在", (await app.js(`document.body.textContent`)).includes("portable-host"));
    check("重启后界面设置还在（语言）", (await app.js(`document.documentElement.lang`)) === "ja");
    await app.stop();
    app = undefined;
    await sleep(1500);

    // ---- 系统的目录没有被动过 ----
    const after = { appData: snapshot(appData), localData: snapshot(localData) };
    check("%APPDATA%\\dev.termipaw.client 没有变化", JSON.stringify(after.appData) === JSON.stringify(before.appData), `${before.appData.length} → ${after.appData.length}`);
    check("%LOCALAPPDATA%\\dev.termipaw.client 没有变化", JSON.stringify(after.localData) === JSON.stringify(before.localData), `${before.localData.length} → ${after.localData.length}`);

    // ---- 写不进去时有明确的提示，不会换个地方存 ----
    const locked = join(work, "locked");
    mkdirSync(locked);
    const lockedExe = join(locked, "termipaw.exe");
    copyFileSync(appExe, lockedExe);
    // 同名的是文件，数据目录建不出来
    writeFileSync(join(locked, "TermiPaw_Data"), "not a folder");
    const env = { ...process.env };
    delete env.TERMIPAW_DATA_DIR;
    delete env.WEBVIEW2_USER_DATA_FOLDER;
    const child = spawn(lockedExe, [], { env, stdio: "ignore" });
    const exited = new Promise((res) => child.once("exit", (code) => res(code)));
    const title = await readDialogTitle(child.pid);
    check("写不进去：弹出说明", title === "TermiPaw", String(title));
    const code = await Promise.race([exited, sleep(15000).then(() => "超时")]);
    check("写不进去：关掉说明后程序退出", code === 1, String(code));
    if (code === "超时") child.kill();
    check("写不进去：没有在别处创建数据", !existsSync(join(locked, "TermiPaw_Data", "hosts.json")) && snapshot(appData).length === before.appData.length);
  } finally {
    if (app) await app.stop();
    await sleep(500);
    removeDir(work);
  }
}
