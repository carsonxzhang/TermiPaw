// 断线后自动重连，恢复文件面板和终端目录，把断线期间保存的修改传回去。
// 服务器是真的被杀掉再启动，连接是真的断了。这里用私钥登录，不需要输入密码，才能真正自动连上。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editorExe, launchApp, removeDir, sleep, startServer, tempDir } from "./harness.mjs";

export async function reconnectSuite({ check }) {
  const work = tempDir();
  const serverDir = join(work, "server");
  const appDir = join(work, "app");
  const data = join(appDir, "data");
  mkdirSync(serverDir);
  mkdirSync(data, { recursive: true });
  const keyFile = join(work, "id_ed25519");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyFile]);

  let server = await startServer(serverDir);
  const port = server.port;
  const host = (id, extra) => ({ id, name: id, group: "", host: "127.0.0.1", port, username: "demo", auth: "key", keyPath: keyFile, saveSecret: false, ...extra });
  writeFileSync(join(data, "hosts.json"), JSON.stringify([host("withkey"), host("withpass", { auth: "password" })]));
  writeFileSync(join(data, "editor.json"), JSON.stringify(editorExe));
  const editorLog = join(work, "editor.log");
  const app = await launchApp(appDir, { TERMIPAW_FAKE_EDITOR_LOG: editorLog });

  try {
    const home = server.home;
    mkdirSync(join(home, "projects", "site"), { recursive: true });
    writeFileSync(join(home, "projects", "notes.txt"), "v1\n");

    await app.js(`window.__termipawTest = { terms: [], flows: [], sessions: [], edits: [] }`);
    await app.waitFor(`!!document.querySelector(".host-item")`);
    const open = async (name) => {
      await app.click(".host-item", name, { count: 2 });
      await sleep(300);
    };
    const connected = (ms = 20000) => app.waitFor(`!!document.querySelector(".dot.connected") && !document.querySelector(".overlay")`, ms);
    const acceptHostKey = async () => {
      if (await app.waitFor(`document.querySelector(".modal")?.textContent.includes("验证主机指纹")`, 8000)) await app.click(".modal .btn.primary");
    };
    const termText = `(() => {
      const buf = window.__termipawTest.terms.at(-1).buffer.active;
      const out = [];
      for (let i = Math.max(0, buf.length - 200); i < buf.length; i++) {
        const line = buf.getLine(i);
        const text = line?.translateToString(true) ?? "";
        if (line?.isWrapped && out.length) out[out.length - 1] += text;
        else out.push(text);
      }
      return out.join("\\n");
    })()`;
    const termHas = (text, ms = 8000) => app.waitFor(`${termText}.includes(${JSON.stringify(text)})`, ms);
    const send = async (line) => {
      await app.click(".term");
      await app.type(line);
      await app.key("Enter", "Enter", 13);
      await sleep(200);
    };
    const pathIs = (path, ms = 6000) => app.waitFor(`document.querySelector(".pathbar input")?.value === ${JSON.stringify(path)}`, ms);
    const banner = () => app.js(`document.querySelector(".banner")?.textContent ?? ""`);
    const bannerHas = (text, ms = 15000) => app.waitFor(`document.querySelector(".banner")?.textContent.includes(${JSON.stringify(text)}) === true`, ms);
    const restart = async (env) => {
      server = await startServer(serverDir, env, port);
    };
    const remote = (path) => readFileSync(join(home, path), "utf8");

    // ---- 准备：开着文件面板，开启了集成，正在编辑一个文件 ----
    await open("withkey");
    await acceptHostKey();
    check("私钥登录成功", await connected());
    await app.toggleFiles();
    await app.waitFor(`!!document.querySelector(".sftp .files")`);
    await app.click(".sftp-toolbar .follow-btn");
    await app.waitFor(`!!document.querySelector(".follow-btn.on")`);
    await send("cd /home/demo/projects/site");
    check("准备：文件面板跟随到目录", await pathIs("/home/demo/projects/site"));
    await send("cd /home/demo/projects");
    await pathIs("/home/demo/projects");
    const rowMenu = async (name, action) => {
      await app.waitFor(`[...document.querySelectorAll(".file-row .fname")].some((e) => e.textContent === ${JSON.stringify(name)})`);
      const p = await app.js(`(() => { const r = [...document.querySelectorAll(".file-row")].find((r) => r.querySelector(".fname")?.textContent === ${JSON.stringify(name)}).getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
      await app.mouse("mouseMoved", p);
      await app.mouse("mousePressed", p, { button: "right" });
      await app.mouse("mouseReleased", p, { button: "right" });
      await sleep(200);
      await app.click(".ctx-menu button", action);
    };
    await rowMenu("notes.txt", "fake_editor");
    await app.waitFor(`document.querySelectorAll(".edit-row").length === 1`, 8000);
    const local = readFileSync(editorLog, "utf8").trim().split(/\r?\n/).at(-1);

    // ---- 断线 ----
    server.stop();
    check("断线：提示并准备自动重连", await bannerHas("秒后第 1 次重试"), await banner());
    check("断线：说明原因", (await banner()).includes("连接已断开"), await banner());
    check("断线：终端内容还在", await app.js(`${termText}.includes("projects")`));

    // 断线期间保存：等能连上时再传
    writeFileSync(local, "v2 saved while offline\n");
    await sleep(1500);
    check("断线期间保存：服务器上还是旧内容", remote("projects/notes.txt") === "v1\n");

    // 连不上时继续重试，不弹对话框
    check("服务器没回来：接着重试", await bannerHas("第 2 次重试", 20000), await banner());
    check("重试时不弹对话框", !(await app.js(`!!document.querySelector(".modal")`)));
    check("重试时不挡住终端", !(await app.js(`!!document.querySelector(".overlay")`)));

    // ---- 恢复 ----
    await restart();
    check("服务器回来后：自动连上", await connected(40000), await banner());
    check("终端里能看到重新连接的分隔线", await termHas("重新连接"));
    check("文件面板自动打开", await app.waitFor(`!!document.querySelector(".sftp .files")`));
    check("文件面板回到原来的目录", await pathIs("/home/demo/projects"), await app.js(`document.querySelector(".pathbar input")?.value`));
    check("断线期间保存的修改传回去了", await app.waitFor(`true`) && (await waitFor(() => remote("projects/notes.txt") === "v2 saved while offline\n", 8000)), remote("projects/notes.txt"));
    check("编辑状态回到已同步", await app.waitFor(`document.querySelector(".edit-row .tstat")?.textContent === "已同步"`));

    // 新的 Shell 没有集成，判断不了状态，所以由用户决定回不回去
    check("提示断开前终端所在的目录", await bannerHas("断开前终端位于 /home/demo/projects"), await banner());
    // 窗口窄时提示条不能跑到文件面板下面去
    check("提示条的按钮没有被文件面板挡住", await app.js(`(() => {
      const b = [...document.querySelectorAll(".banner .btn")].find((e) => e.textContent.includes("回到这里")).getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest(".banner") !== null;
    })()`));
    // 新的输出接在旧内容后面，不能盖在屏幕顶部
    check("重新连接后输出在旧内容的后面", await app.js(`(() => {
      const text = ${termText};
      return text.lastIndexOf("重新连接") > text.lastIndexOf("cd /home/demo/projects");
    })()`), JSON.stringify((await app.js(termText)).trimEnd().slice(-200)));
    const settled = await settle(app, ".banner .btn");
    console.log(`INFO  提示条按钮稳定下来用了 ${settled} 毫秒，移动了 ${moved} 次`);
    await app.click(".banner .btn", "回到这里");
    check("回到目录也先确认", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("无法确认")`), await banner());
    await app.click(".modal .btn", "输入");
    await sleep(300);
    await send("pwd");
    check("终端回到了原来的目录", await termHas("/home/demo/projects\r".trim()));
    check("集成也一起恢复了", await app.waitFor(`!!document.querySelector(".follow-btn.on")`));
    await send("cd /home/demo/projects/site");
    check("重新连接后继续跟随", await pathIs("/home/demo/projects/site"));

    // ---- 断在全屏程序里 ----
    await send("altscreen on");
    await sleep(200);
    check("准备：进入全屏模式", (await app.js(`window.__termipawTest.terms.at(-1).buffer.active.type`)) === "alternate");
    server.stop();
    await bannerHas("重试");
    // 这次服务器启动时就有集成，相当于写进了 .bashrc
    await restart({ TERMIPAW_DEV_INTEGRATED: "1" });
    await settle(app, ".banner .btn");
    await app.click(".banner .btn", "立即重连");
    check("断在全屏程序里：重新连接成功", await connected(20000));
    check("断在全屏程序里：退出了全屏模式", await app.waitFor(`window.__termipawTest.terms.at(-1).buffer.active.type === "normal"`), await app.js(`window.__termipawTest.terms.at(-1).buffer.active.type`));

    // Shell 有集成时能确定状态，自动回去，不用问
    check("Shell 有集成：不弹确认", await app.waitFor(`!document.querySelector(".modal")`));
    await sleep(800);
    await send("pwd");
    check("Shell 有集成：自动回到原来的目录", await termHas("/home/demo/projects/site"), (await app.js(termText)).slice(-200));
    check("Shell 有集成：没有留下提示条", !(await banner()).includes("断开前"), await banner());

    // ---- 取消自动重连 ----
    server.stop();
    await bannerHas("秒后第 1 次重试");
    await settle(app, ".banner .btn", 150, 1000);
    await app.click(".banner .btn", "取消重连");
    check("取消重连：不再显示计划", await app.waitFor(`!document.querySelector(".banner").textContent.includes("秒后")`), await banner());
    await restart();
    await sleep(3500);
    check("取消重连：不会自己连上", !(await app.js(`!!document.querySelector(".dot.connected")`)));
    await settle(app, ".banner .btn");
    await app.click(".banner .btn", "重新连接");
    check("取消后手动重连可以连上", await connected());

    // ---- 自己退出不算断线 ----
    await send("exit");
    check("退出 Shell：说明原因", await bannerHas("已退出"), await banner());
    await sleep(3000);
    check("退出 Shell：不自动重连", !(await app.js(`!!document.querySelector(".dot.connected")`)) && !(await banner()).includes("秒后"), await banner());

    await app.key("w", "KeyW", 87, 2);
    await sleep(300);

    // ---- 需要输入密码的主机 ----
    await open("withpass");
    if (await app.waitFor(`document.querySelector(".modal")?.textContent.includes("输入密码")`, 5000)) {
      await app.click(".modal input[type=password]");
      await app.type("demo");
      await app.key("Enter", "Enter", 13);
    }
    await connected();
    server.stop();
    await bannerHas("重试");
    await restart();
    check("需要密码：停下来说明原因", await bannerHas("需要输入密码", 20000), await banner());
    check("需要密码：自动重连不弹密码框", !(await app.js(`!!document.querySelector(".modal input[type=password]")`)));
    await settle(app, ".banner .btn");
    await app.click(".banner .btn", "重新连接");
    check("需要密码：手动重连时才询问", await app.waitFor(`!!document.querySelector(".modal input[type=password]")`));
    await app.click(".modal .btn", "取消");
    await sleep(200);
    await app.key("w", "KeyW", 87, 2);

    // ---- 关闭自动重连的设置 ----
    check("没有留下临时文件", !existsSync(join(home, "projects", ".termipaw-x")));
  } finally {
    await app.stop();
    server.stop();
    await sleep(300);
    removeDir(work);
  }
}

/** 等元素的位置稳定下来。刚重连时布局还在变，按算好的坐标点下去可能点到旁边的按钮 */
let moved = 0;
async function settle(app, selector, quietMs = 400, maxMs = 5000) {
  const position = () => app.js(`JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect())`);
  const start = Date.now();
  let last = await position();
  let quietSince = Date.now();
  moved = 0;
  while (Date.now() - start < maxMs && Date.now() - quietSince < quietMs) {
    await sleep(50);
    const now = await position();
    if (now !== last) {
      last = now;
      quietSince = Date.now();
      moved++;
    }
  }
  return Date.now() - start;
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
}
