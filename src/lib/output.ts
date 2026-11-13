/** 保存终端输出：把缓冲区整理成文本，并给出建议的文件名 */

interface BufferLine {
  isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

interface Buffer {
  length: number;
  getLine(y: number): BufferLine | undefined;
}

/**
 * 终端里看到的文字，每行一个换行。窗口太窄折行显示的，还原成原来的一行。
 * 存的是排好版的结果，不含颜色和控制字符；vim、top 这类全屏程序画在另一块缓冲区里，不会混进来
 */
export function bufferText(buffer: Buffer): string {
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    // 下一行是接着这一行折过去的：行尾的空格是内容的一部分，不能去掉
    const continued = buffer.getLine(y + 1)?.isWrapped ?? false;
    const text = line.translateToString(!continued);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length > 0 ? `${lines.join("\r\n")}\r\n` : "";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 建议的文件名：会话名_日期_时间.txt。会话名里 Windows 不允许的字符由后端换掉 */
export function outputFileName(title: string, now: Date): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${title}_${date}_${time}.txt`;
}
