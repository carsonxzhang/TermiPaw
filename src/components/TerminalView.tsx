import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { AlertTriangle, Check, ChevronDown, ChevronUp, ClipboardPaste, Copy, Eraser, FolderTree, Pencil, RotateCw, Save, Search, Unplug, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { msg, renderText } from "../i18n";
import { api, errorText, toAppError } from "../lib/api";
import { createDecoder, DEFAULT_ENCODING, Encoding, ENCODING_LABELS, ENCODINGS } from "../lib/encoding";
import { createFlowControl } from "../lib/flow";
import { displayName } from "../lib/names";
import { bufferText, outputFileName } from "../lib/output";
import { needsPasteConfirm, pastePreview, pasteSummary } from "../lib/paste";
import { cdCommand, integrationOneLiner, parseCwdReport, sameHost, ShellTracker } from "../lib/shell";
import { testHook } from "../lib/testHook";
import { attachEdits, dialogs, ResolvedTheme, resolveTheme, runInShell, scheduleReconnect, Tab, terminals, useStore } from "../lib/store";
import { SftpPanel } from "./SftpPanel";
import { ContextMenu } from "./ui";

/** 目录上报的间隔下限。输出是服务器控制的，不能让它用上报把 SFTP 请求刷爆 */
const CWD_REPORT_INTERVAL = 200;

/** 查找结果的高亮。颜色只能用 #RRGGBB */
const findColors: Record<ResolvedTheme, NonNullable<ISearchOptions["decorations"]>> = {
  dark: {
    matchBackground: "#5c4b16",
    matchOverviewRuler: "#f5c46b",
    activeMatchBackground: "#a0701a",
    activeMatchColorOverviewRuler: "#ffd98a",
  },
  light: {
    matchBackground: "#fff1b8",
    matchOverviewRuler: "#d4a72c",
    activeMatchBackground: "#ffc53d",
    activeMatchColorOverviewRuler: "#9a6700",
  },
};

const themes: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: "#0e1014",
    foreground: "#d8dee9",
    cursor: "#8570d8",
    cursorAccent: "#0e1014",
    selectionBackground: "rgba(133, 112, 216, 0.35)",
    black: "#1b1f26",
    red: "#f07178",
    green: "#3ecf8e",
    yellow: "#f5c46b",
    blue: "#5b8cff",
    magenta: "#c792ea",
    cyan: "#4fd6e0",
    white: "#c9d1dc",
    brightBlack: "#5a6374",
    brightRed: "#ff8b92",
    brightGreen: "#6ee7b0",
    brightYellow: "#ffd98a",
    brightBlue: "#82a8ff",
    brightMagenta: "#ddb0f5",
    brightCyan: "#89eaf0",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff",
    foreground: "#24292f",
    cursor: "#6550af",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(101, 80, 175, 0.22)",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};

/** 连接并处理指纹确认、密码输入等交互，直到成功或用户取消 */
async function establish(tab: Tab, term: Terminal, onData: (data: Uint8Array) => void, isCancelled: () => boolean) {
  let secret: string | undefined;
  let remember = false;
  for (;;) {
    try {
      return await api.connect(
        tab.target,
        { secret, remember, cols: term.cols, rows: term.rows },
        onData,
      );
    } catch (e) {
      if (isCancelled()) throw e;
      // 自动重连时不弹对话框：用户可能不在电脑前，失败了由调用者决定怎么办
      if (tab.autoAttempt) throw e;
      const err = toAppError(e);
      if (err.kind === "knownHostsBlocked") {
        if (!err.canReset) throw err;
        const m = msg().terminal;
        const reset = await dialogs.confirm({
          title: m.knownHostsCorruptTitle,
          message: m.knownHostsResetMessage(errorText(err)),
          danger: true,
          confirmText: m.backupAndReset,
        });
        if (!reset) throw err;
        await api.resetKnownHosts();
        continue;
      }
      if (err.kind === "unknownHostKey" || err.kind === "hostKeyChanged") {
        if (!(await dialogs.hostKey(err))) throw err;
        await api.trustHostKey(err.host, err.port);
        continue;
      }
      // 私钥在 Agent 里，没有可以让用户输入的东西
      if (tab.target.auth === "agent") throw err;
      const isKey = tab.target.auth === "key";
      if (err.kind === "secretRequired" || (err.kind === "authFailed" && (!isKey || secret))) {
        const m = msg();
        const r = await dialogs.secret({
          title: isKey ? m.terminal.passphraseTitle : m.terminal.passwordTitle,
          message: err.kind === "authFailed" ? errorText(err) : `${tab.target.username}@${tab.target.host}`,
          label: isKey ? m.auth.passphrase : m.auth.password,
          canRemember: !!tab.target.hostId,
        });
        if (!r) throw err;
        secret = r.secret;
        remember = r.remember;
        continue;
      }
      throw err;
    }
  }
}

export function TerminalView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const sessionRef = useRef<string>();
  // 拿到会话号之前处理完的输出字节数，之后补发确认
  const unackedRef = useRef(0);
  const trackerRef = useRef(new ShellTracker());
  // 这个连接所在机器的名字。第一次收到目录上报时才查询，查不到就以第一次上报的为准
  const hostnameRef = useRef<Promise<string | null>>();
  const restoreRef = useRef<() => void>();
  const separatorShown = useRef(false);
  // 编码在会话中途可以切换，输入输出的回调里读这里
  const encodingRef = useRef<Encoding>(tab.encoding);
  const decoderRef = useRef<{ encoding: Encoding; decode: (bytes: Uint8Array) => string }>();
  const searchRef = useRef<SearchAddon>();
  const pasteRef = useRef<(text: string) => void>();
  const openFindRef = useRef<() => void>();
  const findInput = useRef<HTMLInputElement>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [find, setFind] = useState<{ query: string; index: number; count: number } | null>(null);
  const [encodingMenu, setEncodingMenu] = useState<{ x: number; y: number } | null>(null);
  const { settings, updateTab, closeTab, reconnect, set, hosts, toast } = useStore();
  const theme = useStore(resolveTheme);
  const busy = useStore((s) => s.transfers.filter((t) => t.tabId === tab.id && (t.status === "running" || t.status === "queued")).length);
  encodingRef.current = tab.encoding;

  // 创建终端实例（每个标签一个）
  useEffect(() => {
    const state = useStore.getState();
    const s = state.settings;
    const term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      cursorStyle: s.cursorStyle,
      cursorBlink: true,
      lineHeight: 1.2,
      scrollback: 10000,
      allowProposedApi: true,
      theme: themes[resolveTheme(state)],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // 终端输出是服务器说了算的，点一下就打开链接太危险：要按住 Ctrl，而且只放行 http 和 https
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!event.ctrlKey) return useStore.getState().toast("info", msg().terminal.ctrlClick);
        api.openUrl(uri).catch((e) => useStore.getState().toast("error", errorText(e)));
      }),
    );
    const search = new SearchAddon({ highlightLimit: 1000 });
    term.loadAddon(search);
    search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setFind((f) => f && { ...f, index: resultIndex, count: resultCount }),
    );
    searchRef.current = search;
    term.open(el.current!);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* 不支持 WebGL 时回退到 DOM 渲染 */
    }

    term.onData((d) => {
      trackerRef.current.input(d);
      if (sessionRef.current) api.write(sessionRef.current, d, encodingRef.current);
    });
    term.onResize(({ cols, rows }) => sessionRef.current && api.resize(sessionRef.current, cols, rows));
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      setHasSelection(!!sel);
      if (sel && useStore.getState().settings.copyOnSelect) writeText(sel);
    });
    // 所有粘贴都经过这里：含换行的内容先让用户确认
    const pasteText = async (text: string) => {
      if (!text) return;
      if (useStore.getState().settings.confirmMultilinePaste && needsPasteConfirm(text)) {
        const m = msg().terminal;
        const ok = await dialogs.confirm({
          title: m.pasteTitle,
          message: m.pasteMessage(pasteSummary(text)),
          detail: pastePreview(text),
          confirmText: m.paste,
        });
        if (!ok) return term.focus();
      }
      term.paste(text);
      term.focus();
    };
    pasteRef.current = pasteText;
    // Ctrl+Shift+C / Ctrl+Shift+V / Ctrl+Shift+F
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === "KeyF") {
        e.preventDefault();
        openFindRef.current?.();
        return false;
      }
      if (e.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) writeText(sel);
        return false;
      }
      if (e.code === "KeyV") {
        // 阻止浏览器默认的粘贴，否则下面的 paste 事件会再粘一次
        e.preventDefault();
        readText().then((t) => {
          if (t) pasteText(t);
        });
        return false;
      }
      return true;
    });
    // 右键：有选中则复制，否则粘贴
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) {
        writeText(sel);
        term.clearSelection();
      } else readText().then((t) => {
          if (t) pasteText(t);
        });
    };
    el.current!.addEventListener("contextmenu", onContext);
    // 浏览器自己触发的粘贴（Shift+Insert、系统菜单等）：在 xterm 之前截下来，同样走确认
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      pasteText(e.clipboardData?.getData("text/plain") ?? "");
    };
    el.current!.addEventListener("paste", onPaste, true);

    // 重新连接后回到断开前的目录。只有确定 Shell 停在提示符时才自动输入；否则由用户点按钮，见下面的提示条
    const restoreDirectory = () => {
      const current = useStore.getState().tabs.find((t) => t.id === tab.id);
      if (!current?.restoreDir || !current.sessionId) return;
      if (trackerRef.current.status(term.buffer.active.type === "alternate") !== "prompt") return;
      const command = cdCommand(current.restoreDir);
      useStore.getState().updateTab(tab.id, { restoreDir: undefined });
      if (command) runInShell(tab.id, command, command);
    };
    restoreRef.current = restoreDirectory;

    // Shell 上报的状态和目录。终端输出是服务器说了算的，这些内容都当作不可信输入
    term.parser.registerOscHandler(133, (payload) => {
      trackerRef.current.semanticPrompt(payload);
      if (trackerRef.current.integrated) useStore.getState().updateTab(tab.id, { shellIntegrated: true });
      restoreDirectory();
      return true;
    });
    let reportTimer: ReturnType<typeof setTimeout> | undefined;
    let latestReport: string | undefined;
    const applyReport = async () => {
      reportTimer = undefined;
      const report = latestReport ? parseCwdReport(latestReport) : null;
      if (!report) return;
      const session = sessionRef.current;
      // 第一个提示符可能比“连接成功”的结果先到，等一下
      if (!session) {
        reportTimer = setTimeout(applyReport, CWD_REPORT_INTERVAL);
        return;
      }
      if (!hostnameRef.current) {
        const first = report.host;
        hostnameRef.current = api.remoteHostname(session).then(
          (name) => name ?? first,
          () => first,
        );
      }
      const hostname = await hostnameRef.current;
      if (session !== sessionRef.current) return;
      const here = !report.host || !hostname || sameHost(report.host, hostname);
      useStore.getState().updateTab(tab.id, here ? { shellDir: report.path, shellElsewhere: undefined, shellIntegrated: true } : { shellElsewhere: report.host, shellIntegrated: true });
    };
    term.parser.registerOscHandler(7, (data) => {
      latestReport = data;
      if (reportTimer === undefined) reportTimer = setTimeout(applyReport, CWD_REPORT_INTERVAL);
      return true;
    });

    terminals.set(tab.id, {
      shellStatus: () => trackerRef.current.status(term.buffer.active.type === "alternate"),
      focus: () => term.focus(),
    });

    testHook()?.terms.push(term);
    termRef.current = term;
    fitRef.current = fit;
    const ro = new ResizeObserver(() => {
      if (el.current?.offsetParent) fit.fit();
    });
    ro.observe(el.current!);
    return () => {
      terminals.delete(tab.id);
      clearTimeout(reportTimer);
      ro.disconnect();
      term.dispose();
    };
  }, []);

  // 连接 / 重连
  useEffect(() => {
    const term = termRef.current!;
    let cancelled = false;
    fitRef.current?.fit();
    // 自动重连可能试很多次，分隔线只画一条
    if (tab.attempt > 0 && !separatorShown.current) {
      separatorShown.current = true;
      // 上一个连接可能断在 vim 里：退出全屏，恢复终端的各种模式，否则新的 Shell 显示和输入都不正常。
      // 不在全屏时不能发退出全屏的序列，它会把光标恢复到保存的位置，新的输出就盖在旧内容上了
      const leaveFullscreen = term.buffer.active.type === "alternate" ? "\x1b[?1049l" : "";
      term.write(`${leaveFullscreen}\x1b[!p\x1b[?25h\r\n\x1b[2m──────── ${msg().terminal.reconnectSeparator} ────────\x1b[0m\r\n`);
    }
    trackerRef.current.reset();
    hostnameRef.current = undefined;
    unackedRef.current = 0;
    decoderRef.current = undefined;
    const flow = createFlowControl(
      (data, done) => {
        // UTF-8 直接交给 xterm；其他编码先转成文字。确认的字节数照旧按收到的算
        const encoding = encodingRef.current;
        if (encoding === DEFAULT_ENCODING) return term.write(data, done);
        if (decoderRef.current?.encoding !== encoding) decoderRef.current = { encoding, decode: createDecoder(encoding) };
        term.write(decoderRef.current.decode(data), done);
      },
      (bytes) => {
        if (sessionRef.current) api.ack(sessionRef.current, bytes).catch(() => {});
        else unackedRef.current += bytes;
      },
    );
    testHook()?.flows.push(flow);
    establish(tab, term, (data) => flow.push(data), () => cancelled)
      .then(({ sessionId: id, warnings }) => {
        if (cancelled) return api.close(id);
        sessionRef.current = id;
        if (unackedRef.current > 0) api.ack(id, unackedRef.current).catch(() => {});
        unackedRef.current = 0;
        separatorShown.current = false;
        updateTab(tab.id, { status: "connected", sessionId: id, shellIntegrated: false, shellElsewhere: undefined, retry: undefined, autoAttempt: false });
        attachEdits(tab.id, id);
        testHook()?.sessions?.push(id);
        // 第一个提示符可能比“连接成功”先到
        restoreRef.current?.();
        if (warnings.length > 0) useStore.getState().toast("error", warnings.map((w) => renderText(w)).join(msg().common.sentenceJoin));
        useStore.getState().loadHosts();
        term.focus();
      })
      .catch((e) => {
        if (cancelled) return;
        const err = toAppError(e);
        const m = msg().terminal;
        // 连接时刚好锁定，或者是锁定期间的自动重连。不算失败，解锁后接着连
        if (err.kind === "vaultLocked") return updateTab(tab.id, { status: "closed", message: m.waitingUnlock, retry: undefined, autoAttempt: false, waitingUnlock: true });
        if (!tab.autoAttempt) return updateTab(tab.id, { status: "error", message: errorText(e) });
        // 自动重连失败：网络问题接着试；需要用户操作的停下来等他，点“重新连接”时才会弹对话框
        if (err.kind === "message") return scheduleReconnect(tab.id, m.reconnectFailed(errorText(err)));
        const message = err.kind === "secretRequired" || err.kind === "authFailed" ? m.needsSecret : m.reconnectStopped(errorText(e));
        updateTab(tab.id, { status: "closed", message, retry: undefined, autoAttempt: false });
      });
    return () => {
      cancelled = true;
    };
  }, [tab.attempt]);

  useEffect(() => {
    if (tab.status === "closed") sessionRef.current = undefined;
  }, [tab.status]);

  // 设置变化
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.cursorStyle = settings.cursorStyle;
    term.options.theme = themes[theme];
    fitRef.current?.fit();
  }, [settings.fontFamily, settings.fontSize, settings.cursorStyle, theme]);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [visible, tab.sftpOpen]);

  // ---------- 终端上方的按钮 ----------
  const tb = msg().toolbar;
  const connected = tab.status === "connected";
  const focusTerm = () => termRef.current?.focus();

  const copy = () => {
    const sel = termRef.current?.getSelection();
    if (sel) writeText(sel);
    focusTerm();
  };
  const paste = () =>
    readText().then(
      (t) => (t ? pasteRef.current?.(t) : focusTerm()),
      () => focusTerm(),
    );
  const clear = () => {
    termRef.current?.clear();
    if (find) runFind(find.query);
    focusTerm();
  };
  const saveOutput = async () => {
    const term = termRef.current;
    if (!term) return;
    try {
      const path = await api.saveTerminalOutput(outputFileName(tab.title, new Date()), bufferText(term.buffer.normal));
      if (path) toast("success", tb.saved(path));
    } catch (e) {
      toast("error", tb.saveFailed(errorText(e)));
    }
    focusTerm();
  };

  /** 查找。`incremental`：边输入边找，停在当前匹配上，不跳到下一个 */
  const runFind = (query: string, backwards = false, incremental = false) => {
    const search = searchRef.current;
    if (!search) return;
    if (!query) {
      search.clearDecorations();
      setFind((f) => f && { ...f, index: -1, count: 0 });
      return;
    }
    const options = { decorations: findColors[theme], incremental };
    if (backwards) search.findPrevious(query, options);
    else search.findNext(query, options);
  };
  const openFind = () => {
    // 选中了一行以内的文字就直接查它
    const sel = termRef.current?.getSelection() ?? "";
    const query = sel && !sel.includes("\n") ? sel : (find?.query ?? "");
    setFind({ query, index: -1, count: 0 });
    requestAnimationFrame(() => {
      findInput.current?.focus();
      findInput.current?.select();
      if (query) runFind(query, false, true);
    });
  };
  openFindRef.current = openFind;
  const closeFind = () => {
    searchRef.current?.clearDecorations();
    setFind(null);
    focusTerm();
  };

  const encodingItems = ENCODINGS.flatMap((e, i) => [
    ...(i === 1 ? (["sep"] as const) : []),
    {
      label: ENCODING_LABELS[e],
      icon: e === tab.encoding ? <Check size={14} /> : <span className="menu-icon-space" />,
      onClick: () => {
        updateTab(tab.id, { encoding: e });
        focusTerm();
      },
    },
  ]);

  const savedHost = hosts.find((h) => h.id === tab.target.hostId);
  const m = msg().terminal;
  const common = msg().common;

  return (
    <div className={`term-wrap ${visible ? "active" : ""}`} style={{ display: visible ? "flex" : "none" }}>
      {/* 按下按钮时不抢走终端的键盘焦点 */}
      <div className="term-toolbar" onMouseDown={(e) => e.preventDefault()}>
        <span className="term-title">{tab.title}</span>
        <button className="icon-btn" title={tb.copy} disabled={!hasSelection} onClick={copy}>
          <Copy size={14} />
        </button>
        <button className="icon-btn" title={tb.paste} disabled={!connected} onClick={paste}>
          <ClipboardPaste size={14} />
        </button>
        <span className="sep" />
        <button className={`icon-btn ${find ? "active" : ""}`} title={tb.find} onClick={() => (find ? closeFind() : openFind())}>
          <Search size={14} />
        </button>
        <button className="icon-btn" title={tb.clear} onClick={clear}>
          <Eraser size={14} />
        </button>
        <button className="icon-btn" title={tb.save} onClick={saveOutput}>
          <Save size={14} />
        </button>
        <span className="sep" />
        <button
          className="encoding-btn"
          title={tb.encoding}
          onMouseDown={(e) => {
            // 不让菜单的“点别处关闭”先关掉它，否则再点一次变成关了又开
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setEncodingMenu(encodingMenu ? null : { x: r.left, y: r.bottom + 4 });
          }}
        >
          {ENCODING_LABELS[tab.encoding]} <ChevronDown size={12} />
        </button>
        <button
          className={`icon-btn files-btn ${tab.sftpOpen ? "active" : ""}`}
          title={tb.files}
          disabled={!connected}
          onClick={() => updateTab(tab.id, { sftpOpen: !tab.sftpOpen })}
        >
          <FolderTree size={14} />
          {busy > 0 && <span className="badge">{busy}</span>}
        </button>
      </div>
      {encodingMenu && <ContextMenu x={encodingMenu.x} y={encodingMenu.y} items={encodingItems} onClose={() => setEncodingMenu(null)} />}

      <div className="term-body">
        <div className="term-col">
          <div ref={el} className="term" />

          {find && (
            <div className="find-bar">
              <input
                ref={findInput}
                className="input"
                placeholder={tb.findPlaceholder}
                spellCheck={false}
                value={find.query}
                onChange={(e) => {
                  const query = e.target.value;
                  setFind((f) => f && { ...f, query });
                  runFind(query, false, true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runFind(find.query, e.shiftKey);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    closeFind();
                  }
                }}
              />
              <span className="find-count">{find.query && (find.count > 0 ? `${find.index + 1}/${find.count}` : tb.findNone)}</span>
              <button className="icon-btn" title={tb.findPrev} disabled={find.count === 0} onClick={() => runFind(find.query, true)}>
                <ChevronUp size={14} />
              </button>
              <button className="icon-btn" title={tb.findNext} disabled={find.count === 0} onClick={() => runFind(find.query)}>
                <ChevronDown size={14} />
              </button>
              <button className="icon-btn" title={tb.findClose} onClick={closeFind}>
                <X size={14} />
              </button>
            </div>
          )}

          {/* 自动重连时不挡住终端，断开前的输出还要能看 */}
          {tab.status === "connecting" && tab.autoAttempt && (
            <div className="banner">
              <div className="spinner sm" />
              <span className="msg">{m.reconnecting(tab.retry?.attempt)}</span>
              <button className="icon-btn" onClick={() => closeTab(tab.id)} title={m.closeSession}>
                <X size={14} />
              </button>
            </div>
          )}

          {tab.status === "connected" && tab.restoreDir && (
            <div className="banner">
              <span className="msg">{m.restoreDir(displayName(tab.restoreDir))}</span>
              <button
                className="btn primary sm"
                onClick={() => {
                  const dir = tab.restoreDir!;
                  const cd = cdCommand(dir);
                  updateTab(tab.id, { restoreDir: undefined });
                  if (!cd) return useStore.getState().toast("error", common.controlCharsPath);
                  // 集成只在当时的 Shell 里生效，用户开启过的话一起恢复
                  const command = tab.integrationWanted ? `${integrationOneLiner()}; ${cd}` : cd;
                  runInShell(tab.id, command, displayName(command));
                }}
              >
                {m.goBack}
              </button>
              <button className="icon-btn" onClick={() => updateTab(tab.id, { restoreDir: undefined })} title={m.dismiss}>
                <X size={14} />
              </button>
            </div>
          )}

          {tab.status === "connecting" && !tab.autoAttempt && (
            <div className="overlay">
              <div className="overlay-card">
                <div className="spinner" />
                <div>{m.connectingTo(`${tab.target.username}@${tab.target.host}${tab.target.port !== 22 ? `:${tab.target.port}` : ""}`)}</div>
              </div>
            </div>
          )}

          {tab.status === "error" && (
            <div className="overlay">
              <div className="overlay-card">
                <AlertTriangle size={26} color="var(--danger)" />
                <div style={{ fontWeight: 600 }}>{m.connectFailed}</div>
                <div className="msg">{tab.message}</div>
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <button className="btn primary" onClick={() => reconnect(tab.id)}>
                    <RotateCw size={14} /> {common.retry}
                  </button>
                  {savedHost && (
                    <button className="btn" onClick={() => set("editor", { open: true, host: savedHost })}>
                      <Pencil size={14} /> {m.editHost}
                    </button>
                  )}
                  <button className="btn ghost" onClick={() => closeTab(tab.id)}>
                    <X size={14} /> {common.close}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 会话结束：用底部浮条提示，保留终端最后的输出可读 */}
          {tab.status === "closed" && (
            <div className="banner">
              <Unplug size={15} color="var(--text-3)" />
              <span className="msg">
                {tab.message && displayName(tab.message)}
                {tab.retry && m.retryIn(tab.retry.seconds, tab.retry.attempt)}
              </span>
              <button className="btn primary sm" onClick={() => reconnect(tab.id)}>
                <RotateCw size={13} /> {tab.retry ? m.reconnectNow : m.reconnect}
              </button>
              {tab.retry && (
                <button className="btn sm ghost" onClick={() => useStore.getState().cancelRetry(tab.id)}>
                  {m.cancelRetry}
                </button>
              )}
              <button className="icon-btn" onClick={() => closeTab(tab.id)} title={m.closeSession}>
                <X size={14} />
              </button>
            </div>
          )}
        </div>

        {tab.sftpOpen && tab.sessionId && tab.status === "connected" && (
          <SftpPanel tabId={tab.id} sessionId={tab.sessionId} active={visible} />
        )}
      </div>
    </div>
  );
}
