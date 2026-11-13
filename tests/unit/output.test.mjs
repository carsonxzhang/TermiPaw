// 保存终端输出：缓冲区整理成文本，建议的文件名。

import assert from "node:assert/strict";
import { test } from "node:test";
import { bufferText, outputFileName } from "../../src/lib/output.ts";

/** 模拟 xterm 的缓冲区：每行给出内容（含行尾空格）和是否由上一行折过来 */
function buffer(rows) {
  return {
    length: rows.length,
    getLine: (y) =>
      rows[y] && {
        isWrapped: rows[y][1] ?? false,
        translateToString: (trim) => (trim ? rows[y][0].trimEnd() : rows[y][0]),
      },
  };
}

test("每行一个换行，去掉行尾空格和末尾的空行", () => {
  const text = bufferText(buffer([["$ ls   "], ["a  b"], [""], ["$ "], [""], ["   "]]));
  assert.equal(text, "$ ls\r\na  b\r\n\r\n$\r\n");
});

test("折行显示的长行还原成一行，折行处的空格保留", () => {
  const text = bufferText(buffer([["hello wor"], ["ld and   ", true], ["more", true], ["next"]]));
  assert.equal(text, "hello world and   more\r\nnext\r\n");
  const spaced = bufferText(buffer([["abc "], ["def", true]]));
  assert.equal(spaced, "abc def\r\n");
});

test("什么都没有时是空文本", () => {
  assert.equal(bufferText(buffer([[""], ["  "]])), "");
});

test("文件名带会话名、日期和时间", () => {
  assert.equal(outputFileName("web-01", new Date(2026, 10, 11, 9, 5, 3)), "web-01_2026-11-11_09-05-03.txt");
});
