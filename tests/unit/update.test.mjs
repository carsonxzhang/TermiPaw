// 安装更新前告诉用户会打断什么。

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { RELEASE_FILE_NAME } from "../../scripts/latest-json.mjs";
import { en } from "../../src/i18n/en.ts";
import { zhCN } from "../../src/i18n/zh-CN.ts";
import { whatUpdateInterrupts as interrupts } from "../../src/lib/update.ts";

const whatUpdateInterrupts = (state) => interrupts(state, zhCN);

const none = { tabs: [], transfers: [], edits: [] };

test("没有在进行的事情时不提示", () => {
  assert.deepEqual(whatUpdateInterrupts(none), []);
  assert.deepEqual(
    whatUpdateInterrupts({
      tabs: [{ status: "closed" }, { status: "error" }],
      transfers: [{ status: "done" }, { status: "failed" }, { status: "cancelled" }],
      edits: [],
    }),
    [],
  );
});

test("正在连接和已连接的会话都算", () => {
  assert.deepEqual(whatUpdateInterrupts({ ...none, tabs: [{ status: "connected" }, { status: "connecting" }, { status: "closed" }] }), ["2 个会话会断开"]);
});

test("排队中的传输也算", () => {
  assert.deepEqual(whatUpdateInterrupts({ ...none, transfers: [{ status: "running" }, { status: "queued" }, { status: "done" }] }), ["2 个传输会中断"]);
});

test("编辑中的文件区分有没有没传回的修改", () => {
  const synced = whatUpdateInterrupts({ ...none, edits: [{ status: "synced" }] });
  assert.equal(synced.length, 1);
  assert.match(synced[0], /1 个正在编辑/);
  assert.doesNotMatch(synced[0], /还没传回/);

  for (const status of ["syncing", "conflict", "readOnly", "failed", "deleted", "missing"]) {
    const [line] = whatUpdateInterrupts({ ...none, edits: [{ status: "synced" }, { status }] });
    assert.match(line, /2 个正在编辑.*其中 1 个/, status);
  }
});

test("按传入的语言说明", () => {
  assert.deepEqual(interrupts({ ...none, tabs: [{ status: "connected" }], transfers: [{ status: "running" }, { status: "queued" }] }, en), ["1 session will disconnect", "2 transfers will stop"]);
});

test("发布文件的名字，发布脚本和程序里核对的是同一个", () => {
  assert.equal(RELEASE_FILE_NAME, "TermiPaw.exe");
  // 程序（selfupdate.rs）要求签名里记着的文件名就是这个
  const rust = readFileSync("src-tauri/src/selfupdate.rs", "utf8");
  assert.ok(rust.includes('RELEASE_FILE_NAME: &str = "TermiPaw.exe"'), "selfupdate.rs 里的名字变了");
});
