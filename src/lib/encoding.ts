/**
 * 终端的编码转换，给还在用 GBK、Big5 这类旧编码的服务器用。
 *
 * 解码用 WebView 自带的 TextDecoder。浏览器不提供旧编码的编码器，所以编码表是把每个单字节和双字节
 * （GB18030 还有四字节）序列解码一遍反过来得到的。只有输入了非 ASCII 字符才需要，第一次用到时才生成。
 * 这样不用打包任何编码表，程序不会变大。
 */

/** 支持的编码，用 WHATWG 的名字。顺序就是菜单里的顺序 */
export const ENCODINGS = ["utf-8", "gb18030", "big5", "shift_jis", "euc-jp", "euc-kr", "windows-1252"] as const;
export type Encoding = (typeof ENCODINGS)[number];

export const DEFAULT_ENCODING: Encoding = "utf-8";

export function isEncoding(value: unknown): value is Encoding {
  return typeof value === "string" && (ENCODINGS as readonly string[]).includes(value);
}

/** 显示用的名字，各语言都一样 */
export const ENCODING_LABELS: Record<Encoding, string> = {
  "utf-8": "UTF-8",
  gb18030: "GB18030 / GBK",
  big5: "Big5",
  shift_jis: "Shift_JIS",
  "euc-jp": "EUC-JP",
  "euc-kr": "EUC-KR",
  "windows-1252": "Windows-1252",
};

/** 流式解码：多字节字符被拆在两次输出里也能正确拼起来 */
export function createDecoder(encoding: Encoding): (bytes: Uint8Array) => string {
  const decoder = new TextDecoder(encoding);
  return (bytes) => decoder.decode(bytes, { stream: true });
}

type Table = Map<number, number[]>;
const tables = new Map<Encoding, Table>();

/** 同一个字符有几种写法时，WHATWG 规定 Big5 这几个用最后一个 */
const BIG5_LAST = new Set([0x2550, 0x255e, 0x2561, 0x256a, 0x5341, 0x5345]);

function buildTable(encoding: Encoding): Table {
  const decoder = new TextDecoder(encoding);
  const table: Table = new Map();
  const add = (bytes: number[], last = false) => {
    // 不是合法序列时解出来是替换字符，或者不止一个字符
    const text = decoder.decode(new Uint8Array(bytes));
    const cp = text.codePointAt(0)!;
    if (text.length !== (cp > 0xffff ? 2 : 1) || cp < 0x80 || cp === 0xfffd) return;
    if (!table.has(cp) || (last && BIG5_LAST.has(cp))) table.set(cp, bytes);
  };
  const pairs = (leads: number[]) => {
    for (const lead of leads) for (let trail = 0x30; trail <= 0xfe; trail++) add([lead, trail], encoding === "big5");
  };
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  switch (encoding) {
    case "windows-1252":
      range(0x80, 0xff).forEach((b) => add([b]));
      break;
    case "shift_jis":
      // 半角片假名是单字节的。NEC 选定的 IBM 扩展（0xED、0xEE 开头）和 IBM 扩展重复，按规定用后者
      range(0xa1, 0xdf).forEach((b) => add([b]));
      pairs([...range(0x81, 0x9f), ...range(0xe0, 0xec), ...range(0xef, 0xfc), 0xed, 0xee]);
      break;
    case "euc-jp":
      range(0xa1, 0xdf).forEach((b) => add([0x8e, b]));
      pairs(range(0xa1, 0xfe));
      break;
    case "big5":
      // 香港增补字符（0xA1 之前开头的）和标准 Big5 重复时，用标准的
      pairs([...range(0xa1, 0xfe), ...range(0x81, 0xa0)]);
      break;
    case "gb18030":
      pairs(range(0x81, 0xfe));
      // 双字节里没有的基本平面字符用四字节表示
      for (let a = 0x81; a <= 0x84; a++)
        for (let b = 0x30; b <= 0x39; b++)
          for (let c = 0x81; c <= 0xfe; c++) for (let d = 0x30; d <= 0x39; d++) add([a, b, c, d]);
      break;
    default:
      pairs(range(0x81, 0xfe));
  }
  return table;
}

/** GB18030 的四字节序列按顺序对应 U+10000 以后的字符，直接算 */
function gb18030Supplementary(cp: number): number[] {
  let n = cp - 0x10000 + 189000;
  const d = n % 10;
  n = (n - d) / 10;
  const c = n % 126;
  n = (n - c) / 126;
  const b = n % 10;
  const a = (n - b) / 10;
  return [a + 0x81, b + 0x30, c + 0x81, d + 0x30];
}

/** 服务器的编码里没有的字符，用问号代替 */
const MISSING = 0x3f;

/** 把输入转换成服务器的编码 */
export function encodeText(text: string, encoding: Encoding): Uint8Array {
  if (encoding === "utf-8") return new TextEncoder().encode(text);
  const out: number[] = [];
  let table: Table | undefined;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      out.push(cp);
      continue;
    }
    if (encoding === "gb18030" && cp > 0xffff) {
      out.push(...gb18030Supplementary(cp));
      continue;
    }
    if (!table) {
      table = tables.get(encoding);
      if (!table) tables.set(encoding, (table = buildTable(encoding)));
    }
    const bytes = table.get(cp);
    if (bytes) out.push(...bytes);
    else out.push(MISSING);
  }
  return new Uint8Array(out);
}
