import type { Terminal } from "@xterm/xterm";

/**
 * 端到端测试用。测试脚本在页面里设置 `window.__termipawTest` 之后，程序会把终端实例和流控登记进去，
 * 让脚本能读取终端内容。正常运行时这个全局变量不存在，什么都不会发生。
 */
export interface TestHook {
  terms: Terminal[];
  flows: { peak: number }[];
  /** 测试脚本可以预先放一个数组，用来拿到会话号 */
  sessions?: string[];
  edits?: string[];
}

export const testHook = () => (window as unknown as { __termipawTest?: TestHook }).__termipawTest;
