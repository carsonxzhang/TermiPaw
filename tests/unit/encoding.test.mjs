// 终端编码转换：编码表是从解码器反推的，这里检查反推得对，并且和标准的编码结果一致。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDecoder, encodeText, ENCODINGS, isEncoding } from "../../src/lib/encoding.ts";

const hex = (bytes) => Buffer.from(bytes).toString("hex");

const SAMPLES = {
  gb18030: "中文输入，简体汉字：编码测试 ￥€ 😀",
  big5: "繁體中文輸入：測試編碼",
  shift_jis: "日本語の入力、ｶﾀｶﾅ、テスト",
  "euc-jp": "日本語の入力、ｶﾀｶﾅ、テスト",
  "euc-kr": "한국어 입력 테스트",
  "windows-1252": "Café, niño, Größe, œuvre — €",
};

test("每种编码的示例文字转换后能原样解回来", () => {
  for (const [encoding, text] of Object.entries(SAMPLES)) {
    const bytes = encodeText(`ls ${text}\r`, encoding);
    assert.equal(new TextDecoder(encoding).decode(bytes), `ls ${text}\r`, encoding);
  }
});

test("和各编码的标准写法一致", () => {
  assert.equal(hex(encodeText("中文", "gb18030")), "d6d0cec4");
  assert.equal(hex(encodeText("€", "gb18030")), "a2e3");
  assert.equal(hex(encodeText("😀", "gb18030")), "9439fc36");
  assert.equal(hex(encodeText("\u0080", "gb18030")), "81308130");
  assert.equal(hex(encodeText("中文", "big5")), "a4a4a4e5");
  assert.equal(hex(encodeText("日本", "shift_jis")), "93fa967b");
  assert.equal(hex(encodeText("ｱ", "shift_jis")), "b1");
  assert.equal(hex(encodeText("日本", "euc-jp")), "c6fccbdc");
  assert.equal(hex(encodeText("ｱ", "euc-jp")), "8eb1");
  assert.equal(hex(encodeText("한국", "euc-kr")), "c7d1b1b9");
  assert.equal(hex(encodeText("é€", "windows-1252")), "e980");
  assert.equal(hex(encodeText("中文", "utf-8")), "e4b8ade69687");
});

test("服务器编码里没有的字符换成问号，ASCII 和控制字符原样发送", () => {
  assert.equal(hex(encodeText("a😀b", "big5")), "613f62");
  assert.equal(hex(encodeText("한", "windows-1252")), "3f");
  assert.equal(hex(encodeText("\x1b[A\x03\r", "euc-kr")), "1b5b41030d");
});

test("重复的字符用标准规定的那个写法", () => {
  // Shift_JIS：NEC 选定的 IBM 扩展和 IBM 扩展重复，用 IBM 扩展（0xFA 开头）
  assert.equal(hex(encodeText("ⅰ", "shift_jis")), "fa40");
  // Big5：这几个字有两种写法，规定用后一个
  assert.equal(hex(encodeText("═", "big5")), "f9f9");
  assert.equal(hex(encodeText("十", "big5")), "a451");
  assert.equal(hex(encodeText("卅", "big5")), "a4ca");
});

test("被拆在两段输出里的字符能拼起来", () => {
  for (const encoding of ENCODINGS) {
    const text = encoding === "utf-8" ? "中文😀" : SAMPLES[encoding];
    const bytes = encodeText(text, encoding);
    const decode = createDecoder(encoding);
    let out = "";
    for (const b of bytes) out += decode(new Uint8Array([b]));
    assert.equal(out, text, encoding);
  }
});

test("生成编码表不会让第一次输入卡顿太久", () => {
  for (const encoding of ENCODINGS) {
    const started = performance.now();
    encodeText("测", encoding);
    const ms = performance.now() - started;
    assert.ok(ms < 1500, `${encoding} 用了 ${ms.toFixed(0)} ms`);
  }
});

test("只认识列表里的编码", () => {
  assert.ok(isEncoding("gb18030"));
  assert.ok(!isEncoding("gbk"));
  assert.ok(!isEncoding(undefined));
});
