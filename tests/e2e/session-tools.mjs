// 终端上方的按钮：复制、粘贴、查找、清屏、保存输出、编码、文件面板；主机里保存的编码。
// 会临时改写系统剪贴板（结束后恢复原来的文本）。

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "./harness.mjs";

const powershell = (script, input) =>
  new Promise((res, rej) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }, (err, stdout) => (err ? rej(err) : res(stdout)));
    child.stdin.end(input ?? "");
  });
const readClipboard = async () => (await powershell("Get-Clipboard -Raw")).replace(/\r?\n$/, "");
const writeClipboard = (text) => powershell("Set-Clipboard -Value ([Console]::In.ReadToEnd())", text);

/** 当前会话终端里所有的文字（包括已经滚出屏幕的） */
const termText = `(() => {
  const terms = window.__termipawTest.terms;
  const buf = terms[terms.length - 1].buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
  return out.join("\\n");
})()`;

const BAR = ".term-wrap.active .term-toolbar";
const button = (title) => `[...document.querySelectorAll(${JSON.stringify(`${BAR} button`)})].find((b) => b.title.startsWith(${JSON.stringify(title)}))`;

export async function sessionToolsSuite(app, server, appDir, { check }) {
  const has = (text, ms = 3000) => app.waitFor(`${termText}.includes(${JSON.stringify(text)})`, ms);
  const enabled = (title) => app.js(`(() => { const b = ${button(title)}; return !!b && !b.disabled; })()`);
  const press = async (title) => {
    const p = await app.js(`(() => { const b = ${button(title)}; if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!p) throw new Error(`按钮不能点：${title}`);
    await app.mouse("mouseMoved", p);
    await app.mouse("mousePressed", p, { button: "left", clickCount: 1 });
    await app.mouse("mouseReleased", p, { button: "left", clickCount: 1 });
    await sleep(300);
  };
  const termFocused = () => app.js(`!!document.activeElement?.closest(".xterm")`);
  const run = async (command) => {
    await app.type(command);
    await app.key("Enter", "Enter", 13);
    await sleep(300);
  };
  const encodingLabel = () => app.js(`document.querySelector("${BAR} .encoding-btn")?.textContent.trim()`);
  const chooseEncoding = async (label) => {
    await press("当前会话的终端编码");
    await app.click(".ctx-menu button", label);
    await sleep(200);
  };

  await app.js(`window.__termipawTest = { terms: [], flows: [] }`);
  await app.palette(`demo@127.0.0.1:${server.port}`);
  await app.authenticate();
  await app.waitFor(`window.__termipawTest.terms.length === 1 && !!document.activeElement?.closest(".xterm")`);
  await sleep(500);

  // ---- 位置：终端上方一行，状态栏里不再有文件面板和编码 ----
  const layout = await app.js(`(() => {
    const bar = document.querySelector("${BAR}").getBoundingClientRect();
    const term = document.querySelector(".term-wrap.active .term").getBoundingClientRect();
    return { above: bar.bottom <= term.top, status: document.querySelector(".statusbar").textContent };
  })()`);
  check("按钮在终端上方", layout.above);
  check("状态栏不再有文件面板按钮和编码", !layout.status.includes("SFTP") && !layout.status.includes("UTF-8"), layout.status);

  const saved = await readClipboard();
  try {
    // ---- 复制：没选中时不能点；选中后复制到剪贴板，焦点留在终端 ----
    await run("echo copy-me-123");
    check("复制：没有选中内容时不能点", !(await enabled("复制")));
    await app.js(`window.__termipawTest.terms[0].selectAll()`);
    await sleep(200);
    check("复制：选中后可以点", await enabled("复制"));
    await writeClipboard("nothing");
    await press("复制");
    check("复制：选中的内容进了剪贴板", (await readClipboard()).includes("copy-me-123"));
    check("复制：焦点还在终端", await termFocused());
    await app.js(`window.__termipawTest.terms[0].clearSelection()`);

    // ---- 粘贴：剪贴板的内容输入到终端，不执行 ----
    await writeClipboard("echo pasted-456");
    await press("粘贴");
    check("粘贴：内容输入到终端", await has("$ echo pasted-456"));
    check("粘贴：只是输入，没有执行", !(await app.js(`${termText}.split("\\n").some((l) => l.trim() === "pasted-456")`)));
    await app.key("c", "KeyC", 67, 2); // Ctrl+C 清掉这一行
  } finally {
    if (saved) await writeClipboard(saved);
  }

  // ---- 查找 ----
  await press("查找");
  check("查找：打开查找框，光标在输入框里", await app.waitFor(`document.activeElement === document.querySelector(".find-bar input")`, 2000));
  await app.type("copy-me");
  const count = () => app.js(`document.querySelector(".find-bar .find-count")?.textContent ?? ""`);
  check("查找：显示匹配的位置和总数", await app.waitFor(`/^[12]\\/2$/.test(document.querySelector(".find-bar .find-count")?.textContent ?? "")`, 2000), await count());
  const first = await count();
  await app.key("Enter", "Enter", 13);
  check("查找：回车跳到下一个", (await count()) !== first, `${first} -> ${await count()}`);
  await app.type("-nothing-like-this");
  check("查找：找不到时说明", await app.waitFor(`document.querySelector(".find-bar .find-count")?.textContent === "无结果"`, 2000), await count());
  await app.key("Escape", "Escape", 27);
  check("查找：Esc 关闭，焦点回到终端", !(await app.js(`!!document.querySelector(".find-bar")`)) && (await termFocused()));
  await app.key("F", "KeyF", 70, 2 | 8); // Ctrl+Shift+F
  check("查找：Ctrl+Shift+F 也能打开", await app.waitFor(`!!document.querySelector(".find-bar")`, 2000));
  await app.key("Escape", "Escape", 27);

  // ---- 清屏：只清本地显示 ----
  await press("清屏");
  check("清屏：之前的输出清掉了", !(await app.js(`${termText}.includes("copy-me-123")`)));
  check("清屏：焦点还在终端", await termFocused());
  await run("echo after-clear");
  check("清屏：会话照常使用", await has("after-clear"));

  // ---- 保存当前输出 ----
  await run("colors");
  await run("echo save-me-789");
  const target = join(appDir, "saved-output.txt");
  await press("保存当前输出");
  await app.answerFileDialog([target]);
  check("保存：提示保存的位置", await app.waitFor(`[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("已保存到") && t.textContent.includes("saved-output.txt"))`, 5000));
  const text = existsSync(target) ? readFileSync(target, "utf8") : "";
  check("保存：文件里有终端的输出", text.includes("$ echo save-me-789") && text.includes("save-me-789\r\n"), JSON.stringify(text.slice(-200)));
  check("保存：纯文本，没有颜色和控制字符", text.length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text));
  check("保存：存到别处时不留下空的 logs 文件夹", !existsSync(join(app.dataDir, "logs")));
  const inLogs = join(app.dataDir, "logs", "kept.txt");
  await press("保存当前输出");
  await app.answerFileDialog([inLogs]);
  check("保存：可以存进数据目录里的 logs 文件夹", await app.waitFor(`[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("kept.txt"))`, 5000) && existsSync(inLogs));

  // ---- 编码 ----
  check("编码：默认 UTF-8", (await encodingLabel()) === "UTF-8", await encodingLabel());
  await run("rawbytes d6d0cec4b2e2cad4"); // GBK 的“中文测试”
  check("编码：UTF-8 下 GBK 的输出是乱码", !(await has("中文测试", 800)));
  await chooseEncoding("GB18030");
  check("编码：切换后按钮显示新编码", (await encodingLabel()) === "GB18030 / GBK", await encodingLabel());
  await run("rawbytes d6d0cec4b2e2cad4");
  check("编码：切换后 GBK 的输出正常显示", await has("中文测试"));
  await run("echohex 中文");
  check("编码：输入按 GBK 发给服务器", await has("HEX:d6d0cec4"), (await app.js(termText)).split("\n").filter((l) => l.includes("HEX:")).join(" | "));
  await chooseEncoding("UTF-8");
  await run("echohex 中文");
  check("编码：切回 UTF-8 后输入按 UTF-8 发送", await has("HEX:e4b8ade69687"));

  // ---- 文件面板按钮 ----
  await app.toggleFiles();
  check("文件面板：按钮打开面板", await app.waitFor(`!!document.querySelector(".sftp")`, 5000));
  check("文件面板：按钮显示为打开状态", await app.js(`document.querySelector("${BAR} .files-btn").classList.contains("active")`));
  await app.toggleFiles();
  check("文件面板：再点一次关闭", await app.waitFor(`!document.querySelector(".sftp")`, 3000));
  await app.key("w", "KeyW", 87, 2);

  // ---- 主机里保存编码，连接时就用它；改了之后打开的会话马上换 ----
  /** 按标签找到编辑窗口里的输入框或下拉框，填上值（要触发 React 的事件） */
  const setValue = (label, value) =>
    app.js(`(() => {
      const field = [...document.querySelectorAll(".modal .field")].find((f) => f.querySelector("label")?.textContent === ${JSON.stringify(label)});
      const el = field.querySelector("input, select");
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    })()`);
  await app.click(".sidebar-foot .new-host");
  await app.waitFor(`!!document.querySelector(".modal .host-encoding")`);
  await setValue("名称", "gbk-host");
  await setValue("主机地址", "127.0.0.1");
  await setValue("端口", String(server.port));
  await setValue("用户名", "demo");
  await setValue("编码", "gb18030");
  await app.click(".modal .btn.primary", "保存并连接");
  await app.authenticate();
  await app.waitFor(`document.querySelector(".statusbar")?.textContent.includes("已连接")`, 8000);
  const hostsFile = () => readFileSync(join(app.dataDir, "hosts.json"), "utf8");
  const savedEncoding = () => JSON.parse(hostsFile()).find((h) => h.name === "gbk-host")?.encoding;
  check("主机编码：保存进配置", savedEncoding() === "gb18030", hostsFile());
  check("主机编码：连接时就用它", (await encodingLabel()) === "GB18030 / GBK", await encodingLabel());
  await app.click(".host-item", "gbk-host", { button: "right" });
  await app.click(".ctx-menu button", "编辑");
  await app.waitFor(`!!document.querySelector(".modal .host-encoding")`);
  check("主机编码：编辑时显示已保存的编码", (await app.js(`document.querySelector(".modal .host-encoding").value`)) === "gb18030");
  await setValue("编码", "utf-8");
  await app.click(".modal .btn", "保存");
  await sleep(500);
  check("主机编码：改回 UTF-8 后打开的会话马上换", (await encodingLabel()) === "UTF-8", await encodingLabel());
  check("主机编码：UTF-8 是默认值，不写进配置", savedEncoding() === undefined && !hostsFile().includes("encoding"), hostsFile());
}
