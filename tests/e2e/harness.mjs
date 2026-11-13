// 启动调试版程序和开发服务器，通过 WebView2 调试协议驱动真实界面。
// 所有数据都放在临时目录，不会碰到真实的主机配置。

import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const appExe = join(root, "src-tauri/target/debug/termipaw.exe");
const serverExe = join(root, "src-tauri/target/debug/examples/dev_server.exe");
export const editorExe = join(root, "src-tauri/target/debug/examples/fake_editor.exe");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

const canConnect = (port) =>
  new Promise((res) => {
    const c = net.connect(port, "127.0.0.1");
    c.once("connect", () => (c.destroy(), res(true)));
    c.once("error", () => res(false));
  });

async function until(what, fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`等待超时：${what}`);
}

export function tempDir() {
  return mkdtempSync(join(tmpdir(), "termipaw-e2e-"));
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

/** 启动开发服务器，返回端口和 SFTP 沙箱里主目录的路径。指定端口时用来模拟服务器重启 */
export async function startServer(dir, extraEnv = {}, fixedPort) {
  const port = fixedPort ?? (await freePort());
  // 服务器把沙箱放在系统临时目录下，这里把它指向测试目录
  const env = { ...process.env, PORT: String(port), TMP: dir, TEMP: dir, ...extraEnv };
  const child = spawn(serverExe, [], { env, stdio: "ignore" });
  await until("开发服务器启动", () => canConnect(port));
  return { port, home: join(dir, "termipaw-dev-server/root/home/demo"), stop: () => child.kill() };
}

/** 启动测试用的 SSH Agent（不碰系统的 Agent），返回管道名和停止函数 */
export async function startTestAgent(...keyFiles) {
  const pipe = `\\\\.\\pipe\\termipaw-test-agent-${process.pid}-${Date.now()}`;
  const child = spawn(join(root, "src-tauri/target/debug/examples/test_agent.exe"), [pipe, ...keyFiles], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((res, rej) => {
    let errors = "";
    child.stdout.on("data", (d) => String(d).includes("ready") && res());
    child.stderr.on("data", (d) => (errors += d));
    child.once("exit", (code) => rej(new Error(`测试 Agent 退出（${code}）：${errors}`)));
  });
  return { pipe, stop: () => child.kill() };
}

/**
 * 启动程序并连接调试端口。`lang` 是 WebView 报告的系统语言，默认固定为简体中文：
 * 现有的检查是按中文文字找按钮、核对提示的，不能随运行测试的电脑而变。
 *
 * 默认把数据指向 `dir`（调试版的开关），不碰真实配置。`portable` 时一个开关都不设：
 * 数据放在 `exe` 旁边的 `TermiPaw_Data`，和用户拿到的绿色版一样
 */
export async function launchApp(dir, extraEnv = {}, { lang = "zh-CN", exe = appExe, portable = false } = {}) {
  const port = await freePort();
  const dataDir = portable ? join(dirname(exe), "TermiPaw_Data") : join(dir, "data");
  const env = {
    ...process.env,
    ...extraEnv,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --lang=${lang}`,
  };
  if (portable) {
    // 不设任何开关，除非测试明确要求（比如检查发布版会忽略系统里的 WEBVIEW2_USER_DATA_FOLDER）
    if (!("TERMIPAW_DATA_DIR" in extraEnv)) delete env.TERMIPAW_DATA_DIR;
    if (!("WEBVIEW2_USER_DATA_FOLDER" in extraEnv)) delete env.WEBVIEW2_USER_DATA_FOLDER;
  } else {
    mkdirSync(dataDir, { recursive: true });
    env.TERMIPAW_DATA_DIR = dataDir;
    env.WEBVIEW2_USER_DATA_FOLDER = join(dir, "webview");
  }
  const child = spawn(exe, [], { env, stdio: "ignore" });
  const { driver, ws } = await connectDriver(port);
  return Object.assign(driver, {
    dataDir,
    port,
    pid: child.pid,
    async stop() {
      ws.close();
      child.kill();
      await sleep(500);
    },
  });
}

async function connectDriver(port) {
  const page = await until("程序启动", async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    return targets.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
  });
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  const driver = new Driver(ws);
  await driver.send("Page.enable");
  await driver.send("Runtime.enable");
  await until("界面加载", () => driver.js(`!!document.querySelector(".app[data-vault=ready]")`));
  return { driver, ws };
}

/** 路径是 `exe` 的进程的进程号。绿色版更新后新进程不是测试启动的，只能这样找；不能按名字杀，会杀到用户自己开着的 TermiPaw */
export function pidsOfExe(exe) {
  const script = `(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' }).ProcessId`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  return out.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean);
}

/**
 * 程序自己重新启动之后（绿色版更新），接上它的调试端口。新进程继承了原来的环境，调试端口不变。
 * 要等旧进程退出、端口空出来，所以会等一会儿
 */
export async function attachApp(port, { exe, dataDir, ignorePids = [] }) {
  const { driver, ws } = await connectDriver(port);
  const pid = await until("新进程", async () => pidsOfExe(exe).find((p) => !ignorePids.includes(p)));
  return Object.assign(driver, {
    dataDir,
    port,
    pid,
    async stop() {
      ws.close();
      try {
        process.kill(pid);
      } catch {
        /* 已经退出 */
      }
      await sleep(500);
    },
  });
}

/** 程序退出后，等待页面回应的调用都按出错处理。否则测试会一直等下去，而不是报告失败 */
const APP_GONE = { result: { exceptionDetails: { exception: { description: "程序已经退出" } } } };

class Driver {
  seq = 0;
  closed = false;
  pending = new Map();
  /** 页面里未捕获的异常 */
  exceptions = [];

  constructor(ws) {
    this.ws = ws;
    ws.onclose = () => {
      this.closed = true;
      for (const res of this.pending.values()) res(APP_GONE);
    };
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) this.pending.get(d.id)(d);
      else if (d.method === "Runtime.exceptionThrown") {
        const e = d.params.exceptionDetails;
        this.exceptions.push(e.exception?.description ?? e.text);
      }
    };
  }

  send(method, params = {}) {
    if (this.closed) return Promise.resolve(APP_GONE);
    return new Promise((res) => {
      const id = ++this.seq;
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async js(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "页面脚本出错");
    return r.result?.result?.value;
  }

  center(sel, text) {
    const match = text ? `e.textContent.includes(${JSON.stringify(text)})` : "true";
    return this.js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => ${match});
      if (!el) return null; el.scrollIntoView({block:"nearest"}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  }

  mouse(type, p, extra = {}) {
    return this.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1, ...extra });
  }

  async click(sel, text, opts = {}) {
    const p = await this.center(sel, text);
    if (!p) throw new Error(`找不到 ${sel} ${text ?? ""}`);
    const e = { button: opts.button ?? "left", clickCount: opts.count ?? 1 };
    await this.mouse("mouseMoved", p);
    await sleep(60);
    if (opts.count === 2) {
      await this.mouse("mousePressed", p, { ...e, clickCount: 1 });
      await this.mouse("mouseReleased", p, { ...e, clickCount: 1 });
    }
    await this.mouse("mousePressed", p, e);
    await this.mouse("mouseReleased", p, e);
    await sleep(250);
  }

  async hover(sel, text) {
    await this.mouse("mouseMoved", await this.center(sel, text));
    await sleep(150);
  }

  type(text) {
    return this.send("Input.insertText", { text });
  }

  async key(k, code, vk, modifiers = 0) {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(250);
  }

  async waitFor(expr, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.js(expr)) return true;
      await sleep(100);
    }
    return false;
  }

  /** 处理指纹确认和密码提示，直到连接成功。不保存密码 */
  async authenticate() {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const dialog = await this.js(`document.querySelector(".modal")?.textContent ?? ""`);
      if (dialog.includes("指纹")) {
        const label = await this.js(`[...document.querySelectorAll(".modal .btn.primary, .modal .btn.danger")].at(-1)?.textContent`);
        await this.click(".modal .btn.primary, .modal .btn.danger", label);
      } else if (await this.js(`!!document.querySelector('.modal input[type=password]')`)) {
        if (await this.js(`!!document.querySelector('.modal .switch input')?.checked`)) await this.click(".modal .switch");
        await this.click(".modal input[type=password]");
        await this.type("demo");
        await this.key("Enter", "Enter", 13);
      } else if (await this.js(`document.querySelectorAll(".overlay").length === 0 && !document.querySelector(".modal")`)) {
        return;
      }
      await sleep(200);
    }
    throw new Error("认证超时：" + (await this.js(`document.querySelector(".modal, .overlay")?.textContent`)));
  }

  /** 点当前会话终端上方的文件面板按钮。按钮在连上之前不能点，先等它 */
  async toggleFiles() {
    const ready = await this.waitFor(`(() => { const b = document.querySelector(".term-wrap.active .files-btn"); return !!b && !b.disabled; })()`);
    if (!ready) throw new Error("文件面板按钮一直不能点");
    await this.click(".term-wrap.active .files-btn");
  }

  /** 点标题栏右上角的菜单，再点第 index 项（0 设置，1 帮助，2 关于）。主密码保险库在设置里 */
  async openMenu(index) {
    await this.js(`document.querySelector(".menu-btn").click()`);
    await this.waitFor(`document.querySelectorAll(".ctx-menu button").length > ${index}`);
    await this.js(`document.querySelectorAll(".ctx-menu button")[${index}].click()`);
  }

  async palette(text) {
    await this.click(".search-trigger");
    await this.type(text);
    await sleep(200);
    await this.key("Enter", "Enter", 13);
  }

  /** 在程序弹出的系统文件对话框里选择这些路径 */
  answerFileDialog(paths) {
    const script = join(root, "tests/e2e/file-dialog.ps1");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-AppPid", String(this.pid), ...paths];
    return new Promise((res, rej) => {
      execFile("powershell.exe", args, (err, _stdout, stderr) => (err ? rej(new Error(`文件对话框：${stderr || err.message}`)) : res()));
    });
  }
}

/** 把窗口消息发给程序的主窗口。用来模拟系统锁屏和睡眠的通知，不会真的锁屏 */
export function postWindowMessage(pid, message, wparam) {
  const script = `Add-Type -Name W -Namespace T -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; $h = (Get-Process -Id ${pid}).MainWindowHandle; if ($h -eq 0) { exit 3 }; if (-not [T.W]::PostMessage($h, ${message}, [IntPtr]${wparam}, [IntPtr]0)) { exit 4 }`;
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
}

/** 收集检查结果 */
export class Checks {
  failed = 0;
  total = 0;

  check(label, ok, detail = "") {
    this.total++;
    if (!ok) this.failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  }
}
