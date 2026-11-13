/**
 * 服务器给的文件名是不可信的：控制字符可能被当成按键，RTL 字符能把 `exe.txt` 显示成别的样子。
 * 界面上显示的一律先经过这里；真正操作文件时仍然用原始名字。
 */

/** C0、DEL 和 C1 控制字符。写进终端会被当作按键或转义序列 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** 改变文字方向的字符，能让文件名显示成另一个样子 */
const BIDI = "\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069";
/** 看不见的字符，能让两个不同的文件名看起来一样。保留 U+200C、U+200D：表情和部分文字要用 */
const INVISIBLE = "\u00ad\u034f\u180e\u200b\u2028\u2029\u2060-\u2064\u206a-\u206f\ufeff\ufff9-\ufffb";

const ODD = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${BIDI}${INVISIBLE}]`, "g");

const codePoint = (c: string) => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

function visibleSymbol(c: string): string {
  const code = c.charCodeAt(0);
  if (code < 0x20) return String.fromCharCode(0x2400 + code);
  if (code === 0x7f) return "␡";
  return `⟦${codePoint(c)}⟧`;
}

/** 把看不见或会改变显示的字符换成看得见的符号 */
export const displayName = (name: string) => name.replace(ODD, visibleSymbol);

/** 名字里有没有需要提醒的字符 */
export const isOddName = (name: string) => name.search(ODD) !== -1;

/** 去掉这些字符。重命名时用它作为默认值，这样直接确认就能得到一个干净的名字 */
export const cleanName = (name: string) => name.replace(ODD, "");

export const hasControlChars = (text: string) => CONTROL.test(text);
