// 针对真实 OpenSSH 服务器的验证：npm run test:openssh
//
// 需要一台可以随便折腾的 Linux 测试机（账号要有 sudo），通过环境变量告诉脚本：
//   TERMIPAW_TEST_HOST、TERMIPAW_TEST_USER、TERMIPAW_TEST_PASSWORD
//
// 服务器上只动这些，结束时全部清理：
//   /run/termipaw-test（配置、主机密钥、日志）、端口 2200~2203 上另起的 sshd、~/termipaw-test
// 系统自带的 sshd 和 ~/.ssh 不碰。需要先构建调试版程序（tauri build --debug --no-bundle）。

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checks, editorExe, launchApp, postWindowMessage, removeDir, sleep, startTestAgent, tempDir } from "./harness.mjs";

const HOST = process.env.TERMIPAW_TEST_HOST;
const USER = process.env.TERMIPAW_TEST_USER;
const PASSWORD = process.env.TERMIPAW_TEST_PASSWORD;
if (!HOST || !USER || !PASSWORD) {
  console.error("请设置 TERMIPAW_TEST_HOST、TERMIPAW_TEST_USER、TERMIPAW_TEST_PASSWORD");
  process.exit(2);
}

const checks = new Checks();
const check = checks.check.bind(checks);
const work = tempDir();
const BIG_SIZE = 512 * 2 ** 20;
const RUN = "/run/termipaw-test";

// ---------- 在服务器上执行命令 ----------

const askpass = join(work, "askpass.bat");
writeFileSync(askpass, "@echo off\r\necho %TERMIPAW_TEST_PASSWORD%\r\n");
const sshEnv = { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "none" };
const sshArgs = [
  "-o", `UserKnownHostsFile=${join(work, "known_hosts")}`,
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "PubkeyAuthentication=no",
  "-o", "PreferredAuthentications=password",
  "-o", "LogLevel=ERROR",
  `${USER}@${HOST}`,
  "bash -s",
];

