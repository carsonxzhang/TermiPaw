// 按系统语言选界面语言。不依赖界面的其他部分，单元测试可以直接加载。

export type Lang = "en" | "zh-CN" | "zh-TW" | "ja" | "ko" | "fr" | "es" | "de";

/** 按系统的语言顺序找第一个支持的。英语排在前面的用户就用英语，不会跳过它去找后面的语言 */
export function detectLanguage(list: readonly string[]): Lang {
  for (const raw of list) {
    const tag = raw.toLowerCase();
    if (tag === "zh" || tag.startsWith("zh-")) {
      if (tag.startsWith("zh-hans")) return "zh-CN";
      return /^zh-(hant|tw|hk|mo)\b/.test(tag) ? "zh-TW" : "zh-CN";
    }
    for (const lang of ["en", "ja", "ko", "fr", "es", "de"] as const) {
      if (tag === lang || tag.startsWith(`${lang}-`)) return lang;
    }
  }
  return "en";
}
