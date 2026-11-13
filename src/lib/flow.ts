/**
 * 终端输出的流控：界面这一侧。
 *
 * 后端统计“已发出、界面还没处理完”的字节，到上限就不再读取（见 ssh.rs 的 `run_shell`）。
 * 这里在 xterm 真正处理完一批数据后告诉后端。不能由界面判断积压后再喊停：界面线程忙的时候，
 * 喊停的命令到得太晚，后端已经把几十 MB 塞进了队列。
 */
export function createFlowControl(write: (data: Uint8Array, done: () => void) => void, ack: (bytes: number) => void) {
  let pending = 0;
  let peak = 0;
  return {
    push(data: Uint8Array) {
      pending += data.length;
      peak = Math.max(peak, pending);
      write(data, () => {
        pending -= data.length;
        ack(data.length);
      });
    },
    /** 历史上积压的最大字节数，测试用 */
    get peak() {
      return peak;
    },
  };
}
