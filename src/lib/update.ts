// 安装更新时程序会退出。这里算出会被打断的事情，安装前告诉用户。
// 文字由调用者传进来，这个文件不依赖界面的其他部分，单元测试可以直接加载。

import type { Messages } from "../i18n/en";

export function whatUpdateInterrupts(
  state: {
    tabs: { status: string }[];
    transfers: { status: string }[];
    edits: { status: string }[];
  },
  m: Messages,
): string[] {
  const sessions = state.tabs.filter((t) => t.status === "connected" || t.status === "connecting").length;
  const transfers = state.transfers.filter((t) => t.status === "running" || t.status === "queued").length;
  const unsynced = state.edits.filter((e) => e.status !== "synced").length;

  const lines: string[] = [];
  if (sessions > 0) lines.push(m.update.sessions(sessions));
  if (transfers > 0) lines.push(m.update.transfers(transfers));
  if (state.edits.length > 0) lines.push(m.update.edits(state.edits.length, unsynced));
  return lines;
}
