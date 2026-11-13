// 多语言。每种语言用对应的系统语言启动，走一遍主要界面：没有漏翻、文字没有被截断、
// 后端的错误和系统文件对话框的标题也是这种语言。

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { de } from "../../src/i18n/de.ts";
import { en } from "../../src/i18n/en.ts";
import { es } from "../../src/i18n/es.ts";
import { fr } from "../../src/i18n/fr.ts";
import { ja } from "../../src/i18n/ja.ts";
import { ko } from "../../src/i18n/ko.ts";
import { zhCN } from "../../src/i18n/zh-CN.ts";
import { zhTW } from "../../src/i18n/zh-TW.ts";
import { launchApp, removeDir, sleep, startServer, tempDir } from "./harness.mjs";

/** 语言，WebView 报告的系统语言，文字 */
const LANGS = [
  ["en", "en-US", en],
  ["zh-CN", "zh-CN", zhCN],
  ["zh-TW", "zh-TW", zhTW],
  ["ja", "ja-JP", ja],
  ["ko", "ko-KR", ko],
  ["fr", "fr-FR", fr],
  ["es", "es-ES", es],
  ["de", "de-DE", de],
];
const RUST_LANG = { en: "En", "zh-CN": "ZhCn", "zh-TW": "ZhTw", ja: "Ja", ko: "Ko", fr: "Fr", es: "Es", de: "De" };
const rust = readFileSync(resolve("src-tauri/src/i18n.rs"), "utf8");
const uploadDialogTitle = (lang) => new RegExp(`\\(${RUST_LANG[lang]}, UploadFiles\\) => "([^"]+)"`).exec(rust)?.[1];

/** 系统文件对话框的标题，读到后关掉对话框 */
function readDialogTitle(pid) {
  const script = resolve("tests/e2e/dialog-title.ps1");
  return new Promise((done) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-AppPid", String(pid)], (err, stdout) => {
      if (err || !stdout.trim()) return done(null);
      done(String.fromCharCode(...stdout.trim().split(",").map(Number)));
    });
  });
}

/**
 * 在页面里检查当前看得到的内容：文字的名字（`vault.unlock` 这种）没有直接显示出来，
 * 按钮和标签没有被截断。`noCjk` 时（英文、法文等）界面上也不能有汉字假名韩文，用来抓漏改的中文
 */
const audit = (noCjk) => `(() => {
  const issues = [];
  const keyLike = /\\b(common|auth|status|time|titleBar|palette|welcome|sidebar|hostEditor|prompts|settings|terminal|shell|sftp|edit|update|vault|backend)\\.[a-zA-Z0-9.]+\\b/;
  const cjk = /[\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af]/;
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden"; };
  // 终端内容、文件名、语言列表里各语言自己的名字不算
  const skip = (el) => el.closest(".xterm, .settings-language, .file-row:not(.head), .fingerprint, .detail, .addr, .pathbar, .tname");
  const test = (text, where) => {
    if (!text) return;
    if (keyLike.test(text)) issues.push("名字：" + text);
    if (${noCjk} && cjk.test(text)) issues.push("中日韩文字：" + text + "（" + where + "）");
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode()); ) {
    const el = n.parentElement;
    if (el && shown(el) && !skip(el)) test(n.textContent.trim(), el.className);
  }
  for (const el of document.querySelectorAll("[title], [placeholder]")) {
    if (shown(el) && !skip(el)) test(el.getAttribute("title") || el.getAttribute("placeholder"), "属性");
  }
  for (const el of document.querySelectorAll("button, label, .btn, .palette-section, .statusbar .item, .file-row.head span, .group-head, .sftp-toolbar .title, h1, h2")) {
    if (shown(el) && !skip(el) && el.scrollWidth > el.clientWidth + 1) issues.push("截断：" + el.textContent.trim().slice(0, 60) + "（" + el.scrollWidth + " > " + el.clientWidth + "）");
  }
  // 文字太长时按钮会把外面撑开，按钮自己看不出来，要看容器
  for (const box of document.querySelectorAll(".modal, .sftp, .sftp-toolbar, .statusbar, .sidebar, .sidebar-foot, .welcome-inner, .ctx-menu, .palette, .lock-card, .titlebar, .banner")) {
    if (shown(box) && box.scrollWidth > box.clientWidth + 1) issues.push("撑出容器：" + box.className + "（" + box.scrollWidth + " > " + box.clientWidth + "）");
  }
  for (const el of document.querySelectorAll(".modal button, .modal label, .modal .switch, .ctx-menu button, .statusbar button, .sftp-toolbar button")) {
    const box = el.closest(".modal, .ctx-menu, .statusbar, .sftp-toolbar");
    if (!shown(el) || skip(el)) continue;
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.right > b.right + 1 || r.left < b.left - 1) issues.push("超出边界：" + el.textContent.trim().slice(0, 60));
  }
  return issues;
})()`;

