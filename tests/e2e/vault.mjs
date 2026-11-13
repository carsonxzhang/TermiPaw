// 主密码保险库。保存的密码只放保险库，没有别的地方可存；
// 密钥派生用真实参数。系统锁屏和睡眠是把真实的窗口消息发给窗口，不会真的锁屏。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editorExe, launchApp, postWindowMessage as postMessage, removeDir, sleep, startServer, tempDir } from "./harness.mjs";

const MASTER = "correct horse battery staple";
const MASTER2 = "a completely different passphrase";
const MASTER3 = "set from the recovery key";

const WM_WTSSESSION_CHANGE = 0x2b1;
const WTS_SESSION_LOCK = 7;
const WM_POWERBROADCAST = 0x218;
const PBT_APMSUSPEND = 4;

export async function vaultSuite({ check }) {
  const work = tempDir();
  const serverDir = join(work, "server");
  const appDir = join(work, "app");
  const data = join(appDir, "data");
  mkdirSync(serverDir);
  mkdirSync(data, { recursive: true });
  const editorLog = join(work, "editor.log");
  const file = (name) => join(data, name);
  const raw = (name) => readFileSync(file(name), "utf8");

  let server = await startServer(serverDir);
  const port = server.port;
  const home = server.home;
  const seedHost = (id, extra) => ({ id, name: id, group: "", host: "127.0.0.1", port, username: "demo", auth: "password", saveSecret: false, ...extra });
  // oldflag：记录里写着“已保存密码”，其实没有，相当于从旧版本带来的
  writeFileSync(file("hosts.json"), JSON.stringify([seedHost("withpass"), seedHost("nosecret"), seedHost("oldflag", { saveSecret: true })]));
  writeFileSync(file("editor.json"), JSON.stringify(editorExe));
  writeFileSync(file("hosts.json.bak-123"), "old plaintext backup");

  const baseEnv = { TERMIPAW_FAKE_EDITOR_LOG: editorLog };
  let app;
  const launch = async (env = {}) => {
    if (app) await app.stop();
    app = await launchApp(appDir, { ...baseEnv, ...env });
    await app.js(`window.__termipawTest = { terms: [], flows: [], sessions: [], edits: [] }`);
  };
  const invoke = (cmd, args = {}) => app.js(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then((v) => ({ ok: v }), (e) => ({ err: e }))`);
  const status = async () => (await invoke("vault_status")).ok;
  const lockShown = (ms = 8000) => app.waitFor(`!!document.querySelector(".lock-screen .lock-card")`, ms);
  const lockGone = (ms = 15000) => app.waitFor(`!document.querySelector(".lock-screen")`, ms);
  const modalText = () => app.js(`document.querySelector(".modal")?.textContent ?? ""`);
  // 对话框叠着的时候，最上面的是最后一个
  const topModalText = () => app.js(`[...document.querySelectorAll(".modal")].at(-1)?.textContent ?? ""`);
  const allModals = () => app.js(`[...document.querySelectorAll(".modal")].map((m) => m.textContent.slice(0, 60)).join(" || ")`);
  const lockText = () => app.js(`document.querySelector(".lock-card")?.textContent ?? ""`);
  const typeIn = async (selector, text) => {
    await app.click(selector);
    await app.type(text);
    await sleep(100);
  };
  const clear = (selector) => app.js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const sftpCenter = () => app.js(`(() => { const r = document.querySelector(".sftp").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const unlock = async (password = MASTER) => {
    await typeIn(".lock-password", password);
    await app.key("Enter", "Enter", 13);
  };
  const openSettings = async () => {
    await app.openMenu(0);
    await app.waitFor(`!!document.querySelector(".vault-section")`);
    // 对话框弹出时有动画，等它停下来再按坐标点击
    await sleep(300);
  };
  const closeTopModal = async () => {
    await app.key("Escape", "Escape", 27);
    await sleep(200);
  };
  const connected = (ms = 20000) => app.waitFor(`!!document.querySelector(".dot.connected") && !document.querySelector(".overlay")`, ms);
  const termText = `(() => {
    const buf = window.__termipawTest.terms.at(-1).buffer.active;
    const out = [];
    for (let i = Math.max(0, buf.length - 200); i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
    return out.join("\\n");
  })()`;
  const send = async (line) => {
    await app.click(".term");
    await app.type(line);
    await app.key("Enter", "Enter", 13);
    await sleep(200);
  };
  const acceptHostKey = async () => {
    if (await app.waitFor(`document.querySelector(".modal")?.textContent.includes("验证主机指纹")`, 5000)) await app.click(".modal .btn.primary");
  };

  try {
    // ---- 没开启时一切照旧 ----
    await launch();
    check("默认：没有锁定界面", !(await app.js(`!!document.querySelector(".lock-screen")`)));
    check("默认：界面可以操作", !(await app.js(`document.querySelector(".app").inert`)));
    check("默认：状态是没开启", !(await status()).enabled);

    // 没开保险库时不能保存密码：界面说明，后端也拒绝
    await app.key("n", "KeyN", 78, 2);
    await app.waitFor(`!!document.querySelector(".modal")`);
    await sleep(300);
    check("默认：保存密码的开关不能用，下面有开启保险库的按钮", (await app.js(`document.querySelector(".modal .switch.disabled input")?.disabled === true`)) && (await app.js(`document.querySelector(".modal .host-enable-vault")?.textContent`)) === "开启保险库…", await modalText());
    await closeTopModal();
    check("默认：旧版本带来的“已保存”标记不显示", (await invoke("hosts_list")).ok.find((h) => h.id === "oldflag")?.saveSecret === false);
    const refusedSave = await invoke("hosts_save", { host: seedHost("withpass", { saveSecret: true }), secret: "x" });
    check("默认：后端拒绝保存密码", refusedSave.err?.code === "vault.needed", JSON.stringify(refusedSave));
    check("默认：被拒绝后主机文件没有变", (raw("hosts.json").match(/"saveSecret":\s*true/g) ?? []).length === 1 && !raw("hosts.json").includes('"x"'));
    await openSettings();
    check("默认：设置里可以开启", await app.js(`!!document.querySelector(".vault-enable")`));

    // ---- 开启 ----
    await app.click(".vault-enable");
    await typeIn(".vault-new", "short12");
    await typeIn(".vault-again", "short12");
    await app.click(".vault-confirm");
    check("开启：主密码不到 8 个字符被拒绝", await app.waitFor(`document.querySelector(".lock-error")?.textContent.includes("8")`), await modalText());
    check("开启：失败时什么都没变", !existsSync(file("vault.json")) && /"saveSecret":\s*true/.test(raw("hosts.json")));
    await clear(".vault-new");
    await clear(".vault-again");
    await typeIn(".vault-new", MASTER);
    await typeIn(".vault-again", `${MASTER} typo`);
    await app.click(".vault-confirm");
    check("开启：两次不一样被拒绝", await app.waitFor(`document.querySelector(".lock-error")?.textContent.includes("不一样")`), await modalText());
    await clear(".vault-again");
    await typeIn(".vault-again", MASTER);
    await app.click(".vault-confirm");
    check("开启：显示恢复密钥", await app.waitFor(`!!document.querySelector(".recovery-key")`, 15000), await modalText());
    const recovery = await app.js(`document.querySelector(".recovery-key").textContent`);
    check("开启：恢复密钥是 26 个字符", recovery.replace(/-/g, "").length === 26, recovery);
    check("开启：确认保存之前不能关", await app.js(`[...document.querySelectorAll(".modal .btn.primary")].at(-1).disabled`));
    await closeTopModal();
    check("开启：按 Esc 也关不掉恢复密钥", await app.js(`!!document.querySelector(".recovery-key")`));
    await app.click(".modal .switch", "我已经保存好了");
    await app.click(".modal .btn.primary", "完成");
    // 保险库从空开始。记录里“已保存”的标记是空的，要告诉用户是哪些主机
    check("开启：告诉用户哪些主机的“已保存”标记是空的", await app.waitFor(`(() => { const m = [...document.querySelectorAll(".modal")].at(-1); return !!m && m.textContent.includes("没有找到") && !!m.querySelector(".detail")?.textContent.includes("oldflag"); })()`), await allModals());
    await app.click(".modal .btn", "知道了");
    await sleep(300);
    check("开启：保险库文件是密文", existsSync(file("vault.json")) && !raw("vault.json").includes("withpass"));
    check("开启：空标记去掉了", !/"saveSecret":\s*true/.test(raw("hosts.json")), raw("hosts.json").slice(0, 200));
    check("开启：恢复密钥不在文件里", !raw("vault.json").includes(recovery) && !raw("vault.json").includes(recovery.replace(/-/g, "")));
    check("开启：没开加密时主机文件还是明文", raw("hosts.json").includes("withpass"));
    let st = await status();
    check("开启：已解锁，默认 15 分钟", st.enabled && !st.locked && st.hasRecovery && st.idleMinutes === 15, JSON.stringify(st));
    check("开启：设置里显示状态", (await app.js(`document.querySelector(".vault-state").textContent`)).includes("有恢复密钥"));
    check("开启：自动锁定有五个选项", (await app.js(`[...document.querySelectorAll(".vault-idle option")].map((o) => o.textContent).join()`)) === "5 分钟,15 分钟,30 分钟,60 分钟,从不");
    await closeTopModal();

    // ---- 第一次连接：输入密码，保存到保险库 ----
    await app.waitFor(`!!document.querySelector(".host-item")`);
    await app.click(".host-item", "withpass", { count: 2 });
    await acceptHostKey();
    check("连接：开了保险库后第一次要输入密码", await app.waitFor(`!!document.querySelector(".modal input[type=password]")`, 15000));
    check("连接：密码框里有“保存到保险库”", (await modalText()).includes("保存到保险库"), await modalText());
    await app.click(".modal .switch");
    await app.click(".modal input[type=password]");
    await app.type("demo");
    await app.key("Enter", "Enter", 13);
    check("连接：输入的密码连上了", await connected());
    check("连接：主机记录里标了已保存", JSON.parse(raw("hosts.json")).find((h) => h.id === "withpass")?.saveSecret === true);
    check("连接：保存的密码在保险库里，文件里是密文", existsSync(file("vault.json")) && !raw("vault.json").includes("demo"));

    // ---- 再连一次：用保险库里的密码，不询问 ----
    await app.key("w", "KeyW", 87, 2);
    await sleep(500);
    await app.click(".host-item", "withpass", { count: 2 });
    check("连接：用保险库里的密码，不询问", await connected());
    check("连接：没有弹密码框", !(await app.js(`!!document.querySelector(".modal input[type=password]")`)));
    await send("echo before-lock");
    check("连接：终端可用", await app.waitFor(`${termText}.includes("before-lock")`));

    // ---- 在主机编辑器里保存密码 ----
    {
      const row = await app.center(".host-item", "nosecret");
      await app.mouse("mouseMoved", row);
      await app.mouse("mousePressed", row, { button: "right" });
      await app.mouse("mouseReleased", row, { button: "right" });
      await sleep(200);
      await app.click(".ctx-menu button", "编辑");
      await app.waitFor(`!!document.querySelector(".modal input[type=password]")`);
      await sleep(300);
      check("编辑器：开了保险库，保存密码的开关可以用", await app.js(`!document.querySelector(".modal .switch input").disabled`));
      await app.click(".modal input[type=password]");
      await app.type("editor-secret");
      await app.click(".modal .switch", "保存密码");
      await app.click(".modal .btn", "保存");
      await app.waitFor(`!document.querySelector(".modal")`, 5000);
      check("编辑器：保存后主机标了已保存", (await invoke("hosts_list")).ok.find((h) => h.id === "nosecret")?.saveSecret === true);
      check("编辑器：密码在保险库里，不在任何明文文件里", !raw("vault.json").includes("editor-secret") && !raw("hosts.json").includes("editor-secret"));
    }

    // 正在编辑一个文件，锁定时也要能传回去
    await app.toggleFiles();
    writeFileSync(join(home, "notes.txt"), "v1\n");
    await app.click(".sftp-toolbar [title='刷新']");
    await app.waitFor(`[...document.querySelectorAll(".file-row .fname")].some((e) => e.textContent === "notes.txt")`);
    {
      const p = await app.js(`(() => { const r = [...document.querySelectorAll(".file-row")].find((r) => r.querySelector(".fname")?.textContent === "notes.txt").getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
      await app.mouse("mouseMoved", p);
      await app.mouse("mousePressed", p, { button: "right" });
      await app.mouse("mouseReleased", p, { button: "right" });
      await sleep(200);
      await app.click(".ctx-menu button", "fake_editor");
    }
    await app.waitFor(`document.querySelectorAll(".edit-row").length === 1`, 8000);
    const localEdit = readFileSync(editorLog, "utf8").trim().split(/\r?\n/).at(-1);
    await sleep(1000);

    // ---- 手动锁定 ----
    await openSettings();
    await app.click(".vault-lock");
    check("锁定：显示锁定界面", await lockShown(), JSON.stringify(await status()) + await app.js(`String(document.querySelector(".vault-lock")?.getBoundingClientRect().y) + "/" + innerHeight`));
    check("锁定：遮住了整个窗口", await app.js(`(() => { const r = document.querySelector(".lock-screen").getBoundingClientRect(); return Math.abs(r.width - innerWidth) < 1 && Math.abs(r.height - innerHeight) < 1 && getComputedStyle(document.querySelector(".lock-screen")).backgroundColor !== "rgba(0, 0, 0, 0)"; })()`), await app.js(`(() => { const e = document.querySelector(".lock-screen"); const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, innerWidth, innerHeight, getComputedStyle(e).backgroundColor, getComputedStyle(e).opacity].join(" "); })()`));
    check("锁定：窗口中心露不出下面的内容", await app.js(`!!document.elementFromPoint(innerWidth / 2, innerHeight - 5)?.closest(".lock-screen")`));
    check("锁定：下面的内容不能操作", await app.js(`document.querySelector(".app").inert`));
    check("锁定：窗口按钮还能用", await app.js(`!!document.querySelector(".lock-screen .winctl [title='关闭']")`));
    const barHeights = await app.js(`[".app > .titlebar", ".lock-screen > .titlebar"].map((s) => document.querySelector(s)?.getBoundingClientRect().height)`);
    check("锁定：标题栏和平时一样高", barHeights[0] > 0 && Math.abs(barHeights[0] - barHeights[1]) < 1, barHeights.join(" / "));

    // 键盘不会进到终端里，快捷键也不起作用
    await app.mouse("mouseMoved", { x: 300, y: 300 });
    await app.mouse("mousePressed", { x: 300, y: 300 });
    await app.mouse("mouseReleased", { x: 300, y: 300 });
    await app.js(`document.activeElement?.blur()`);
    await app.type("typed-while-locked");
    await app.key("Enter", "Enter", 13);
    await app.key("w", "KeyW", 87, 2);
    await app.key("k", "KeyK", 75, 2);
    await sleep(300);
    check("锁定：Ctrl+W 关不掉会话", (await app.js(`document.querySelectorAll(".term").length`)) === 1 && (await app.js(`!!document.querySelector(".dot.connected")`)));
    check("锁定：Ctrl+K 打不开命令面板", !(await app.js(`!!document.querySelector(".backdrop.top")`)));

    // 拖进来的文件不能悄悄开始上传
    writeFileSync(join(work, "dropped.txt"), "dropped");
    const dropAt = await sftpCenter();
    await invoke("debug_drop", { paths: [join(work, "dropped.txt")], ...dropAt });
    await sleep(800);
    check("锁定：拖进来的文件不上传", !existsSync(join(home, "dropped.txt")));

    // 编辑的文件照常传回
    writeFileSync(localEdit, "saved while locked\n");
    let edited = false;
    for (let i = 0; i < 60 && !edited; i++) {
      edited = existsSync(join(home, "notes.txt")) && readFileSync(join(home, "notes.txt"), "utf8") === "saved while locked\n";
      if (!edited) await sleep(100);
    }
    check("锁定：编辑的文件照常传回", edited);
    check("锁定：会话没有断开", (await app.js(`document.querySelectorAll(".dot.connected").length`)) >= 1);

    // 后端同样拒绝，不只是界面遮住
    check("锁定：后端拒绝保存新密码", (await invoke("hosts_save", { host: seedHost("nosecret", { saveSecret: true }), secret: "x" })).err?.kind === "vaultLocked");
    check("锁定：后端拒绝删除保存了密码的主机", (await invoke("hosts_delete", { id: "withpass" })).err?.kind === "vaultLocked");
    check("锁定：主机文件没有变", raw("hosts.json").includes("withpass"));

    // 解锁
    await unlock("this is the wrong password");
    check("解锁：主密码不对时说明", await app.waitFor(`document.querySelector(".lock-error")?.textContent.includes("不对")`, 10000), await lockText());
    check("解锁：还是锁着", (await status()).locked);
    check("解锁：输入框清空了", (await app.js(`document.querySelector(".lock-password").value`)) === "");
    await unlock();
    check("解锁：回到原来的界面", await lockGone());
    check("解锁：界面可以操作", !(await app.js(`document.querySelector(".app").inert`)));
    check("解锁：会话还在", await app.js(`!!document.querySelector(".dot.connected")`));
    check("解锁：键盘回到终端", await app.waitFor(`document.activeElement?.classList.contains("xterm-helper-textarea")`, 3000), await app.js(`document.activeElement?.className`));
    check("解锁：锁定时打的字没有进终端", !(await app.js(termText)).includes("typed-while-locked"));
    await send("echo after-unlock");
    check("解锁：终端接着用", await app.waitFor(`${termText}.includes("after-unlock")`) && (await app.js(termText)).includes("before-lock"));
    check("解锁：编辑状态是已同步", await app.waitFor(`document.querySelector(".edit-row .tstat")?.textContent === "已同步"`));
    await app.click(".edit-row [title='停止编辑']");
    await sleep(200);
    // 对照：同样的操作解锁后能上传，说明上面的检查不是因为别的原因才通过
    await invoke("debug_drop", { paths: [join(work, "dropped.txt")], ...(await sftpCenter()) });
    check("解锁后：拖进来的文件正常上传", await waitForFile(() => existsSync(join(home, "dropped.txt"))));

    // ---- 系统锁屏和睡眠：真实的窗口消息 ----
    postMessage(app.pid, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK);
    check("系统锁屏：立刻锁定", await lockShown(3000));
    await unlock();
    await lockGone();
    // 别的会话事件（比如解除锁屏）不锁定
    postMessage(app.pid, WM_WTSSESSION_CHANGE, 8);
    await sleep(500);
    check("解除锁屏的通知不会锁定", !(await status()).locked);
    postMessage(app.pid, WM_POWERBROADCAST, PBT_APMSUSPEND);
    check("电脑睡眠：立刻锁定", await lockShown(3000));
    await unlock();
    await lockGone();
    postMessage(app.pid, WM_POWERBROADCAST, 7); // 恢复运行
    await sleep(500);
    check("电脑恢复运行的通知不会锁定", !(await status()).locked);

    // ---- 自动重连：锁定时暂停，解锁后继续 ----
    await send("echo before-outage");
    postMessage(app.pid, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK);
    await lockShown(3000);
    server.stop();
    await sleep(500);
    server = await startServer(serverDir, {}, port);
    // 等第一次重试（2 秒）撞上锁定
    await sleep(5000);
    check("重连：锁定时连不上，也不弹对话框", !(await app.js(`!!document.querySelector(".dot.connected")`)) && !(await app.js(`!!document.querySelector(".modal input[type=password]")`)));
    check("重连：等着解锁", await app.js(`[...document.querySelectorAll(".banner, .overlay")].some((e) => e.textContent.includes("解锁后继续"))`), await app.js(`document.querySelector(".banner, .overlay")?.textContent ?? ""`));
    await unlock();
    check("重连：解锁后自动连上，不询问密码", await connected(30000), await app.js(`document.querySelector(".banner")?.textContent ?? ""`));
    check("重连：没有弹密码框", !(await app.js(`!!document.querySelector(".modal input[type=password]")`)));

    // ---- 重启后默认锁定 ----
    await launch();
    check("重启：默认锁定", await lockShown());
    check("重启：没开加密时主机列表在界面下面，但被遮住", await app.js(`document.querySelector(".app").inert`));
    await unlock();
    check("重启：解锁后可以用", await lockGone());

    // ---- 自动锁定的设置保存在保险库里 ----
    await openSettings();
    await app.js(`(() => { const el = document.querySelector(".vault-idle"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(el, "60"); el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await app.waitFor(`document.querySelector(".vault-idle").value === "60"`);
    check("设置：可以改自动锁定时间", (await status()).idleMinutes === 60);
    check("设置：后端不接受别的时长", (await invoke("vault_set_idle", { minutes: 7 })).err !== undefined);
    await closeTopModal();

    // ---- 加密主机信息 ----
    await openSettings();
    await app.click(".vault-section .switch", "加密主机信息");
    check("加密：提醒旧备份里还有明文", await app.waitFor(`document.querySelector(".modal .detail")?.textContent.includes("hosts.json.bak-123") === true`), await modalText());
    await app.click(".modal .btn", "保留");
    await sleep(200);
    check("加密：选择保留时不删除", existsSync(file("hosts.json.bak-123")));
    check("加密：明文文件删掉了", !existsSync(file("hosts.json")) && !existsSync(file("known_hosts.json")) && !existsSync(file("upload_temp_files.json")), readdirSync(data).join());
    check("加密：保险库文件里看不到地址", !raw("vault.json").includes("127.0.0.1") && !raw("vault.json").includes("withpass"));
    check("加密：其他文件里也看不到地址", readdirSync(data).filter((n) => !n.endsWith(".bak-123") && n !== "editing" && n !== "webview").every((n) => !existsSync(file(n)) || !raw(n).includes("127.0.0.1")), readdirSync(data).join());
    await closeTopModal();

    await launch();
    check("加密：启动时必须先解锁", await lockShown());
    check("加密：锁定时读不到主机列表", ((await invoke("hosts_list")).ok ?? []).length === 0);
    check("加密：界面上也没有", (await app.js(`document.querySelectorAll(".host-item").length`)) === 0);
    check("加密：锁定时不能保存主机，也不会写出明文文件", (await invoke("hosts_save", { host: seedHost("new"), secret: null })).err?.kind === "vaultLocked" && !existsSync(file("hosts.json")));
    const lockedConnect = await app.js(`(() => { const onData = "__CHANNEL__:" + window.__TAURI_INTERNALS__.transformCallback(() => {}); return window.__TAURI_INTERNALS__.invoke("ssh_connect", { target: { host: "127.0.0.1", port: ${port}, username: "demo", auth: "password" }, secret: "demo", remember: false, cols: 80, rows: 24, onData }).then(() => "connected", (e) => e.kind); })()`).catch((e) => String(e));
    check("加密：锁定时不能连接，指纹检查不会当作首次连接", lockedConnect === "vaultLocked", String(lockedConnect));
    await unlock();
    check("加密：解锁后主机列表回来了", await lockGone() && (await app.waitFor(`document.querySelectorAll(".host-item").length === 3`)));
    await app.click(".host-item", "withpass", { count: 2 });
    check("加密：指纹记录也回来了，不用重新确认", await connected(15000) && !(await modalText()).includes("指纹"), await modalText());
    await send("echo encrypted-session");
    await app.waitFor(`${termText}.includes("encrypted-session")`);

    // 锁定时列表清空，解锁后恢复；断线重连也要等解锁
    postMessage(app.pid, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK);
    await lockShown(3000);
    // 正在运行的会话还留在侧栏（被锁定界面遮住），没有会话的主机不能再出现
    check("加密：锁定后界面上的主机列表清空了", await app.waitFor(`![...document.querySelectorAll(".host-item")].some((e) => e.textContent.includes("nosecret"))`));
    check("加密：锁定时会话不断开", await app.js(`!!document.querySelector(".dot.connected")`));
    check("加密：锁定后后端也读不到", ((await invoke("hosts_list")).ok ?? []).length === 0);
    await unlock();
    await lockGone();
    check("加密：再次解锁后列表恢复", await app.waitFor(`document.querySelectorAll(".host-item").length === 3`));

    // 关掉加密再开：选择删除旧备份
    await openSettings();
    await app.click(".vault-section .switch", "加密主机信息");
    check("不再加密：先确认", await app.waitFor(`document.querySelector(".modal .btn.danger")?.textContent === "不再加密" || [...document.querySelectorAll(".modal .btn.danger")].some((b) => b.textContent === "不再加密")`), await modalText());
    await app.click(".modal .btn.danger", "不再加密");
    await sleep(400);
    check("不再加密：明文文件写回来了", existsSync(file("hosts.json")) && raw("hosts.json").includes("withpass") && raw("known_hosts.json").includes("127.0.0.1"));
    await app.click(".vault-section .switch", "加密主机信息");
    await app.waitFor(`document.querySelector(".modal .detail")?.textContent.includes("hosts.json.bak-123") === true`);
    await app.click(".modal .btn.danger", "删除");
    await sleep(300);
    check("加密：选择删除后旧备份没了", !existsSync(file("hosts.json.bak-123")));
    check("加密：删除后主机还在", (await invoke("hosts_list")).ok.length === 3);
    await closeTopModal();
    await app.key("w", "KeyW", 87, 2);
    await sleep(300);

    // ---- 修改主密码 ----
    await openSettings();
    await app.click(".vault-change");
    await typeIn(".vault-current", "not the current password");
    await typeIn(".vault-new", MASTER2);
    await typeIn(".vault-again", MASTER2);
    await app.click(".vault-confirm");
    check("修改主密码：当前主密码不对时拒绝", await app.waitFor(`document.querySelector(".lock-error")?.textContent.includes("不对")`, 10000));
    await clear(".vault-current");
    await typeIn(".vault-current", MASTER);
    await app.click(".vault-confirm");
    check("修改主密码：发新的恢复密钥", await app.waitFor(`!!document.querySelector(".recovery-key")`, 15000), await modalText());
    const recovery2 = await app.js(`document.querySelector(".recovery-key").textContent`);
    check("修改主密码：恢复密钥换了", recovery2 !== recovery);
    await app.click(".modal .switch", "我已经保存好了");
    await app.click(".modal .btn.primary", "完成");
    await sleep(300);
    await closeTopModal();

    await launch();
    await lockShown();
    await unlock(MASTER);
    check("修改后：旧主密码不能用", await app.waitFor(`document.querySelector(".lock-error")?.textContent.includes("不对")`, 10000));

    // ---- 恢复密钥 ----
    await app.click(".link", "用恢复密钥");
    await typeIn(".lock-recovery", recovery);
    await typeIn(".lock-new", MASTER3);
    await typeIn(".lock-again", MASTER3);
    await app.click(".lock-submit");
    check("恢复：旧的恢复密钥不能用", await app.waitFor(`document.querySelector(".lock-error")?.textContent.includes("不对")`, 10000), await lockText());
    await clear(".lock-recovery");
    // 小写和空格也能接受
    await typeIn(".lock-recovery", recovery2.toLowerCase().replace(/-/g, " "));
    await app.click(".lock-submit");
    check("恢复：解锁成功", await lockGone());
    check("恢复：发新的恢复密钥", await app.waitFor(`!!document.querySelector(".recovery-key")`, 5000), await modalText());
    const recovery3 = await app.js(`document.querySelector(".recovery-key").textContent`);
    check("恢复：新的恢复密钥和旧的不一样", recovery3 !== recovery2);
    await app.click(".modal .switch", "我已经保存好了");
    await app.click(".modal .btn.primary", "完成");
    await sleep(200);
    check("恢复：内容都在", (await invoke("hosts_list")).ok.length === 3);

    await launch();
    await lockShown();
    await unlock(MASTER2);
    check("恢复后：之前的主密码不能用", await app.waitFor(`document.querySelector(".lock-error")?.textContent.includes("不对")`, 10000));
    await unlock(MASTER3);
    check("恢复后：新主密码可以用", await lockGone());

    // ---- 关闭 ----
    await openSettings();
    await app.click(".vault-disable");
    await typeIn(".vault-current", "wrong wrong wrong wrong");
    await app.click(".vault-confirm");
    check("关闭：主密码不对时拒绝", await app.waitFor(`document.querySelector(".lock-error")?.textContent.includes("不对")`, 10000));
    check("关闭：失败时保险库还在", existsSync(file("vault.json")));
    await clear(".vault-current");
    await typeIn(".vault-current", MASTER3);
    await app.click(".vault-confirm");
    check("关闭：保险库文件删除了", await waitForFile(() => !existsSync(file("vault.json"))));
    check("关闭：保存的密码随保险库一起删除，不会留在别的文件里", readdirSync(data).filter((n) => n !== "hosts.json" && n !== "known_hosts.json" && statSync(file(n)).isFile()).every((n) => !raw(n).includes("demo")), readdirSync(data).join());
    check("关闭：主机文件写回明文", raw("hosts.json").includes("withpass"));
    check("关闭：界面上不再显示密码已保存", (await invoke("hosts_list")).ok.every((h) => !h.saveSecret));
    await closeTopModal();
    await launch();
    check("关闭后：启动时不再锁定", !(await app.js(`!!document.querySelector(".lock-screen")`)));
    await app.waitFor(`!!document.querySelector(".host-item")`);
    await app.click(".host-item", "withpass", { count: 2 });
    check("关闭后：保存的密码没有了，要重新输入", await app.waitFor(`!!document.querySelector(".modal input[type=password]")`, 15000));
    check("关闭后：密码框里没有保存选项，只有提示", !(await app.js(`!!document.querySelector(".modal .switch")`)) && (await modalText()).includes("保险库"), await modalText());
    await app.click(".modal input[type=password]");
    await app.type("demo");
    await app.key("Enter", "Enter", 13);
    check("关闭后：输入密码可以连接", await connected(15000));
    await app.key("w", "KeyW", 87, 2);
    await sleep(300);

    // ---- 空闲自动锁定 ----
    await launch({ TERMIPAW_TEST_IDLE_SECONDS: "8" });
    // 这次从新建主机窗口开启：为了保存这台主机的密码
    await app.key("n", "KeyN", 78, 2);
    await app.waitFor(`!!document.querySelector(".modal .host-enable-vault")`);
    await app.click(".modal .host-enable-vault");
    check("新建主机里开启：弹出开启保险库的窗口", await app.waitFor(`document.querySelectorAll(".modal").length === 2 && !!document.querySelector(".vault-new")`));
    await typeIn(".vault-new", MASTER);
    await typeIn(".vault-again", MASTER);
    await app.click(".modal .switch", "生成恢复密钥");
    check("没有恢复密钥：明确提示后果", (await modalText()).includes("无法找回"), await modalText());
    await app.click(".vault-confirm");
    await app.waitFor(`!document.querySelector(".vault-confirm")`, 15000);
    // 记录里还留着关闭前的“已保存”标记，开启时会再提示一次
    if (await app.waitFor(`[...document.querySelectorAll(".modal")].at(-1)?.textContent.includes("没有找到") === true`, 3000)) await app.click(".modal .btn", "知道了");
    check("没有恢复密钥：不显示恢复密钥", !(await app.js(`!!document.querySelector(".recovery-key")`)));
    check(
      "新建主机里开启：回到新建主机窗口，按钮消失，保存密码已打开",
      await app.waitFor(`document.querySelectorAll(".modal").length === 1 && !!document.querySelector(".modal .host-name") && !document.querySelector(".host-enable-vault") && document.querySelector(".modal .switch input")?.checked === true && !document.querySelector(".modal .switch input").disabled`),
      await allModals(),
    );
    await closeTopModal();
    await sleep(200);
    // 一直在动就不锁定
    for (let i = 0; i < 12; i++) {
      await app.mouse("mouseMoved", { x: 200 + i * 5, y: 200 });
      await sleep(1000);
    }
    check("空闲：有操作时不锁定", !(await status()).locked);
    check("空闲：停下来之后自动锁定", await lockShown(15000));
    check("没有恢复密钥：锁定界面不提供", !(await lockText()).includes("用恢复密钥"));

    // ---- 忘记主密码 ----
    await app.click(".link", "忘记主密码");
    check("重置：说明后果", (await lockText()).includes("都不能再用"), await lockText());
    check("重置：没输入确认文字时不能点", await app.js(`document.querySelector(".lock-submit").disabled`));
    const refused = await invoke("vault_reset", { confirm: "随便" });
    check("重置：后端也检查确认文字", refused.err !== undefined && existsSync(file("vault.json")));
    await typeIn(".lock-confirm", "重置");
    await app.click(".lock-submit");
    check("重置：锁定界面消失", await lockGone());
    check("重置：保险库文件留了备份", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("保险库已重置")`) && readdirSync(data).some((n) => n.startsWith("vault.json.bak-")) && !existsSync(file("vault.json")), (await allModals()) + " / " + readdirSync(data).join());
    await app.click(".modal .btn", "知道了");
    check("重置：不再显示密码已保存", (await invoke("hosts_list")).ok.every((h) => !h.saveSecret));

    // ---- 保险库文件有问题 ----
    writeFileSync(file("vault.json"), "broken");
    await launch();
    check("文件损坏：不当作没开启", await lockShown() && (await status()).enabled);
    check("文件损坏：说明情况", (await lockText()).includes("已损坏"), await lockText());
    check("文件损坏：内容没动", raw("vault.json") === "broken");
    check("文件损坏：可以重置", (await lockText()).includes("重置"));
    await app.click(".link", "重置");
    await typeIn(".lock-confirm", "重置");
    await app.click(".lock-submit");
    check("文件损坏：重置后可以用", await lockGone());
    await app.click(".modal .btn", "知道了");

    writeFileSync(file("vault.json"), JSON.stringify({ format: "termipaw-vault", version: 99 }));
    await launch();
    check("新版本的文件：提示升级", await lockShown() && (await lockText()).includes("升级"), await lockText());
    check("新版本的文件：不提供重置", !(await lockText()).includes("重置"));
    check("新版本的文件：后端也不重置", (await invoke("vault_reset", { confirm: "重置" })).err !== undefined && existsSync(file("vault.json")));
    check("页面没有未捕获的异常", app.exceptions.length === 0, app.exceptions.join(" | "));
  } finally {
    await app?.stop();
    server.stop();
    await sleep(300);
    removeDir(work);
  }
}

async function waitForFile(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
}
