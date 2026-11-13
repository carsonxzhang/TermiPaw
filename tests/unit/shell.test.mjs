// 目录上报、Shell 状态和命令生成。随机输入的部分带固定种子，失败时可以重现。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { cdCommand, integrationOneLiner, integrationSnippet, parseCwdReport, sameHost, shellQuote, ShellTracker } from "../../src/lib/shell.ts";
import { hasControlChars } from "../../src/lib/names.ts";

function random(seed) {
  let s = seed >>> 0;
  return (n) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
}

const NASTY = ["/", "..", ".", "%", "%2", "%2F", "%2e%2e", "%00", "%0a", "%1b", "%ff", "%C0%AF", "\x00", "\n", "\x1b", "\x07", "\x9b", "\u202e", "中", "'", '"', "\\", " ", "file://", "a", "b", "?", "#", ":", "~", "-"];

test("正常的上报能解析出路径", () => {
  assert.deepEqual(parseCwdReport("file://web01/var/www"), { host: "web01", path: "/var/www" });
  assert.deepEqual(parseCwdReport("file:///tmp"), { host: "", path: "/tmp" });
  assert.deepEqual(parseCwdReport("FILE://h/"), { host: "h", path: "/" });
  assert.deepEqual(parseCwdReport("file://h/tmp/%E4%B8%AD%E6%96%87%20dir"), { host: "h", path: "/tmp/中文 dir" });
  assert.deepEqual(parseCwdReport("file://h/a//b/./c/"), { host: "h", path: "/a/b/c" });
  assert.deepEqual(parseCwdReport("file://h/it%27s"), { host: "h", path: "/it's" });
  // 这些字符不是分隔符，就是路径的一部分
  assert.deepEqual(parseCwdReport("file://h/a?b#c"), { host: "h", path: "/a?b#c" });
});

test("不合规的上报一律不要", () => {
  for (const bad of [
    "",
    "/var/www",
    "http://h/var",
    "file:/var",
    "file://h",
    "file://h/../etc",
    "file://h/a/../../etc",
    "file://h/a/%2e%2e/etc", // 编码过的 ..
    "file://h/a%0Ab",
    "file://h/a%00b",
    "file://h/a%1B]0;x",
    "file://h/a%C2%9Bb", // C1 控制字符
    "file://h/a\nb",
    "file://h/%ff", // 不是合法的 UTF-8
    "file://h/%C0%AF", // 超长编码的斜杠
    "file://h/%", // 不完整的转义
    "file://h/%zz",
    "file://bad host/tmp",
    "file://h\x1b/tmp",
    `file://${"h".repeat(300)}/tmp`,
    `file://h/${"a".repeat(20000)}`,
  ]) {
    assert.equal(parseCwdReport(bad), null, JSON.stringify(bad));
  }
});

