import { CSSProperties, Fragment, ReactNode } from "react";

/**
 * 译文里可以用 `<b>…</b>` 标出加粗的部分，各语言能把它放在句子里合适的位置。
 * 只认这一种标记，而且只是拆成 React 元素，不会当成 HTML 解析：参数里有主机名之类的内容也不会变成标签。
 */
export function Rich({ text, boldStyle }: { text: string; boldStyle?: CSSProperties }): ReactNode {
  const parts = text.split(/<b>(.*?)<\/b>/s);
  return parts.map((part, i) => (i % 2 === 1 ? <b key={i} style={boldStyle}>{part}</b> : <Fragment key={i}>{part}</Fragment>));
}
