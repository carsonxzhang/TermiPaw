// 配置文件损坏或读取失败时的提示和保护。

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, removeDir, sleep, tempDir } from "./harness.mjs";

const addHost = async (app, name) => {
  await app.click('.sidebar-foot .new-host');
  await app.click(".modal .host-name");
  await app.type(name);
  await app.click(".modal .host-address");
  await app.type("127.0.0.1");
  await app.click(".modal .host-username");
  await app.type("root");
  await app.click(".modal .btn", "保存");
  await sleep(400);
};

async function withApp(seed, fn) {
  const dir = tempDir();
  mkdirSync(join(dir, "data"), { recursive: true });
  seed(join(dir, "data"));
  const app = await launchApp(dir);
  try {
    await fn(app);
  } finally {
    await app.stop();
    removeDir(dir);
  }
}

export async function storeSuite({ check }) {
  await withApp(
    (data) => writeFileSync(join(data, "hosts.json"), "这不是 JSON"),
    async (app) => {
      check("配置损坏：启动时提示", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("主机列表文件已损坏")`));
      check("配置损坏：只有一个确认按钮", (await app.js(`document.querySelectorAll(".modal-foot .btn").length`)) === 1);
      await app.click(".modal .btn", "知道了");
      const backups = readdirSync(app.dataDir).filter((n) => n.startsWith("hosts.json.bak-"));
      check("配置损坏：原内容已备份", backups.length === 1 && readFileSync(join(app.dataDir, backups[0]), "utf8") === "这不是 JSON", backups.join());
      await addHost(app, "after-corrupt");
      const saved = JSON.parse(readFileSync(join(app.dataDir, "hosts.json"), "utf8"));
      check("配置损坏：之后仍可保存", saved.length === 1 && saved[0].name === "after-corrupt");
    },
  );

  await withApp(
    // 目录无法按文件读取，用来模拟读取失败
    (data) => mkdirSync(join(data, "hosts.json")),
    async (app) => {
      check("读取失败：启动时提示", await app.waitFor(`document.querySelector(".modal")?.textContent.includes("无法读取主机列表")`));
      await app.click(".modal .btn", "知道了");
      await addHost(app, "should-not-save");
      check("读取失败：拒绝保存并报错", await app.waitFor(`document.querySelector(".toast.error")?.textContent.includes("已暂停保存")`));
      check("读取失败：原路径未被覆盖", statSync(join(app.dataDir, "hosts.json")).isDirectory());
    },
  );

  await withApp(
    () => {},
    async (app) => {
      await sleep(500);
      check("配置正常：启动时没有提示", !(await app.js(`!!document.querySelector(".modal")`)));
    },
  );
}
