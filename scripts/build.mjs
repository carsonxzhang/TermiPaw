// 构建绿色版：npm run app:build
// 先构建 termipaw.exe（单个文件，没有安装包），再复制一份到 builds\，文件名是 TermiPaw_<版本>_x64.exe。
// 旧版本的文件留在原处，不删除。本机的文件名带版本号，方便几个版本放在一起；
// 发布出去的文件每个版本都叫 TermiPaw.exe（见 npm run release）。

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));

const run = spawnSync(process.execPath, [join(root, "node_modules/@tauri-apps/cli/tauri.js"), "build", "--no-bundle"], { cwd: root, stdio: "inherit" });
if (run.status !== 0) {
  console.error("构建失败");
  process.exit(run.status ?? 1);
}

const built = join(root, "src-tauri/target/release/termipaw.exe");
if (!existsSync(built)) {
  console.error(`没有找到构建出来的程序 ${built}`);
  process.exit(1);
}
const out = join(root, "builds");
mkdirSync(out, { recursive: true });
const target = join(out, `TermiPaw_${version}_x64.exe`);
copyFileSync(built, target);
console.log(`\n已生成 ${target}`);
