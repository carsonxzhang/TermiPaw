/**
 * 和远程 Shell 打交道的纯函数：解析它上报的目录，判断它现在能不能接受命令，生成要输入的命令。
 *
 * 终端输出是服务器说了算的，`cat` 一个文件就能伪造任意转义序列，所以这里收到的东西都不可信。
 */

import { hasControlChars } from "./names.ts";

// ---------- 目录上报（OSC 7） ----------

/** 比 Linux 的 PATH_MAX 宽松一些，百分号编码后长度可能变成三倍 */
const MAX_REPORT_LENGTH = 16 * 1024;

export interface CwdReport {
  host: string;
  path: string;
}

function decodePercent(text: string): string | null {
  const bytes: number[] = [];
  const raw = new TextEncoder().encode(text);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0x25) {
      bytes.push(raw[i]);
      continue;
    }
    const hex = String.fromCharCode(raw[i + 1] ?? 0, raw[i + 2] ?? 0);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
    bytes.push(parseInt(hex, 16));
    i += 2;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/**
 * 解析 `file://主机/路径`。格式不对、含控制字符、不是绝对路径、含 `..` 的一律不要：
 * `..` 的实际位置取决于符号链接，这里判断不了它指向哪里。
 */
export function parseCwdReport(data: string): CwdReport | null {
  if (data.length > MAX_REPORT_LENGTH) return null;
  const match = /^file:\/\/([^/]*)(\/.*)$/is.exec(data);
  if (!match) return null;
  const [, host, encoded] = match;
  if (host.length > 255 || !/^[A-Za-z0-9._:\[\]-]*$/.test(host)) return null;
  const decoded = decodePercent(encoded);
  if (decoded === null || hasControlChars(decoded)) return null;
  const parts: string[] = [];
  for (const part of decoded.split("/")) {
    if (part === "..") return null;
    if (part !== "" && part !== ".") parts.push(part);
  }
  return { host, path: `/${parts.join("/")}` };
}

/** 只比较第一段，上报的可能是短名字，也可能是完整域名 */
export function sameHost(a: string, b: string): boolean {
  const short = (name: string) => name.split(".")[0].toLowerCase();
  return short(a) === short(b);
}

// ---------- Shell 状态 ----------

/**
 * - `prompt`：Shell 集成说它停在提示符，当前行没有输入
 * - `typing`：当前行可能有还没执行的内容，再输入命令会拼在一起
 * - `busy`：Shell 集成说有程序在运行
 * - `fullscreen`：全屏程序（vim、less、top……）
 * - `unknown`：这个 Shell 没有上报状态，判断不了
 */
export type ShellStatus = "prompt" | "typing" | "busy" | "fullscreen" | "unknown";

/** 终端替程序自动回复的内容（光标位置、设备属性、鼠标和焦点事件），不算用户输入 */
const AUTOMATIC_REPLY = /^\x1b(?:\[(?:[<>?=]?[\d;]*(?:[cRnMmtIO]|\$y)|M[\s\S]{3})|\][\s\S]*|P[\s\S]*)$/;

export class ShellTracker {
  private phase: "unknown" | "prompt" | "busy" = "unknown";
  /** 上次回车或 Ctrl+C 之后又有过输入。退格也算：判断不了行是否已经清空，宁可多问 */
  private dirty = false;

  /** `onData` 收到的内容。程序自己发送的命令不经过这里 */
  input(data: string) {
    if (AUTOMATIC_REPLY.test(data) || data === "\x0c") return;
    this.dirty = !/[\r\n\x03]$/.test(data);
  }

  /** OSC 133 的内容：`A` 提示符开始，`C` 命令开始运行，`D` 命令结束 */
  semanticPrompt(payload: string) {
    const kind = payload[0];
    if (kind === "A") this.phase = "prompt";
    else if (kind === "C") this.phase = "busy";
  }

  get integrated() {
    return this.phase !== "unknown";
  }

  status(alternateScreen: boolean): ShellStatus {
    if (alternateScreen) return "fullscreen";
    if (this.dirty) return "typing";
    return this.phase;
  }

  reset() {
    this.phase = "unknown";
    this.dirty = false;
  }
}

// ---------- 要输入的命令 ----------

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * 进入目录的命令。名字里有控制字符时返回 null：单引号挡不住它们，
 * 这些字节会先被行编辑器当作按键处理，`\x03` 能打断当前行，回车能执行后面跟着的内容。
 */
export function cdCommand(path: string): string | null {
  if (!path || hasControlChars(path)) return null;
  return `cd ${shellQuote(path.startsWith("-") ? `./${path}` : path)}`;
}

// ---------- Shell 集成 ----------

const ENCODE_PWD = (start: string, length: string, char: string) =>
  `local LC_ALL=C p=$PWD o= c i; for ((i = ${start}; i ${length}; i++)); do c=${char}; case $c in ([a-zA-Z0-9/._~-]) o+=$c ;; (*) printf -v c '%%%02X' "'$c"; o+=$c ;; esac; done`;
const REPORT_CWD = (host: string) => `printf '\\033]7;file://%s%s\\033\\\\' "${host}" "$o"`;
const MARK = (text: string) => `printf '\\033]133;${text}\\033\\\\'`;

const BASH = [
  `__tp_cwd() { ${ENCODE_PWD("0", "< ${#p}", "${p:i:1}")}; ${REPORT_CWD("$HOSTNAME")}; }`,
  // bash 4.4 之前没有 PS0，看不出命令什么时候开始运行，所以只上报目录，不上报状态
  `__tp_prompt() { local s=$?; __tp_cwd; if [ "\${BASH_VERSINFO[0]}\${BASH_VERSINFO[1]}" -ge 44 ]; then ${MARK("A")}; fi; return $s; }`,
  `case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in ("declare -a"*) PROMPT_COMMAND=(__tp_prompt "\${PROMPT_COMMAND[@]}") ;; (*) PROMPT_COMMAND="__tp_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;; esac`,
  `PS0="$PS0"'\\e]133;C\\e\\\\'`,
];

const ZSH = [
  `__tp_cwd() { emulate -L zsh; ${ENCODE_PWD("1", "<= $#p", "$p[i]")}; ${REPORT_CWD("$HOST")}; }`,
  `__tp_precmd() { __tp_cwd; ${MARK("A")}; }`,
  `__tp_preexec() { ${MARK("C")}; }`,
  `autoload -Uz add-zsh-hook`,
  `add-zsh-hook precmd __tp_precmd`,
  `add-zsh-hook preexec __tp_preexec`,
];

// 已经开启过就不再重复添加
const guarded = (shell: string, statements: string[], separator: string, indent: string) =>
  `[ -n "$${shell}_VERSION" ] && ! typeset -f __tp_cwd >/dev/null; then${indent}${statements.join(separator + indent)}`;

/** 只在当前 Shell 生效的一行命令。开头的空格让它不进历史记录（bash 默认如此，zsh 要开启相应选项） */
export const integrationOneLiner = () =>
  ` if ${guarded("BASH", BASH, ";", " ")}; elif ${guarded("ZSH", ZSH, ";", " ")}; fi`;

/** 给用户写进 ~/.bashrc 或 ~/.zshrc 的版本 */
export const integrationSnippet = () =>
  `# TermiPaw: report the current directory and shell state\nif ${guarded("BASH", BASH, "", "\n  ")}\nelif ${guarded("ZSH", ZSH, "", "\n  ")}\nfi`;
