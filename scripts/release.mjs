// 发布一个版本：构建 termipaw.exe（单个文件，没有安装包），在本机用离线私钥签名，生成 latest.json，
// 上传成 GitHub Release 草稿。发布草稿前用户收不到更新，可以先下载核对。流程和原因见 docs/UPDATER.md。
//
//   npm run release -- --notes-file notes.md
//   npm run release -- --notes-file notes.md --key D:\keys\termipaw.key
//   npm run release -- --notes-file notes.md --dry-run     只构建和签名，不上传，也不要求已配置发布信息
//   npm run release -- --notes-file notes.md --ignore-audit   依赖检查有问题时不询问，直接继续（没有终端时用）
//
// 构建前先用 cargo audit 检查 Rust 依赖有没有已知漏洞（scripts/audit.mjs）。有漏洞，或者没能完成检查时，
// 列出来并询问是否继续；没有终端可以回答时中止。
//
// 私钥默认在 ~/.tauri/termipaw.key。密码在这里输入，不显示也不保存，只通过环境变量传给签名那一步。
// 签名工具自己不会询问：没有给密码时，它当作空密码处理。

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeProblem, runAudit } from "./audit.mjs";
import { RELEASE_FILE_NAME, latestJson } from "./latest-json.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => {
  console.error(`\n发布中止：${message}`);
  process.exit(1);
};
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const runTauri = (args, env = {}) => spawnSync(process.execPath, [join(root, "node_modules/@tauri-apps/cli/tauri.js"), ...args], { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });

/** 输入时不显示 */
function askHidden(prompt) {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== undefined) return Promise.resolve(process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD);
  if (!process.stdin.isTTY) fail("没有终端可以输入私钥密码");
  return new Promise((done) => {
    let text = "";
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\u0003") {
          process.stdin.setRawMode(false);
          fail("已取消");
        } else if (c === "\r" || c === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.off("data", onData);
          process.stdin.pause();
          process.stdout.write("\n");
          return done(text);
        } else if (c === "\b" || c === "\u007f") {
          text = text.slice(0, -1);
        } else {
          text += c;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

function option(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}
const dryRun = process.argv.includes("--dry-run");
const ignoreAudit = process.argv.includes("--ignore-audit");
const keyPath = resolve(option("--key") ?? join(homedir(), ".tauri", "termipaw.key"));
const notesFile = option("--notes-file");

if (!notesFile || !existsSync(notesFile)) fail("用 --notes-file 指定更新说明文件");
const notes = readFileSync(notesFile, "utf8").trim();
if (!notes) fail("更新说明是空的");
if (!existsSync(keyPath)) fail(`找不到私钥 ${keyPath}，用 --key 指定`);

// ---- 版本号 ----
const conf = json("src-tauri/tauri.conf.json");
const version = conf.version;
const cargoVersion = /^version = "(.+)"/m.exec(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"))?.[1];
const lockVersion = /name = "termipaw"\r?\nversion = "(.+)"/.exec(readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8"))?.[1];
for (const [where, v] of [["package.json", json("package.json").version], ["Cargo.toml", cargoVersion], ["Cargo.lock", lockVersion]]) {
  if (v !== version) fail(`${where} 的版本号是 ${v}，tauri.conf.json 是 ${version}`);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`版本号 ${version} 不是 x.y.z`);
const tag = `v${version}`;

// ---- 发布配置和公钥 ----
const updater = conf.plugins.updater;
const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/latest\.json$/.exec(updater.endpoints[0] ?? "")?.[1];
if (!dryRun) {
  if (!repo) fail("tauri.conf.json 里还没配置 GitHub 更新地址");
  if (!updater.pubkey) fail("tauri.conf.json 里还没配置更新公钥");
  const pubFile = `${keyPath}.pub`;
  if (!existsSync(pubFile)) fail(`找不到 ${pubFile}，无法确认私钥和程序里的公钥是一对`);
  if (readFileSync(pubFile, "utf8").trim() !== updater.pubkey.trim()) fail("这把私钥和程序里配置的公钥不是一对，用它签名的更新会被拒绝");

  // ---- 代码状态 ----
  if (git("branch", "--show-current") !== "main") fail("只从 main 发布");
  if (git("status", "--porcelain")) fail("工作区有没提交的修改");
  git("fetch", "origin", "main", "--tags");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) fail("本地 main 和 GitHub 上的不一致，先推送");
  if (git("tag", "--list", tag)) fail(`标签 ${tag} 已经存在，先升版本号`);
  if (spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status !== 0) fail("gh 没有安装或没有登录，先运行 gh auth login");
}

// ---- 依赖检查 ----
// 在构建（要好几分钟）和输入私钥密码之前做
function askYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((done) => {
    process.stdout.write(`${question} [y/N] `);
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (line) => {
      process.stdin.pause();
      done(/^y(es)?$/i.test(line.trim()));
    });
  });
}
console.log("检查 Rust 依赖有没有已知漏洞（cargo audit）……");
const audit = runAudit(join(root, "src-tauri"));
const auditProblem = describeProblem(audit);
if (!auditProblem) console.log(`  没有已知漏洞${audit.warnings ? `（另有 ${audit.warnings} 条“不再维护”之类的警告，不拦，运行 cargo audit 可以看详情）` : ""}`);
if (auditProblem) {
  console.warn(`\n${auditProblem}\n`);
  if (ignoreAudit) console.warn("已指定 --ignore-audit，继续。");
  else if (!(await askYesNo("仍然继续发布吗？"))) fail(process.stdin.isTTY ? "依赖检查有问题，你选择不继续" : "依赖检查有问题，又没有终端可以确认；确认没问题后加 --ignore-audit");
}

// ---- 构建和签名 ----
const signing = { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: await askHidden("私钥密码：") };
const sign = (file) => runTauri(["signer", "sign", "--private-key-path", keyPath, "--app-version", version, file], signing).status === 0;

// 构建要好几分钟，先试着签一个小文件，密码输错马上就知道
const probeDir = mkdtempSync(join(tmpdir(), "termipaw-release-"));
const probe = join(probeDir, "probe");
writeFileSync(probe, "probe");
const keyWorks = sign(probe);
rmSync(probeDir, { recursive: true, force: true });
if (!keyWorks) fail("私钥密码不对，或者私钥文件有问题");

if (runTauri(["build", "--no-bundle"]).status !== 0) fail("构建失败");
const built = join(root, "src-tauri/target/release/termipaw.exe");
if (!existsSync(built)) fail(`没有找到构建出来的程序 ${built}`);

// 发布文件放在单独的文件夹里，名字每个版本都一样：签名里会记着它，程序更新时核对
const assetName = RELEASE_FILE_NAME;
const bundle = join(root, "src-tauri/target/release/release-files");
mkdirSync(bundle, { recursive: true });
const installer = join(bundle, assetName);
rmSync(`${installer}.sig`, { force: true });
copyFileSync(built, installer);
// 程序更新时也会这样检查。先在这里拦下，不要把打错的包签了名发出去
{
  const bytes = readFileSync(installer);
  const header = bytes.length > 0x40 ? bytes.readUInt32LE(0x3c) : 0;
  const isX64Windows = bytes.length > header + 6 && bytes.subarray(0, 2).toString() === "MZ" && bytes.subarray(header, header + 4).equals(Buffer.from("PE\0\0")) && bytes.readUInt16LE(header + 4) === 0x8664;
  if (bytes.length < 1 << 20 || !isX64Windows) fail(`${built} 不像是 64 位的 Windows 程序，不签名`);
}

// 把版本号写进签名。程序开启了 requireSignedVersion，不带版本号或版本号不对的更新包都会被拒绝
if (!sign(installer)) fail("签名失败");
const signature = readFileSync(`${installer}.sig`, "utf8").trim();

const url = `https://github.com/${repo ?? "OWNER/REPO"}/releases/download/${tag}/${assetName}`;
const latestPath = join(bundle, "latest.json");
writeFileSync(latestPath, `${JSON.stringify(latestJson({ version, notes, url, signature }), null, 2)}\n`);

const hash = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-FileHash -Algorithm SHA256 -LiteralPath '${installer}').Hash.ToLower()`], { encoding: "utf8" }).trim();
console.log(`\n程序：${installer}（${(statSync(installer).size / 1024 / 1024).toFixed(2)} MiB）`);
console.log(`SHA256：${hash}`);
console.log(`latest.json：${latestPath}`);

if (dryRun) {
  console.log("\n试运行：没有上传。");
  process.exit(0);
}

// ---- 上传草稿 ----
const body = join(bundle, "release-notes.md");
writeFileSync(body, `${notes}\n\nSHA256 (${assetName}): \`${hash}\`\n`);
const created = spawnSync("gh", ["release", "create", tag, "--repo", repo, "--draft", "--target", "main", "--title", `TermiPaw ${version}`, "--notes-file", body, installer, `${installer}.sig`, latestPath], { cwd: root, stdio: "inherit" });
if (created.status !== 0) fail("创建 Release 失败");
console.log(`\n草稿已创建。在网页上下载 exe 核对后点 Publish，用户才会收到更新：\nhttps://github.com/${repo}/releases`);
