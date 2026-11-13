// 在线更新。程序里跑的是真实的更新插件和签名校验，只是把地址和公钥换成本地服务器和一次性的密钥
// （调试版的开关）。“换掉自己再重新启动”是真的：在复制到临时文件夹的 exe 上做，
// 不会动 target\debug 里刚编译好的程序（程序自己也拒绝在那里替换自己，这一条也有测试）。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { RELEASE_FILE_NAME, latestJson } from "../../scripts/latest-json.mjs";
import { appExe, attachApp, editorExe, launchApp, removeDir, sleep, startServer, tempDir } from "./harness.mjs";

const cli = resolve("node_modules/@tauri-apps/cli/tauri.js");
const NEW = "9.9.9";

function tauriSigner(...args) {
  execFileSync(process.execPath, [cli, "signer", ...args], { stdio: "ignore" });
}

export async function updateSuite({ check }) {
  const work = tempDir();
  const files = join(work, "files");
  mkdirSync(files);
  const log = join(work, "editor.log");
  const logLines = () => (existsSync(log) ? readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean) : []);
  const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

  // ---- 密钥和更新文件 ----
  const generate = (name) => {
    const key = join(work, name);
    tauriSigner("generate", "--ci", "-p", "", "-w", key, "-f");
    return { key, pub: readFileSync(`${key}.pub`, "utf8").trim() };
  };
  const main = generate("main.key");
  const other = generate("other.key");
  const signed = (file, key, version) => {
    tauriSigner("sign", "--private-key-path", key, "-p", "", ...(version ? ["--app-version", version] : []), file);
    return readFileSync(`${file}.sig`, "utf8").trim();
  };
  // 新版本：真正的程序，末尾加一段标记（程序后面多出来的数据不影响运行），换完之后靠它认出是新的
  const MARKER = Buffer.from("TERMIPAW-TEST-NEW-BUILD");
  const newBytes = Buffer.concat([readFileSync(appExe), MARKER]);
  const NAME = RELEASE_FILE_NAME;
  /** 放进自己的子文件夹，文件名保持发布用的名字 */
  const put = (folder, name = NAME, content = newBytes) => {
    mkdirSync(join(files, folder), { recursive: true });
    const path = join(files, folder, name);
    writeFileSync(path, content);
    return path;
  };
  const goodPath = put("good");
  const goodSig = signed(goodPath, main.key, NEW);
  const good = "good/" + NAME;
  const tamperedBytes = Buffer.from(newBytes);
  tamperedBytes[tamperedBytes.length - 1] ^= 0xff;
  put("tampered", NAME, tamperedBytes);
  const otherKeySig = signed(put("otherkey"), other.key, NEW);
  const wrongVersionSig = signed(put("wrongversion"), main.key, "1.0.0");
  const noVersionSig = signed(put("noversion"), main.key);
  // 签名没问题，但签的文件名不是这个版本的发布文件（比如同一把密钥签过的别的文件）
  const badNameSig = signed(put("badname", "TermiPaw_9.9.9_x64-setup.exe"), main.key, NEW);
  const textSig = signed(put("text", NAME, Buffer.from("这不是可执行文件")), main.key, NEW);
  // 签名没问题，文件名也对，但不是 64 位程序（32 位的 editor 示例程序也不是我们的程序，太小）
  const tinySig = signed(put("tiny", NAME, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(2000)])), main.key, NEW);

  // ---- 更新服务器 ----
  let latest = null;
  let hits = 0;
  let downloads = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/latest.json") {
      hits++;
      if (latest === null) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(typeof latest === "string" ? latest : JSON.stringify(latest));
    }
    downloads++;
    const path = join(files, req.url.slice(1));
    if (!existsSync(path)) return res.writeHead(404).end();
    res.writeHead(200);
    res.end(readFileSync(path));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const release = (file, signature, notes = "修复了一些问题", version = NEW) => latestJson({ version, notes, url: `${base}/${file}`, signature });

  const serverDir = join(work, "ssh");
  mkdirSync(serverDir);
  const ssh = await startServer(serverDir);

  const appDir = join(work, "app");
  mkdirSync(join(appDir, "data"), { recursive: true });
  let app;
  const configured = { TERMIPAW_TEST_UPDATE_URL: `${base}/latest.json`, TERMIPAW_TEST_UPDATE_PUBKEY: main.pub };
  const launch = async (env = configured, dir = appDir) => {
    if (app) await app.stop();
    app = await launchApp(dir, { TERMIPAW_FAKE_EDITOR_LOG: log, ...env });
    await app.js(`window.__termipawTest = { terms: [], flows: [], sessions: [], edits: [] }`);
  };
  const invoke = (cmd, args = {}) => app.js(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then((v) => ({ ok: v }), (e) => ({ err: e }))`);
  const hasModal = () => app.js(`!!document.querySelector(".modal")`);
  const updateButton = () => app.js(`!!document.querySelector(".update-available")`);
  const toastSeen = (kind, text) => app.waitFor(`[...document.querySelectorAll(".toast.${kind}")].some((t) => t.textContent.includes(${JSON.stringify(text)}))`, 8000);
  const openAbout = async () => {
    await app.openMenu(2);
    await app.waitFor(`!!document.querySelector(".update-section")`);
    await sleep(300);
  };
  const openSettings = async () => {
    await app.openMenu(0);
    await app.waitFor(`!!document.querySelector(".update-startup")`);
    await sleep(300);
  };
  const closeTopModal = async () => {
    await app.key("Escape", "Escape", 27);
    await sleep(200);
  };
  /** 在关于窗口里手动检查。有更新时对话框会自己打开 */
  const checkNow = async () => {
    await openAbout();
    await app.js(`document.querySelector(".update-check").click()`);
  };
  const dialogOpen = () => app.waitFor(`!!document.querySelector(".update-install")`, 8000);
  const alive = () => {
    try {
      process.kill(app.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const processExited = async (ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!alive()) return true;
      await sleep(100);
    }
    return false;
  };

  try {
    // ---- 没有配置 ----
    await launch({});
    await openAbout();
    check("没配置：关于窗口里说明不会检查", await app.js(`!!document.querySelector(".update-unconfigured")`));
    check("没配置：检查按钮不能点", await app.js(`document.querySelector(".update-check").disabled`));
    check("没配置：显示当前版本", await app.js(`/当前版本 \\d+\\.\\d+\\.\\d+/.test(document.querySelector(".update-row").textContent)`));
    const unconfigured = await invoke("update_check");
    check("没配置：后端也拒绝检查", unconfigured.err?.code === "update.notConfigured", JSON.stringify(unconfigured));

    // ---- 启动时的检查：没有新版本 ----
    latest = release(good, goodSig, "", "0.0.1");
    await launch();
    check("启动时：检查一次", await waitForHits(1));
    await sleep(500);
    check("版本更旧：不算更新，也不能回退", !(await updateButton()) && !(await hasModal()));

    // ---- 界面不能绕过后端 ----
    const direct = await invoke("plugin:updater|check");
    check("界面不能直接调用更新插件", !!direct.err, JSON.stringify(direct));
    const noPending = await invoke("update_install", { onProgress: "__CHANNEL__:0" });
    check("没检查过：不能安装", noPending.err?.code === "update.nothingPending", JSON.stringify(noPending));

    // ---- 手动检查 ----
    await checkNow();
    check("手动检查：已是最新", await toastSeen("success", "最新"));
    await closeTopModal();

    latest = release(good, goodSig, "", (await invoke("update_status")).ok.current);
    await checkNow();
    check("版本相同：不算更新", await toastSeen("success", "最新"));
    await closeTopModal();

    latest = null;
    await checkNow();
    check("服务器上没有版本信息：说清楚", await toastSeen("error", "没有找到版本信息"));
    await closeTopModal();

    latest = "{ 这不是 JSON";
    await checkNow();
    check("版本信息损坏：说清楚", await toastSeen("error", "无法解析"));
    await closeTopModal();

    latest = { version: NEW, platforms: { "linux-x86_64": { url: `${base}/${good}`, signature: goodSig } } };
    await checkNow();
    check("新版本没有这台电脑能用的程序：说清楚", await toastSeen("error", "适用于这台电脑的程序"));
    await closeTopModal();

    // ---- 关闭启动时的检查 ----
    await openSettings();
    await app.click(".update-startup .switch");
    await closeTopModal();
    latest = release(good, goodSig);
    hits = 0;
    await launch();
    await sleep(1500);
    check("关闭后：启动时不连接服务器", hits === 0, `${hits}`);
    check("关闭后：没有提示", !(await updateButton()));
    await checkNow();
    check("关闭后：仍然可以手动检查", await dialogOpen());
    await closeTopModal();
    await openSettings();
    await app.click(".update-startup .switch");
    await closeTopModal();

    // ---- 有新版本 ----
    const nasty = `第一行\n<img src=x onerror="window.__notesRan=1">‮txt.exe\u0007\n[链接](javascript:alert(1))`;
    latest = release(good, goodSig, nasty);
    hits = 0;
    await launch();
    check("有新版本：状态栏提示", await app.waitFor(`document.querySelector(".update-available")?.textContent.includes(${JSON.stringify(NEW)})`));
    check("有新版本：不弹对话框，不抢输入焦点", !(await hasModal()));
    await app.click(".update-available");
    check("点击后才打开", await dialogOpen());
    const notes = await app.js(`document.querySelector(".update-notes")?.textContent ?? ""`);
    check("更新说明：HTML 只当文本显示", notes.includes("<img src=x") && (await app.js(`!document.querySelector(".update-notes img") && !window.__notesRan`)), notes);
    check("更新说明：去掉控制字符和反向字符", !notes.includes("‮") && !notes.includes("\u0007"), JSON.stringify(notes));
    check("更新说明：没有链接可以点", await app.js(`!document.querySelector(".update-notes a")`));
    check("没有在进行的事情：不提示打断", await app.js(`!document.querySelector(".update-warning") && document.querySelector(".update-install").textContent.includes("下载并安装")`));
    await app.click(".modal .btn", "稍后");
    check("稍后：关闭对话框", !(await app.js(`!!document.querySelector(".update-install")`)));
    check("稍后：状态栏还在", await updateButton());

    // ---- 不该安装的更新包 ----
    const rejected = async (label, file, signature, expected) => {
      latest = release(file, signature);
      await checkNow();
      await dialogOpen();
      await app.click(".update-install");
      const message = await app.waitFor(`document.querySelector(".update-error")?.textContent.includes(${JSON.stringify(expected)})`, 15000);
      check(`${label}：拒绝安装`, message && alive(), await app.js(`document.querySelector(".update-error")?.textContent ?? ""`));
      await closeTopModal();
    };
    // 这里的程序是 target\debug 里的，一个都不能被换掉
    const debugExeBefore = sha256(appExe);
    await rejected("内容被改过", "tampered/" + NAME, goodSig, "签名校验");
    await rejected("别的密钥签的", "otherkey/" + NAME, otherKeySig, "签名校验");
    await rejected("旧版本的包配上新版本号", "wrongversion/" + NAME, wrongVersionSig, "签名校验");
    await rejected("签名里没有版本号", "noversion/" + NAME, noVersionSig, "签名校验");
    await rejected("签名是乱写的", good, "bm90IGEgc2lnbmF0dXJl", "签名校验");
    await rejected("签名正确但签的不是这个版本的发布文件", "badname/TermiPaw_9.9.9_x64-setup.exe", badNameSig, "签名校验");
    await rejected("正确签名但不是程序（说明文件）", "text/" + NAME, textSig, "格式");
    await rejected("正确签名但不是 64 位的 Windows 程序", "tiny/" + NAME, tinySig, "格式");
    await rejected("下载不到", "missing/" + NAME, goodSig, "下载");
    // 一切都对，但程序是在编译目录里运行的：不换自己
    await rejected("在编译目录里运行的程序不换自己", good, goodSig, "替换程序失败");
    check("被拒绝之后 target\\debug 里的程序没有变", sha256(appExe) === debugExeBefore);
    check("被拒绝之后没有留下 .new 和 .old", !existsSync(appExe + ".new") && !existsSync(appExe + ".old"));

    // 下载失败后不用重新检查，直接再点一次
    latest = release("missing/" + NAME, goodSig);
    await checkNow();
    await dialogOpen();
    await app.click(".update-install");
    await app.waitFor(`!!document.querySelector(".update-error")`, 15000);
    await app.click(".update-install");
    await app.waitFor(`document.querySelector(".update-install") && !document.querySelector(".update-install").disabled`, 15000);
    check("失败后：可以直接重试", await app.js(`document.querySelector(".update-error")?.textContent.includes("下载")`));
    await closeTopModal();

    // ---- 绿色版里真的换掉自己 ----
    // 在复制出来的 exe 上做：程序所在的文件夹、旁边的 TermiPaw_Data\ 和真正的绿色版一样
    const portableDir = join(work, "portable");
    mkdirSync(portableDir);
    const exe = join(portableDir, "termipaw.exe");
    copyFileSync(appExe, exe);
    const oldHash = sha256(exe);
    const oldSize = readFileSync(exe).length;
    latest = release(good, goodSig);
    writeFileSync(join(ssh.home, "notes.txt"), "line one\n");
    if (app) await app.stop();
    app = await launchApp(portableDir, { TERMIPAW_FAKE_EDITOR_LOG: log, TERMIPAW_TEST_OLD_CLEANUP_SECONDS: "15", ...configured }, { portable: true, exe });
    await app.js(`window.__termipawTest = { terms: [], flows: [], sessions: [], edits: [] }`);
    writeFileSync(join(app.dataDir, "editor.json"), JSON.stringify(editorExe));
    const savedHost = await invoke("hosts_save", {
      host: { id: "kept", name: "kept-after-update", group: "", host: "127.0.0.1", port: 22, username: "demo", auth: "agent", saveSecret: false },
      secret: null,
    });
    check("绿色版：存一台主机，更新之后它还在", !savedHost.err, JSON.stringify(savedHost.err ?? ""));
    await app.waitFor(`!!document.querySelector(".update-available")`);
    await app.palette(`demo@127.0.0.1:${ssh.port}`);
    await app.authenticate();
    await app.toggleFiles();
    await app.waitFor(`[...document.querySelectorAll(".file-row .fname")].some((e) => e.textContent === "notes.txt")`);
    const row = await app.js(`(() => { const r = [...document.querySelectorAll(".file-row")].find((e) => e.querySelector(".fname")?.textContent === "notes.txt").getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
    await app.mouse("mouseMoved", row);
    await app.mouse("mousePressed", row, { button: "right" });
    await app.mouse("mouseReleased", row, { button: "right" });
    await sleep(200);
    await app.click(".ctx-menu button", "fake_editor");
    await app.waitFor(`[...document.querySelectorAll(".edit-row")].some((r) => r.textContent.includes("notes.txt"))`);
    const editedFile = await waitForLogLine();
    check("编辑中：文件已经打开", existsSync(editedFile ?? ""), editedFile ?? "");

    await app.click(".update-available");
    await dialogOpen();
    const warning = await app.js(`document.querySelector(".update-warning")?.textContent ?? ""`);
    check("更新前：列出会断开的会话", warning.includes("1 个会话"), warning);
    check("更新前：列出正在编辑的文件", warning.includes("1 个正在编辑"), warning);
    check("更新前：按钮说明会打断", await app.js(`document.querySelector(".update-install").textContent.includes("中断并安装")`));
    await app.click(".modal .btn", "稍后");
    check("不更新：会话还在", (await app.js(`!!document.querySelector(".dot.connected")`)) && alive());

    const errorText = () => app.js(`document.querySelector(".update-error")?.textContent ?? ""`);
    const untouched = () => sha256(exe) === oldHash && !existsSync(exe + ".new") && !existsSync(exe + ".old") && alive() && existsSync(editedFile);

    // 程序所在的文件夹写不进去：下载之前就说明，不白下载
    await app.click(".update-available");
    await dialogOpen();
    const downloadsBefore = downloads;
    const probe = join(portableDir, ".write-test-" + app.pid);
    mkdirSync(probe);
    await app.click(".update-install");
    check("写不进去：说明原因，并告诉用户手动更新", await app.waitFor(`document.querySelector(".update-error")?.textContent.includes("不能写入")`, 15000), await errorText());
    check("写不进去：没有下载", downloads === downloadsBefore, `${downloads - downloadsBefore}`);
    check("写不进去：程序没动，会话还在，编辑的文件还在", untouched() && (await app.js(`!!document.querySelector(".dot.connected")`)));
    rmSync(probe, { recursive: true });

    // 下载校验都通过，但换不上：什么都不变
    mkdirSync(exe + ".new");
    await app.click(".update-install");
    check("换不上：说明原因", await app.waitFor(`document.querySelector(".update-error")?.textContent.includes("替换程序失败")`, 20000), await errorText());
    check("换不上：下载过，程序没动，不留下半成品", downloads > downloadsBefore && sha256(exe) === oldHash && !existsSync(exe + ".old") && alive() && existsSync(editedFile));
    rmSync(exe + ".new", { recursive: true });

    // 换上并重新启动。不用模拟点击：程序一退出，点击的回应就再也收不到了
    const oldPid = app.pid;
    const oldApp = app;
    await app.js(`document.querySelector(".update-install").click()`);
    check("更新：旧程序退出", await processExited());
    app = await attachApp(oldApp.port, { exe, dataDir: oldApp.dataDir, ignorePids: [oldPid] });
    await oldApp.stop();
    check("更新：新程序起来了，不是旧进程", app.pid !== oldPid);
    const replaced = readFileSync(exe);
    check("更新：程序换成了新版本", replaced.length === oldSize + MARKER.length && replaced.subarray(-MARKER.length).equals(MARKER), `${replaced.length} / ${oldSize + MARKER.length}`);
    check("更新：旧版本留作备份，没有半成品", existsSync(exe + ".old") && sha256(exe + ".old") === oldHash && !existsSync(exe + ".new"));
    check("更新：主机还在", (await invoke("hosts_list")).ok.some((h) => h.id === "kept"));
    check("更新：退出前清理了已同步的编辑临时文件", !existsSync(editedFile));
    check("更新：新程序有数据目录，用的还是旁边的 TermiPaw_Data", app.dataDir === join(portableDir, "TermiPaw_Data") && existsSync(join(portableDir, "TermiPaw_Data", "hosts.json")));
    check("更新：稳定运行一会儿之后，旧版本的备份删掉了", await waitUntil(() => !existsSync(exe + ".old"), 40000));
    check("更新：新程序的页面没有未捕获的异常", app.exceptions.length === 0, app.exceptions.join(" | "));
    await app.stop();
    app = undefined;

    // ---- 保险库锁定时 ----
    const lockedDir = join(work, "locked");
    mkdirSync(join(lockedDir, "data"), { recursive: true });
    const MASTER = "correct horse battery staple";
    await launch(configured, lockedDir);
    const enabled = await invoke("vault_enable", { password: MASTER, recovery: false, encryptMetadata: false });
    check("保险库：开启", !enabled.err, JSON.stringify(enabled.err ?? ""));
    await launch(configured, lockedDir);
    hits = 0;
    check("锁定时：显示锁定界面", await app.waitFor(`!!document.querySelector(".lock-screen .lock-card")`));
    await sleep(1500);
    check("锁定时：不检查更新", hits === 0, `${hits}`);
    await app.click(".lock-password");
    await app.type(MASTER);
    await app.key("Enter", "Enter", 13);
    check("解锁后：检查一次并提示", await app.waitFor(`!!document.querySelector(".update-available")`, 20000) && hits === 1, `${hits}`);
    check("页面没有未捕获的异常", app.exceptions.length === 0, app.exceptions.join(" | "));
  } finally {
    if (app) await app.stop();
    ssh.stop();
    server.close();
    server.closeAllConnections();
    removeDir(work);
  }

  async function waitUntil(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await sleep(250);
    }
    return fn();
  }

  async function waitForHits(n, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (hits >= n) return true;
      await sleep(100);
    }
    return false;
  }

  async function waitForLogLine(ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const [line] = logLines();
      if (line) return line;
      await sleep(100);
    }
    return null;
  }
}
