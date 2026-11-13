import { AlertCircle, ArrowUpCircle, CheckCircle2, Info, Lock, PanelLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { HostEditor } from "./components/HostEditor";
import { Prompts } from "./components/Prompts";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { TerminalView } from "./components/TerminalView";
import { TitleBar } from "./components/TitleBar";
import { AboutDialog } from "./components/About";
import { UpdateDialog } from "./components/Update";
import { LockScreen } from "./components/Vault";
import { Welcome } from "./components/Welcome";
import { msg, renderText, useLanguage } from "./i18n";
import { api, updateApi, vaultApi } from "./lib/api";
import { cycleTab, dialogs, onVaultLocked, refreshVault, resolveTheme, scheduleReconnect, useStore } from "./lib/store";

function StatusBar() {
  const m = msg();
  const { tabs, activeTab, settings, updateSettings, availableUpdate, set } = useStore();
  const tab = tabs.find((t) => t.id === activeTab);
  return (
    <div className="statusbar">
      <button onClick={() => updateSettings({ sidebarOpen: !settings.sidebarOpen })} title={m.status.sidebar}>
        <PanelLeft size={13} />
      </button>
      {tab ? (
        <>
          <span className="item">
            <span className={`dot ${tab.status}`} />
            {m.status[tab.status]}
          </span>
          <span className="item">
            {tab.target.username}@{tab.target.host}:{tab.target.port}
          </span>
          <span className="item">
            <Lock size={11} /> {m.auth[tab.target.auth]}
          </span>
        </>
      ) : (
        <span className="item">{m.status.ready}</span>
      )}
      <span className="spacer" />
      {availableUpdate && (
        <button className="update-available" onClick={() => set("updateOpen", true)}>
          <ArrowUpCircle size={13} /> {m.update.newVersion(availableUpdate.version)}
        </button>
      )}
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "success" ? <CheckCircle2 size={16} /> : t.kind === "error" ? <AlertCircle size={16} /> : <Info size={16} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const s = useStore();
  // 切换语言时整个界面重新渲染，组件里直接读当前语言的文字
  const lang = useLanguage();

  useEffect(() => {
    refreshVault();
    const unLocked = vaultApi.onLocked(onVaultLocked);
    s.loadHosts();
    api.storeTakeIssues().then(async (issues) => {
      for (const { title, message } of issues) {
        await dialogs.confirm({ title: renderText(title), message: renderText(message), notice: true, confirmText: msg().common.gotIt });
      }
    });
    const un = api.onClosed(({ sessionId, reason, lost }) => {
      const state = useStore.getState();
      const tab = state.tabs.find((t) => t.sessionId === sessionId);
      if (!tab) return;
      // 文件面板的开关保持原样，重新连接后接着用
      const text = renderText(reason);
      state.updateTab(tab.id, { status: "closed", sessionId: undefined, message: text, retry: undefined });
      if (lost && state.settings.autoReconnect) scheduleReconnect(tab.id, text);
    });
    return () => {
      un.then((f) => f());
      unLocked.then((f) => f());
    };
  }, []);

  // 用户有操作就告诉后端，空闲时间由后端计算。不用每次都说
  useEffect(() => {
    let last = 0;
    const onActivity = () => {
      const { vault } = useStore.getState();
      if (!vault?.enabled || vault.locked || Date.now() - last < 5000) return;
      last = Date.now();
      vaultApi.touch().catch(() => {});
    };
    const events = ["keydown", "mousedown", "mousemove", "wheel"];
    events.forEach((name) => window.addEventListener(name, onActivity, { capture: true, passive: true }));
    return () => events.forEach((name) => window.removeEventListener(name, onActivity, { capture: true }));
  }, []);

  // 锁定时下面的内容既不能点也不能得到焦点，键盘输入不会进到终端里
  const locked = !s.vault || s.vault.locked;
  const appRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    appRef.current?.toggleAttribute("inert", locked);
  }, [locked]);

  // 启动时查一次更新。锁定时什么都不提示，解锁后才查。失败不打扰，用户可以在设置里手动检查
  const updateChecked = useRef(false);
  useEffect(() => {
    if (locked || updateChecked.current) return;
    updateChecked.current = true;
    if (!s.settings.checkUpdates) return;
    updateApi
      .status()
      .then((status) => (status.configured ? updateApi.check() : null))
      .then((found) => found && s.set("availableUpdate", found))
      .catch(() => {});
  }, [locked]);

  const theme = resolveTheme(s);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (!st.vault || st.vault.locked) return;
      if (!e.ctrlKey || e.altKey) return;
      // 用 e.code 而非 e.key：不受键盘布局和中文输入法（key 为 "Process"）影响
      const key = e.code.replace(/^Key/, "").toLowerCase();
      const tab = st.tabs.find((t) => t.id === st.activeTab);
      let handled = true;
      if (!e.shiftKey && (key === "k" || key === "t")) st.set("paletteOpen", !st.paletteOpen);
      else if (!e.shiftKey && key === "n") st.set("editor", { open: true });
      else if (!e.shiftKey && key === "b") st.updateSettings({ sidebarOpen: !st.settings.sidebarOpen });
      else if (!e.shiftKey && key === "w" && tab) st.closeTab(tab.id);
      else if (e.shiftKey && key === "e" && tab?.status === "connected") st.updateTab(tab.id, { sftpOpen: !tab.sftpOpen });
      else if (key === "tab") cycleTab(e.shiftKey ? -1 : 1);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // 捕获阶段，优先于 xterm 处理
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // 禁用 WebView 默认右键菜单（输入框除外）
  useEffect(() => {
    const block = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
    };
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  return (
    <>
      <div ref={appRef} className="app" data-vault={s.vault ? "ready" : "loading"} data-lang={lang}>
        <TitleBar />
        <div className="body">
          {s.settings.sidebarOpen && <Sidebar />}
          <main className="main">
            {s.tabs.length === 0 && <Welcome />}
            {s.tabs.map((t) => (
              <TerminalView key={t.id} tab={t} visible={t.id === s.activeTab} />
            ))}
          </main>
        </div>
        <StatusBar />

        {s.editor.open && <HostEditor key={s.editor.host?.id ?? "new"} />}
        {s.paletteOpen && <CommandPalette />}
        {s.settingsOpen && <SettingsDialog />}
        {s.aboutOpen && <AboutDialog />}
        {s.updateOpen && <UpdateDialog />}
        <Prompts />
        <Toasts />
      </div>
      {locked && <LockScreen />}
    </>
  );
}
