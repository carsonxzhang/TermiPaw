// 多语言：各语言的条目齐全、参数用对、和后端一致，代码里不再写死中文。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { de } from "../../src/i18n/de.ts";
import { detectLanguage } from "../../src/i18n/detect.ts";
import { en } from "../../src/i18n/en.ts";
import { es } from "../../src/i18n/es.ts";
import { fr } from "../../src/i18n/fr.ts";
import { ja } from "../../src/i18n/ja.ts";
import { ko } from "../../src/i18n/ko.ts";
import { zhCN } from "../../src/i18n/zh-CN.ts";
import { zhTW } from "../../src/i18n/zh-TW.ts";

const catalogs = { en, "zh-CN": zhCN, "zh-TW": zhTW, ja, ko, fr, es, de };
const translations = Object.entries(catalogs).filter(([lang]) => lang !== "en");

/** 每一条的路径和类型（文字，或者几个参数的函数） */
function shape(obj, prefix = "", out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, "string");
    else if (typeof value === "function") out.set(path, `function(${value.length})`);
    else shape(value, path, out);
  }
  return out;
}

const entries = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === "object" ? entries(value, path) : [[path, value]];
  });

test("每种语言的条目和英文完全一致", () => {
  const reference = shape(en);
  for (const [lang, catalog] of translations) {
    assert.deepEqual([...shape(catalog)], [...reference], lang);
  }
});

test("译文都填了，不是英文占位", () => {
  const english = new Map(entries(en));
  for (const [lang, catalog] of translations) {
    const strings = entries(catalog).filter(([, v]) => typeof v === "string");
    for (const [path, value] of strings) assert.ok(value.trim() || path.endsWith("Join"), `${lang} ${path} 是空的`);
    // 技术名词（SSH Agent、OK 这类）可以和英文一样，大部分不应该一样
    const same = strings.filter(([path, value]) => english.get(path) === value).length;
    assert.ok(same / strings.length < 0.15, `${lang}：${same} / ${strings.length} 条和英文完全一样，可能还没翻译`);
  }
});

/** 用记号代替参数调用一次，返回输出里出现了哪些参数 */
function usedParams(fn, path) {
  if (path.startsWith("backend.")) {
    const read = new Set();
    const args = new Proxy({}, { get: (_, key) => (read.add(String(key)), `⟦${String(key)}⟧`) });
    fn(args);
    return [...read].sort();
  }
  const markers = Array.from({ length: fn.length }, (_, i) => `⟦${i}⟧`);
  const out = fn(...markers);
  return markers.filter((m) => out.includes(m));
}

test("带参数的文字用上了和英文一样的参数", () => {
  const english = new Map(entries(en));
  for (const [lang, catalog] of translations) {
    for (const [path, value] of entries(catalog)) {
      if (typeof value !== "function") continue;
      assert.deepEqual(usedParams(value, path), usedParams(english.get(path), path), `${lang} ${path}`);
    }
  }
});

test("加粗标记成对出现", () => {
  for (const [lang, catalog] of Object.entries(catalogs)) {
    for (const [path, value] of entries(catalog)) {
      const text = typeof value === "function" ? value(...Array.from({ length: value.length }, () => "x")) : value;
      if (typeof text !== "string") continue;
      assert.equal((text.match(/<b>/g) ?? []).length, (text.match(/<\/b>/g) ?? []).length, `${lang} ${path}`);
      assert.ok(!/<(?!\/?b>)/.test(text), `${lang} ${path} 里有 <b> 以外的标记`);
    }
  }
});

// ---------- 和后端一致 ----------

const rustFiles = execFileSync("git", ["ls-files", "src-tauri/src"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith(".rs"));
/** 测试模块之前的代码 */
const rustCode = (file) => {
  const text = readFileSync(file, "utf8");
  const tests = text.indexOf("#[cfg(test)]");
  return tests < 0 ? text : text.slice(0, tests);
};

const PREFIXES = new Set(["agent", "debug", "dialog", "edit", "grant", "hostKey", "hosts", "knownHosts", "link", "raw", "sftp", "ssh", "store", "task", "transfer", "tree", "update", "vault"]);

test("后端用到的每个文字代码都有译文，译文里也没有用不到的", () => {
  const used = new Set(["raw"]);
  for (const file of rustFiles) {
    for (const [, code] of rustCode(file).matchAll(/"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)"/g)) {
      if (PREFIXES.has(code.split(".")[0]) && !/\.(json|lock|tmp|rs|exe)$/.test(code)) used.add(code);
    }
  }
  const known = new Set(Object.keys(en.backend));
  assert.deepEqual([...used].filter((c) => !known.has(c)).sort(), [], "后端用了但没有译文");
  assert.deepEqual([...known].filter((c) => !used.has(c)).sort(), [], "有译文但后端没有用到");
});

test("重置保险库的确认词和后端一致", () => {
  const rust = readFileSync("src-tauri/src/i18n.rs", "utf8");
  const body = rust.slice(rust.indexOf("pub fn reset_word"), rust.indexOf("#[cfg(test)]"));
  const names = { En: "en", ZhCn: "zh-CN", ZhTw: "zh-TW", Ja: "ja", Ko: "ko", Fr: "fr", Es: "es", De: "de" };
  const words = Object.fromEntries([...body.matchAll(/Lang::(\w+) => "([^"]+)"/g)].map(([, lang, word]) => [names[lang], word]));
  assert.equal(Object.keys(words).length, 8);
  for (const [lang, catalog] of Object.entries(catalogs)) assert.equal(catalog.vault.resetWord, words[lang], lang);
});

// ---------- 选择语言 ----------

test("按系统的语言顺序选第一个支持的", () => {
  const cases = [
    [["zh-CN", "en"], "zh-CN"],
    [["zh"], "zh-CN"],
    [["zh-Hans-HK"], "zh-CN"],
    [["zh-SG"], "zh-CN"],
    [["zh-TW"], "zh-TW"],
    [["zh-HK"], "zh-TW"],
    [["zh-MO"], "zh-TW"],
    [["zh-Hant"], "zh-TW"],
    [["ja-JP"], "ja"],
    [["ko"], "ko"],
    [["fr-CA"], "fr"],
    [["es-419"], "es"],
    [["de-AT", "en"], "de"],
    [["en-GB", "de"], "en"],
    [["pt-BR", "it", "de"], "de"],
    [["pt-BR"], "en"],
    [[], "en"],
    [["jav"], "en"],
  ];
  for (const [list, expected] of cases) assert.equal(detectLanguage(list), expected, list.join(","));
});

// ---------- 不再写死中文 ----------

test("界面和后端的代码里没有写死的中文", () => {
  const cjk = /[぀-ヿ㐀-鿿가-힯]/;
  const found = [];
  const frontend = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith("src/i18n/"));
  for (const file of frontend) {
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        const code = line.replace(/\{\/\*.*?\*\/\}/g, "").replace(/\s\/\/.*$/, "");
        if (cjk.test(code)) found.push(`${file}:${i + 1}`);
      });
  }
  for (const file of rustFiles.filter((f) => !f.endsWith("/i18n.rs"))) {
    rustCode(file)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (cjk.test(line.replace(/\/\/.*$/, ""))) found.push(`${file}:${i + 1}`);
      });
  }
  assert.deepEqual(found, [], "给用户看的文字要放进 src/i18n/");
});
