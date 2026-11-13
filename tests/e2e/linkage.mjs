// 终端与文件联动：目录跟随、往终端输入命令前的判断、恶意文件名。
// 用单独的开发服务器，它的主目录里多了几个模拟恶意服务器给出的名字（Windows 上建不出这些文件）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeDir, sleep, startServer, tempDir } from "./harness.mjs";

const RLO = String.fromCodePoint(0x202e);
const SPOOFED = `invoice${RLO}txt.exe`;
const INJECTION = ["evil", String.fromCharCode(3), "touch pwned", String.fromCharCode(13), "x"].join("");

const hex = (text) => Buffer.from(text, "utf8").toString("hex");
/** 和 SftpPanel 里一样：点了跟随按钮后等这么久才判断 Shell 不支持 */
const INTEGRATION_WAIT = 3000;

export async function linkageSuite(app, appDir, { check }) {
  const serverDir = tempDir();
  const server = await startServer(serverDir, {
    TERMIPAW_SFTP_FAKE_NAMES: JSON.stringify([
      [SPOOFED, false],
      [INJECTION, true],
    ]),
  });
  const home = server.home;
  try {
    await run(app, server, home, appDir, { check });
  } finally {
    server.stop();
    await sleep(300);
    removeDir(serverDir);
  }
}

