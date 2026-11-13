// 粘贴确认、链接和页面导航限制。
// 会临时改写系统剪贴板（结束后恢复原来的文本）。

import { execFile } from "node:child_process";
import { sleep } from "./harness.mjs";

const powershell = (script, input) =>
  new Promise((res, rej) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }, (err, stdout) => (err ? rej(err) : res(stdout)));
    child.stdin.end(input ?? "");
  });
const readClipboard = async () => (await powershell("Get-Clipboard -Raw")).replace(/\r?\n$/, "");
const writeClipboard = (text) => powershell("Set-Clipboard -Value ([Console]::In.ReadToEnd())", text);

const tail = `(() => {
  const buf = window.__termipawTest.terms[0].buffer.active;
  const out = [];
  for (let i = Math.max(0, buf.length - 60); i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
  return out;
})()`;
const count = (lines, text) => (lines.join("\n").split(text).length - 1);

export async function pasteSuite(app, server, { check }) {
  await app.js(`window.__termipawTest = { terms: [], flows: [] }`);
  await app.palette(`demo@127.0.0.1:${server.port}`);
  await app.authenticate();
  await app.waitFor(`window.__termipawTest.terms.length === 1 && !!document.activeElement?.closest(".xterm")`);
  await sleep(500);

  const dialog = () => app.js(`document.querySelector(".modal")?.textContent ?? ""`);
  const dialogOpen = () => app.waitFor(`document.querySelector(".modal")?.textContent.includes("粘贴多行内容")`, 3000);
  const noDialog = async () => {
    await sleep(500);
    return !(await app.js(`!!document.querySelector(".modal")`));
  };
  /** 模拟浏览器自己触发的粘贴（Shift+Insert、系统菜单），不经过系统剪贴板 */
  const pasteEvent = (text) =>
    app.js(`(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", ${JSON.stringify(text)});
      document.querySelector(".xterm-helper-textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
  const clearLine = () => app.key("c", "KeyC", 67, 2); // Ctrl+C

  // ---- 单行：直接粘贴 ----
  await pasteEvent("echo single");
  check("单行内容：直接粘贴，不询问", (await noDialog()) && count(await app.js(tail), "echo single") === 1);
  await clearLine();

  // ---- 多行：询问 ----
  await pasteEvent("echo L1\necho L2");
  check("多行内容：先询问", await dialogOpen(), await dialog());
  check("多行内容：显示行数", (await dialog()).includes("共 2 行"), await dialog());
  check("多行内容：显示预览", (await app.js(`document.querySelector(".modal .detail")?.textContent`)) === "echo L1\necho L2");
  check("多行内容：询问期间没有粘贴", count(await app.js(tail), "echo L1") === 0);
  await app.click(".modal .btn", "取消");
  await sleep(300);
  check("选择取消：什么都没粘贴", count(await app.js(tail), "echo L1") === 0);
  check("选择取消：焦点回到终端", await app.js(`!!document.activeElement?.closest(".xterm")`));

  await pasteEvent("echo L1\necho L2");
  await dialogOpen();
  await app.click(".modal .btn", "粘贴");
  await sleep(800);
  const lines = await app.js(tail);
  // 换行会执行前面的命令；最后一行没有换行，停在命令行里等回车
  check("选择粘贴：带换行的那一行已执行", lines.includes("L1"), lines.filter((l) => l.trim()).slice(-6).join(" | "));
  check("选择粘贴：最后一行停在命令行", lines.some((l) => l.endsWith("$ echo L2")));
  check("选择粘贴：只粘贴了一次", count(lines, "echo L1") === 1);
  await clearLine();

  // ---- 只有结尾换行也要问：它会立即执行 ----
  await pasteEvent("echo TRAIL\n");
  check("结尾带换行：先询问", await dialogOpen());
  await app.click(".modal .btn", "取消");

  // ---- 控制字符在预览里可见 ----
  await pasteEvent("echo \u001b[31mred\u001b[0m\n");
  await dialogOpen();
  const preview = await app.js(`document.querySelector(".modal .detail")?.textContent ?? ""`);
  check("预览：转义字符显示为可见符号", preview.includes("␛[31m") && !preview.includes("\u001b"), JSON.stringify(preview));
  await app.click(".modal .btn", "取消");

  // ---- 系统剪贴板的几条路径 ----
  const saved = await readClipboard();
  try {
    await writeClipboard("echo CLIP");
    await app.key("V", "KeyV", 86, 2 | 8); // Ctrl+Shift+V
    await sleep(800);
    check("Ctrl+Shift+V：单行直接粘贴，且只粘贴一次", (await noDialog()) && count(await app.js(tail), "echo CLIP") === 1, String(count(await app.js(tail), "echo CLIP")));
    await clearLine();

    await writeClipboard("echo R1\r\necho R2");
    await app.key("V", "KeyV", 86, 2 | 8);
    check("Ctrl+Shift+V：多行先询问", await dialogOpen());
    await app.click(".modal .btn", "取消");

    // 右键：没有选中内容时粘贴
    const rect = await app.js(`(() => { const r = document.querySelector(".xterm-screen").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await app.mouse("mousePressed", rect, { button: "right" });
    await app.mouse("mouseReleased", rect, { button: "right" });
    check("右键粘贴：多行先询问", await dialogOpen());
    await app.click(".modal .btn", "取消");
    await sleep(300);
    check("右键粘贴：取消后没有粘贴", count(await app.js(tail), "echo R1") === 0);
  } finally {
    // 开始时没有文本（空的或图片等）就清空，Set-Clipboard 不接受空字符串
    if (saved) await writeClipboard(saved);
    else await powershell("Set-Clipboard -Value $null");
  }

  // ---- 关掉确认后直接粘贴 ----
  await app.openMenu(0);
  await app.click(".modal .switch", "粘贴多行内容前确认");
  check("设置：开关已关闭", !(await app.js(`[...document.querySelectorAll(".modal .switch")].find((s) => s.textContent.includes("粘贴多行内容前确认")).querySelector("input").checked`)));
  await app.key("Escape", "Escape", 27);
  await sleep(200);
  await app.click(".term");
  await pasteEvent("echo OFF1\necho OFF2");
  check("关闭确认后：不再询问", await noDialog());
  await sleep(500);
  const off = await app.js(tail);
  check("关闭确认后：直接粘贴并执行", off.includes("OFF1") && off.some((l) => l.endsWith("$ echo OFF2")));
  await clearLine();

  // ---- 链接：不按 Ctrl 只提示，不打开 ----
  await app.type("echo http://example.test/page");
  await app.key("Enter", "Enter", 13);
  await sleep(500);
  const where = await app.js(`(() => {
    const term = window.__termipawTest.terms[0];
    const buf = term.buffer.active;
    for (let i = buf.length - 1; i >= 0; i--) {
      const text = buf.getLine(i)?.translateToString(true) ?? "";
      if (text === "http://example.test/page") {
        const screen = document.querySelector(".xterm-screen").getBoundingClientRect();
        const cellW = screen.width / term.cols, cellH = screen.height / term.rows;
        return { x: screen.x + 5 * cellW, y: screen.y + (i - buf.viewportY + 0.5) * cellH };
      }
    }
    return null;
  })()`);
  check("找到终端里的链接", !!where);
  if (where) {
    await app.js(`document.querySelectorAll(".toast").forEach((t) => t.remove())`);
    await app.mouse("mouseMoved", where);
    await sleep(300);
    await app.mouse("mousePressed", where);
    await app.mouse("mouseReleased", where);
    check("单击链接：提示要按住 Ctrl", await app.waitFor(`document.querySelector(".toast")?.textContent.includes("按住 Ctrl")`, 3000));
  }

  // ---- 窗口不能跳转到别处 ----
  // 不能弹新窗口的限制没有测试：window.open 在有没有限制时都返回 null，区分不出来
  const before = await app.js(`location.href`);
  await app.js(`location.href = "https://example.com/"`);
  await sleep(2500);
  check("页面跳转到外部网址被拦截", (await app.js(`location.hostname`)) === new URL(before).hostname && (await app.js(`!!document.querySelector(".brand")`)), await app.js(`location.href`));
}
