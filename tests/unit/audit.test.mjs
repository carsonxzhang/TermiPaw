import assert from "node:assert/strict";
import { test } from "node:test";
import { describeProblem, runAudit, summarize } from "../../scripts/audit.mjs";

const clean = JSON.stringify({ vulnerabilities: { found: false, count: 0, list: [] }, warnings: { unmaintained: [{}, {}], unsound: [{}] } });
const dirty = JSON.stringify({
  vulnerabilities: { found: true, count: 1, list: [{ advisory: { id: "RUSTSEC-2099-0001", title: "boom" }, package: { name: "foo", version: "1.2.3" }, versions: { patched: [">=1.2.4"] } }] },
  warnings: {},
});

test("没有漏洞：警告只计数", () => {
  assert.deepEqual(summarize(clean), { vulnerabilities: [], warnings: 3 });
});

test("有漏洞：列出库、版本、编号和修复版本", () => {
  assert.deepEqual(summarize(dirty), { vulnerabilities: [{ name: "foo", version: "1.2.3", id: "RUSTSEC-2099-0001", title: "boom", patched: [">=1.2.4"] }], warnings: 0 });
});

test("读不懂的输出不能当成没有漏洞", () => {
  for (const bad of ["", "not json", "{}", '{"vulnerabilities":{"found":false},"warnings":{}}', "null"]) assert.equal(summarize(bad), null, bad);
});

test("没装 cargo-audit、没有 cargo、输出读不懂：都是没能完成检查，不是通过", () => {
  const missing = runAudit(".", () => ({ status: 1, stdout: "", stderr: "error: no such command: `audit`" }));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /没有安装 cargo-audit/);
  assert.equal(runAudit(".", () => ({ error: new Error("ENOENT") })).ok, false);
  assert.equal(runAudit(".", () => ({ status: 1, stdout: "garbage", stderr: "network error" })).ok, false);
});

test("检查完成时带上结果", () => {
  const r = runAudit(".", () => ({ status: 0, stdout: dirty, stderr: "" }));
  assert.equal(r.ok, true);
  assert.equal(r.vulnerabilities.length, 1);
});

test("说明：没问题时为空，有漏洞时逐条列出，没能检查时说明原因", () => {
  assert.equal(describeProblem({ ok: true, vulnerabilities: [], warnings: 5 }), "");
  const text = describeProblem({ ok: true, ...summarize(dirty) });
  assert.match(text, /发现 1 个有已知漏洞的依赖/);
  assert.match(text, /foo 1\.2\.3 {2}RUSTSEC-2099-0001 {2}boom（修复版本 >=1\.2\.4）/);
  assert.match(describeProblem({ ok: false, reason: "没有安装 cargo-audit" }), /没能完成依赖检查：没有安装 cargo-audit/);
});