export async function i18nSuite({ check }) {
  const work = tempDir();
  const serverDir = join(work, "server");
  mkdirSync(serverDir);
  const server = await startServer(serverDir);
  let app;
  const launch = async (dir, lang) => {
    if (app) await app.stop();
    mkdirSync(join(dir, "data"), { recursive: true });
    app = await launchApp(dir, {}, { lang });
    await app.js(`window.__termipawTest = { terms: [], flows: [], sessions: [], edits: [] }`);
  };
  const modalText = () => app.js(`document.querySelector(".modal")?.textContent ?? ""`);
  const escape = async () => {
    await app.key("Escape", "Escape", 27);
    await sleep(250);
  };

  try {
    for (const [lang, systemLang, m] of LANGS) {
      const noCjk = ["en", "fr", "es", "de"].includes(lang);
      await launch(join(work, lang), systemLang);
      const issues = [];
      const look = async (screen) => {
        for (const issue of await app.js(audit(noCjk))) issues.push(`${screen}：${issue}`);
      };

      check(`${lang}：跟随系统语言 ${systemLang}`, (await app.js(`document.documentElement.lang`)) === lang, await app.js(`document.documentElement.lang`));
      check(`${lang}：欢迎页是这种语言`, (await app.js(`document.querySelector(".welcome h1")?.textContent`)) === m.welcome.title);
      await look("欢迎页");

      // 菜单本身也看一眼：三项都是这种语言，没有被截断
      await app.js(`document.querySelector(".menu-btn").click()`);
      await app.waitFor(`document.querySelectorAll(".ctx-menu button").length === 3`);
      check(`${lang}：菜单是这种语言`, (await app.js(`[...document.querySelectorAll(".ctx-menu button")].map((b) => b.textContent.trim()).join("|")`)) === [m.common.settings, m.titleBar.help, m.titleBar.about].join("|"));
      await look("菜单");
      await app.js(`document.querySelectorAll(".ctx-menu button")[0].click()`);
      await app.waitFor(`!!document.querySelector(".settings-language")`);
      await sleep(300);
      check(`${lang}：设置里选的是跟随系统`, (await app.js(`document.querySelector(".settings-language").value`)) === "system");
      check(`${lang}：设置里有保险库`, (await app.js(`document.querySelector(".modal .settings-section h4")?.textContent`)) === m.vault.section);
      const helps = await app.js(`JSON.stringify([...document.querySelectorAll(".modal .help-tip")].map((t) => t.getAttribute("aria-label")))`);
      const expected = ["language", "theme", "font", "fontSize", "cursor", "copyOnSelect", "confirmPaste", "autoReconnect", "vault"].map((k) => m.settings.help[k]);
      check(`${lang}：每个设置项的问号说明是这种语言`, helps === JSON.stringify(expected), helps);
      await look("设置");
      // 最长的一条说明（保险库）显示出来，看有没有超出窗口
      await app.hover(".modal .settings-section .help-tip");
      const pop = await app.js(`(() => { const e = document.querySelector(".help-pop"); if (!e) return "没有显示"; const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight ? "" : [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight].join(" "); })()`);
      check(`${lang}：问号说明完整显示在窗口内`, pop === "", pop);
      await look("设置说明");
      await escape();

      await app.openMenu(2);
      await app.waitFor(`!!document.querySelector(".about-head")`);
      await sleep(300);
      check(`${lang}：关于窗口标题只有 TermiPaw`, (await app.js(`document.querySelector(".modal h3").textContent.trim()`)) === "TermiPaw");
      await look("关于");
      await escape();

      await app.key("n", "KeyN", 78, 2);
      await app.waitFor(`!!document.querySelector(".modal")`);
      await sleep(300);
      await look("主机编辑器");
      await escape();

      await app.click(".search-trigger");
      await sleep(300);
      await look("命令面板");
      await escape();

      // 首次连接：指纹确认，然后故意输错一次密码，看后端的错误
      await app.click(".quick input");
      await app.type(`demo@127.0.0.1:${server.port}`);
      await app.key("Enter", "Enter", 13);
      const askedKey = await app.waitFor(`!!document.querySelector(".modal .fingerprint")`, 15000);
      check(`${lang}：指纹确认`, askedKey && (await modalText()).includes(m.prompts.trust));
      await sleep(300);
      await look("指纹确认");
      await app.click(".modal .btn.primary");
      await app.waitFor(`!!document.querySelector(".modal input[type=password]")`, 15000);
      await app.click(".modal input[type=password]");
      await app.type("wrong");
      await app.key("Enter", "Enter", 13);
      const wrong = m.backend["ssh.wrongPassword"];
      check(`${lang}：后端错误是这种语言`, await app.waitFor(`document.querySelector(".modal")?.textContent.includes(${JSON.stringify(wrong)})`, 15000), await modalText());
      await sleep(300);
      await look("密码输入");
      await app.click(".modal input[type=password]");
      await app.type("demo");
      await app.key("Enter", "Enter", 13);
      const connected = await app.waitFor(`!!document.querySelector(".dot.connected") && !document.querySelector(".modal")`, 20000);
      check(`${lang}：连上了`, connected);

      await app.toggleFiles();
      await app.waitFor(`!!document.querySelector(".sftp .file-row.head")`, 10000);
      await sleep(500);
      await look("文件面板和状态栏");
      const area = await app.js(`(() => { const r = document.querySelector(".files").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.bottom - 20 }; })()`);
      await app.mouse("mouseMoved", area);
      await app.mouse("mousePressed", area, { button: "right" });
      await app.mouse("mouseReleased", area, { button: "right" });
      await sleep(300);
      await look("右键菜单");
      // 系统文件对话框的标题由后端决定
      const titlePromise = readDialogTitle(app.pid);
      await app.js(`[...document.querySelectorAll(".ctx-menu button")].find((b) => b.textContent.includes(${JSON.stringify(m.sftp.uploadFiles)}))?.click()`);
      const title = await titlePromise;
      check(`${lang}：文件对话框的标题是这种语言`, title === uploadDialogTitle(lang), `${title} / ${uploadDialogTitle(lang)}`);
      await sleep(300);

      check(`${lang}：界面上没有漏翻和截断`, issues.length === 0, issues.slice(0, 8).join(" | "));
    }

    // ---- 在设置里切换 ----
    const switchDir = join(work, "switch");
    await launch(switchDir, "en-US");
    const chooseLanguage = async (value) => {
      await app.openMenu(0);
      await app.waitFor(`!!document.querySelector(".settings-language")`);
      await app.js(`(() => { const s = document.querySelector(".settings-language"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await sleep(300);
    };
    await chooseLanguage("ja");
    check("切换：立即生效", (await app.js(`document.documentElement.lang`)) === "ja" && (await modalText()).includes(ja.settings.title));
    check("切换：后面的界面也跟着变", (await app.js(`document.querySelector(".statusbar")?.textContent ?? ""`)).includes(ja.status.ready));
    await launch(switchDir, "en-US");
    check("切换：重启后保持", (await app.js(`document.documentElement.lang`)) === "ja" && (await app.js(`document.querySelector(".welcome h1")?.textContent`)) === ja.welcome.title);
    await chooseLanguage("system");
    check("切换：改回跟随系统", (await app.js(`document.documentElement.lang`)) === "en");
    await escape();

    // ---- 重置保险库的确认词：界面显示的词后端真的接受 ----
    await launch(join(work, "reset"), "fr-FR");
    const invoke = (cmd, args = {}) => app.js(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then((v) => ({ ok: v }), (e) => ({ err: e }))`);
    const enabled = await invoke("vault_enable", { password: "correct horse battery staple", recovery: false, encryptMetadata: false });
    check("确认词：开启保险库", !enabled.err, JSON.stringify(enabled.err ?? ""));
    await app.js(`window.__TAURI_INTERNALS__.invoke("vault_lock").then(() => window.dispatchEvent(new Event("focus")))`);
    await launch(join(work, "reset"), "fr-FR");
    await app.waitFor(`!!document.querySelector(".lock-screen .lock-card")`);
    await app.click(".lock-links .link", fr.vault.forgot);
    await app.waitFor(`!!document.querySelector(".lock-confirm")`);
    check("确认词：显示这种语言的词", (await app.js(`document.querySelector(".lock-card label")?.textContent ?? ""`)).includes(fr.vault.resetWord));
    const wrongWord = await invoke("vault_reset", { confirm: zhCN.vault.resetWord });
    check("确认词：别的语言的词不行", wrongWord.err?.code === "vault.resetConfirm", JSON.stringify(wrongWord));
    await app.click(".lock-confirm");
    await app.type(fr.vault.resetWord);
    await app.click(".lock-submit");
    check("确认词：这种语言的词可以重置", await app.waitFor(`!document.querySelector(".lock-screen")`, 15000));
  } finally {
    if (app) await app.stop();
    server.stop();
    removeDir(work);
  }
}
