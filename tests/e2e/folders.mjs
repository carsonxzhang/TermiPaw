// 目录的上传和下载，包括恶意服务器给出的文件名。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeDir, sleep, startServer, tempDir } from "./harness.mjs";

export async function foldersSuite(app, appDir, { check }) {
  const serverDir = tempDir();
  // 这两个名字想让文件写到下载目录外面。主目录的上一级真的有 climb.txt，服务器乐于提供内容
  const server = await startServer(serverDir, {
    TERMIPAW_SFTP_FAKE_NAMES: JSON.stringify([
      ["../climb.txt", false],
      ["sub/../../climb.txt", false],
    ]),
  });
  const home = server.home;
  const local = join(appDir, "local");
  mkdirSync(local);
  try {
    mkdirSync(join(home, "site", "assets", "img"), { recursive: true });
    mkdirSync(join(home, "site", "empty"), { recursive: true });
    writeFileSync(join(home, "site", "index.html"), "<h1>hi</h1>");
    writeFileSync(join(home, "site", "assets", "app.js"), "app");
    writeFileSync(join(home, "site", "assets", "img", "logo.bin"), Buffer.alloc(300_000, 7));
    writeFileSync(join(home, "..", "climb.txt"), "outside the tree");

    await app.palette(`demo@127.0.0.1:${server.port}`);
    await app.authenticate();
    await app.toggleFiles();
    await app.waitFor(`[...document.querySelectorAll(".file-row .fname")].some((e) => e.textContent === "site")`);

    const rowMenu = async (name, action) => {
      const p = await app.js(`(() => {
        const row = [...document.querySelectorAll(".file-row")].find((r) => r.querySelector(".fname")?.textContent === ${JSON.stringify(name)});
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
    // 系统的文件夹对话框没法用脚本操作，调试版会读这个文件作为答案
    const answerFolder = (path) => writeFileSync(join(app.dataDir, "folder-answer.txt"), path);
    const doneCount = () => app.js(`document.querySelectorAll(".transfer.done").length`);
    const waitDone = (n) => app.waitFor(`document.querySelectorAll(".transfer.done").length >= ${n}`, 20000);
    const toastSeen = (text) => app.waitFor(`[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes(${JSON.stringify(text)}))`, 5000);
    const modalText = () => app.js(`document.querySelector(".modal")?.textContent ?? ""`);

    // ---- 下载 ----
    answerFolder(local);
    await rowMenu("site", "下载文件夹");
    check("下载文件夹：完成", await waitDone(1));
    check("下载文件夹：文件都在", readFileSync(join(local, "site", "assets", "app.js"), "utf8") === "app" && readFileSync(join(local, "site", "assets", "img", "logo.bin")).length === 300_000);
    check("下载文件夹：空目录也在", existsSync(join(local, "site", "empty")));

    // 本地已有同名文件夹：不合并，也不覆盖
    writeFileSync(join(local, "site", "index.html"), "mine");
    answerFolder(local);
    await rowMenu("site", "下载文件夹");
    check("本地已有同名文件夹：新建一个", (await waitDone(2)) && existsSync(join(local, "site (2)", "index.html")));
    check("本地已有同名文件夹：原来的不变", readFileSync(join(local, "site", "index.html"), "utf8") === "mine");

    // ---- 恶意服务器 ----
    // 下载的是主目录本身，里面多了想往外爬的名字
    await app.click(".sftp-toolbar [title='上一级']");
    await sleep(400);
    const before = readdirSync(local).sort();
    answerFolder(local);
    await rowMenu("demo", "下载文件夹");
    check("恶意服务器：明确说拒绝了几个", await toastSeen("拒绝了 2 个"));
    check("恶意服务器：文件夹外面没有多出东西", !existsSync(join(appDir, "climb.txt")) && !existsSync(join(local, "climb.txt")) && !existsSync(join(appDir, "..", "climb.txt")), readdirSync(local).join());
    const added = readdirSync(local).filter((n) => !before.includes(n));
    check("恶意服务器：其余内容正常下载", added.length === 1 && existsSync(join(local, added[0], "site", "index.html")) && !existsSync(join(local, added[0], "climb.txt")), added.join());
    await app.click(".file-row", "demo", { count: 2 });
    await sleep(400);

    // ---- 上传 ----
    const source = join(local, "upload-me");
    mkdirSync(join(source, "nested", "deep"), { recursive: true });
    writeFileSync(join(source, "a.txt"), "A");
    writeFileSync(join(source, "nested", "deep", "b.txt"), "B");
    const finished = await doneCount();
    answerFolder(source);
    await app.click(".sftp-toolbar [title='上传文件夹']");
    check("上传文件夹：完成", await waitDone(finished + 1));
    check("上传文件夹：文件都在", readFileSync(join(home, "upload-me", "nested", "deep", "b.txt"), "utf8") === "B");
    check("上传文件夹：列表里能看到", await app.waitFor(`[...document.querySelectorAll(".file-row .fname")].some((e) => e.textContent === "upload-me")`));

    // 已存在：先问，跳过时什么都不动
    writeFileSync(join(source, "a.txt"), "A2");
    writeFileSync(join(home, "upload-me", "keep.txt"), "keep");
    answerFolder(source);
    await app.click(".sftp-toolbar [title='上传文件夹']");
    check("文件夹已存在：先询问", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("文件夹已存在")`), await modalText());
    check("文件夹已存在：默认聚焦在跳过", (await app.js(`document.activeElement?.textContent`)) === "跳过");
    await app.click(".modal .btn", "跳过");
    await sleep(400);
    check("选择跳过：内容不变", readFileSync(join(home, "upload-me", "a.txt"), "utf8") === "A");

    // 合并：同名覆盖，其余保留
    const beforeMerge = await doneCount();
    answerFolder(source);
    await app.click(".sftp-toolbar [title='上传文件夹']");
    await app.waitFor(`!!document.querySelector(".modal")`);
    await app.click(".modal .btn", "合并");
    check("选择合并：完成", await waitDone(beforeMerge + 1));
    check("选择合并：同名文件被覆盖", readFileSync(join(home, "upload-me", "a.txt"), "utf8") === "A2");
    check("选择合并：其余文件保留", readFileSync(join(home, "upload-me", "keep.txt"), "utf8") === "keep");
    check("没有留下临时文件", !readdirSync(join(home, "upload-me")).some((n) => n.startsWith(".termipaw-")));

    // 拖进来的文件夹
    const dropped = join(local, "dropped-dir");
    mkdirSync(dropped);
    writeFileSync(join(dropped, "c.txt"), "C");
    const beforeDrop = await doneCount();
    const at = await app.js(`(() => { const r = document.querySelector(".sftp").getBoundingClientRect(); return { x: (r.x + r.width / 2) * devicePixelRatio, y: (r.y + r.height / 2) * devicePixelRatio }; })()`);
    await app.js(`window.__TAURI_INTERNALS__.invoke("debug_drop", { paths: [${JSON.stringify(dropped)}], x: ${at.x}, y: ${at.y} })`);
    check("拖入文件夹：上传完成", (await waitDone(beforeDrop + 1)) && readFileSync(join(home, "dropped-dir", "c.txt"), "utf8") === "C");

    await app.key("w", "KeyW", 87, 2);
  } finally {
    server.stop();
    await sleep(300);
    removeDir(serverDir);
  }
}
