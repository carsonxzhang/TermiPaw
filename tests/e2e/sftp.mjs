// SFTP 上传和下载的数据安全：同名询问、失败时保留原文件、不留下临时文件。

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "./harness.mjs";

export async function sftpSuite(app, server, dir, { check }) {
  const local = join(dir, "local");
  mkdirSync(local);
  const remote = (name) => join(server.home, name);
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  const leftovers = (folder) => readdirSync(folder).filter((n) => n.startsWith(".termipaw-"));

  writeFileSync(remote("a.txt"), "old remote");
  writeFileSync(local + "/a.txt", "new local");
  writeFileSync(local + "/b.txt", "brand new");

  await app.palette(`demo@127.0.0.1:${server.port}`);
  await app.authenticate();
  await app.toggleFiles();
  check("文件面板列出远程文件", await app.waitFor(`[...document.querySelectorAll(".file-row .fname")].some(e => e.textContent === "a.txt")`));

  const pickAndUpload = async (...paths) => {
    await app.click('.sftp-toolbar [title^="上传"]');
    await app.answerFileDialog(paths);
  };
  const downloadTo = async (name, path) => {
    await app.click(".file-row", name, { count: 2 });
    await app.answerFileDialog([path]);
  };
  const dialogText = () => app.js(`document.querySelector(".modal")?.textContent ?? ""`);

  // ---- 同名文件询问 ----
  await pickAndUpload(join(local, "a.txt"));
  check("同名文件先询问", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("文件已存在")`), await dialogText());
  check("默认聚焦在跳过上", (await app.js(`document.activeElement?.textContent`)) === "跳过");
  await app.click(".modal .btn", "跳过");
  await sleep(300);
  check("选择跳过：远程文件不变", read(remote("a.txt")) === "old remote");
  check("选择跳过：没有发起传输", (await app.js(`document.querySelectorAll(".transfer").length`)) === 0);

  await pickAndUpload(join(local, "a.txt"));
  await app.waitFor(`!!document.querySelector(".modal")`);
  await app.click(".modal .btn", "覆盖");
  check("选择覆盖：传输完成", await app.waitFor(`document.querySelectorAll(".transfer.done").length === 1`));
  check("选择覆盖：内容已替换", read(remote("a.txt")) === "new local", read(remote("a.txt")));
  check("选择覆盖：没有留下临时文件", leftovers(server.home).length === 0, leftovers(server.home).join());

  // ---- 只读文件 ----
  check("普通文件的确认框不提只读", !(await (async () => {
    await pickAndUpload(join(local, "a.txt"));
    await app.waitFor(`!!document.querySelector(".modal")`);
    const text = await dialogText();
    await app.click(".modal .btn", "跳过");
    await sleep(200);
    return text;
  })()).includes("只读"));
  // 用没被覆盖过的文件：沙箱会记住覆盖时设置的权限，盖过只读属性
  writeFileSync(join(local, "ro.txt"), "new ro");
  writeFileSync(remote("ro.txt"), "old ro");
  chmodSync(remote("ro.txt"), 0o444);
  await app.click(".sftp-toolbar [title='刷新']");
  await sleep(300);
  await pickAndUpload(join(local, "ro.txt"));
  check("只读文件：确认框里提示", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("这是只读文件")`), await dialogText());
  await app.click(".modal .btn", "跳过");
  await sleep(200);
  check("只读文件：选择跳过后内容不变", read(remote("ro.txt")) === "old ro", read(remote("ro.txt")));
  await pickAndUpload(join(local, "a.txt"), join(local, "ro.txt"));
  check("多个文件：只点名只读的那个", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("其中「ro.txt」是只读文件")`), await dialogText());
  await app.click(".modal .btn", "跳过");
  await sleep(200);
  chmodSync(remote("ro.txt"), 0o644);
  rmSync(remote("ro.txt"));

  // ---- 新文件不询问，多个文件时跳过只影响同名的 ----
  writeFileSync(remote("a.txt"), "old remote");
  await pickAndUpload(join(local, "a.txt"), join(local, "b.txt"));
  await app.waitFor(`!!document.querySelector(".modal")`);
  check("多个文件时列出同名文件", (await dialogText()).includes("a.txt") && !(await dialogText()).includes("b.txt"), await dialogText());
  await app.click(".modal .btn", "跳过");
  check("跳过后仍上传其余文件", await app.waitFor(`document.querySelectorAll(".transfer.done").length === 2`));
  check("跳过的文件不变", read(remote("a.txt")) === "old remote");
  check("其余文件已上传", read(remote("b.txt")) === "brand new");

  // ---- 下载，目标已存在时替换 ----
  const target = join(local, "download.txt");
  writeFileSync(target, "old local");
  await app.click(".sftp-toolbar [title='刷新']");
  await sleep(300);
  await downloadTo("b.txt", target);
  check("下载：内容已替换", (await app.waitFor(`document.querySelectorAll(".transfer.done").length === 3`)) && read(target) === "brand new", read(target));
  check("下载：没有留下临时文件", leftovers(local).length === 0, leftovers(local).join());

  // ---- 下载失败：远程文件在列表刷新前已被删除 ----
  writeFileSync(target, "old local");
  rmSync(remote("b.txt"));
  await downloadTo("b.txt", target);
  check("下载失败：显示失败", await app.waitFor(`document.querySelectorAll(".transfer.failed").length === 1`));
  check("下载失败：本地文件不变", read(target) === "old local", read(target));
  check("下载失败：没有留下临时文件", leftovers(local).length === 0, leftovers(local).join());

  // ---- 拖拽上传 ----
  // 系统的拖拽事件没法从外部触发，所以用调试版里的模拟拖拽：它走的是和真实拖拽相同的后端处理函数
  writeFileSync(join(local, "dropped.txt"), "dropped in");
  writeFileSync(join(local, "outside.txt"), "dropped outside");
  const physical = (point) => `(() => { const r = document.querySelector(".sftp").getBoundingClientRect(); return ${point}; })()`;
  const inside = await app.js(physical("({ x: (r.x + r.width / 2) * devicePixelRatio, y: (r.y + r.height / 2) * devicePixelRatio })"));
  const drop = (name, at) =>
    app.js(`window.__TAURI_INTERNALS__.invoke("debug_drop", { paths: [${JSON.stringify(join(local, name))}], x: ${at.x}, y: ${at.y} })`);

  await drop("dropped.txt", inside);
  check("拖拽：拖进文件面板的文件已上传", await app.waitFor(`document.querySelectorAll(".transfer.done").length >= 4`) && read(remote("dropped.txt")) === "dropped in", read(remote("dropped.txt")));

  await drop("outside.txt", { x: 5, y: 5 });
  await sleep(1200);
  check("拖拽：拖到面板外面的文件不上传", read(remote("outside.txt")) === null);

  writeFileSync(remote("dropped.txt"), "remote version");
  await drop("dropped.txt", inside);
  check("拖拽：同名文件也先询问", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("文件已存在")`));
  await app.click(".modal .btn", "跳过");
  await sleep(500);
  check("拖拽：选择跳过后远程文件不变", read(remote("dropped.txt")) === "remote version");

  await app.key("w", "KeyW", 87, 2);
}
