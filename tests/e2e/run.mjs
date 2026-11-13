// 端到端测试入口：npm run test:e2e
// 需要先构建调试版程序和开发服务器（npm 脚本已包含这一步）。

import { join } from "node:path";
import { connectionSuite } from "./connection.mjs";
import { editingSuite } from "./editing.mjs";
import { foldersSuite } from "./folders.mjs";
import { reconnectSuite } from "./reconnect.mjs";
import { linkageSuite } from "./linkage.mjs";
import { Checks, launchApp, removeDir, startServer, tempDir } from "./harness.mjs";
import { sftpSuite } from "./sftp.mjs";
import { pasteSuite } from "./paste.mjs";
import { securitySuite } from "./security.mjs";
import { sessionToolsSuite } from "./session-tools.mjs";
import { storeSuite } from "./store.mjs";
import { terminalSuite } from "./terminal.mjs";
import { transfersSuite } from "./transfers.mjs";
import { uiSuite } from "./ui.mjs";
import { i18nSuite } from "./i18n.mjs";
import { portableSuite } from "./portable.mjs";
import { updateSuite } from "./update.mjs";
import { vaultSuite } from "./vault.mjs";

const checks = new Checks();
const check = checks.check.bind(checks);
const dir = tempDir();
const server = await startServer(dir);
let crashed = false;

async function withFreshApp(name, suite, env = {}) {
  // TERMIPAW_TEST_ONLY：只跑名称里包含这段文字的部分
  if (process.env.TERMIPAW_TEST_ONLY && !name.includes(process.env.TERMIPAW_TEST_ONLY)) return;
  console.log(`\n=== ${name} ===`);
  const appDir = tempDir();
  const app = await launchApp(appDir, typeof env === "function" ? env(appDir) : env);
  try {
    await suite(app, appDir);
  } finally {
    await app.stop();
    removeDir(appDir);
  }
}

try {
  await withFreshApp("界面与会话", (app) => uiSuite(app, server, { check }));
  await withFreshApp("后端接口收窄", (app) => securitySuite(app, { check }));
  await withFreshApp("终端上方的按钮", (app, appDir) => sessionToolsSuite(app, server, appDir, { check }));
  await withFreshApp("SFTP 数据安全", (app, appDir) => sftpSuite(app, server, appDir, { check }));
  await withFreshApp("终端与文件联动", (app, appDir) => linkageSuite(app, appDir, { check }));
  await withFreshApp("目录传输", (app, appDir) => foldersSuite(app, appDir, { check }));
  await withFreshApp("用本地程序编辑", (app, appDir) => editingSuite(app, appDir, join(appDir, "editor.log"), { check }), (appDir) => ({ TERMIPAW_FAKE_EDITOR_LOG: join(appDir, "editor.log") }));
  if (!process.env.TERMIPAW_TEST_ONLY || "断线重连".includes(process.env.TERMIPAW_TEST_ONLY)) {
    console.log("\n=== 断线重连 ===");
    await reconnectSuite({ check });
  }
  if (!process.env.TERMIPAW_TEST_ONLY || "主密码保险库".includes(process.env.TERMIPAW_TEST_ONLY)) {
    console.log("\n=== 主密码保险库 ===");
    await vaultSuite({ check });
  }
  if (!process.env.TERMIPAW_TEST_ONLY || "绿色版".includes(process.env.TERMIPAW_TEST_ONLY)) {
    console.log("\n=== 绿色版 ===");
    await portableSuite({ check });
  }
  if (!process.env.TERMIPAW_TEST_ONLY || "多语言".includes(process.env.TERMIPAW_TEST_ONLY)) {
    console.log("\n=== 多语言 ===");
    await i18nSuite({ check });
  }
  if (!process.env.TERMIPAW_TEST_ONLY || "在线更新".includes(process.env.TERMIPAW_TEST_ONLY)) {
    console.log("\n=== 在线更新 ===");
    await updateSuite({ check });
  }
  await withFreshApp("终端流控", (app) => terminalSuite(app, server, { check }));
  // 写入很慢的服务器，让排队的状态能保持几秒钟
  if (!process.env.TERMIPAW_TEST_ONLY || "传输队列".includes(process.env.TERMIPAW_TEST_ONLY)) {
  const slowDir = tempDir();
  const quickDir = tempDir();
  const slow = await startServer(slowDir, { TERMIPAW_SFTP_WRITE_DELAY_MS: "150" });
  const quick = await startServer(quickDir, { TERMIPAW_SFTP_WRITE_DELAY_MS: "20" });
  try {
    await withFreshApp("传输队列", (app, appDir) => transfersSuite(app, slow, quick, appDir, { check }));
  } finally {
    slow.stop();
    quick.stop();
    await new Promise((r) => setTimeout(r, 300));
    removeDir(slowDir);
    removeDir(quickDir);
  }
  }
  await withFreshApp("粘贴、链接与页面导航", (app) => pasteSuite(app, server, { check }));
  if (!process.env.TERMIPAW_TEST_ONLY) {
    console.log("\n=== 配置文件保护 ===");
    await storeSuite({ check });
    console.log("\n=== 连接与凭据 ===");
    await connectionSuite(server, { check });
  }
} catch (e) {
  crashed = true;
  console.error(`\n测试中断：${e.stack ?? e}`);
} finally {
  server.stop();
  await new Promise((r) => setTimeout(r, 300));
  removeDir(dir);
}

console.log(`\n共 ${checks.total} 项，失败 ${checks.failed} 项${crashed ? "，且测试中途中断" : ""}`);
process.exit(checks.failed || crashed ? 1 : 0);