test("模糊测试：任何输入解析出的路径都是安全的", () => {
  const next = random(20261107);
  let accepted = 0;
  for (let round = 0; round < 200_000; round++) {
    let input = next(4) === 0 ? "" : "file://";
    if (next(3) === 0) input += "host";
    if (next(5) !== 0) input += "/";
    for (let i = next(10); i > 0; i--) input += NASTY[next(NASTY.length)];
    const report = parseCwdReport(input);
    if (!report) continue;
    accepted++;
    assert.ok(report.path.startsWith("/"), input);
    assert.ok(!hasControlChars(report.path), JSON.stringify(input));
    assert.ok(!report.path.split("/").includes(".."), input);
    assert.ok(!report.path.split("/").includes("."), input);
    assert.ok(!/\/\//.test(report.path), input);
    assert.ok(/^[A-Za-z0-9._:\[\]-]*$/.test(report.host), input);
  }
  assert.ok(accepted > 1000, `样本太少：${accepted}`);
});

test("主机名只比较第一段，不分大小写", () => {
  assert.ok(sameHost("web01", "WEB01.example.com"));
  assert.ok(!sameHost("web01", "web02"));
});

test("Shell 状态：没有上报时判断不了", () => {
  const t = new ShellTracker();
  assert.equal(t.status(false), "unknown");
  assert.equal(t.integrated, false);
});

test("Shell 状态：跟着提示符和命令变化", () => {
  const t = new ShellTracker();
  t.semanticPrompt("A");
  assert.equal(t.status(false), "prompt");
  t.input("ls");
  assert.equal(t.status(false), "typing");
  t.input("\r");
  t.semanticPrompt("C");
  assert.equal(t.status(false), "busy");
  t.semanticPrompt("D;0");
  t.semanticPrompt("A");
  assert.equal(t.status(false), "prompt");
});

test("Shell 状态：全屏程序优先于其他判断", () => {
  const t = new ShellTracker();
  t.semanticPrompt("A");
  assert.equal(t.status(true), "fullscreen");
});

test("Shell 状态：命令运行时打的字在下一个提示符还算输入", () => {
  const t = new ShellTracker();
  t.semanticPrompt("C");
  t.input("foo");
  t.semanticPrompt("A");
  assert.equal(t.status(false), "typing");
});

test("Shell 状态：Ctrl+C 和回车清空当前行，自动回复不算输入", () => {
  const t = new ShellTracker();
  t.semanticPrompt("A");
  t.input("rm -rf ");
  t.input("\x03");
  assert.equal(t.status(false), "prompt");
  for (const reply of ["\x1b[24;80R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[I", "\x1b[O", "\x1b[<0;10;20M", "\x1b[<0;10;20m", "\x1b[M !!", "\x1b]11;rgb:0/0/0\x07", "\x1bP1$r0m\x1b\\", "\x0c"]) {
    t.input(reply);
    assert.equal(t.status(false), "prompt", JSON.stringify(reply));
  }
  // 方向键可能调出历史命令，粘贴也会留在行上
  for (const typed of ["\x1b[A", "\x1b[200~x\x1b[201~", "\x7f"]) {
    t.input(typed);
    assert.equal(t.status(false), "typing", JSON.stringify(typed));
    t.input("\x03");
  }
});

test("Shell 状态：重新连接后回到判断不了", () => {
  const t = new ShellTracker();
  t.semanticPrompt("A");
  t.input("x");
  t.reset();
  assert.equal(t.status(false), "unknown");
});

test("进入目录的命令：引号和开头的横线", () => {
  assert.equal(cdCommand("/tmp/it's"), `cd '/tmp/it'\\''s'`);
  assert.equal(cdCommand("-rf"), "cd './-rf'");
  assert.equal(cdCommand("/a b"), "cd '/a b'");
});

test("进入目录的命令：控制字符不能进终端", () => {
  for (const bad of ["", "/tmp/x\x03rm -rf ~\r", "/a\nb", "/a\rb", "/a\x1b[A", "/a\x7f", "/a\u0085", "/a\u009b1m", "/a\x00"]) {
    assert.equal(cdCommand(bad), null, JSON.stringify(bad));
  }
});

test("模糊测试：生成的命令里没有控制字符，解析回来还是原路径", () => {
  const next = random(7);
  const alphabet = ["'", '"', "\\", "$", "`", " ", ";", "|", "&", "*", "\u202e", "中", "-", "/", "a", "\x03", "\r", "\n", "\x1b", "\x7f", "\u0090"];
  for (let round = 0; round < 50_000; round++) {
    let path = "";
    for (let i = next(12); i > 0; i--) path += alphabet[next(alphabet.length)];
    const cmd = cdCommand(path);
    if (hasControlChars(path) || !path) {
      assert.equal(cmd, null);
      continue;
    }
    assert.ok(!hasControlChars(cmd));
    // 把单引号转义还原，应该得到原路径
    const inner = cmd.slice(4, -1).replace(/'\\''/g, "'");
    assert.equal(inner, path.startsWith("-") ? `./${path}` : path);
  }
});

test("shellQuote 之后没有落单的单引号", () => {
  assert.equal(shellQuote("a'b'c"), `'a'\\''b'\\''c'`);
});

// ---------- Shell 集成 ----------

const bashAvailable = (() => {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** 在交互式 bash 里运行：提示符走标准错误，把它和标准输出一起收回来 */
function runInteractive(script) {
  const result = execFileSync("bash", ["--norc", "--noprofile", "-i"], {
    input: script,
    encoding: "utf8",
    env: { PATH: process.env.PATH, PS1: "$ ", HOSTNAME: "testhost", HOME: process.env.TEMP ?? "/tmp" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result;
}

function runInteractiveAll(script) {
  // execFileSync 不返回标准错误，这里让 bash 自己合并
  return runInteractive(`exec 2>&1\n${script}`);
}

const OSC7 = /\x1b\]7;file:\/\/([^\x1b]*)\x1b\\/g;

test("Shell 集成：一行版本和多行版本都是合法的 bash", { skip: !bashAvailable }, () => {
  execFileSync("bash", ["-n"], { input: integrationOneLiner() });
  execFileSync("bash", ["-n"], { input: integrationSnippet() });
  assert.ok(!/[\r\n]/.test(integrationOneLiner()), "一行版本不能有换行，否则每行都会单独执行");
  assert.ok(integrationOneLiner().startsWith(" "));
});

test("Shell 集成：bash 上报的目录能被解析，状态按顺序变化", { skip: !bashAvailable }, () => {
  const out = runInteractiveAll(`${integrationOneLiner()}\ncd /\nmkdir -p "$TEMP/tp-中文 dir" 2>/dev/null; cd /tmp\necho marker\nexit\n`);
  const reports = [...out.matchAll(OSC7)].map((m) => parseCwdReport(`file://${m[1]}`));
  assert.ok(reports.length >= 3, JSON.stringify(out));
  assert.ok(reports.every(Boolean), JSON.stringify(out));
  assert.ok(reports.some((r) => r.path === "/"), JSON.stringify(reports));
  assert.ok(reports.every((r) => r.host === "testhost"), JSON.stringify(reports));
  const marks = [...out.matchAll(/\x1b\]133;([ACD])/g)].map((m) => m[1]).join("");
  assert.match(marks, /(CA)+/, JSON.stringify(out));
});

test("Shell 集成：目录名里的特殊字符不会破坏上报", { skip: !bashAvailable }, () => {
  // 目录名不一定建得出来（Windows 不允许控制字符），所以直接把 PWD 交给编码函数
  const out = runInteractiveAll(`${integrationOneLiner()}\nPWD=$'/tmp/a\\nb\\e]0;evil\\a/中 文\\'x'\n__tp_cwd\necho\nexit\n`);
  const raw = [...out.matchAll(OSC7)].map((m) => m[1]).find((v) => v.includes("%0A"));
  assert.ok(raw, JSON.stringify(out));
  assert.ok(!hasControlChars(raw), "上报内容必须全部编码");
  // 里面有控制字符，解析时会被拒绝，但不会提前结束转义序列
  assert.equal(parseCwdReport(`file://${raw}`), null);
});

test("Shell 集成：重复开启不会重复添加", { skip: !bashAvailable }, () => {
  const out = runInteractiveAll(`${integrationOneLiner()}\n${integrationOneLiner()}\necho "PC=[$PROMPT_COMMAND]"\nexit\n`);
  // 第一个匹配是回显的命令本身（方括号里是 $PROMPT_COMMAND），要的是执行结果
  const line = /PC=\[([^$\]]*)\]/.exec(out)?.[1];
  assert.equal(line, "__tp_prompt", JSON.stringify(out));
});

test("Shell 集成：保留已有的 PROMPT_COMMAND 和退出码", { skip: !bashAvailable }, () => {
  const out = runInteractiveAll(`PROMPT_COMMAND='echo "old=$?"'\n${integrationOneLiner()}\nfalse\ntrue\nexit\n`);
  assert.match(out, /old=1/, JSON.stringify(out));
});
