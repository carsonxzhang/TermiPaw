// 实测绿色版往系统里写了什么：文件、注册表、凭据管理器、环境变量。
//
//   npm run test:footprint [-- 要测的 exe，默认是 src-tauri/target/release/termipaw.exe]
//
// 方法：先有一段“对照期”，什么都不运行，只记录系统自己在这段时间里改了什么（别的程序、系统服务都在写）；
// 再运行程序做一遍典型操作（开保险库、存主机和密码、改语言），正常关闭，记录改了什么。
// 对照期里也出现的变化不算程序的。程序自己的数据在临时文件夹的 TermiPaw_Data\ 里，不算。
// 这个测试要导出整个当前用户的注册表，需要几分钟，而且结果受电脑上别的程序影响，所以不放进自动测试。
//
// 程序的环境变量里设了 HTTPS_PROXY 指向一个不存在的端口：发布版启动时会检查更新，不要真的连到 GitHub。
// 这些变量只给被测程序，不改系统的环境。

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp, removeDir, sleep } from "./e2e/harness.mjs";

const exeSource = resolve(process.argv[2] ?? "src-tauri/target/release/termipaw.exe");
if (!existsSync(exeSource)) throw new Error(`找不到 ${exeSource}`);
const CONTROL_SECONDS = 45;
const work = join(tmpdir(), `termipaw-footprint-${process.pid}`);
const tmpRoot = tmpdir().toLowerCase();

// ---------- 记录 ----------

const watched = [
  ["%LOCALAPPDATA%", process.env.LOCALAPPDATA],
  ["%APPDATA%", process.env.APPDATA],
  ["系统临时目录", tmpdir()],
  ["桌面", join(homedir(), "Desktop")],
  ["公共桌面", join(process.env.PUBLIC ?? "C:\\Users\\Public", "Desktop")],
  ["ProgramData", process.env.ProgramData ?? "C:\\ProgramData"],
];

function files() {
  const seen = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      // 我们自己的测试文件夹不算
      if (path.toLowerCase().startsWith(work.toLowerCase())) continue;
      if (entry.isDirectory()) walk(path);
      else {
        try {
          const s = statSync(path);
          seen.set(path, `${s.size}|${Math.round(s.mtimeMs)}`);
        } catch {
          /* 读的时候被删了 */
        }
      }
    }
  };
  for (const [, root] of watched) if (root && existsSync(root)) walk(root);
  return seen;
}

function registry(label) {
  const out = join(work, `hkcu-${label}.reg`);
  execFileSync("reg.exe", ["export", "HKCU", out, "/y"], { stdio: "ignore" });
  // 去掉每个键的“最后写入时间”之外没有的信息：只留 键 + 值 这一行
  const lines = new Set();
  let key = "";
  for (const raw of readFileSync(out, "utf16le").split(/\r?\n/)) {
    if (raw.startsWith("[")) key = raw;
    else if (raw && !raw.startsWith("Windows Registry")) lines.add(`${key} ${raw}`);
  }
  return lines;
}

const credentials = () => execFileSync("cmdkey.exe", ["/list"], { encoding: "utf8" }).split(/\r?\n/).filter((l) => l.trim().startsWith("Target:") || l.includes("目标")).sort();
const userEnvironment = () => execFileSync("reg.exe", ["query", "HKCU\\Environment"], { encoding: "utf8" }).trim();

function snapshot(label) {
  return { files: files(), registry: registry(label), credentials: credentials(), environment: userEnvironment() };
}

function changes(before, after) {
  const files = [...after.files].filter(([p, v]) => before.files.get(p) !== v).map(([p]) => p);
  const removed = [...before.files.keys()].filter((p) => !after.files.has(p));
  const registryAdded = [...after.registry].filter((l) => !before.registry.has(l));
  const registryRemoved = [...before.registry].filter((l) => !after.registry.has(l));
  return { files, removed, registryAdded, registryRemoved };
}

// ---------- 运行 ----------

