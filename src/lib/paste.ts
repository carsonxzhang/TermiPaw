import { msg } from "../i18n";

/** 内容里有换行时，粘贴进终端会把每一行当作命令立即执行，所以需要先让用户确认 */
export const needsPasteConfirm = (text: string) => /[\r\n]/.test(text);

/**
 * 确认框里显示的预览。控制字符（比如藏在文本里的 ESC 转义序列）会变成看得见的符号，
 * 否则用户看到的和实际发给终端的不一样。
 */
export function pastePreview(text: string, maxLines = 8): string {
  const visible = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (c) => String.fromCharCode(c === "\u007f" ? 0x2421 : 0x2400 + c.charCodeAt(0)));
  const lines = visible.split("\n");
  const shown = lines.slice(0, maxLines).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
  if (lines.length > maxLines) shown.push(msg().terminal.pasteMore(lines.length - maxLines));
  return shown.join("\n");
}

export function pasteSummary(text: string): string {
  const breaks = text.split(/\r\n|\r|\n/).length - 1;
  const chars = [...text].length;
  return msg().terminal.pasteSummary(breaks + 1, chars);
}