/** 脚本走标准输入，密码不会出现在服务器的命令行里。脚本里可以用 `S 命令` 以 root 身份执行 */
const remote = (script) =>
  new Promise((resolve, reject) => {
    const child = execFile("ssh", sshArgs, { env: sshEnv, maxBuffer: 16 * 2 ** 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`远程命令失败：${stderr || err.message}\n${script}`)) : resolve(stdout.trim()),
    );
    const quoted = `'${PASSWORD.replace(/'/g, `'\\''`)}'`;
    child.stdin.end(`TP_PW=${quoted}\nS() { printf '%s\\n' "$TP_PW" | sudo -S -p '' "$@"; }\nT=$HOME/termipaw-test\ncd "$HOME"\n${script}\n`);
  });

const INSTANCES = {
  // 普通配置，日志里能看到协商结果
  2200: `HostKey ${RUN}/host_ed25519`,
  // 只提供 SHA-1 的 ssh-rsa 主机密钥
  2201: `HostKey ${RUN}/host_rsa\nHostKeyAlgorithms ssh-rsa`,
  // 只接受用 SHA-1 签名的 RSA 用户私钥
  2202: `HostKey ${RUN}/host_ed25519\nPubkeyAcceptedAlgorithms ssh-rsa`,
  // 用来换主机密钥
  2203: `HostKey ${RUN}/host_a`,
};

const unit = (port) => `termipaw-sshd-${port}`;

async function setupServer(authorizedKeys) {
  const configs = Object.entries(INSTANCES)
    .map(
      ([port, extra]) => `sudo tee ${RUN}/${port}.conf >/dev/null <<'EOF'
Port ${port}
${extra}
PidFile ${RUN}/${port}.pid
AuthorizedKeysFile ${RUN}/authorized_keys
PasswordAuthentication yes
KbdInteractiveAuthentication no
UsePAM yes
StrictModes no
Subsystem sftp /usr/lib/openssh/sftp-server
LogLevel DEBUG3
EOF
S /usr/sbin/sshd -t -f ${RUN}/${port}.conf
S systemd-run --quiet --unit=${unit(port)} /usr/sbin/sshd -D -f ${RUN}/${port}.conf -E ${RUN}/${port}.log`,
    )
    .join("\n");
  return remote(`set -e
# 下面的 sudo tee 要从标准输入读内容，不能走 S（S 的标准输入是密码），所以先缓存 sudo 凭据
S -v
S install -d -m 755 ${RUN}
for name in ed25519:host_ed25519 rsa:host_rsa ed25519:host_a ed25519:host_b; do
  S ssh-keygen -q -t "\${name%%:*}" -N '' -f ${RUN}/"\${name##*:}"
done
sudo tee ${RUN}/authorized_keys >/dev/null <<'EOF'
${authorizedKeys}
EOF
S chmod 644 ${RUN}/authorized_keys
${configs}
mkdir -p "$T"
sleep 1
for p in ${Object.keys(INSTANCES).join(" ")}; do systemctl is-active ${unit(2200).replace("2200", "$p")}; done
sshd -V 2>&1 | head -1 || true`);
}

async function cleanupServer() {
  await remote(`S systemctl stop 'termipaw-sshd-*' 2>/dev/null
S systemctl reset-failed 'termipaw-sshd-*' 2>/dev/null
S rm -rf ${RUN}
chmod -R u+rwx "$T" 2>/dev/null
rm -rf "$T" /tmp/termipaw-vim.txt /tmp/.termipaw-vim.txt.sw?`);
}

/** 这个端口的 sshd 日志里匹配的行 */
const sshdLog = (port, pattern) => remote(`S grep -E ${JSON.stringify(pattern)} ${RUN}/${port}.log | tail -40 || true`);

// ---------- 本地文件和密钥 ----------

const run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim()))));

const keyDir = join(work, "keys");
const localDir = join(work, "local");
mkdirSync(keyDir);
mkdirSync(localDir);
const key = (name) => join(keyDir, name);

async function makeKeys() {
  const make = (name, ...args) => run("ssh-keygen", ["-q", ...args, "-f", key(name)]);
  await make("ed25519", "-t", "ed25519", "-N", "");
  await make("ed25519_locked", "-t", "ed25519", "-N", "open sesame");
  await make("ecdsa", "-t", "ecdsa", "-N", "");
  await make("rsa", "-t", "rsa", "-b", "3072", "-N", "");
  await make("rsa_pem", "-t", "rsa", "-b", "3072", "-m", "PEM", "-N", "");
  await make("not_authorized", "-t", "ed25519", "-N", "");
  return ["ed25519", "ed25519_locked", "ecdsa", "rsa", "rsa_pem"].map((n) => readFileSync(`${key(n)}.pub`, "utf8").trim()).join("\n");
}

const sha256 = (path) =>
  new Promise((resolve) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex")));
  });

async function makeBigFile(path, size) {
  const out = createWriteStream(path);
  const chunk = 16 * 2 ** 20;
  for (let written = 0; written < size; written += chunk) {
    if (!out.write(randomBytes(chunk))) await new Promise((r) => out.once("drain", r));
  }
  await new Promise((r) => out.end(r));
}

// ---------- 驱动界面 ----------

const host = (name, port, extra = {}) => ({ id: name, name, group: "", host: HOST, port, username: USER, auth: "password", saveSecret: false, ...extra });
const keyHost = (name, port, file, extra = {}) => host(name, port, { auth: "key", keyPath: key(file), ...extra });

async function withApp(hosts, seed, fn, env) {
  const dir = tempDir();
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "hosts.json"), JSON.stringify(hosts));
  seed?.(data);
  const app = await launchApp(dir, env);
  await app.js(`window.__termipawTest = { terms: [], flows: [] }`);
  if (hosts.length) await app.waitFor(`!!document.querySelector(".host-item")`);
  try {
    return await fn(app);
  } finally {
    await app.stop();
    removeDir(dir);
  }
}

async function scenario(name, fn) {
  // TERMIPAW_TEST_ONLY：只跑名称里包含这段文字的场景
  if (process.env.TERMIPAW_TEST_ONLY && !name.includes(process.env.TERMIPAW_TEST_ONLY)) return;
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
  } catch (e) {
    check(`${name}：场景中断`, false, e.stack ?? String(e));
  }
}

const open = async (app, name) => {
  await app.click(".host-item", name, { count: 2 });
  await sleep(300);
};
const anyDialog = (app, text) => app.waitFor(`[...document.querySelectorAll(".modal")].some((m) => m.textContent.includes(${JSON.stringify(text)}))`, 15000);
const connected = (app) => app.waitFor(`!!document.querySelector(".dot.connected") && !document.querySelector(".overlay")`, 20000);
const overlayHas = (app, text) => app.waitFor(`document.querySelector(".overlay")?.textContent.includes(${JSON.stringify(text)})`, 20000);
const overlayText = (app) => app.js(`document.querySelector(".overlay")?.textContent ?? ""`);
const closeSession = async (app) => {
  await app.key("w", "KeyW", 87, 2);
  await sleep(300);
};
/** 接受“首次连接”的指纹确认 */
const acceptHostKey = async (app) => {
  if (await anyDialog(app, "验证主机指纹")) await app.click(".modal .btn.primary");
};

const termTail = `(() => {
  const terms = window.__termipawTest.terms;
  const buf = terms[terms.length - 1].buffer.active;
  const out = [];
  // 窗口窄时长行会折行，拼回一行再匹配
  for (let i = Math.max(0, buf.length - 200); i < buf.length; i++) {
    const line = buf.getLine(i);
    const text = line?.translateToString(true) ?? "";
    if (line?.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  return out.join("\\n");
})()`;
const termHas = (app, text, ms = 15000) => app.waitFor(`${termTail}.includes(${JSON.stringify(text)})`, ms);
const termReady = (app) => app.waitFor(`/\\$ $/.test(${termTail}.trimEnd() + " ")`, 15000);
const send = async (app, line) => {
  await app.type(line);
  await app.key("Enter", "Enter", 13);
};

const goTo = async (app, path) => {
  await app.click(".pathbar input");
  await app.js(`document.querySelector(".pathbar input").select()`);
  await app.type(path);
  await app.key("Enter", "Enter", 13);
  await sleep(500);
};
const refresh = async (app) => {
  await app.click(".sftp-toolbar [title='刷新']");
  await sleep(400);
};
const rowExists = (app, name) => app.js(`[...document.querySelectorAll(".file-row .fname")].some((e) => e.textContent === ${JSON.stringify(name)})`);
const clearTransfers = (app) => app.js(`document.querySelectorAll(".transfer.done .icon-btn, .transfer.failed .icon-btn, .transfer.cancelled .icon-btn").forEach((b) => b.click())`);
const transferIs = (app, name, status, ms = 60000) => app.waitFor(`[...document.querySelectorAll(".transfer.${status} .tname")].some((e) => e.textContent === ${JSON.stringify(name)})`, ms);
const upload = async (app, ...paths) => {
  await app.click('.sftp-toolbar [title^="上传"]');
  await app.answerFileDialog(paths);
};
const rowAction = async (app, name, action) => {
  await app.js(`[...document.querySelectorAll(".file-row")].find((r) => r.querySelector(".fname")?.textContent === ${JSON.stringify(name)})?.scrollIntoView({ block: "nearest" })`);
  const p = await app.js(`(() => { const r = [...document.querySelectorAll(".file-row")].find((r) => r.querySelector(".fname")?.textContent === ${JSON.stringify(name)}).getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
  await app.mouse("mouseMoved", p);
  await app.mouse("mousePressed", p, { button: "right" });
  await app.mouse("mouseReleased", p, { button: "right" });
  await sleep(200);
  await app.click(".ctx-menu button", action);
};
const pasteEvent = (app, text) =>
  app.js(`(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", ${JSON.stringify(text)});
    document.querySelector(".term-wrap:not([style*='none']) .xterm-helper-textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);

// ---------- 场景 ----------

async function loginScenarios() {
  await scenario("密码登录（系统 sshd，端口 22）", () =>
    withApp([host("pw", 22)], null, async (app) => {
      await open(app, "pw");
      await acceptHostKey(app);
      await anyDialog(app, "输入密码");
      await app.type("wrong-password");
      await app.key("Enter", "Enter", 13);
      check("输错密码：提示错误并可以重试", await anyDialog(app, "用户名或密码错误"));
      await app.js(`document.querySelector(".modal input[type=password]").select()`);
      await app.type(PASSWORD);
      await app.key("Enter", "Enter", 13);
      check("正确密码：连接成功", await connected(app));
      check("终端显示真实的 Shell 提示符", await termReady(app));
      const stored = JSON.parse(readFileSync(join(app.dataDir, "hosts.json"), "utf8"))[0];
      check("没有勾选保存时，密码没有保存", stored.saveSecret === false);
    }),
  );

  const logins = [
    ["ed25519", "Ed25519 私钥", null],
    ["ecdsa", "ECDSA 私钥", null],
    ["rsa", "RSA 私钥（OpenSSH 格式）", null],
    ["rsa_pem", "RSA 私钥（PEM 格式）", null],
    ["ed25519_locked", "加密的 Ed25519 私钥", "open sesame"],
  ];
  await scenario("私钥登录（端口 2200）", () =>
    withApp(logins.map(([file]) => keyHost(file, 2200, file)).concat(keyHost("not_authorized", 2200, "not_authorized")), null, async (app) => {
      let firstHost = true;
      for (const [file, label, passphrase] of logins) {
        await open(app, file);
        if (firstHost) await acceptHostKey(app);
        firstHost = false;
        if (passphrase) {
          check(`${label}：要求输入口令`, await anyDialog(app, "私钥口令"));
          await app.type("wrong");
          await app.key("Enter", "Enter", 13);
          check(`${label}：口令错误时提示`, await anyDialog(app, "口令错误"));
          await app.js(`document.querySelector(".modal input[type=password]").select()`);
          await app.type(passphrase);
          await app.key("Enter", "Enter", 13);
        }
        const ok = await connected(app);
        check(`${label}：登录成功`, ok, ok ? "" : await overlayText(app));
        await closeSession(app);
      }
      await open(app, "not_authorized");
      check("未授权的私钥：被拒绝", await overlayHas(app, "服务器拒绝了该私钥"), await overlayText(app));
      await closeSession(app);

      const accepted = await sshdLog(2200, "Accepted publickey");
      const rsaLines = accepted.split("\n").filter((l) => /RSA/.test(l));
      check("服务器日志：RSA 私钥登录成功", rsaLines.length >= 2, `${rsaLines.length} 条`);
      const sha2 = await sshdLog(2200, "userauth_pubkey: .*(rsa-sha2|ssh-rsa)");
      check("服务器日志：RSA 用 SHA-2 签名，没有用 SHA-1", /rsa-sha2-(256|512)/.test(sha2) && !/pkalg ssh-rsa/.test(sha2), sha2.split("\n").slice(-2).join(" | "));
    }),
  );

  await scenario("协商的算法与 strict KEX（服务器日志）", async () => {
    const strict = await sshdLog(2200, "strict KEX");
    check("strict KEX 已生效（防 Terrapin）", /strict KEX/.test(strict), strict.split("\n").slice(-1)[0]);
    const kex = await sshdLog(2200, "kex: (algorithm|host key algorithm|client->server cipher|server->client cipher)");
    const last = kex.split("\n").slice(-4).map((l) => l.replace(/^.*debug\d: /, "")).join(" | ");
    console.log(`INFO  协商结果：${last}`);
    check("没有协商到 SHA-1 或旧算法", !/ssh-rsa |sha1|cbc|3des|diffie-hellman-group1/.test(last), last);
  });
}

async function legacyScenarios() {
  await scenario("只提供 SHA-1 ssh-rsa 主机密钥的服务器（端口 2201）", () =>
    withApp([host("legacy", 2201)], null, async (app) => {
      await open(app, "legacy");
      check("拒绝连接并说明不支持", await overlayHas(app, "TermiPaw 不支持"), await overlayText(app));
      check("不会询问指纹或密码", !(await app.js(`!!document.querySelector(".modal")`)));
    }),
  );

  await scenario("只接受 SHA-1 签名 RSA 私钥的服务器（端口 2202）", () =>
    withApp([keyHost("rsa", 2202, "rsa")], null, async (app) => {
      await open(app, "rsa");
      await acceptHostKey(app);
      check("拒绝用 SHA-1 签名并说明不支持", await overlayHas(app, "TermiPaw 不支持"), await overlayText(app));
    }),
  );
}

async function hostKeyScenarios() {
  // 条目在服务器上生成（本机的 ssh-keyscan 可能太旧，不认识服务器的算法）。哈希格式由 OpenSSH 自己的 ssh-keygen -H 生成
  const plain = `[${HOST}]:2200 ${(await remote(`S cat ${RUN}/host_ed25519.pub`)).split(" ").slice(0, 2).join(" ")}`;
  const hashed = await remote(`f=$(mktemp)
cat > "$f" <<'EOF'
${plain}
EOF
ssh-keygen -q -H -f "$f" >/dev/null 2>&1
head -1 "$f"
rm -f "$f" "$f.old"`);
  const seedKnown = (content) => (data) => writeFileSync(join(data, "openssh_known_hosts"), `${content}\n`);

  for (const [label, content] of [
    ["明文", plain],
    ["哈希", hashed],
  ]) {
    await scenario(`复用 OpenSSH 的 known_hosts（${label}格式）`, () =>
      withApp([keyHost("known", 2200, "ed25519")], seedKnown(content), async (app) => {
        await open(app, "known");
        const ok = await connected(app);
        check(`${label}格式：不询问指纹，直接连接`, ok, ok ? "" : await overlayText(app));
      }),
    );
  }

  await scenario("服务器真的换了主机密钥（端口 2203）", () =>
    withApp([keyHost("rotate", 2203, "ed25519")], null, async (app) => {
      await open(app, "rotate");
      await acceptHostKey(app);
      check("第一次：确认后连接", await connected(app));
      await closeSession(app);

      await remote(`S systemctl stop ${unit(2203)}
S sed -i 's#host_a#host_b#' ${RUN}/2203.conf
S systemd-run --quiet --unit=${unit(2203)}-b /usr/sbin/sshd -D -f ${RUN}/2203.conf -E ${RUN}/2203.log
sleep 1`);
      await open(app, "rotate");
      check("换密钥后：显示指纹已变化的警告", await anyDialog(app, "主机指纹已变化"));
      check("换密钥后：不输入地址不能继续", await app.js(`document.querySelector(".modal .btn.danger").disabled`));
      await app.type(HOST);
      await sleep(100);
      await app.click(".modal .btn.danger");
      check("输入地址确认后：连接成功", await connected(app));
      await remote(`S systemctl stop ${unit(2203)}-b; S systemctl reset-failed ${unit(2203)}-b 2>/dev/null; true`);
    }),
  );
}

const agentHost = (name, port, extra = {}) => host(name, port, { auth: "agent", ...extra });

async function agentScenarios() {
  /** 用只装了这些私钥的测试 Agent 打开主机 */
  const withAgent = (keys, fn) =>
    scenario(`SSH Agent：${keys.length ? keys.join("、") : "没有私钥"}`, async () => {
      const agent = await startTestAgent(...keys.map(key));
      try {
        await withApp([agentHost("agent", 2200)], null, fn, { TERMIPAW_AGENT_PIPE: agent.pipe });
      } finally {
        agent.stop();
      }
    });

  await scenario("SSH Agent：没有运行", () =>
    withApp(
      [agentHost("agent", 2200)],
      null,
      async (app) => {
        await open(app, "agent");
        await acceptHostKey(app);
        check("提示没有找到 Agent", await overlayHas(app, "没有找到正在运行的 SSH Agent"), await overlayText(app));
        check("不会询问密码", !(await app.js(`[...document.querySelectorAll(".modal")].some((m) => m.textContent.includes("输入密码"))`)));
      },
      { TERMIPAW_AGENT_PIPE: "\\\\.\\pipe\\termipaw-test-no-such-agent" },
    ),
  );

  await withAgent([], async (app) => {
    await open(app, "agent");
    await acceptHostKey(app);
    check("提示 Agent 里没有私钥", await overlayHas(app, "没有私钥"), await overlayText(app));
  });

  await withAgent(["not_authorized"], async (app) => {
    await open(app, "agent");
    await acceptHostKey(app);
    check("未授权的私钥：被拒绝且说明数量", await overlayHas(app, "共 1 把"), await overlayText(app));
  });

  for (const name of ["ed25519", "ecdsa", "rsa"]) {
    await withAgent([name], async (app) => {
      await open(app, "agent");
      await acceptHostKey(app);
      const ok = await connected(app);
      check(`${name}：经 Agent 登录`, ok, ok ? "" : await overlayText(app));
      check(`${name}：终端可用`, ok && (await app.waitFor(`document.querySelector(".statusbar")?.textContent.includes("SSH Agent")`, 5000)));
    });
  }

  await scenario("RSA 经 Agent 用 SHA-2 签名（服务器日志）", async () => {
    const log = await sshdLog(2200, "Accepted publickey .* RSA");
    check("服务器接受了 Agent 的 RSA 签名", log.includes("Accepted publickey"), log.split("\n").pop());
    const algo = await sshdLog(2200, "userauth_pubkey: .*rsa-sha2");
    check("签名算法是 SHA-2", algo.includes("rsa-sha2"), algo.split("\n").pop());
  });

  await withAgent(["not_authorized", "ed25519"], async (app) => {
    await open(app, "agent");
    await acceptHostKey(app);
    check("第一把被拒绝时继续试下一把", await connected(app), await overlayText(app));
  });

  await scenario("SSH Agent：只接受 SHA-1 的服务器（端口 2202）", async () => {
    const agent = await startTestAgent(key("rsa"));
    try {
      await withApp(
        [agentHost("sha1", 2202)],
        null,
        async (app) => {
          await open(app, "sha1");
          await acceptHostKey(app);
          check("不用 SHA-1 签名并说明不支持", await overlayHas(app, "TermiPaw 不支持"), await overlayText(app));
        },
        { TERMIPAW_AGENT_PIPE: agent.pipe },
      );
    } finally {
      agent.stop();
    }
  });
}

async function terminalScenarios() {
  await scenario("真实 Shell 里的终端", () =>
    withApp([keyHost("term", 2200, "ed25519")], null, async (app) => {
      await open(app, "term");
      await acceptHostKey(app);
      await connected(app);
      await termReady(app);

      await send(app, "echo MARK_$((6*7))");
      check("执行命令：输出正确", await termHas(app, "MARK_42"));
      await send(app, "printf '\\344\\270\\255\\346\\226\\207-OK\\n'");
      check("UTF-8 中文输出正确", await termHas(app, "中文-OK"));
      await send(app, 'echo TERM=$TERM');
      check("TERM 是 xterm-256color", await termHas(app, "TERM=xterm-256color"));

      const size = () => app.js(`(() => { const t = window.__termipawTest.terms.at(-1); return t.rows + " " + t.cols; })()`);
      await send(app, "stty size");
      check("终端尺寸和服务器一致", await termHas(app, await size()), await size());
      await app.key("b", "KeyB", 66, 2); // Ctrl+B 收起侧栏
      await sleep(600);
      const wider = await size();
      await app.click(".term");
      await send(app, "clear; stty size");
      check("改变窗口后服务器收到新尺寸", await termHas(app, wider), wider);
      await app.key("b", "KeyB", 66, 2);
      await sleep(400);

      // 全屏程序
      await app.click(".term");
      await send(app, "vim -u NONE /tmp/termipaw-vim.txt");
      await sleep(1000);
      check("vim：进入备用屏幕", (await app.js(`window.__termipawTest.terms.at(-1).buffer.active.type`)) === "alternate");
      await app.type("ihello from vim");
      await app.key("Escape", "Escape", 27);
      await app.type(":wq");
      await app.key("Enter", "Enter", 13);
      await sleep(800);
      check("vim：退出后回到普通屏幕", (await app.js(`window.__termipawTest.terms.at(-1).buffer.active.type`)) === "normal");
      check("vim：文件内容正确", (await remote("cat /tmp/termipaw-vim.txt")) === "hello from vim");

      // Ctrl+C
      await send(app, "sleep 300");
      await sleep(500);
      await app.key("c", "KeyC", 67, 2);
      await sleep(300);
      await send(app, "echo AFTER_$((1+1))_CTRLC");
      check("Ctrl+C 能打断前台程序", await termHas(app, "AFTER_2_CTRLC"));

      // Shell 退出
      await send(app, "exit 3");
      check("Shell 退出：显示退出码", await app.waitFor(`document.querySelector(".banner")?.textContent.includes("代码 3")`, 8000), await app.js(`document.querySelector(".banner")?.textContent ?? ""`));
      await app.click(".banner .btn", "重新连接");
      check("重新连接成功", await connected(app));
    }),
  );

  await scenario("真实服务器上的大量输出（150 MB）", () =>
    withApp([keyHost("flood", 2200, "ed25519")], null, async (app) => {
      await open(app, "flood");
      await acceptHostKey(app);
      await connected(app);
      await termReady(app);
      app.exceptions.length = 0;
      const started = Date.now();
      await send(app, "yes abcdefghijklmnopqrstuvwxyz0123456789 | head -c 157286400; echo FLOOD_$((40+2))");
      const done = await termHas(app, "FLOOD_42", 180000);
      const seconds = (Date.now() - started) / 1000;
      const peak = await app.js(`window.__termipawTest.flows.at(-1).peak`);
      console.log(`INFO  150 MB 输出用时 ${seconds.toFixed(1)} 秒（${(150 / seconds).toFixed(0)} MB/s），积压峰值 ${(peak / 2 ** 20).toFixed(1)} MiB`);
      check("全部收完", done);
      check("积压不超过 2 MiB", peak < 2 * 2 ** 20, `${(peak / 2 ** 20).toFixed(2)} MiB`);
      check("页面没有未捕获的异常", app.exceptions.length === 0, app.exceptions[0]);
      await send(app, "echo STILL_$((2+2))_ALIVE");
      check("之后终端仍能正常使用", await termHas(app, "STILL_4_ALIVE"));
    }),
  );

  await scenario("真实服务器上粘贴 8 MB（带回显）", () =>
    withApp([keyHost("paste", 2200, "ed25519")], null, async (app) => {
      await open(app, "paste");
      await acceptHostKey(app);
      await connected(app);
      await termReady(app);
      const line = "0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrs\n";
      const text = `中文开头\n${line.repeat(Math.ceil((8 * 2 ** 20) / line.length))}`;
      const expected = createHash("sha256").update(text).digest("hex");
      const bytes = Buffer.byteLength(text);

      await send(app, "cat > ~/termipaw-test/paste.txt");
      await sleep(500);
      app.exceptions.length = 0;
      const started = Date.now();
      await pasteEvent(app, text);
      check("询问是否粘贴", await anyDialog(app, "粘贴多行内容"));
      await app.click(".modal .btn", "粘贴");

      const end = Date.now() + 240000;
      let size = -1;
      while (Date.now() < end) {
        size = Number(await remote("stat -c %s ~/termipaw-test/paste.txt"));
        if (size >= bytes) break;
        await sleep(2000);
      }
      const seconds = (Date.now() - started) / 1000;
      console.log(`INFO  粘贴 ${(bytes / 2 ** 20).toFixed(1)} MB 用时 ${seconds.toFixed(1)} 秒，服务器收到 ${size} 字节`);
      check("没有卡住：全部送达", size === bytes, `${size} / ${bytes}`);
      await app.click(".term");
      await app.key("d", "KeyD", 68, 2); // Ctrl+D 结束 cat
      await sleep(1000);
      const actual = await remote("sha256sum ~/termipaw-test/paste.txt | cut -d' ' -f1");
      check("内容和粘贴的一致", actual === expected, `${actual.slice(0, 12)} vs ${expected.slice(0, 12)}`);
      await send(app, "echo PASTE_$((3+3))_DONE");
      check("之后终端仍能正常使用", await termHas(app, "PASTE_6_DONE", 60000));
      check("页面没有未捕获的异常", app.exceptions.length === 0, app.exceptions[0]);
    }),
  );
}

async function sftpScenarios() {
  const big = join(localDir, "big.bin");
  await makeBigFile(big, BIG_SIZE);
  const bigHash = await sha256(big);
  const dirPath = await remote("echo $T");

  await scenario("SFTP 基本操作", () =>
    withApp([keyHost("sftp", 2200, "ed25519")], null, async (app) => {
      await remote(`set -e
mkdir -p "$T/sftp/sub"; cd "$T/sftp"
echo keep > keep.txt
printf 'old\\n' > run.sh; chmod 755 run.sh
printf 'real\\n' > target.conf; ln -s target.conf link.conf
ln -s sub linkdir
mkdir locked; echo locked-old > locked/a.txt; chmod 555 locked
echo readonly-old > readonly.txt; chmod 444 readonly.txt
mkdir del; mkdir del/inner; echo x > del/inner/f; ln -s ../keep.txt del/outside-link
mkdir "it's a dir"`);
      writeFileSync(join(localDir, "run.sh"), "new script\n");
      writeFileSync(join(localDir, "link.conf"), "through link\n");
      writeFileSync(join(localDir, "a.txt"), "should not arrive\n");
      writeFileSync(join(localDir, "readonly.txt"), "replaced\n");
      writeFileSync(join(localDir, "文件 名's.txt"), "特殊文件名\n");
      writeFileSync(join(localDir, "dropped.txt"), "dropped\n");

      await open(app, "sftp");
      await acceptHostKey(app);
      await connected(app);
      await termReady(app);
      await app.toggleFiles();
      check("文件面板显示主目录", await app.waitFor(`document.querySelector(".pathbar input")?.value.length > 1 && document.querySelectorAll(".file-row").length > 1`, 10000), await app.js(`document.querySelector(".pathbar input")?.value`));
      const sftpDir = `${dirPath}/sftp`;
      await goTo(app, sftpDir);
      check("跳转目录：列出文件", await rowExists(app, "keep.txt"));

      const entry = (name, q) => app.js(`(() => { const r = [...document.querySelectorAll(".file-row")].find((r) => r.querySelector(".fname")?.textContent === ${JSON.stringify(name)}); return r ? r.querySelector(${JSON.stringify(q)}) !== null : null; })()`);
      check("普通目录显示为目录", await entry("sub", ".ficon.dir"));
      check("指向目录的软链接显示为目录", await entry("linkdir", ".ficon.dir"));
      check("普通文件不显示为目录", !(await entry("keep.txt", ".ficon.dir")));

      // 新建、改名
      await app.click(".sftp-toolbar [title='新建文件夹']");
      await app.type("made-by-ui");
      await app.key("Enter", "Enter", 13);
      await sleep(600);
      check("新建文件夹", (await remote(`test -d "$T/sftp/made-by-ui" && echo yes`)) === "yes");
      await rowAction(app, "made-by-ui", "重命名");
      await sleep(200);
      await app.js(`document.querySelector(".modal input").select()`);
      await app.type("renamed");
      await app.key("Enter", "Enter", 13);
      await sleep(600);
      check("重命名", (await remote(`test -d "$T/sftp/renamed" && test ! -e "$T/sftp/made-by-ui" && echo yes`)) === "yes");

      // 上传：新文件、特殊文件名
      await clearTransfers(app);
      await upload(app, join(localDir, "文件 名's.txt"));
      check("上传中文和引号文件名", await transferIs(app, "文件 名's.txt", "done"));
      check("文件名和内容正确", (await remote(`cat "$T/sftp/文件 名's.txt"`)) === "特殊文件名");

      // 覆盖：真实 OpenSSH 的改名不能覆盖已有文件，要走两步替换
      await clearTransfers(app);
      await upload(app, join(localDir, "run.sh"));
      check("同名文件先询问", await anyDialog(app, "文件已存在"));
      await app.click(".modal .btn", "覆盖");
      check("覆盖上传成功", await transferIs(app, "run.sh", "done"));
      check("内容已替换", (await remote(`cat "$T/sftp/run.sh"`)) === "new script");
      check("保留了可执行权限", (await remote(`stat -c %a "$T/sftp/run.sh"`)) === "755", await remote(`stat -c %a "$T/sftp/run.sh"`));

      // 覆盖软链接：写入它指向的文件
      await clearTransfers(app);
      await upload(app, join(localDir, "link.conf"));
      await anyDialog(app, "文件已存在");
      await app.click(".modal .btn", "覆盖");
      check("覆盖软链接：上传成功", await transferIs(app, "link.conf", "done"));
      check("覆盖软链接：链接还在", (await remote(`readlink "$T/sftp/link.conf"`)) === "target.conf");
      check("覆盖软链接：写入了目标文件", (await remote(`cat "$T/sftp/target.conf"`)) === "through link");

      // 权限不足：目录不可写
      await goTo(app, `${sftpDir}/locked`);
      await clearTransfers(app);
      await upload(app, join(localDir, "a.txt"));
      await anyDialog(app, "文件已存在");
      await app.click(".modal .btn", "覆盖");
      check("目录不可写：上传失败", await transferIs(app, "a.txt", "failed", 15000), await app.js(`document.querySelector(".transfer.failed .tstat")?.textContent ?? ""`));
      check("目录不可写：原文件不变", (await remote(`cat "$T/sftp/locked/a.txt"`)) === "locked-old");
      await goTo(app, sftpDir);

      // 只读文件、目录可写：用户确认覆盖后可以替换，权限沿用
      await clearTransfers(app);
      await upload(app, join(localDir, "readonly.txt"));
      await anyDialog(app, "文件已存在");
      await app.click(".modal .btn", "覆盖");
      await transferIs(app, "readonly.txt", "done", 15000);
      const ro = await remote(`cat "$T/sftp/readonly.txt"; stat -c %a "$T/sftp/readonly.txt"`);
      console.log(`INFO  只读文件确认覆盖后：${ro.replace("\n", " / 权限 ")}`);
      check("只读文件：确认覆盖后被替换，仍是只读", ro === "replaced\n444", ro);

      check("没有留下临时文件", (await remote(`find "$T/sftp" -name '.termipaw-*' | wc -l`)) === "0");

      // 拖拽
      await refresh(app);
      await clearTransfers(app);
      const inside = await app.js(`(() => { const r = document.querySelector(".sftp").getBoundingClientRect(); return { x: (r.x + r.width / 2) * devicePixelRatio, y: (r.y + r.height / 2) * devicePixelRatio }; })()`);
      await app.js(`window.__TAURI_INTERNALS__.invoke("debug_drop", { paths: [${JSON.stringify(join(localDir, "dropped.txt"))}], x: ${inside.x}, y: ${inside.y} })`);
      check("模拟拖拽上传", await transferIs(app, "dropped.txt", "done", 15000));
      check("模拟拖拽：内容正确", (await remote(`cat "$T/sftp/dropped.txt"`)) === "dropped");

      // 下载
      await refresh(app);
      await clearTransfers(app);
      const saveTo = join(localDir, "downloaded.txt");
      writeFileSync(saveTo, "old local");
      await app.click(".file-row", "keep.txt", { count: 2 });
      await app.answerFileDialog([saveTo]);
      check("下载并替换本地文件", (await transferIs(app, "keep.txt", "done", 15000)) && readFileSync(saveTo, "utf8") === "keep\n", readFileSync(saveTo, "utf8"));

      // 在终端中进入带引号的目录
      await rowAction(app, "it's a dir", "在终端中进入");
      // 这个 Shell 没有开启集成，判断不了状态，要先确认
      await anyDialog(app, "无法确认");
      await app.click(".modal .btn", "输入");
      await sleep(500);
      await app.click(".term");
      await send(app, "pwd");
      const entered = await termHas(app, "/sftp/it's a dir");
      check("在终端中进入带引号的目录", entered, entered ? "" : (await app.js(termTail)).trim().split("\n").slice(-6).join(" | "));

      // 递归删除：软链接只删链接本身
      await rowAction(app, "del", "删除");
      await anyDialog(app, "递归删除");
      await app.click(".modal .btn", "删除");
      await sleep(800);
      check("递归删除目录", (await remote(`test ! -e "$T/sftp/del" && echo gone`)) === "gone");
      check("递归删除不跟随软链接：链接指向的文件还在", (await remote(`cat "$T/sftp/keep.txt"`)) === "keep");

      // 删除普通文件
      await refresh(app);
      await rowAction(app, "dropped.txt", "删除");
      await anyDialog(app, "删除文件");
      await app.click(".modal .btn", "删除");
      await sleep(600);
      check("删除文件", (await remote(`test ! -e "$T/sftp/dropped.txt" && echo gone`)) === "gone");
      await remote(`chmod u+w "$T/sftp/locked"`);
    }),
  );

  await scenario(`大文件传输（${BIG_SIZE / 2 ** 20} MB 随机数据）`, () =>
    withApp([keyHost("big", 2200, "ed25519")], null, async (app) => {
      await remote(`mkdir -p "$T/big"`);
      const bigDir = `${dirPath}/big`;
      await open(app, "big");
      await acceptHostKey(app);
      await connected(app);
      await app.toggleFiles();
      await app.waitFor(`document.querySelectorAll(".file-row").length > 0`, 10000);
      await goTo(app, bigDir);

      let started = Date.now();
      await upload(app, big);
      check("上传完成", await transferIs(app, "big.bin", "done", 300000));
      const up = (Date.now() - started) / 1000;
      const remoteHash = await remote(`sha256sum "$T/big/big.bin" | cut -d' ' -f1`);
      console.log(`INFO  上传 ${up.toFixed(1)} 秒（${(BIG_SIZE / 2 ** 20 / up).toFixed(0)} MB/s）`);
      check("上传后校验和一致", remoteHash === bigHash, remoteHash.slice(0, 16));

      await refresh(app);
      await clearTransfers(app);
      const saved = join(localDir, "big-back.bin");
      started = Date.now();
      await app.click(".file-row", "big.bin", { count: 2 });
      await app.answerFileDialog([saved]);
      check("下载完成", await transferIs(app, "big.bin", "done", 300000));
      const down = (Date.now() - started) / 1000;
      console.log(`INFO  下载 ${down.toFixed(1)} 秒（${(BIG_SIZE / 2 ** 20 / down).toFixed(0)} MB/s）`);
      check("下载后校验和一致", (await sha256(saved)) === bigHash);
      check("下载后本地没有临时文件", !readdirSync(localDir).some((n) => n.startsWith(".termipaw-")));

      // 中途取消覆盖上传：原文件不能受影响
      const other = join(localDir, "big2", "big.bin");
      mkdirSync(join(localDir, "big2"), { recursive: true });
      await makeBigFile(other, BIG_SIZE);
      await clearTransfers(app);
      await upload(app, other);
      await anyDialog(app, "文件已存在");
      await app.click(".modal .btn", "覆盖");
      await app.waitFor(`parseFloat(document.querySelector(".transfer.running .bar > div")?.style.width) > 3`, 30000);
      const cancelAt = Date.now();
      await app.js(`document.querySelector(".transfer.running .icon-btn").click()`);
      check("中途取消：变为已取消", await transferIs(app, "big.bin", "cancelled", 60000));
      console.log(`INFO  取消用了 ${((Date.now() - cancelAt) / 1000).toFixed(1)} 秒`);
      check("中途取消：原文件没有变", (await remote(`sha256sum "$T/big/big.bin" | cut -d' ' -f1`)) === bigHash);
      await sleep(500);
      const left = await remote(`find "$T/big" -name '.termipaw-*' | wc -l`);
      check("中途取消：没有留下临时文件", left === "0", left);

      // 中途关闭会话
      await clearTransfers(app);
      await upload(app, other);
      await anyDialog(app, "文件已存在");
      await app.click(".modal .btn", "覆盖");
      await app.waitFor(`parseFloat(document.querySelector(".transfer.running .bar > div")?.style.width) > 3`, 30000);
      await closeSession(app);
      await sleep(4500);
      const leftAfterClose = await remote(`find "$T/big" -name '.termipaw-*' | wc -l`);
      check("中途关闭会话：没有留下临时文件", leftAfterClose === "0", leftAfterClose);
      check("中途关闭会话：原文件没有变", (await remote(`sha256sum "$T/big/big.bin" | cut -d' ' -f1`)) === bigHash);
    }),
  );

  await scenario("传输中连接断开", () =>
    withApp([keyHost("drop", 2200, "ed25519")], null, async (app) => {
      await remote(`mkdir -p "$T/drop"; echo original > "$T/drop/big.bin"`);
      await open(app, "drop");
      await acceptHostKey(app);
      await connected(app);
      await app.toggleFiles();
      await app.waitFor(`document.querySelectorAll(".file-row").length > 0`, 10000);
      await goTo(app, `${dirPath}/drop`);
      await upload(app, big);
      await anyDialog(app, "文件已存在");
      await app.click(".modal .btn", "覆盖");
      await app.waitFor(`parseFloat(document.querySelector(".transfer.running .bar > div")?.style.width) > 3`, 30000);
      // 杀掉这个端口上已建立的会话（停 sshd 服务不会断开已有会话）
      await remote(`S bash -c "ss -tnpH 'sport = :2200' | grep -oP 'pid=\\\\K[0-9]+' | sort -u | xargs -r kill -9"`);
      check("终端显示连接已断开", await app.waitFor(`!!document.querySelector(".banner")`, 40000), await app.js(`document.querySelector(".banner")?.textContent ?? ""`));
      check("原文件没有变", (await remote(`head -c 100 "$T/drop/big.bin"`)) === "original");
      const left = await remote(`find "$T/drop" -name '.termipaw-*' | wc -l`);
      console.log(`INFO  连接断开后留在服务器上的临时文件：${left} 个`);
      // 使用私钥，不用输入密码，所以会自动重连；文件面板也会跟着恢复
      check("断开后自动重新连接", await connected(app));
      check("文件面板自动恢复", await app.waitFor(`!!document.querySelector(".sftp .files")`, 10000));
      check("传输显示失败，不是一直卡在进行中", await app.waitFor(`document.querySelector(".transfer.failed .tname")?.textContent === "big.bin" && !document.querySelector(".transfer.running")`, 20000), await app.js(`document.querySelector(".transfer")?.textContent ?? "(没有传输)"`));
      const failure = await app.js(`document.querySelector(".transfer.failed")?.textContent ?? ""`);
      check("传输的错误文字是“连接已断开”", failure.includes("连接已断开"), failure);
      // 打开文件面板时才会连上 SFTP，临时文件在那之后清理
      await app.waitFor(`document.querySelectorAll(".file-row").length > 0`, 10000);
      let remaining = "";
      for (let i = 0; i < 40 && remaining !== "0"; i++) {
        remaining = await remote(`find "$T/drop" -name '.termipaw-*' | wc -l`);
        if (remaining !== "0") await new Promise((r) => setTimeout(r, 500));
      }
      check("重新连接后清理了遗留的临时文件", remaining === "0", remaining);
      check("清理后原文件没有变", (await remote(`head -c 100 "$T/drop/big.bin"`)) === "original");
    }),
  );
}

/** 终端与文件联动。真实的 bash、vim、sudo，以及在 Windows 上建不出来的文件名 */
async function linkageScenarios() {
  const home = await remote('printf %s "$HOME"');
  const base = home + "/termipaw-test/link";
  const openPanel = async (app, name) => {
    await open(app, name);
    await acceptHostKey(app);
    await connected(app);
    await termReady(app);
    await app.toggleFiles();
    await app.waitFor('!!document.querySelector(".sftp .files")', 10000);
  };
  const pathIs = (app, path, ms = 6000) => app.waitFor('document.querySelector(".pathbar input").value === ' + JSON.stringify(path), ms);
  const toastSeen = (app, text) => app.waitFor('[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes(' + JSON.stringify(text) + '))', 5000);
  const noModal = (app) => app.js('!document.querySelector(".modal")');
  const enableIntegration = async (app) => {
    await app.click(".sftp-toolbar .follow-btn");
    return app.waitFor('!!document.querySelector(".follow-btn.on")', 8000);
  };
  const rowContains = async (app, part, action) => {
    const p = await app.js('(() => { const row = [...document.querySelectorAll(".file-row")].find((r) => r.querySelector(".fname")?.textContent.includes(' + JSON.stringify(part) + ')); if (!row) return null; row.scrollIntoView({ block: "nearest" }); const r = row.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()');
    if (!p) throw new Error("找不到 " + part);
    await app.mouse("mouseMoved", p);
    await app.mouse("mousePressed", p, { button: "right" });
    await app.mouse("mouseReleased", p, { button: "right" });
    await sleep(200);
    await app.click(".ctx-menu button", action);
  };

  await remote(`mkdir -p "$T/link/中文 目录" "$T/link/it's" "$T/link/plain"`);

  await scenario("真实 bash：开启集成后文件面板跟随目录", () =>
    withApp([keyHost("follow", 2200, "ed25519")], null, async (app) => {
      await openPanel(app, "follow");
      check("没有报告目录：不显示提示条，跟随按钮不亮", await app.js('!document.querySelector(".sftp-hint") && !document.querySelector(".follow-btn.on")'));
      check("点跟随按钮后真实 bash 开始报告目录", await enableIntegration(app));
      await app.click(".term");
      await send(app, "cd " + JSON.stringify(base + "/plain"));
      check("终端进入目录：面板跟随", await pathIs(app, base + "/plain"), await app.js('document.querySelector(".pathbar input").value'));
      await send(app, "cd " + JSON.stringify(base + "/中文 目录"));
      check("中文和空格：面板跟随", await pathIs(app, base + "/中文 目录"), await app.js('document.querySelector(".pathbar input").value'));
      await send(app, "cd " + JSON.stringify(base + "/it's"));
      check("带引号的目录：面板跟随", await pathIs(app, base + "/it's"), await app.js('document.querySelector(".pathbar input").value'));
      await send(app, "cd /");
      check("根目录：面板跟随", await pathIs(app, "/"), await app.js('document.querySelector(".pathbar input").value'));
      // 集成不能破坏命令的退出码
      await send(app, "false; echo code=$?");
      check("退出码不受影响", await termHas(app, "code=1"));

      // 全屏程序
      await send(app, "cd " + JSON.stringify(base));
      await pathIs(app, base);
      await send(app, "vim /tmp/termipaw-vim.txt");
      await app.waitFor('window.__termipawTest.terms.at(-1).buffer.active.type === "alternate"', 8000);
      await rowContains(app, "plain", "在终端中进入");
      check("vim 开着：拒绝输入命令", await toastSeen(app, "全屏程序"));
      await sleep(400);
      const vimScreen = await app.js(termTail);
      check("vim 开着：命令没有进编辑器", !vimScreen.includes("cd '"), vimScreen.trim().split("\n").slice(0, 3).join(" | "));
      await app.click(".term");
      await app.key("Escape", "Escape", 27);
      await app.type(":q!");
      await app.key("Enter", "Enter", 13);
      await app.waitFor('window.__termipawTest.terms.at(-1).buffer.active.type === "normal"', 8000);

      // sudo 等密码
      await send(app, "sudo -k; sudo -p 'PW-PROMPT: ' true");
      await termHas(app, "PW-PROMPT:");
      await rowContains(app, "plain", "在终端中进入");
      check("sudo 等密码：先确认", await anyDialog(app, "正在运行"));
      await app.click(".modal .btn", "取消");
      await sleep(200);
      await app.click(".term");
      await app.key("c", "KeyC", 67, 2);
      await sleep(500);

      // 打了一半的命令
      await app.type("rm -rf ");
      await sleep(150);
      await rowContains(app, "plain", "在终端中进入");
      check("当前行打了一半：拒绝", await toastSeen(app, "尚未执行的内容"));
      await app.click(".term");
      await app.key("c", "KeyC", 67, 2);
      await sleep(500);

      // 停在提示符：不用确认
      await rowContains(app, "plain", "在终端中进入");
      await sleep(300);
      check("停在提示符：不用确认", await noModal(app));
      check("停在提示符：进入目录并跟随", await pathIs(app, base + "/plain"));
    }),
  );

  await scenario("真实 bash：恶意文件名", () =>
    withApp([keyHost("names", 2200, "ed25519")], null, async (app) => {
      await remote('cd "$T/link"; mkdir -p "$(printf "evil\\003touch pwned\\rx")"; touch "$(printf "invoice\\342\\200\\256txt.exe")" "$(printf "line\\nbreak.txt")"');
      await openPanel(app, "names");
      await goTo(app, base);
      const names = await app.js('[...document.querySelectorAll(".file-row .fname")].map((e) => e.textContent)');
      check("RTL 伪装的名字显示真实结构", names.includes("invoice⟦U+202E⟧txt.exe"), names.join(" | "));
      check("换行显示为可见符号", names.includes("line␊break.txt"), names.join(" | "));
      await rowContains(app, "evil", "在终端中进入");
      check("目录名有控制字符：拒绝输入到终端", await toastSeen(app, "控制字符"));
      await sleep(300);
      check("目录名有控制字符：藏的命令没有运行", (await remote('find "$HOME" -maxdepth 3 -name pwned | wc -l')) === "0");
      await remote('cd "$T/link"; rm -rf evil* invoice* line*');
    }),
  );

  await scenario("真实服务器：目录传输", () =>
    withApp([keyHost("tree", 2200, "ed25519")], null, async (app) => {
      await remote('mkdir -p "$T/tree/sub/deep" "$T/tree/noaccess" "$T/secret"; cd "$T/tree"; echo a > a.txt; echo b > sub/deep/b.txt; : > empty.txt; echo x > "$T/secret/s.txt"; ln -s "$T/secret" link-dir; ln -s "$T/secret/s.txt" link-file; ln -s link-loop link-loop; mkfifo pipe; chmod 000 noaccess; touch "what?.txt" "$(printf "tail.")" CON');
      const target = join(localDir, "tree-down");
      mkdirSync(target);
      await openPanel(app, "tree");
      await goTo(app, home + "/termipaw-test");
      writeFileSync(join(app.dataDir, "folder-answer.txt"), target);
      await rowAction(app, "tree", "下载文件夹");
      const failed = await app.waitFor('document.querySelector(".transfer.failed")?.textContent.includes("tree") === true', 30000);
      check("读不了的子目录：明确报告", failed && (await app.js('document.querySelector(".transfer.failed").textContent')).includes("没有下载成功"), await app.js('document.querySelector(".transfers")?.textContent ?? ""'));
      const got = join(target, "tree");
      check("其余文件都下载了", readFileSync(join(got, "sub", "deep", "b.txt"), "utf8") === "b\n" && readFileSync(join(got, "a.txt"), "utf8") === "a\n");
      const names = readdirSync(got);
      check("符号链接和管道都没有下载", !names.some((n) => n.startsWith("link") || n === "pipe"), names.join());
      check("Windows 不接受的名字改成了安全的", names.includes("what_.txt") && names.includes("tail") && names.includes("_CON"), names.join());
      await remote('chmod 755 "$T/tree/noaccess"');

      const source = join(localDir, "tree-up");
      mkdirSync(join(source, "x", "y"), { recursive: true });
      writeFileSync(join(source, "x", "y", "z.txt"), "z");
      writeFileSync(join(app.dataDir, "folder-answer.txt"), source);
      await clearTransfers(app);
      await app.click(".sftp-toolbar [title='上传文件夹']");
      check("上传文件夹：完成", await transferIs(app, "tree-up", "done", 20000));
      check("上传文件夹：内容正确", (await remote('cat "$T/tree-up/x/y/z.txt"')) === "z");

      // 合并时不能顺着服务器上的符号链接写到别处
      await remote('rm -rf "$T/tree-up/x"; ln -s "$T/secret" "$T/tree-up/x"');
      writeFileSync(join(app.dataDir, "folder-answer.txt"), source);
      await clearTransfers(app);
      await app.click(".sftp-toolbar [title='上传文件夹']");
      await anyDialog(app, "文件夹已存在");
      await app.click(".modal .btn", "合并");
      check("合并遇到符号链接：拒绝", await transferIs(app, "tree-up", "failed", 20000));
      check("合并遇到符号链接：链接指向的目录没有变化", (await remote('ls -A "$T/secret"')) === "s.txt", await remote('ls -A "$T/secret"'));
    }),
  );

  await scenario("真实服务器：覆盖只读文件", () =>
    withApp([keyHost("ro", 2200, "ed25519")], null, async (app) => {
      await remote(`mkdir -p "$T/ro"; echo old > "$T/ro/ro.txt"; chmod 444 "$T/ro/ro.txt"`);
      const file = join(localDir, "ro.txt");
      writeFileSync(file, "new\n");
      await openPanel(app, "ro");
      await goTo(app, base.replace("/link", "/ro"));
      await upload(app, file);
      check("确认框里提示只读", await anyDialog(app, "这是只读文件"));
      await app.click(".modal .btn", "覆盖");
      check("确认后文件被替换", await transferIs(app, "ro.txt", "done", 15000) && (await remote(`cat "$T/ro/ro.txt"`)) === "new");
      check("替换后还是只读", (await remote(`stat -c %a "$T/ro/ro.txt"`)) === "444");
    }),
  );

  const editorLog = join(work, "openssh-editor.log");
  const seedEditor = (data) => writeFileSync(join(data, "editor.json"), JSON.stringify(editorExe));

  await scenario("真实服务器：用本地程序编辑", () =>
    withApp(
      [keyHost("edit", 2200, "ed25519")],
      seedEditor,
      async (app) => {
        await remote('mkdir -p "$T/edit"; printf "one\\n" > "$T/edit/run.sh"; chmod 750 "$T/edit/run.sh"; printf "real\\n" > "$T/edit/real.txt"; ln -s real.txt "$T/edit/link.txt"');
        await openPanel(app, "edit");
        await goTo(app, base.replace("/link", "/edit"));
        await rowAction(app, "run.sh", "fake_editor");
        await app.waitFor('document.querySelectorAll(".edit-row").length === 1', 10000);
        const local = readFileSync(editorLog, "utf8").trim().split(/\r?\n/).at(-1);
        await sleep(1000);
        writeFileSync(local, "two\n");
        let content = "";
        for (let i = 0; i < 40 && content !== "two"; i++) {
          content = await remote('cat "$T/edit/run.sh"');
          if (content !== "two") await sleep(300);
        }
        check("保存后传回真实服务器", content === "two", content);
        check("传回后保留权限", (await remote('stat -c %a "$T/edit/run.sh"')) === "750");
        check("传回后没有留下临时文件", (await remote('find "$T/edit" -name ".termipaw-*" | wc -l')) === "0");

        // 别人同时改了
        await sleep(1100);
        await remote('echo "someone else" > "$T/edit/run.sh"');
        writeFileSync(local, "three\n");
        check("服务器上也改过：先询问", await anyDialog(app, "也被改过"));
        await app.click(".modal .btn", "暂不传回");
        check("选择暂不传回：服务器上的内容不变", (await remote('cat "$T/edit/run.sh"')) === "someone else");

        // 符号链接写到它指向的文件，链接本身保留
        await rowAction(app, "link.txt", "fake_editor");
        await app.waitFor('document.querySelectorAll(".edit-row").length === 2', 10000);
        const linkLocal = readFileSync(editorLog, "utf8").trim().split(/\r?\n/).at(-1);
        await sleep(1000);
        writeFileSync(linkLocal, "via link\n");
        let real = "";
        for (let i = 0; i < 40 && real !== "via link"; i++) {
          real = await remote('cat "$T/edit/real.txt"');
          if (real !== "via link") await sleep(300);
        }
        check("符号链接：写到它指向的文件", real === "via link", real);
        check("符号链接：链接还在", (await remote('test -L "$T/edit/link.txt" && echo link')) === "link");

        // 只读文件：第一次传回前问一次，之后不再问
        await remote('printf "ro old\\n" > "$T/edit/ro.txt"; chmod 444 "$T/edit/ro.txt"; printf "target old\\n" > "$T/edit/ro-target.txt"; chmod 444 "$T/edit/ro-target.txt"; ln -s ro-target.txt "$T/edit/ro-link.txt"');
        await app.click(".sftp-toolbar [title='刷新']");
        await sleep(500);
        await rowAction(app, "ro.txt", "fake_editor");
        await app.waitFor('document.querySelectorAll(".edit-row").length === 3', 10000);
        const roLocal = readFileSync(editorLog, "utf8").trim().split(/\r?\n/).at(-1);
        await sleep(1000);
        writeFileSync(roLocal, "ro one\n");
        check("只读文件：保存后先询问", await anyDialog(app, "这是只读文件"));
        check("只读文件：询问时内容不变", (await remote('cat "$T/edit/ro.txt"')) === "ro old");
        await app.click(".modal .btn", "暂不传回");
        await sleep(500);
        check("只读文件：选择暂不传回后内容不变", (await remote('cat "$T/edit/ro.txt"')) === "ro old");
        await sleep(1000);
        writeFileSync(roLocal, "ro two\n");
        check("只读文件：暂不传回之后再保存，还会询问", await anyDialog(app, "这是只读文件"));
        await app.click(".modal .btn", "替换");
        const waitRemote = async (cmd, want) => {
          let got = "";
          for (let i = 0; i < 40 && got !== want; i++) {
            got = await remote(cmd);
            if (got !== want) await sleep(300);
          }
          return got;
        };
        check("只读文件：同意后传回", (await waitRemote('cat "$T/edit/ro.txt"', "ro two")) === "ro two");
        check("只读文件：替换后还是只读", (await remote('stat -c %a "$T/edit/ro.txt"')) === "444");
        await sleep(1500);
        writeFileSync(roLocal, "ro three\n");
        check("只读文件：之后的保存不再询问", (await waitRemote('cat "$T/edit/ro.txt"', "ro three")) === "ro three" && !(await app.js('!!document.querySelector(".modal")')));
        check("只读文件：再次传回后还是只读", (await remote('stat -c %a "$T/edit/ro.txt"')) === "444");

        // 链接本身的权限总是 777，要看它指向的文件
        await rowAction(app, "ro-link.txt", "fake_editor");
        await app.waitFor('document.querySelectorAll(".edit-row").length === 4', 10000);
        const roLinkLocal = readFileSync(editorLog, "utf8").trim().split(/\r?\n/).at(-1);
        await sleep(1000);
        writeFileSync(roLinkLocal, "target new\n");
        check("指向只读文件的链接：也询问", await anyDialog(app, "这是只读文件"));
        await app.click(".modal .btn", "替换");
        check("指向只读文件的链接：写到它指向的文件", (await waitRemote('cat "$T/edit/ro-target.txt"', "target new")) === "target new");
        check("指向只读文件的链接：链接还在", (await remote('test -L "$T/edit/ro-link.txt" && echo link')) === "link");
        check("指向只读文件的链接：目标还是只读", (await remote('stat -c %a "$T/edit/ro-target.txt"')) === "444");
      },
      { TERMIPAW_FAKE_EDITOR_LOG: editorLog },
    ),
  );

  await scenario("真实服务器：主密码保险库", () => {
    const MASTER = "correct horse battery staple";
    const passphraseHost = keyHost("vkey", 2200, "ed25519_locked");
    return withApp(
      [host("vpw", 2200), passphraseHost],
      null,
      async (app) => {
        const file = (name) => join(app.dataDir, name);
        const typeIn = async (selector, text) => {
          await app.click(selector);
          await app.type(text);
        };
        // 开启，同时加密主机信息
        await app.openMenu(0);
        await app.waitFor('!!document.querySelector(".vault-enable")');
        await app.click(".vault-enable");
        await typeIn(".vault-new", MASTER);
        await typeIn(".vault-again", MASTER);
        await app.click(".modal .switch", "生成恢复密钥");
        await app.click(".modal .switch", "同时加密主机信息");
        await app.click(".vault-confirm");
        check("保险库：开启成功", await app.waitFor('!document.querySelector(".vault-confirm") && document.querySelector(".vault-state")?.textContent.includes("已开启") === true', 15000));
        await app.key("Escape", "Escape", 27);
        await sleep(200);
        const vault = readFileSync(file("vault.json"), "utf8");
        check("保险库：文件里没有密码、口令和地址", !vault.includes(PASSWORD) && !vault.includes("open sesame") && !vault.includes(HOST));
        check("保险库：明文主机文件删掉了", !existsSync(file("hosts.json")));

        // 第一次连接：输入密码和私钥口令，保存到保险库
        const secretPrompt = async (secret) => {
          await app.waitFor('!!document.querySelector(".modal input[type=password]")', 20000);
          await app.click(".modal .switch");
          await app.click(".modal input[type=password]");
          await app.type(secret);
          await app.key("Enter", "Enter", 13);
        };
        await open(app, "vpw");
        await acceptHostKey(app);
        await secretPrompt(PASSWORD);
        check("保险库：真实服务器用输入的密码登录", await connected(app));
        check("保险库：密码登录后终端可用", await termReady(app));
        await open(app, "vkey");
        await secretPrompt("open sesame");
        check("保险库：私钥口令输入后可以登录并保存", await app.waitFor('document.querySelectorAll(".dot.connected").length >= 1 && !document.querySelector(".overlay")', 20000) && !(await app.js('!!document.querySelector(".modal input[type=password]")')));
        check("保险库：私钥登录后终端可用", await termReady(app));

        // 锁定时服务器断开：不询问，解锁后自动连上
        postWindowMessage(app.pid, 0x2b1, 7);
        check("保险库：锁定", await app.waitFor('!!document.querySelector(".lock-screen .lock-card")', 3000));
        await remote('S bash -c "ss -tnpH ' + "'sport = :2200'" + ' | grep -oP ' + "'pid=\\\\K[0-9]+'" + ' | sort -u | xargs -r kill -9"');
        check("保险库：服务器断开后等解锁", await app.waitFor('[...document.querySelectorAll(".banner, .overlay")].some((e) => e.textContent.includes("解锁后继续"))', 45000));
        check("保险库：锁定时没有弹密码框", !(await app.js('!!document.querySelector(".modal input[type=password]")')));
        await typeIn(".lock-password", MASTER);
        await app.key("Enter", "Enter", 13);
        check("保险库：解锁后自动连上", await app.waitFor('!document.querySelector(".lock-screen") && !!document.querySelector(".dot.connected") && !document.querySelector(".overlay")', 30000));
        check("保险库：重连时也不询问", !(await app.js('!!document.querySelector(".modal input[type=password]")')));
        check("保险库：重连后终端可用", await termReady(app));

        const afterSave = readFileSync(file("vault.json"), "utf8");
        check("保险库：保存后文件里仍然没有密码和口令", !afterSave.includes(PASSWORD) && !afterSave.includes("open sesame"));

        // 关闭：保存的密码随保险库一起删除
        await app.openMenu(0);
        await app.waitFor('!!document.querySelector(".vault-disable")');
        await app.click(".vault-disable");
        await typeIn(".vault-current", MASTER);
        await app.click(".vault-confirm");
        check("保险库：关闭后文件删除", await app.waitFor('!document.querySelector(".vault-state")', 15000) && !existsSync(file("vault.json")));
        const plain = existsSync(file("hosts.json")) ? readFileSync(file("hosts.json"), "utf8") : "";
        check("保险库：关闭后主机信息写回明文文件", plain.includes("vpw") && plain.includes("vkey"));
        check("保险库：关闭后密码和口令没有留在任何文件里", !plain.includes(PASSWORD) && !plain.includes("open sesame"));
      },
    );
  });

  await scenario("真实服务器：断线重连", () =>
    withApp([keyHost("recon", 2200, "ed25519")], null, async (app) => {
      await openPanel(app, "recon");
      await enableIntegration(app);
      await app.click(".term");
      await send(app, "cd " + JSON.stringify(base + "/plain"));
      await pathIs(app, base + "/plain");

      // 断在 vim 里
      await send(app, "vim /tmp/termipaw-vim.txt");
      await app.waitFor('window.__termipawTest.terms.at(-1).buffer.active.type === "alternate"', 8000);
      await remote('S bash -c "ss -tnpH ' + "'sport = :2200'" + ' | grep -oP ' + "'pid=\\\\K[0-9]+'" + ' | sort -u | xargs -r kill -9"');
      check("连接断开：显示自动重连", await app.waitFor('document.querySelector(".banner")?.textContent.includes("重试") === true', 30000), await app.js('document.querySelector(".banner")?.textContent ?? ""'));
      check("自动连上", await connected(app));
      check("退出了全屏模式", await app.waitFor('window.__termipawTest.terms.at(-1).buffer.active.type === "normal"', 5000));
      check("文件面板回到原来的目录", await pathIs(app, base + "/plain"), await app.js('document.querySelector(".pathbar input")?.value ?? ""'));
      check("提示回到断开前的目录", await app.waitFor('document.querySelector(".banner")?.textContent.includes("断开前终端位于") === true', 8000));
      await sleep(600);
      await app.click(".banner .btn", "回到这里");
      await anyDialog(app, "无法确认");
      await app.click(".modal .btn", "输入");
      await sleep(500);
      await app.click(".term");
      await send(app, "pwd");
      check("终端回到了原来的目录", await termHas(app, base + "/plain"));

      // 网络静默中断：没有任何通知，只能靠心跳发现
      const hasIptables = (await remote('command -v iptables >/dev/null && echo yes || echo no')) === "yes";
      if (!hasIptables) return console.log("INFO  服务器没有 iptables，跳过网络静默中断的测试");
      const started = Date.now();
      try {
        await remote('S iptables -I INPUT -p tcp --dport 2200 -j DROP');
        const noticed = await app.waitFor('document.querySelector(".banner")?.textContent.includes("连接已断开") === true', 120000);
        console.log("INFO  发现网络中断用了 " + ((Date.now() - started) / 1000).toFixed(0) + " 秒");
        check("网络静默中断：能发现", noticed, await app.js('document.querySelector(".banner")?.textContent ?? ""'));
      } finally {
        await remote('S iptables -D INPUT -p tcp --dport 2200 -j DROP');
      }
      check("网络恢复后自动连上", await app.waitFor('!!document.querySelector(".dot.connected") && !document.querySelector(".overlay")', 90000), await app.js('document.querySelector(".banner")?.textContent ?? ""'));
    }),
  );
}

// ---------- 入口 ----------

let crashed = false;
try {
  console.log("生成测试密钥、配置服务器");
  const pubs = await makeKeys();
  for (const n of ["ed25519", "ed25519_locked", "ecdsa", "rsa", "rsa_pem", "not_authorized"]) chmodSync(key(n), 0o600);
  console.log(await setupServer(pubs));
  console.log("服务器：" + (await remote(`. /etc/os-release; echo "$PRETTY_NAME"; ssh -V 2>&1`)).replace("\n", "，"));

  await loginScenarios();
  await legacyScenarios();
  await hostKeyScenarios();
  await agentScenarios();
  await terminalScenarios();
  await sftpScenarios();
  await linkageScenarios();
} catch (e) {
  crashed = true;
  console.error(`\n测试中断：${e.stack ?? e}`);
} finally {
  console.log("\n清理服务器");
  try {
    await cleanupServer();
    console.log("残留检查：" + (await remote(`ls -d ${RUN} "$T" 2>/dev/null | wc -l; S ss -ltnH 'sport >= 2200 and sport <= 2203' | wc -l`)).replace("\n", " 个目录，") + " 个监听端口");
  } catch (e) {
    console.error(`清理失败：${e.message}`);
    crashed = true;
  }
  removeDir(work);
}
console.log(`\n共 ${checks.total} 项，失败 ${checks.failed} 项${crashed ? "，且测试中途中断" : ""}`);
process.exit(checks.failed || crashed ? 1 : 0);
