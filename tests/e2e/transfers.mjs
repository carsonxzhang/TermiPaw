// 传输队列：同时进行的数量、排队时取消、关掉面板和关闭会话。
// 用一个写入很慢的服务器，让排队的状态能保持几秒钟。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "./harness.mjs";

export async function transfersSuite(app, server, quick, dir, { check }) {
  const local = join(dir, "local");
  mkdirSync(local);
  const names = Array.from({ length: 8 }, (_, i) => `file-${i + 1}.bin`);
  for (const [i, name] of names.entries()) writeFileSync(join(local, name), Buffer.alloc(1_500_000, i + 1));
  const remote = (name) => join(server.home, name);
  const remoteSize = (name) => (existsSync(remote(name)) ? statSync(remote(name)).size : -1);
  const leftovers = () => readdirSync(server.home).filter((n) => n.startsWith(".termipaw-"));
  const count = (cls) => app.js(`document.querySelectorAll(".transfer.${cls}").length`);

  await app.palette(`demo@127.0.0.1:${server.port}`);
  await app.authenticate();
  await app.toggleFiles();
  await app.waitFor(`!!document.querySelector(".sftp .files")`);

  // 每 10 毫秒记一次同时进行和排队的数量
  await app.js(`window.__peak = { running: 0, queued: 0 };
    setInterval(() => {
      const n = (c) => document.querySelectorAll(".transfer." + c).length;
      window.__peak.running = Math.max(window.__peak.running, n("running"));
      window.__peak.queued = Math.max(window.__peak.queued, n("queued"));
    }, 10);`);

  // ---- 一次上传 8 个文件：同时最多 3 个 ----
  await app.click('.sftp-toolbar [title^="上传"]');
  await app.answerFileDialog(names.map((n) => join(local, n)));
  check("上传 8 个文件：有的在排队", await app.waitFor(`document.querySelectorAll(".transfer.queued").length > 0`, 5000));
  check("上传 8 个文件：同时进行的不超过 3 个", (await app.js(`window.__peak.running`)) <= 3 && (await app.js(`window.__peak.running`)) >= 1, JSON.stringify(await app.js(`window.__peak`)));
  const queuedText = await app.js(`document.querySelector(".transfer.queued .tstat")?.textContent`);
  check("排队的显示“排队中”", queuedText === "排队中", queuedText);

  // ---- 取消还在排队的 ----
  const queuedName = await app.js(`document.querySelector(".transfer.queued .tname")?.textContent`);
  await app.js(`document.querySelector(".transfer.queued .icon-btn").click()`);
  await sleep(300);
  check("取消排队中的：状态变为已取消", await app.js(`[...document.querySelectorAll(".transfer.cancelled .tname")].some((e) => e.textContent === ${JSON.stringify(queuedName)})`), queuedName);

  // ---- 取消正在进行的：挑进度最少的，免得它恰好在取消送到之前传完 ----
  const runningName = await app.js(`(() => {
    const progress = (row) => parseFloat(row.querySelector(".bar > div").style.width) || 0;
    const rows = [...document.querySelectorAll(".transfer.running")].sort((a, b) => progress(a) - progress(b));
    rows[0].querySelector(".icon-btn").click();
    return rows[0].querySelector(".tname").textContent;
  })()`);
  const cancelStarted = Date.now();
  check("取消进行中的：马上显示正在取消", await app.waitFor(`[...document.querySelectorAll(".transfer.running")].some((r) => r.querySelector(".tname").textContent === ${JSON.stringify(runningName)} && r.querySelector(".tstat").textContent === "正在取消…")`, 2000));
  // 已发出的写入请求要先传完，这个服务器又特别慢（每次写入 150 毫秒，3 个传输共用），所以可能要等几秒
  check("取消进行中的：最终变为已取消", await app.waitFor(`[...document.querySelectorAll(".transfer.cancelled .tname")].some((e) => e.textContent === ${JSON.stringify(runningName)})`, 30000), runningName);
  console.log(`INFO  取消进行中的传输用了 ${((Date.now() - cancelStarted) / 1000).toFixed(1)} 秒`);

  // ---- 关掉文件面板，传输继续，文件面板按钮上有数量 ----
  await app.key("E", "KeyE", 69, 2 | 8); // Ctrl+Shift+E
  await sleep(300);
  check("关掉文件面板：面板消失", !(await app.js(`!!document.querySelector(".sftp")`)));
  const badge = await app.js(`document.querySelector(".term-wrap.active .files-btn .badge")?.textContent`);
  check("关掉文件面板：按钮上显示还有传输", !!badge && Number(badge) > 0, String(badge));
  await app.key("E", "KeyE", 69, 2 | 8);
  await app.waitFor(`!!document.querySelector(".sftp .transfers")`);
  check("重新打开面板：传输列表还在", (await count("running")) + (await count("queued")) + (await count("done")) > 0);

  // ---- 全部结束后：传完的内容完整，取消的没有留下东西 ----
  // 服务器串行处理，每个文件约 7 秒，6 个文件加上被取消的那部分要 50 秒左右，所以上限要留够
  const waitStarted = Date.now();
  check("全部结束", await app.waitFor(`document.querySelectorAll(".transfer.running, .transfer.queued").length === 0`, 120000));
  console.log(`INFO  从重新打开面板到全部结束用了 ${((Date.now() - waitStarted) / 1000).toFixed(1)} 秒`);
  check("没有同时超过 3 个", (await app.js(`window.__peak.running`)) === 3, JSON.stringify(await app.js(`window.__peak`)));
  const cancelled = new Set([queuedName, runningName]);
  const finished = names.filter((n) => !cancelled.has(n));
  check("没取消的 6 个文件完整上传", finished.every((n) => remoteSize(n) === 1_500_000), finished.map((n) => `${n}=${remoteSize(n)}`).join(" "));
  check("取消的文件没有留在服务器上", [...cancelled].every((n) => remoteSize(n) === -1), [...cancelled].map((n) => `${n}=${remoteSize(n)}`).join(" "));
  check("没有留下临时文件", leftovers().length === 0, leftovers().join());
  check("文件内容正确", finished.every((n) => readFileSync(remote(n)).every((b) => b === Number(n.match(/\d+/)[0]))));

  // ---- 关闭会话：进行中的传输先收尾，不留下临时文件 ----
  // 换到写入较快的服务器。清理临时文件的请求要排在已经发出的写入请求后面，服务器太慢就来不及，见 TODO
  await app.key("w", "KeyW", 87, 2);
  await app.palette(`demo@127.0.0.1:${quick.port}`);
  await app.authenticate();
  await app.toggleFiles();
  await app.waitFor(`!!document.querySelector(".sftp .files")`);
  const quickRemote = (name) => join(quick.home, name);
  await app.click('.sftp-toolbar [title^="上传"]');
  await app.answerFileDialog(names.map((n) => join(local, n)));
  await app.waitFor(`document.querySelectorAll(".transfer.running").length > 0`, 8000);
  await app.key("w", "KeyW", 87, 2);
  check("关闭会话：传输列表随会话清掉", await app.waitFor(`document.querySelectorAll(".transfer").length === 0`, 3000));
  await sleep(4500);
  const quickLeftovers = readdirSync(quick.home).filter((n) => n.startsWith(".termipaw-"));
  check("关闭会话：没有留下临时文件", quickLeftovers.length === 0, quickLeftovers.join());
  const sizes = names.map((n) => (existsSync(quickRemote(n)) ? statSync(quickRemote(n)).size : -1));
  check("关闭会话：没传完的文件不会以半截内容出现", sizes.every((s) => s === 1_500_000 || s === -1), sizes.join(","));
}