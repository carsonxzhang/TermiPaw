// 终端：大量输出时的流控。

import { sleep } from "./harness.mjs";

/** 终端缓冲区最后若干行里是否出现了这段文字 */
const tailHas = (text) => `(() => {
  const buf = window.__termipawTest.terms[0].buffer.active;
  for (let i = buf.length - 1; i >= Math.max(0, buf.length - 40); i--) {
    if (buf.getLine(i)?.translateToString(true).includes(${JSON.stringify(text)})) return true;
  }
  return false;
})()`;

/** 让服务器输出 `mb` MB 文本，返回结果 */
export async function flood(app, server, mb) {
  await app.js(`window.__termipawTest = { terms: [], flows: [] }`);
  app.exceptions.length = 0;
  await app.palette(`demo@127.0.0.1:${server.port}`);
  await app.authenticate();
  await app.waitFor(`window.__termipawTest.terms.length === 1`);
  await sleep(500);

  const started = Date.now();
  await app.type(`flood ${mb}`);
  await app.key("Enter", "Enter", 13);
  const finished = await app.waitFor(tailHas("FLOOD-DONE"), 180000);
  const seconds = (Date.now() - started) / 1000;
  const peak = await app.js(`window.__termipawTest.flows[0].peak`);
  const lines = await app.js(`(() => {
    const buf = window.__termipawTest.terms[0].buffer.active;
    for (let i = buf.length - 1; i >= 0; i--) {
      const m = /FLOOD-DONE (\\d+)/.exec(buf.getLine(i)?.translateToString(true) ?? "");
      if (m) return Number(m[1]);
    }
    return -1;
  })()`);
  // 标记前一行必须是最后一行的编号：说明末尾的数据一行没丢
  const lastLineOk = await app.js(`(() => {
    const buf = window.__termipawTest.terms[0].buffer.active;
    for (let i = buf.length - 1; i > 0; i--) {
      if (buf.getLine(i)?.translateToString(true).includes("FLOOD-DONE")) {
        // 窗口窄时一行会折成几行，退回到这一行的开头
        let start = i - 1;
        while (start > 0 && buf.getLine(start)?.isWrapped) start--;
        return buf.getLine(start)?.translateToString(true).startsWith(String(${lines} - 1).padStart(8, "0"));
      }
    }
    return false;
  })()`);
  const exceptions = [...app.exceptions];
  await app.key("w", "KeyW", 87, 2);
  return { finished, seconds, peak, lines, lastLineOk, exceptions };
}

export async function terminalSuite(app, server, { check }) {
  const MB = 150;
  const result = await flood(app, server, MB);
  console.log(
    `INFO  积压峰值 ${(result.peak / 2 ** 20).toFixed(1)} MiB，用时 ${result.seconds.toFixed(1)} 秒，` +
      `${result.finished ? "收完" : "没收完"}，页面异常 ${result.exceptions.length} 个`,
  );
  check(`流控：${MB} MB 输出全部收完`, result.finished);
  check("流控：末尾的数据一行没丢", result.lastLineOk && result.lines > 1_000_000, `lines=${result.lines}`);
  // 上限由后端保证：1 MiB 窗口加上最后一批
  check("流控：积压不超过 2 MiB", result.peak < 2 * 2 ** 20, `${(result.peak / 2 ** 20).toFixed(2)} MiB`);
  check("流控：页面没有未捕获的异常", result.exceptions.length === 0, result.exceptions[0]);
}