async function run(app, server, home, appDir, { check }) {
  mkdirSync(join(home, "projects", "site"), { recursive: true });
  mkdirSync(join(home, "中文 目录"), { recursive: true });
  mkdirSync(join(home, "it's"), { recursive: true });

  await app.js(`window.__termipawTest = { terms: [], flows: [] }`);
  await app.palette(`demo@127.0.0.1:${server.port}`);
  await app.authenticate();
  await app.toggleFiles();
  await app.waitFor(`!!document.querySelector(".sftp .files")`);

  const termText = `(() => {
    const buf = window.__termipawTest.terms.at(-1).buffer.active;
    const out = [];
    for (let i = Math.max(0, buf.length - 300); i < buf.length; i++) {
      const line = buf.getLine(i);
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped && out.length) out[out.length - 1] += text;
      else out.push(text);
    }
    return out.join("\\n");
  })()`;
  const termHas = (text, ms = 8000) => app.waitFor(`${termText}.includes(${JSON.stringify(text)})`, ms);
  const focusTerm = () => app.click(".term");
  const send = async (line) => {
    await focusTerm();
    await app.type(line);
    await app.key("Enter", "Enter", 13);
    await sleep(150);
  };
  const pathShown = () => app.js(`document.querySelector(".pathbar input").value`);
  const pathIs = (path, ms = 4000) => app.waitFor(`document.querySelector(".pathbar input").value === ${JSON.stringify(path)}`, ms);
  const modalText = () => app.js(`document.querySelector(".modal")?.textContent ?? ""`);
  const rowMenu = async (nameIncludes, action) => {
    const p = await app.js(`(() => {
      const row = [...document.querySelectorAll(".file-row")].find((r) => r.querySelector(".fname")?.textContent.includes(${JSON.stringify(nameIncludes)}));
      if (!row) return null;
      row.scrollIntoView({ block: "nearest" });
      const r = row.getBoundingClientRect();
      return { x: r.x + 40, y: r.y + r.height / 2 };
    })()`);
    if (!p) throw new Error(`找不到 ${nameIncludes}`);
    await app.mouse("mouseMoved", p);
    await app.mouse("mousePressed", p, { button: "right" });
    await app.mouse("mouseReleased", p, { button: "right" });
    await sleep(200);
    await app.click(".ctx-menu button", action);
  };
  const rowNames = () => app.js(`[...document.querySelectorAll(".file-row .fname")].map((e) => e.textContent)`);
  const toastSeen = (text, ms = 3000) => app.waitFor(`[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes(${JSON.stringify(text)}))`, ms);

  // ---- 恶意文件名 ----
  const names = await rowNames();
  check("RTL 伪装的文件名显示出真实结构", names.includes("invoice⟦U+202E⟧txt.exe"), names.join(" | "));
  check("文件列表里没有方向控制字符", !names.some((n) => n.includes(RLO)));
  const injectedName = names.find((n) => n.startsWith("evil"));
  check("控制字符显示为可见符号", injectedName === "evil␃touch pwned␍x", JSON.stringify(injectedName));
  check("这样的名字标了醒目颜色", await app.js(`[...document.querySelectorAll(".fname.odd")].length === 2`));

  await rowMenu("evil", "在终端中进入");
  check("目录名有控制字符：拒绝输入到终端", await toastSeen("控制字符"));
  await sleep(300);
  check("目录名有控制字符：后面藏的命令没有执行", !existsSync(join(home, "pwned")) && !(await app.js(`${termText}.includes("touch pwned")`)));

  // 对照：把旧版会输入的内容原样发给 Shell，引号挡不住控制字符，后面的命令真的会运行
  const oldCommand = `cd '/home/demo/${INJECTION}'\r`;
  await app.js(`window.__termipawTest.terms.at(-1).input(${JSON.stringify(oldCommand)}, true)`);
  check("对照：只加引号时，藏在目录名里的命令会运行", await termHas("touch: 命令未找到"), (await app.js(termText)).slice(-200));
  await focusTerm();
  await app.key("c", "KeyC", 67, 2);
  await sleep(200);

  await rowMenu("invoice", "删除");
  await app.waitFor(`!!document.querySelector(".modal")`);
  const deleteDialog = await modalText();
  check("确认框里也显示真实结构", deleteDialog.includes("invoice⟦U+202E⟧txt.exe") && !deleteDialog.includes(RLO), deleteDialog);
  await app.click(".modal .btn", "取消");
  await sleep(200);

  // ---- 没有开启 Shell 集成 ----
  const followBtn = `document.querySelector(".sftp-toolbar .follow-btn")`;
  check("Shell 没有报告目录：不显示提示条", !(await app.js(`!!document.querySelector(".sftp-hint")`)));
  check("Shell 没有报告目录：跟随按钮不亮，说明点了会发命令", await app.js(`!${followBtn}.classList.contains("on") && ${followBtn}.title.includes("发送一行命令")`), await app.js(`${followBtn}.title`));
  await rowMenu("projects", "在终端中进入");
  check("判断不了 Shell 状态时先确认", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("无法确认")`));
  check("确认框里显示要输入的命令", (await modalText()).includes(`cd '/home/demo/projects'`), await modalText());
  await app.click(".modal .btn", "取消");
  await sleep(300);
  await focusTerm();
  await app.key("Enter", "Enter", 13);
  check("取消后命令没有输入", !(await app.js(`${termText}.includes("cd '/home/demo/projects'")`)));

  await rowMenu("projects", "在终端中进入");
  await app.waitFor(`!!document.querySelector(".modal")`);
  await app.click(".modal .btn", "输入");
  await sleep(200);
  await send("pwd");
  check("确认后命令输入到终端", await termHas("/home/demo/projects"));

  // ---- 全屏程序和打了一半的行 ----
  await send("cd /home/demo");
  await send("altscreen on");
  await sleep(200);
  await rowMenu("projects", "在终端中进入");
  check("全屏程序：直接拒绝", await toastSeen("全屏程序"));
  check("全屏程序：不弹确认", !(await app.js(`!!document.querySelector(".modal")`)));
  await send("altscreen off");
  await sleep(200);

  await focusTerm();
  await app.type("rm -rf ");
  await sleep(150);
  await rowMenu("projects", "在终端中进入");
  check("当前行打了一半：直接拒绝", await toastSeen("尚未执行的内容"));
  await focusTerm();
  await app.key("c", "KeyC", 67, 2);
  await sleep(200);

  // ---- 每次登录都跟随：右键菜单里给出配置 ----
  const head = await app.js(`(() => { const r = document.querySelector(".file-row.head").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await app.mouse("mouseMoved", head);
  await app.mouse("mousePressed", head, { button: "right" });
  await app.mouse("mouseReleased", head, { button: "right" });
  await sleep(200);
  await app.click(".ctx-menu button", "每次登录都跟随终端目录");
  await app.waitFor(`!!document.querySelector(".modal")`);
  check("每次登录都跟随：显示要加进 .bashrc 的配置", (await modalText()).includes(".bashrc") && (await modalText()).includes("__tp_cwd"), await modalText());
  await app.click(".modal .btn", "取消");
  await sleep(200);
  check("只是显示配置，没有往终端输入", !(await app.js(`${termText}.includes("__tp_cwd")`)));

  // ---- 不支持的 Shell：命令发出去了，但 Shell 一直不报告 ----
  await send("integrate never");
  await app.click(".sftp-toolbar .follow-btn");
  await sleep(300);
  check("点跟随按钮：直接输入，不再确认", !(await app.js(`!!document.querySelector(".modal")`)));
  check("不支持的 Shell：提示只支持 bash 和 zsh", await toastSeen("只支持 bash 和 zsh", 6000));
  check("不支持的 Shell：按钮仍然不亮", !(await app.js(`${followBtn}.classList.contains("on")`)));
  await send("integrate any");

  // ---- 开启 Shell 集成 ----
  await app.click(".sftp-toolbar .follow-btn");
  check("点跟随按钮：Shell 开始报告目录，按钮亮起", await app.waitFor(`${followBtn}.classList.contains("on")`));
  check("开启后不弹确认框", !(await app.js(`!!document.querySelector(".modal")`)));
  await sleep(INTEGRATION_WAIT + 300);
  check("支持的 Shell：不提示不支持", !(await app.js(`[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("只支持 bash"))`)));

  // ---- 跟随目录 ----
  await send("cd /home/demo/projects");
  check("终端进入目录：文件面板跟随", await pathIs("/home/demo/projects"), await pathShown());
  await send("cd site");
  check("相对路径也能跟随", await pathIs("/home/demo/projects/site"), await pathShown());
  await send(`cd '/home/demo/中文 目录'`);
  check("中文和空格：解码后跟随", await pathIs("/home/demo/中文 目录"), await pathShown());

  // 用户自己翻到别的目录后，提示符再次上报同一个目录不能把它顶掉
  await app.click(".sftp-toolbar [title='上一级']");
  await pathIs("/home/demo");
  await send("pwd");
  await sleep(500);
  check("终端目录没变时，不顶掉用户自己翻到的目录", (await pathShown()) === "/home/demo", await pathShown());
  await send("cd /home/demo/projects");
  check("终端目录变了才再次跟随", await pathIs("/home/demo/projects"), await pathShown());

  // 关闭跟随
  await app.click(".sftp-toolbar [title^='正在跟随']");
  await send("cd /home/demo");
  await sleep(500);
  check("关闭跟随后不再跳转", (await pathShown()) === "/home/demo/projects", await pathShown());
  await app.click(".sftp-toolbar [title='跟随终端目录']");
  check("重新开启后跳到终端所在的目录", await pathIs("/home/demo"), await pathShown());

  // ---- 集成开启后的状态判断 ----
  const noModal = () => app.js(`!document.querySelector(".modal")`);
  await rowMenu("it's", "在终端中进入");
  await sleep(300);
  check("停在提示符：不用确认", await noModal());
  check("带引号的目录能进入并跟随", await pathIs("/home/demo/it's"), await pathShown());

  await send("cd /home/demo");
  await pathIs("/home/demo");
  await send("askpw");
  await sleep(200);
  await rowMenu("projects", "在终端中进入");
  check("程序正在运行：先确认", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("正在运行")`), await modalText());
  await app.click(".modal .btn", "取消");
  await sleep(200);
  await focusTerm();
  await app.type("hunter2");
  await app.key("Enter", "Enter", 13);
  await sleep(300);
  check("取消后命令没有变成密码", readFileSync(join(home, "askpw.log"), "utf8") === "hunter2", readFileSync(join(home, "askpw.log"), "utf8"));

  // ---- 不可信的上报 ----
  // 真实的提示符紧接着会上报正确的目录，把测试内容盖掉，所以先让提示符不再上报，只看注入的内容
  await send("integrate off");
  const report = (host, path) => `\x1b]7;file://${host}${path}\x1b\\`;
  // 对照：合法的上报确实会让面板跳转，否则下面“没有跳转”的检查没有意义
  await send(`rawhex ${hex(report("termipaw", "/home/demo/projects"))}`);
  check("对照：合法的上报会跳转", await pathIs("/home/demo/projects"), await pathShown());
  await send(`rawhex ${hex(report("termipaw", "/home/demo"))}`);
  await pathIs("/home/demo");
  const raw = async (payload, note) => {
    await send(`rawhex ${hex(payload)}`);
    await sleep(350);
    check(`不接受的上报：${note}`, (await pathShown()) === "/home/demo", await pathShown());
  };
  await raw("\x1b]7;file://termipaw/home/demo/../../etc\x1b\\", "含 ..");
  await raw("\x1b]7;file://termipaw/home/%0Ademo\x1b\\", "含编码过的换行");
  await raw("\x1b]7;/etc\x1b\\", "不是 file:// 地址");
  await raw("\x1b]7;file://termipaw/%ff\x1b\\", "不是合法的 UTF-8");
  await raw(`\x1b]7;file://termipaw/${"a/".repeat(9000)}\x1b\\`.slice(0, 18100), "太长");

  // 另一台机器上报的目录（比如在终端里又 ssh 到了别处）
  await send(`rawhex ${hex("\x1b]7;file://other-host/etc\x1b\\")}`);
  check("别的机器上报的目录：提示不跟随", await app.waitFor(`document.querySelector(".sftp-hint")?.textContent.includes("other-host") === true`), await app.js(`document.querySelector(".sftp-hint")?.textContent ?? ""`));
  check("别的机器上报的目录：面板不动", (await pathShown()) === "/home/demo", await pathShown());
  await send(`rawhex ${hex(report("termipaw", "/home/demo"))}`);
  check("回到这台机器：提示消失", await app.waitFor(`!document.querySelector(".sftp-hint")`));

  // 打不开的目录：不弹提示刷屏，在面板里说明
  await send(`rawhex ${hex("\x1b]7;file://termipaw/no/such/dir\x1b\\")}`);
  check("打不开的目录：在面板里说明", await app.waitFor(`document.querySelector(".sftp-hint.warn")?.textContent.includes("/no/such/dir") === true`), await app.js(`document.querySelector(".sftp-hint")?.textContent ?? ""`));
  check("打不开的目录：不弹错误提示", !(await app.js(`[...document.querySelectorAll(".toast.error")].some((t) => t.textContent.includes("no/such"))`)));

  // 连续上报不能把 SFTP 请求刷爆：面板只处理最后一个
  const burst = Array.from({ length: 300 }, (_, i) => `\x1b]7;file://termipaw/burst/${i}\x1b\\`).join("") + "\x1b]7;file://termipaw/home/demo/projects\x1b\\";
  await send(`rawhex ${hex(burst)}`);
  check("连续上报：停在最后一个", await pathIs("/home/demo/projects", 5000), await pathShown());

  // ---- 名字里带 “/”：不能借新建文件夹或重命名跑到别的目录 ----
  await app.click(".sftp-toolbar [title='新建文件夹']");
  await app.waitFor(`!!document.querySelector(".modal input")`);
  await app.type("evil/nested");
  await app.click(".modal .btn", "确定");
  check("新建文件夹：名字带 / 时拒绝", await toastSeen("不能包含"));
  await sleep(300);
  check("新建文件夹：没有建出目录", !existsSync(join(home, "projects", "evil")));
  await rowMenu("site", "重命名");
  await app.waitFor(`!!document.querySelector(".modal input")`);
  await app.js(`document.querySelector(".modal input").select()`);
  await app.type("../moved");
  await app.click(".modal .btn", "确定");
  check("重命名：名字带 / 时拒绝", await toastSeen("不能包含"));
  await sleep(300);
  check("重命名：目录还在原处", existsSync(join(home, "projects", "site")) && !existsSync(join(home, "moved")));

  await app.key("w", "KeyW", 87, 2);
  writeFileSync(join(appDir, "done"), "");
}