mkdirSync(work, { recursive: true });
const interesting = /termipaw|webview|edge|msedge|chromium/i;
try {
  console.log("检查程序是否要求管理员权限……");
  const bytes = readFileSync(exeSource);
  const asInvoker = bytes.includes(Buffer.from('level="asInvoker"')) || bytes.includes(Buffer.from("asInvoker"));
  const elevated = bytes.includes(Buffer.from("requireAdministrator")) || bytes.includes(Buffer.from("highestAvailable"));
  console.log(`  asInvoker: ${asInvoker}，要求更高权限: ${elevated}`);

  console.log(`对照期：什么都不运行，${CONTROL_SECONDS} 秒……`);
  const start = snapshot("start");
  await sleep(CONTROL_SECONDS * 1000);
  const afterControl = snapshot("control");
  const noise = changes(start, afterControl);
  console.log(`  系统自己改了 ${noise.files.length} 个文件，注册表新增 ${noise.registryAdded.length} 行、去掉 ${noise.registryRemoved.length} 行`);

  console.log("运行程序……");
  const folder = join(work, "我的 TermiPaw");
  mkdirSync(folder);
  const exe = join(folder, "termipaw.exe");
  copyFileSync(exeSource, exe);
  // 故意设上 WEBVIEW2_USER_DATA_FOLDER：发布版应该忽略它，界面数据仍然放在 TermiPaw_Data\webview
  const elsewhere = join(work, "elsewhere");
  const app = await launchApp(folder, { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", WEBVIEW2_USER_DATA_FOLDER: elsewhere }, { exe, portable: true, lang: "en-US" });
  const invoke = (cmd, args) => app.js(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(() => "ok", (e) => JSON.stringify(e))`);
  const results = [];
  results.push(["开启保险库", await invoke("vault_enable", { password: "correct horse battery staple", recovery: true, encryptMetadata: true })]);
  results.push([
    "保存主机和密码",
    await invoke("hosts_save", { host: { id: "fp", name: "footprint", group: "", host: "127.0.0.1", port: 22, username: "demo", auth: "password", saveSecret: true }, secret: "a secret" }),
  ]);
  await app.openMenu(0);
  await app.waitFor(`!!document.querySelector(".settings-language")`);
  await sleep(300);
  await app.js(`(() => { const s = document.querySelector(".settings-language"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "ja"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(CONTROL_SECONDS * 1000);
  // 正常关闭窗口，让程序和 WebView2 自己收尾
  await app.js(`window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" })`).catch(() => {});
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(app.pid, 0);
      await sleep(300);
    } catch {
      break;
    }
  }
  await app.stop();
  await sleep(3000);
  console.log(`  操作结果：${results.map(([name, r]) => `${name}=${r}`).join("，")}`);
  const inData = existsSync(join(folder, "TermiPaw_Data", "webview", "EBWebView"));
  console.log(`  系统环境变量指向别处时，界面数据：TermiPaw_Data\\webview ${inData ? "有" : "没有"}，别处 ${existsSync(elsewhere) ? "有（程序没有忽略它）" : "没有"}`);

  const afterApp = snapshot("app");
  const run = changes(afterControl, afterApp);
  const noiseFiles = new Set(noise.files);
  const noiseLines = new Set([...noise.registryAdded, ...noise.registryRemoved]);

  console.log("\n========== 结果 ==========");
  const own = join(folder, "TermiPaw_Data");
  console.log(`程序自己的数据（都在程序旁边）：${existsSync(own) ? readdirSync(own).join("、") : "没有"}`);

  const stray = run.files.filter((p) => !noiseFiles.has(p) && interesting.test(p));
  console.log(`\n运行期间新增或改动的文件里，名字里有 termipaw / webview / edge 的、且对照期里没有的：${stray.length} 个`);
  for (const p of stray.slice(0, 40)) console.log(`  ${p}`);
  const termipawNamed = run.files.filter((p) => /termipaw/i.test(p));
  console.log(`其中路径里有 termipaw 的：${termipawNamed.length} 个`);
  for (const p of termipawNamed.slice(0, 40)) console.log(`  ${p}`);
  console.log(`其他文件变化（多半是别的程序，对照期里也有 ${noise.files.length} 个）：${run.files.length - stray.length} 个`);

  const lines = [...run.registryAdded, ...run.registryRemoved].filter((l) => !noiseLines.has(l));
  const relevant = lines.filter((l) => interesting.test(l));
  console.log(`\n注册表：运行期间变化 ${lines.length} 行（对照期没有的），其中键名或值里有 termipaw / webview / edge 的：${relevant.length} 行`);
  for (const l of relevant.slice(0, 60)) console.log(`  ${l.slice(0, 220)}`);

  const credentialDiff = afterApp.credentials.filter((c) => !afterControl.credentials.includes(c)).concat(afterControl.credentials.filter((c) => !afterApp.credentials.includes(c)));
  console.log(`\n凭据管理器：运行前后条目变化 ${credentialDiff.length} 个，名字里有 termipaw 的 ${afterApp.credentials.filter((c) => /termipaw/i.test(c)).length} 个`);
  console.log(`用户环境变量（HKCU\\Environment）：${afterApp.environment === afterControl.environment ? "没有变化" : "有变化！"}`);
} finally {
  removeDir(work);
}
