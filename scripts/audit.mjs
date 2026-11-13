// 发布前检查 Rust 依赖有没有已知的安全问题：cargo audit 对照 RustSec 的公开漏洞库。
// 只能发现已经被登记过的问题，不能证明程序没有恶意代码。需要先安装：cargo install cargo-audit --locked

import { spawnSync } from "node:child_process";

/** 把 cargo audit --json 的输出整理成：有漏洞的库、警告数。读不懂时返回 null */
export function summarize(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return null;
  }
  const list = report?.vulnerabilities?.list;
  if (!Array.isArray(list) || typeof report?.warnings !== "object") return null;
  return {
    vulnerabilities: list.map((v) => ({
      name: v.package?.name ?? "?",
      version: v.package?.version ?? "?",
      id: v.advisory?.id ?? "?",
      title: v.advisory?.title ?? "",
      patched: v.versions?.patched ?? [],
    })),
    // unmaintained / unsound 之类：只提示数量，不拦
    warnings: Object.values(report.warnings).reduce((n, items) => n + (Array.isArray(items) ? items.length : 0), 0),
  };
}

/**
 * 在 cwd（放着 Cargo.lock 的文件夹）里运行 cargo audit。
 * 返回 { ok: true, vulnerabilities, warnings } 或 { ok: false, reason }，ok:false 表示没能完成检查。
 */
export function runAudit(cwd, run = spawnSync) {
  const result = run("cargo", ["audit", "--json"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) return { ok: false, reason: `没能运行 cargo：${result.error.message}` };
  if (/no such command/i.test(result.stderr ?? "")) return { ok: false, reason: "没有安装 cargo-audit（cargo install cargo-audit --locked）" };
  const summary = summarize(result.stdout ?? "");
  if (!summary) return { ok: false, reason: `cargo audit 没有给出能读懂的结果（${(result.stderr ?? "").trim().split("\n").pop() || "没有错误信息"}）` };
  return { ok: true, ...summary };
}

/** runAudit 的结果里有问题时的说明；没问题返回空字符串 */
export function describeProblem(audit) {
  if (!audit.ok) return `没能完成依赖检查：${audit.reason}`;
  if (audit.vulnerabilities.length === 0) return "";
  const lines = audit.vulnerabilities.map((v) => `  ${v.name} ${v.version}  ${v.id}  ${v.title}${v.patched.length ? `（修复版本 ${v.patched.join(", ")}）` : ""}`);
  return `发现 ${audit.vulnerabilities.length} 个有已知漏洞的依赖：\n${lines.join("\n")}`;
}
