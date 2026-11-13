// 用本地程序打开远程文件并自动传回。“编辑器”是 examples/fake_editor.rs：记下收到的路径就退出，由脚本改文件来模拟保存。

import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { editorExe, removeDir, sleep, startServer, tempDir } from "./harness.mjs";

const RLO = String.fromCodePoint(0x202e);

export async function editingSuite(app, appDir, editorLog, { check }) {
  const serverDir = tempDir();
  const server = await startServer(serverDir, { TERMIPAW_SFTP_FAKE_NAMES: JSON.stringify([[`invoice${RLO}txt.exe`, false]]) });
  const otherDir = tempDir();
  const other = await startServer(otherDir);
  const home = server.home;
  try {
    writeFileSync(join(home, "notes.txt"), "line one\n");
    writeFileSync(join(home, "evil.exe"), "MZ");
    writeFileSync(join(home, "deploy.sh"), "#!/bin/sh\n");
    writeFileSync(join(home, "shortcut.lnk"), "x");

    await app.js(`window.__termipawTest = { terms: [], flows: [], sessions: [], edits: [] }`);
    await app.palette(`demo@127.0.0.1:${server.port}`);
    await app.authenticate();
    await app.toggleFiles();
    await app.waitFor(`[...document.querySelectorAll(".file-row .fname")].some((e) => e.textContent === "notes.txt")`);

    const rowMenu = async (name, action) => {
      const p = await app.js(`(() => {
        const row = [...document.querySelectorAll(".file-row")].find((r) => r.querySelector(".fname")?.textContent.includes(${JSON.stringify(name)}));
        if (!row) return null;
        row.scrollIntoView({ block: "nearest" });
        const r = row.getBoundingClientRect();
        return { x: r.x + 40, y: r.y + r.height / 2 };
      })()`);
      if (!p) throw new Error(`找不到 ${name}`);
      await app.mouse("mouseMoved", p);
      await app.mouse("mousePressed", p, { button: "right" });
      await app.mouse("mouseReleased", p, { button: "right" });
      await sleep(200);
      await app.click(".ctx-menu button", action);
    };
    /** 只打开右键菜单，不点 */
    const rowMenuOnly = async (name) => {
      const p = await app.js(`(() => {
        const row = [...document.querySelectorAll(".file-row")].find((r) => r.querySelector(".fname")?.textContent.includes(${JSON.stringify(name)}));
        if (!row) return null;
        row.scrollIntoView({ block: "nearest" });
        const r = row.getBoundingClientRect();
        return { x: r.x + 40, y: r.y + r.height / 2 };
      })()`);
      if (!p) throw new Error(`找不到 ${name}`);
      await app.mouse("mouseMoved", p);
      await app.mouse("mousePressed", p, { button: "right" });
      await app.mouse("mouseReleased", p, { button: "right" });
      await sleep(300);
    };
    const toastSeen = (text, ms = 5000) => app.waitFor(`[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes(${JSON.stringify(text)}))`, ms);
    const openedPaths = () => (existsSync(editorLog) ? readFileSync(editorLog, "utf8").split(/\r?\n/).filter(Boolean) : []);
    const remote = (name) => readFileSync(join(home, name), "utf8");
    const remoteIs = async (name, content, ms = 6000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        // 替换文件时有一小段时间文件不在，检查和读取之间也可能碰上
        try {
          if (remote(name) === content) return true;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        await sleep(100);
      }
      return false;
    };
    const editStatus = (name) => app.js(`[...document.querySelectorAll(".edit-row")].find((r) => r.querySelector(".tname").textContent.includes(${JSON.stringify(name)}))?.querySelector(".tstat").textContent ?? ""`);
    const statusIs = (name, text, ms = 6000) => app.waitFor(`[...document.querySelectorAll(".edit-row")].find((r) => r.querySelector(".tname").textContent.includes(${JSON.stringify(name)}))?.querySelector(".tstat").textContent.includes(${JSON.stringify(text)}) === true`, ms);

    // ---- 系统默认程序：可执行类型一律拦截 ----
    for (const [name, label] of [
      ["evil.exe", ".exe"],
      ["shortcut.lnk", ".lnk"],
      ["deploy.sh", ".sh"],
      ["invoice", "RTL 伪装的 .exe"],
    ]) {
      await rowMenu(name, "用默认程序打开");
      check(`用默认程序：拦截 ${label}`, await app.waitFor(`document.querySelector(".modal")?.textContent.includes("已拦截")`), await app.js(`document.querySelector(".modal")?.textContent ?? ""`));
      await app.click(".modal .btn", "知道了");
      await sleep(200);
    }
    check("拦截时没有启动任何程序", openedPaths().length === 0, openedPaths().join());
    check("拦截时不留在传输列表里", (await app.js(`document.querySelectorAll(".transfer").length`)) === 0);
    check("拦截时没有下载到本地", !existsSync(join(app.dataDir, "editing")) || (await dirEmpty(join(app.dataDir, "editing"))));

    // ---- 右键：选择其他程序打开。在系统对话框里选，之后菜单里直接列出它 ----
    const menuTexts = () => app.js(`[...document.querySelectorAll(".ctx-menu button")].map((b) => b.textContent).join("|")`);
    await rowMenuOnly("notes.txt");
    check("没选过程序：菜单里只有默认程序和选择其他程序", /用默认程序打开\|选择其他程序打开…/.test(await menuTexts()) && !(await menuTexts()).includes("fake_editor"), await menuTexts());
    await app.click(".ctx-menu button", "选择其他程序打开");
    await app.answerFileDialog([editorExe]);

    // ---- 打开和自动传回 ----
    check("打开：启动了指定的程序", await app.waitFor(`document.querySelectorAll(".edit-row").length === 1`, 8000) && openedPaths().length === 1, openedPaths().join());
    const local = openedPaths()[0];
    check("打开：文件在工作目录里", local?.startsWith(join(app.dataDir, "editing")), local);
    check("打开：内容和服务器一样", readFileSync(local, "utf8") === "line one\n");
    check("打开：显示已同步", await statusIs("notes.txt", "已同步"));

    await sleep(1000);
    writeFileSync(local, "line one\nline two\n");
    check("保存：自动传回服务器", await remoteIs("notes.txt", "line one\nline two\n"));
    check("保存：提示已传回", await toastSeen("已传回"));
    check("保存：显示已同步", await statusIs("notes.txt", "已同步"));
    check("保存：传完的不留在传输列表里", await app.waitFor(`document.querySelectorAll(".transfer").length === 0`, 3000));
    check("保存：列表刷新了大小", await app.waitFor(`[...document.querySelectorAll(".file-row")].find((r) => r.querySelector(".fname")?.textContent === "notes.txt")?.querySelector(".fsize").textContent === "18 B"`));

    // 内容没变的保存不传
    const mtime = statSync(join(home, "notes.txt")).mtimeMs;
    await sleep(1100);
    writeFileSync(local, "line one\nline two\n");
    await sleep(2500);
    check("内容没变的保存：不传", statSync(join(home, "notes.txt")).mtimeMs === mtime);

    // 很多编辑器是写临时文件再改名
    await sleep(300);
    writeFileSync(`${local}.tmp`, "saved by rename\n");
    rmSync(local);
    renameSync(`${local}.tmp`, local);
    check("先删除再改名的保存方式：也能传回", await remoteIs("notes.txt", "saved by rename\n"));

    // 重复打开同一个文件：不新建副本
    await rowMenu("notes.txt", "fake_editor");
    await sleep(600);
    check("重复打开：不新建副本", (await app.js(`document.querySelectorAll(".edit-row").length`)) === 1 && openedPaths().length === 2 && openedPaths()[1] === local, openedPaths().join());

    // ---- 服务器上的文件也被改过 ----
    await statusIs("notes.txt", "已同步");
    writeFileSync(join(home, "notes.txt"), "changed on the server\n");
    utimesSync(join(home, "notes.txt"), new Date(), new Date(Date.now() + 60_000));
    writeFileSync(local, "changed locally\n");
    check("服务器也改过：先询问", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("也被改过")`, 8000));
    check("服务器也改过：默认聚焦在暂不传回", (await app.js(`document.activeElement?.textContent`)) === "暂不传回");
    check("询问时服务器上的内容没动", remote("notes.txt") === "changed on the server\n");
    await app.click(".modal .btn", "暂不传回");
    check("选择暂不传回：标出冲突", await statusIs("notes.txt", "也改过"), await editStatus("notes.txt"));
    await sleep(1600);
    check("选择暂不传回：服务器上的内容不变", remote("notes.txt") === "changed on the server\n");
    await app.click(".edit-row .btn", "覆盖");
    check("点击覆盖：传回服务器", await remoteIs("notes.txt", "changed locally\n"));
    check("点击覆盖：回到已同步", await statusIs("notes.txt", "已同步"));

    // ---- 已经有对话框时又来一个询问：排队，不能把正在显示的顶掉 ----
    await sleep(500);
    await rowMenu("evil.exe", "删除");
    await app.waitFor(`document.querySelector(".modal")?.textContent.includes("删除文件")`);
    writeFileSync(join(home, "notes.txt"), "changed on the server again\n");
    utimesSync(join(home, "notes.txt"), new Date(), new Date(Date.now() + 90_000));
    writeFileSync(local, "changed locally again\n");
    await sleep(2500);
    check("排队的询问：正在显示的对话框没有被顶掉", (await app.js(`document.querySelector(".modal")?.textContent ?? ""`)).includes("删除文件"), await app.js(`document.querySelector(".modal")?.textContent ?? ""`));
    await app.click(".modal .btn", "取消");
    check("排队的询问：关掉后轮到下一个", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("也被改过")`, 8000), await app.js(`document.querySelector(".modal")?.textContent ?? ""`));
    await app.click(".modal .btn", "覆盖");
    check("排队的询问：回答后照常处理", await remoteIs("notes.txt", "changed locally again\n"));
    await statusIs("notes.txt", "已同步");

    // ---- 只读文件：第一次传回前问一次 ----
    const stopEditing = async (name) => {
      await app.js(`[...document.querySelectorAll(".edit-row")].find((r) => r.textContent.includes(${JSON.stringify(name)})).querySelector("[title='停止编辑']").click()`);
      await app.waitFor(`![...document.querySelectorAll(".edit-row")].some((r) => r.textContent.includes(${JSON.stringify(name)}))`);
      chmodSync(join(home, name), 0o644);
      rmSync(join(home, name));
    };
    const modalText = () => app.js(`document.querySelector(".modal")?.textContent ?? ""`);
    await sleep(500);
    writeFileSync(join(home, "locked.txt"), "locked old\n");
    chmodSync(join(home, "locked.txt"), 0o444);
    await app.click(".sftp-toolbar [title='刷新']");
    await sleep(300);
    await rowMenu("locked.txt", "fake_editor");
    await app.waitFor(`[...document.querySelectorAll(".edit-row")].some((r) => r.textContent.includes("locked.txt"))`, 8000);
    const lockedLocal = openedPaths().at(-1);
    check("只读文件：打开时不询问", (await statusIs("locked.txt", "已同步")) && (await modalText()) === "");
    await sleep(1000);
    writeFileSync(lockedLocal, "first save\n");
    check("只读文件：保存后先询问", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("这是只读文件")`, 8000), await modalText());
    check("只读文件：默认聚焦在暂不传回", (await app.js(`document.activeElement?.textContent`)) === "暂不传回");
    check("只读文件：询问时服务器上的内容没动", remote("locked.txt") === "locked old\n");
    // 询问还开着时又保存：不能再排一个询问
    writeFileSync(lockedLocal, "second save\n");
    await sleep(2500);
    await app.click(".modal .btn", "暂不传回");
    await sleep(1500);
    check("只读文件：询问时再保存，不会多问一次", (await modalText()) === "", await modalText());
    check("只读文件：选择暂不传回后内容不变", remote("locked.txt") === "locked old\n");
    check("只读文件：选择暂不传回后标出来", await statusIs("locked.txt", "只读文件"), await editStatus("locked.txt"));
    await app.click(".edit-row .btn", "替换");
    check("只读文件：点击替换后传回最新内容", await remoteIs("locked.txt", "second save\n"), remote("locked.txt"));
    check("只读文件：替换后回到已同步", await statusIs("locked.txt", "已同步"));
    await sleep(1000);
    writeFileSync(lockedLocal, "third save\n");
    check("只读文件：之后的保存不再询问", (await remoteIs("locked.txt", "third save\n")) && (await modalText()) === "", remote("locked.txt"));
    await statusIs("locked.txt", "已同步");
    await stopEditing("locked.txt");

    // 打开之后才变成只读：看的是传回时的权限。只改权限不算“别人也改过”
    writeFileSync(join(home, "later.txt"), "later old\n");
    await app.click(".sftp-toolbar [title='刷新']");
    await sleep(300);
    await rowMenu("later.txt", "fake_editor");
    await app.waitFor(`[...document.querySelectorAll(".edit-row")].some((r) => r.textContent.includes("later.txt"))`, 8000);
    const laterLocal = openedPaths().at(-1);
    await statusIs("later.txt", "已同步");
    chmodSync(join(home, "later.txt"), 0o444);
    await sleep(1000);
    writeFileSync(laterLocal, "later new\n");
    check("打开后才变成只读：传回前也询问", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("这是只读文件")`, 8000), await modalText());
    await app.click(".modal .btn", "替换");
    check("打开后才变成只读：同意后传回", await remoteIs("later.txt", "later new\n"), remote("later.txt"));
    await statusIs("later.txt", "已同步");
    await stopEditing("later.txt");
    await app.click(".sftp-toolbar [title='刷新']");
    await sleep(300);

    // ---- 服务器上的文件被删除 ----
    await sleep(500);
    rmSync(join(home, "notes.txt"));
    writeFileSync(local, "after delete\n");
    check("服务器上被删除：先询问", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("已被删除")`, 8000));
    await app.click(".modal .btn", "重新创建");
    check("选择重新创建：文件回来了", await remoteIs("notes.txt", "after delete\n"));

    // ---- 不能把文件接到别的服务器上 ----
    await app.palette(`demo@127.0.0.1:${other.port}`);
    await app.authenticate();
    await app.waitFor(`window.__termipawTest.sessions.length === 2`);
    const refused = await app.js(`window.__TAURI_INTERNALS__.invoke("edit_attach", { editId: window.__termipawTest.edits[0], sessionId: window.__termipawTest.sessions[1] }).then(() => "accepted", (e) => e.code)`);
    check("不能把编辑中的文件接到另一台服务器", refused === "edit.otherServer", refused);
    await app.key("w", "KeyW", 87, 2);
    await sleep(300);

    // ---- 停止编辑 ----
    await statusIs("notes.txt", "已同步");
    await app.click(".edit-row [title='停止编辑']");
    check("停止编辑：列表里没有了", await app.waitFor(`document.querySelectorAll(".edit-row").length === 0`));
    check("停止编辑：已同步的本地文件被删除", await waitGone(dirname(local)), local);
    await sleep(200);
    writeFileSync(join(home, "notes.txt"), "server stays\n");

    // 还有没传回去的修改时保留文件
    await rowMenu("notes.txt", "fake_editor");
    await app.waitFor(`document.querySelectorAll(".edit-row").length === 1`, 8000);
    const local2 = openedPaths().at(-1);
    // 让服务器上的文件变化，这样保存后会停在冲突上，修改留在本地
    utimesSync(join(home, "notes.txt"), new Date(), new Date(Date.now() + 120_000));
    await sleep(800);
    writeFileSync(local2, "unsynced work\n");
    await app.waitFor(`document.querySelector(".modal")?.textContent.includes("也被改过")`, 8000);
    await app.click(".modal .btn", "暂不传回");
    await sleep(200);
    await app.click(".edit-row [title='停止编辑']");
    check("有没传回去的修改：告诉用户文件留在哪里", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("没有传回服务器") && document.querySelector(".modal")?.textContent.includes("notes.txt")`));
    await app.click(".modal .btn", "知道了");
    check("有没传回去的修改：文件还在", readFileSync(local2, "utf8") === "unsynced work\n");

    // ---- 选过程序以后：菜单里列出它；用默认程序打开时仍然拦截 ----
    await rowMenuOnly("evil.exe");
    check("选过程序后：菜单里有“用 fake_editor.exe 打开”", (await menuTexts()).includes("用 fake_editor.exe 打开"), await menuTexts());
    await app.click(".ctx-menu button", "用默认程序打开");
    check("选过程序后：用默认程序打开仍然拦截", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("已拦截")`));
    await app.click(".modal .btn", "知道了");
    // 交给选过的程序只是把文件给它，不会运行，所以不拦
    const before = openedPaths().length;
    await rowMenu("evil.exe", "fake_editor");
    check("交给选过的程序：可执行类型也能打开", await app.waitFor(`[...document.querySelectorAll(".edit-row .tname")].some((n) => n.textContent.includes("evil.exe"))`, 8000) && openedPaths().length === before + 1, openedPaths().join());

    await app.key("w", "KeyW", 87, 2);
  } finally {
    server.stop();
    other.stop();
    await sleep(300);
    removeDir(serverDir);
    removeDir(otherDir);
  }
}

async function dirEmpty(dir) {
  const { readdirSync } = await import("node:fs");
  return readdirSync(dir).length === 0;
}

async function waitGone(path, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}
