// 主机指纹、密码保存和连接异常。

import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, removeDir, sleep, tempDir } from "./harness.mjs";

/** 一把与开发服务器不同的主机密钥 */
const OTHER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

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

const hasDialog = (app, text) => app.waitFor(`[...document.querySelectorAll(".modal")].some((m) => m.textContent.includes(${JSON.stringify(text)}))`);
const readJson = (app, name) => JSON.parse(readFileSync(join(app.dataDir, name), "utf8"));

export async function connectionSuite(server, { check }) {
  const quickConnect = (app, user = "demo") => app.palette(`${user}@127.0.0.1:${server.port}`);
  const hostKeyId = `127.0.0.1:${server.port}`;
  let serverKey;

  // ---- 首次连接确认并记录指纹 ----
  await withApp(
    () => {},
    async (app) => {
      await quickConnect(app);
      check("首次连接：要求确认指纹", await hasDialog(app, "验证主机指纹"));
      await app.authenticate();
      serverKey = readJson(app, "known_hosts.json")[hostKeyId];
      check("首次连接：指纹已记录", serverKey?.startsWith("ssh-ed25519 "), serverKey);
    },
  );

  // ---- 指纹变化：必须输入主机地址 ----
  await withApp(
    (data) => writeFileSync(join(data, "known_hosts.json"), JSON.stringify({ [hostKeyId]: OTHER_KEY })),
    async (app) => {
      await quickConnect(app);
      check("指纹变化：显示警告", await hasDialog(app, "主机指纹已变化"));
      const danger = `document.querySelector(".modal .btn.danger")`;
      check("指纹变化：默认不能继续", await app.js(`${danger}.disabled`));
      await app.type("10.0.0.1");
      await sleep(100);
      check("指纹变化：输入错误的地址不能继续", await app.js(`${danger}.disabled`));
      await app.js(`document.querySelector(".modal input").select()`);
      await app.type("127.0.0.1");
      await sleep(100);
      check("指纹变化：输入正确的地址才能继续", !(await app.js(`${danger}.disabled`)));
      await app.click(".modal .btn.danger");
      await app.authenticate();
      check("指纹变化：确认后可以连接", await app.waitFor(`!!document.querySelector(".dot.connected")`));
      check("指纹变化：记录已更新", readJson(app, "known_hosts.json")[hostKeyId] === serverKey);
    },
  );

  // ---- 取消指纹警告 ----
  await withApp(
    (data) => writeFileSync(join(data, "known_hosts.json"), JSON.stringify({ [hostKeyId]: OTHER_KEY })),
    async (app) => {
      await quickConnect(app);
      await hasDialog(app, "主机指纹已变化");
      await app.click(".modal .btn", "取消");
      check("取消指纹警告：连接失败", await app.waitFor(`document.querySelector(".overlay")?.textContent.includes("连接失败")`));
      check("取消指纹警告：记录不变", readJson(app, "known_hosts.json")[hostKeyId] === OTHER_KEY);
    },
  );

  // ---- 复用 OpenSSH 的 known_hosts ----
  await withApp(
    (data) => writeFileSync(join(data, "openssh_known_hosts"), `[127.0.0.1]:${server.port} ${serverKey}\n`),
    async (app) => {
      await quickConnect(app);
      check("OpenSSH 已信任：直接要求密码", await app.waitFor(`!!document.querySelector('.modal input[type=password]')`));
      check("OpenSSH 已信任：没有指纹提示", !(await app.js(`document.querySelector(".modal").textContent.includes("指纹")`)));
      await app.authenticate();
      const original = readFileSync(join(app.dataDir, "openssh_known_hosts"), "utf8");
      check("OpenSSH 已信任：文件未被改写", original === `[127.0.0.1]:${server.port} ${serverKey}\n`);
    },
  );

  await withApp(
    (data) => writeFileSync(join(data, "openssh_known_hosts"), `[127.0.0.1]:${server.port} ${OTHER_KEY}\n`),
    async (app) => {
      await quickConnect(app);
      check("OpenSSH 记录的指纹不同：显示警告", await hasDialog(app, "主机指纹已变化"));
    },
  );

  // ---- 指纹文件损坏：阻止连接，用户确认后才重置 ----
  await withApp(
    (data) => writeFileSync(join(data, "known_hosts.json"), "这不是 JSON"),
    async (app) => {
      check("指纹损坏：启动时提示", await hasDialog(app, "主机指纹文件已损坏"));
      await app.click(".modal .btn", "知道了");
      check("指纹损坏：文件留在原处", readFileSync(join(app.dataDir, "known_hosts.json"), "utf8") === "这不是 JSON");

      await quickConnect(app);
      check("指纹损坏：连接时询问", await hasDialog(app, "备份并重置"));
      check("指纹损坏：默认聚焦在取消上", (await app.js(`document.activeElement?.textContent`)) === "取消");
      await app.click(".modal .btn", "取消");
      check("指纹损坏：取消后不连接", await app.waitFor(`document.querySelector(".overlay")?.textContent.includes("已阻止连接")`));

      await app.click(".overlay .btn", "重试");
      await hasDialog(app, "备份并重置");
      await app.click(".modal .btn", "备份并重置");
      check("指纹损坏：重置后按首次连接确认", await hasDialog(app, "验证主机指纹"));
      const backups = readdirSync(app.dataDir).filter((n) => n.startsWith("known_hosts.json.bak-"));
      check("指纹损坏：原文件已备份", backups.length === 1, backups.join());
      await app.authenticate();
      check("指纹损坏：可以继续使用", readJson(app, "known_hosts.json")[hostKeyId] === serverKey);
    },
  );

  // ---- 认证卡住时超时 ----
  await withApp(
    () => {},
    async (app) => {
      await quickConnect(app, "hang");
      await app.waitFor(`document.querySelector(".modal")?.textContent.includes("指纹")`);
      await app.click(".modal .btn.primary");
      await app.waitFor(`!!document.querySelector('.modal input[type=password]')`);
      await app.type("demo");
      await app.key("Enter", "Enter", 13);
      check("认证卡住：30 秒后报超时", await app.waitFor(`document.querySelector(".overlay")?.textContent.includes("认证超时")`, 40000));
    },
  );

  // ---- 保存密码默认关闭；改地址时询问 ----
  await withApp(
    () => {},
    async (app) => {
      const switchOn = `document.querySelector(".modal .switch input").checked`;
      await app.click(".sidebar-foot .new-host");
      check("新建主机：保存密码默认关闭", !(await app.js(switchOn)));
      await app.click(".modal .btn", "取消");

      await quickConnect(app);
      await hasDialog(app, "指纹");
      await app.click(".modal .btn.primary");
      await app.waitFor(`!!document.querySelector('.modal input[type=password]')`);
      await app.click(".modal .btn", "取消");
      await app.key("w", "KeyW", 87, 2);

      const fill = async (selector, value) => {
        await app.click(`.modal ${selector}`);
        await app.js(`document.querySelector(".modal ${selector}").select()`);
        await app.type(value);
      };
      const open = async () => {
        await app.click(".host-item", "keep-me", { button: "right" });
        await app.click(".ctx-menu button", "编辑");
      };
      const saved = () => readJson(app, "hosts.json")[0];

      // 密码只能存进保险库：先开启保险库（不加密主机信息，下面要直接读 hosts.json），密码跟着主机一起在结尾删除
      await app.js(`window.__TAURI_INTERNALS__.invoke("vault_enable", { password: "correct horse battery staple", recovery: false, encryptMetadata: false }).then(() => "ok", (e) => JSON.stringify(e))`);
      // 界面只在自己的流程里刷新保险库状态，直接调后端后要重新加载页面
      await app.js("location.reload()");
      await sleep(1000);
      await app.waitFor(`!!document.querySelector(".sidebar-foot .new-host")`);
      await sleep(500);
      await app.click(".sidebar-foot .new-host");
      await fill(".host-name", "keep-me");
      await fill(".host-address", "127.0.0.1");
      await fill(".host-username", "root");
      await app.click(".modal input[type=password]");
      await app.type("demo");
      await app.click(".modal .switch");
      await app.click(".modal .btn", "保存");
      await sleep(300);
      check("保存主机：密码已保存", saved().saveSecret === true);

      try {
        await open();
        await fill(".host-address", "127.0.0.2");
        await app.click(".modal-foot .btn", "保存");
        check("改地址：询问是否沿用密码", await hasDialog(app, "沿用已保存的密码"));
        check("改地址：默认聚焦在清除上", (await app.js(`document.activeElement?.textContent`)) === "清除");
        await app.click(".modal-foot .btn", "沿用");
        await sleep(300);
        check("选择沿用：密码保留", saved().saveSecret === true && saved().host === "127.0.0.2");

        await open();
        await fill(".host-address", "127.0.0.3");
        await app.click(".modal-foot .btn", "保存");
        await hasDialog(app, "沿用已保存的密码");
        await app.key("Escape", "Escape", 27);
        await sleep(300);
        check("按 Esc：只关闭询问并清除密码", saved().saveSecret === false && saved().host === "127.0.0.3", JSON.stringify(saved()));
        check("按 Esc：编辑窗口已随保存关闭", !(await app.js(`!!document.querySelector(".modal")`)));

        await open();
        await fill(".host-name", "keep-me");
        await app.click(".modal-foot .btn", "保存");
        await sleep(300);
        check("只改名称：不询问", !(await app.js(`!!document.querySelector(".modal")`)));

        // ---- SSH Agent ----
        await open();
        await app.click(".modal .segmented button", "SSH Agent");
        check("选 Agent：没有密码输入框", !(await app.js(`!!document.querySelector(".modal input[type=password]")`)));
        await app.click(".modal-foot .btn", "保存");
        await sleep(300);
        check("选 Agent：已保存", saved().auth === "agent" && saved().saveSecret === false, JSON.stringify(saved()));

        // ---- 编辑窗口：没有严格模式和兼容旧服务器 ----
        await open();
        check("编辑窗口：没有严格模式和兼容旧服务器", !(await app.js(`/严格模式|兼容旧服务器/.test(document.querySelector(".modal").textContent)`)));

        // ---- 分组：输入新组名，之后可以从列表里选 ----
        check("还没有分组时：没有下拉按钮", !(await app.js(`!!document.querySelector(".modal .combo-toggle")`)));
        await fill(".host-group", "  生产  ");
        await app.click(".modal-foot .btn", "保存");
        await sleep(300);
        check("输入新组名：保存时去掉首尾空格", saved().group === "生产", JSON.stringify(saved()));
        await app.click(".sidebar-foot .new-host");
        await app.waitFor(`!!document.querySelector(".modal .combo-toggle")`);
        await app.click(".modal .combo-toggle");
        check("新建主机：点箭头列出已有的组", (await app.js(`[...document.querySelectorAll(".combo-list button")].map((b) => b.textContent).join("|")`)) === "生产");
        await app.click(".combo-list button", "生产");
        check("选一个组：填进输入框，列表收起", (await app.js(`document.querySelector(".modal .combo input").value`)) === "生产" && !(await app.js(`!!document.querySelector(".combo-list")`)));
        await app.click(".modal .combo input");
        await app.js(`document.querySelector(".modal .combo input").select()`);
        await app.type("测试");
        check("输入不存在的组名：列表里没有匹配的就不显示", !(await app.js(`!!document.querySelector(".combo-list")`)));
        await app.key("ArrowDown", "ArrowDown", 40);
        await app.key("Escape", "Escape", 27);
        check("Esc：只收起列表，编辑窗口还在", await app.js(`!!document.querySelector(".modal")`));
        await app.click(".modal .btn", "取消");
      } finally {
        await app.click(".host-item", "keep-me", { button: "right" });
        await app.click(".ctx-menu button", "删除");
        await app.click(".modal .btn", "删除");
      }
    },
  );

  // ---- 配置写入失败不影响已经成功的连接 ----
  const host = {
    id: "readonly-host",
    name: "readonly-host",
    group: "",
    host: "127.0.0.1",
    port: server.port,
    username: "demo",
    auth: "password",
    saveSecret: false,
  };
  await withApp(
    (data) => {
      const hosts = join(data, "hosts.json");
      writeFileSync(hosts, JSON.stringify([host]));
      chmodSync(hosts, 0o444);
    },
    async (app) => {
      await app.waitFor(`!!document.querySelector(".host-item")`);
      await app.click(".host-item", "readonly-host", { count: 2 });
      await app.authenticate();
      check("配置写入失败：连接仍然成功", await app.waitFor(`document.querySelector(".host-item .dot")?.classList.contains("connected")`));
      check("配置写入失败：提示用户", await app.waitFor(`document.querySelector(".toast.error")?.textContent.includes("未能更新主机记录")`));
      chmodSync(join(app.dataDir, "hosts.json"), 0o666);
    },
  );
}
