// 界面的语言。设计见 docs/I18N.md。
//
// 文字按名字取：组件里 `const m = msg()`，然后用 `m.vault.unlock`。切换语言时 App 整体重新渲染，
// 所以组件里直接读当前语言就行，不需要各自订阅。

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { de } from "./de";
import { detectLanguage as detectFrom, type Lang } from "./detect";
import { en, type Messages } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { ja } from "./ja";
import { ko } from "./ko";
import { zhCN } from "./zh-CN";
import { zhTW } from "./zh-TW";

export type { Lang, Messages };
export type LanguageChoice = "system" | Lang;

/** 语言列表里用各语言自己的名字 */
export const LANGUAGES: { id: Lang; name: string }[] = [
  { id: "en", name: "English" },
  { id: "zh-CN", name: "简体中文" },
  { id: "zh-TW", name: "繁體中文" },
  { id: "ja", name: "日本語" },
  { id: "ko", name: "한국어" },
  { id: "fr", name: "Français" },
  { id: "es", name: "Español" },
  { id: "de", name: "Deutsch" },
];

export const catalogs: Record<Lang, Messages> = { en, "zh-CN": zhCN, "zh-TW": zhTW, ja, ko, fr, es, de };

/** 系统（WebView）报告的语言里第一个支持的，规则见 detect.ts */
export const detectLanguage = (): Lang => detectFrom(navigator.languages);

export const resolveLanguage = (choice: LanguageChoice): Lang => (choice === "system" ? detectLanguage() : choice);

const useLang = create<{ lang: Lang }>(() => ({ lang: "en" }));

/** 启动时和用户切换语言时调用。后端也要知道：系统文件对话框的标题和重置确认词由它决定 */
export function applyLanguage(choice: LanguageChoice) {
  const lang = resolveLanguage(choice);
  useLang.setState({ lang });
  // 中日韩共用很多汉字但字形不同，浏览器按 lang 选字体
  document.documentElement.lang = lang;
  invoke("set_language", { lang }).catch(() => {});
}

/** 当前语言的文字。只在 App 里订阅一次，切换语言时整个界面重新渲染 */
export const useLanguage = () => useLang((s) => s.lang);
export const currentLang = () => useLang.getState().lang;
export const msg = (): Messages => catalogs[currentLang()];

// ---------- 后端返回的文字 ----------

/** 后端的 `Text`：代码和参数，见 src-tauri/src/i18n.rs */
export interface BackendText {
  code: string;
  args?: Record<string, BackendArg>;
}
export type BackendArg = string | number | string[] | BackendText;

type BackendEntry = string | ((a: Record<string, string | number>) => string);

/** 翻译后端的一句话。参数里的名字列表按当前语言的习惯连接，嵌套的话先翻译 */
export function renderText(text: BackendText, m: Messages = msg()): string {
  const args: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(text.args ?? {})) {
    args[name] = typeof value === "string" || typeof value === "number" ? value : Array.isArray(value) ? value.join(m.common.listJoin) : renderText(value, m);
  }
  const entry = (m.backend as Record<string, BackendEntry>)[text.code];
  if (entry === undefined) {
    // 不应该发生（测试会核对），也不能什么都不显示
    const detail = Object.values(args).join(" ");
    return detail ? `${text.code}: ${detail}` : text.code;
  }
  return typeof entry === "string" ? entry : entry(args);
}

/** 后端返回的一组情况，按当前语言的标点连成一句 */
export const renderTexts = (texts: BackendText[], m: Messages = msg()) => texts.map((t) => renderText(t, m)).join(m.common.clauseJoin);

// ---------- 格式 ----------

/** 必须明确传语言：传入 zh-TW 时浏览器默认的格式仍按简体中文处理 */
export const formatNumber = (n: number, fractionDigits = 0) =>
  new Intl.NumberFormat(currentLang(), { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(n);
