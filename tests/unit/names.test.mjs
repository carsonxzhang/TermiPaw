// 文件名的显示。真正的文件操作用原始名字，这里只管用户看到的样子。

import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanName, displayName, hasControlChars, isOddName } from "../../src/lib/names.ts";

test("普通名字不变", () => {
  for (const name of ["a.txt", "中文 文件.log", "emoji-👨‍👩‍👧.png", "it's (1).tar.gz", "مرحبا.txt", "שלום"]) {
    assert.equal(displayName(name), name);
    assert.equal(isOddName(name), false, name);
  }
});

test("RTL 伪装的扩展名会露出来", () => {
  const spoofed = "evil\u202etxt.exe";
  assert.equal(displayName(spoofed), "evil⟦U+202E⟧txt.exe");
  assert.ok(isOddName(spoofed));
  assert.equal(cleanName(spoofed), "eviltxt.exe");
});

test("控制字符变成看得见的符号", () => {
  assert.equal(displayName("a\nb"), "a␊b");
  assert.equal(displayName("a\x1b[2Jb"), "a␛[2Jb");
  assert.equal(displayName("a\x7fb"), "a␡b");
  assert.equal(displayName("a\u0085b"), "a⟦U+0085⟧b");
});

test("看不见的字符变成看得见的符号", () => {
  for (const c of ["\u200b", "\u2060", "\ufeff", "\u00ad", "\u2028", "\u2029"]) {
    assert.ok(isOddName(`a${c}b`), c.charCodeAt(0).toString(16));
    assert.ok(!displayName(`a${c}b`).includes(c));
  }
});

test("模糊测试：显示出来的名字里没有控制字符和方向控制字符", () => {
  // 把容易出问题的码位都走一遍，再随机拼接
  const odd = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b\u2028\u2029\ufeff]/;
  for (let code = 0; code <= 0xffff; code++) {
    const text = `a${String.fromCharCode(code)}b`;
    assert.ok(!odd.test(displayName(text)), code.toString(16));
    assert.ok(!odd.test(cleanName(text)), code.toString(16));
  }
  let seed = 12345;
  const next = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let round = 0; round < 20_000; round++) {
    let text = "";
    for (let i = next(16); i > 0; i--) text += String.fromCharCode(next(0x3000));
    const shown = displayName(text);
    assert.ok(!odd.test(shown));
    // 连续调用结果一样，符号不会被再次替换
    assert.equal(displayName(shown), shown);
    assert.equal(hasControlChars(shown), false);
  }
});
