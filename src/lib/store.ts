import { create } from "zustand";
import { applyLanguage, LanguageChoice, msg, renderText } from "../i18n";
import { api, ConnectTarget, editApi, errorCode, errorText, Host, HostKeyError, Progress, UpdateInfo, vaultApi, VaultStatus } from "./api";
import { DEFAULT_ENCODING, Encoding, isEncoding } from "./encoding";
import { displayName } from "./names";
import { testHook } from "./testHook";
import { ShellStatus } from "./shell";

export type TabStatus = "connecting" | "connected" | "closed" | "error";

export interface Tab {
  id: string;
  title: string;
  target: ConnectTarget;
  status: TabStatus;
  sessionId?: string;
  message?: string;
  sftpOpen: boolean;
  /** 终端输入输出用的编码。从主机设置来，可以在这个会话里临时切换 */
  encoding: Encoding;
  /** 递增以触发重新连接 */
  attempt: number;
  /** 同一主机下的会话编号，关闭其他会话后保持不变 */
  seq: number;
  /** 终端上报的当前目录，已校验过格式 */
  shellDir?: string;
  /** 上报的目录在另一台机器上（比如在终端里又 ssh 到了别处），这时文件面板不跟随 */
  shellElsewhere?: string;
  /** 这个 Shell 开启了集成，能上报目录和状态 */
  shellIntegrated?: boolean;
  /** 文件面板正在看的目录。关掉面板或重新连接后回到这里 */
  sftpDir?: string;
  /** 文件面板最后跟随到的终端目录。终端的目录没变就不再跳，免得顶掉用户自己翻到的目录 */
  followedDir?: string;
  /** 这个目录里的内容变了（比如编辑的文件传回去了），文件面板要刷新 */
  changedDir?: { dir: string; n: number };
  /** 这次连接是自动重连发起的：不弹对话框，失败了按计划再试 */
  autoAttempt?: boolean;
  /** 自动重连的计划：第几次、多少秒后 */
  retry?: { attempt: number; seconds: number };
  /** 断开前终端所在的目录，重新连接后回到这里 */
  restoreDir?: string;
  /** 用户为这个会话开启过 Shell 集成。集成只在当时的 Shell 里生效，重新连接后要再开一次 */
  integrationWanted?: boolean;
  /** 连接时保险库锁着，解锁后接着连 */
  waitingUnlock?: boolean;
}

export type EditStatus = "synced" | "syncing" | "conflict" | "deleted" | "readOnly" | "failed" | "missing";

/** 用本地程序打开的远程文件 */
export interface EditItem {
  id: string;
  tabId: string;
  name: string;
  remote: string;
  status: EditStatus;
  error?: string;
}

export type TransferStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Transfer {
  id: string;
  /** 属于哪个会话标签，关闭标签时一并取消 */
  tabId: string;
  name: string;
  direction: "upload" | "download";
  transferred: number;
  total: number;
  status: TransferStatus;
  error?: string;
  /** 已经要求取消，等传输真正停下来。已发出的数据要先传完，所以可能要等一会儿 */
  cancelling?: boolean;
  /** 上传的目标目录，传完后文件面板据此决定要不要刷新 */
  dir?: string;
}

/** 每个会话同时进行的传输数。同一条 SSH 连接上同时传太多，只会互相拖慢 */
export const MAX_PARALLEL_TRANSFERS = 3;

export type ResolvedTheme = "dark" | "light";

export interface Settings {
  theme: "system" | ResolvedTheme;
  fontFamily: string;
  fontSize: number;
  cursorStyle: "block" | "bar" | "underline";
  copyOnSelect: boolean;
  /** 粘贴含换行的内容前先确认 */
  confirmMultilinePaste: boolean;
  sidebarOpen: boolean;
  /** 文件面板跟随终端的当前目录 */
  followTerminalDir: boolean;
  /** 连接意外断开时自动重连 */
  autoReconnect: boolean;
  /** 启动时检查更新 */
  checkUpdates: boolean;
  /** 界面语言，默认跟随系统 */
  language: LanguageChoice;
}

export type Prompt =
  | {
      type: "secret";
      title: string;
      message: string;
      label: string;
      canRemember: boolean;
      resolve: (v: { secret: string; remember: boolean } | null) => void;
    }
  | { type: "hostKey"; error: HostKeyError; resolve: (ok: boolean) => void }
  | {
      type: "confirm";
      title: string;
      message: string;
      danger?: boolean;
      confirmText?: string;
      cancelText?: string;
      /** 等宽显示的补充内容，比如要粘贴的文本 */
      detail?: string;
      /** 只是告知，只显示一个按钮 */
      notice?: boolean;
      resolve: (ok: boolean) => void;
    }
  | { type: "input"; title: string; label: string; value: string; resolve: (v: string | null) => void }
  | { type: "recoveryKey"; recoveryKey: string; resolve: (v: void) => void };

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

const defaultSettings: Settings = {
  theme: "system",
  fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
  fontSize: 14,
  cursorStyle: "bar",
  copyOnSelect: true,
  confirmMultilinePaste: true,
  sidebarOpen: true,
  followTerminalDir: true,
  autoReconnect: true,
  checkUpdates: true,
  language: "system",
};

function loadSettings(): Settings {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem("termipaw.settings") || "{}") };
  } catch {
    return defaultSettings;
  }
}

// 只有系统明确为深色时才用深色，其余情况（包括无法判断）一律为浅色
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const systemTheme = (): ResolvedTheme => (darkQuery.matches ? "dark" : "light");

interface State {
  systemTheme: ResolvedTheme;
  /** 还没问过后端时为 null：这时也遮住界面，免得启动时闪过主机列表 */
  vault: VaultStatus | null;
  hosts: Host[];
  tabs: Tab[];
  activeTab: string | null;
  settings: Settings;
  /** tabId：把这个临时连接保存为主机时使用 */
  editor: { open: boolean; host?: Host; tabId?: string };
  paletteOpen: boolean;
  settingsOpen: boolean;
  aboutOpen: boolean;
  prompt: Prompt | null;
  toasts: Toast[];
  /** 新的在前。放在这里而不是文件面板里，关掉面板后传输仍在进行，重新打开还能看到 */
  transfers: Transfer[];
  edits: EditItem[];
  availableUpdate: UpdateInfo | null;
  updateOpen: boolean;

  loadHosts(): Promise<void>;
  saveHost(host: Host, secret?: string): Promise<void>;
  deleteHost(id: string): Promise<void>;

  openTab(target: ConnectTarget, title: string, encoding?: string | null): void;
  /** 主机已有会话时切换过去，否则发起连接 */
  connectHost(host: Host): void;
  newSession(host: Host): void;
  closeTab(id: string): void;
  updateTab(id: string, patch: Partial<Tab>): void;
  reconnect(id: string, auto?: boolean): void;
  /** 取消还没开始的自动重连 */
  cancelRetry(id: string): void;

  /** 加入传输队列，同一会话最多同时进行 MAX_PARALLEL_TRANSFERS 个。传完（成功为 true）时返回 */
  enqueueTransfer(spec: {
    tabId: string;
    name: string;
    direction: Transfer["direction"];
    dir?: string;
    run: (transferId: string, onProgress: (p: Progress) => void) => Promise<void>;
  }): Promise<boolean>;
  cancelTransfer(id: string): void;
  removeTransfer(id: string): void;

  set<K extends keyof State>(key: K, value: State[K]): void;
  updateSettings(patch: Partial<Settings>): void;
  toast(kind: Toast["kind"], text: string): void;
}

let toastSeq = 0;

export const useStore = create<State>((set, get) => ({
  systemTheme: systemTheme(),
  vault: null,
  hosts: [],
  tabs: [],
  activeTab: null,
  settings: loadSettings(),
  editor: { open: false },
  paletteOpen: false,
  settingsOpen: false,
  aboutOpen: false,
  prompt: null,
  toasts: [],
  transfers: [],
  edits: [],
  availableUpdate: null,
  updateOpen: false,

  async loadHosts() {
    try {
      set({ hosts: await api.hostsList() });
    } catch (e) {
      get().toast("error", errorText(e));
    }
  },
  async saveHost(host, secret) {
    await api.hostsSave(host, secret);
    await get().loadHosts();
  },
  async deleteHost(id) {
    await api.hostsDelete(id);
    await get().loadHosts();
  },

  openTab(target, title, encoding) {
    const id = crypto.randomUUID();
    set((s) => {
      const same = target.hostId ? s.tabs.filter((t) => t.target.hostId === target.hostId) : [];
      const seq = Math.max(0, ...same.map((t) => t.seq)) + 1;
      const tab: Tab = { id, title, target, status: "connecting", sftpOpen: false, encoding: isEncoding(encoding) ? encoding : DEFAULT_ENCODING, attempt: 0, seq };
      return {
        tabs: [...s.tabs, tab],
        activeTab: id,
      };
    });
  },
  connectHost(host) {
    const { tabs, activeTab } = get();
    const sessions = tabs.filter((t) => t.target.hostId === host.id);
    if (sessions.length === 0) return get().newSession(host);
    set({ activeTab: (sessions.find((t) => t.id === activeTab) ?? sessions[0]).id });
  },
  newSession(host) {
    get().openTab(
      { hostId: host.id, host: host.host, port: host.port, username: host.username, auth: host.auth, keyPath: host.keyPath },
      host.name || `${host.username}@${host.host}`,
      host.encoding,
    );
  },
  closeTab(id) {
    const { hosts, tabs, activeTab } = get();
    const tab = tabs.find((t) => t.id === id);
    clearRetryTimer(id);
    // 会话关了，它的传输也没法继续：先取消，再从列表里去掉。
    // 进行中的传输要等它们自己收尾（清理临时文件需要连接还在），所以稍后再关会话，最多等 3 秒
    const unwinding = get()
      .transfers.filter((t) => t.tabId === id && t.status === "running")
      .map((t) => transferJobs.get(t.id)?.finished)
      .filter((p): p is Promise<boolean> => !!p);
    get()
      .transfers.filter((t) => t.tabId === id)
      .forEach((t) => get().cancelTransfer(t.id));
    if (tab?.sessionId) {
      const sessionId = tab.sessionId;
      const grace = new Promise((resolve) => setTimeout(resolve, 3000));
      Promise.race([Promise.all(unwinding), grace]).then(() => api.close(sessionId).catch(() => {}));
    }
    get()
      .edits.filter((e) => e.tabId === id)
      .forEach((e) => stopEdit(e.id));
    const list = tabsInListOrder(hosts, tabs);
    const idx = list.findIndex((t) => t.id === id);
    const rest = list.filter((t) => t.id !== id);
    set({
      tabs: tabs.filter((t) => t.id !== id),
      transfers: get().transfers.filter((t) => t.tabId !== id),
      activeTab: activeTab === id ? (rest[Math.min(idx, rest.length - 1)]?.id ?? null) : activeTab,
    });
  },
  updateTab(id, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  },
  reconnect(id, auto = false) {
    const tab = get().tabs.find((t) => t.id === id);
    clearRetryTimer(id);
    if (tab) {
      get().updateTab(id, {
        status: "connecting",
        sessionId: undefined,
        message: undefined,
        attempt: tab.attempt + 1,
        autoAttempt: auto,
        waitingUnlock: false,
        retry: auto ? tab.retry : undefined,
        // 断开前知道终端在哪，重新连接后回去。多次重试时不能被清掉
        restoreDir: tab.shellDir ?? tab.restoreDir,
      });
    }
  },
  cancelRetry(id) {
    clearRetryTimer(id);
    get().updateTab(id, { retry: undefined });
  },

  enqueueTransfer({ tabId, name, direction, dir, run }) {
    const id = crypto.randomUUID();
    let done!: (ok: boolean) => void;
    const finished = new Promise<boolean>((resolve) => (done = resolve));
    transferJobs.set(id, { run, done, finished });
    set((s) => ({ transfers: [{ id, tabId, name, direction, dir, transferred: 0, total: 0, status: "queued" }, ...s.transfers] }));
    pumpTransfers(tabId);
    return finished;
  },
  cancelTransfer(id) {
    const t = get().transfers.find((x) => x.id === id);
    if (t?.status === "queued") {
      // 还没开始：不用通知后端
      const job = transferJobs.get(id);
      transferJobs.delete(id);
      patchTransfer(id, { status: "cancelled", error: renderText({ code: "transfer.cancelled" }) });
      job?.done(false);
      pumpTransfers(t.tabId);
    } else if (t?.status === "running") {
      patchTransfer(id, { cancelling: true });
      api.sftpCancel(id).catch(() => {});
    }
  },
  removeTransfer(id) {
    set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id || t.status === "queued" || t.status === "running") }));
  },

  set(key, value) {
    set({ [key]: value } as Partial<State>);
  },
  updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    localStorage.setItem("termipaw.settings", JSON.stringify(settings));
    if (patch.language && patch.language !== get().settings.language) applyLanguage(settings.language);
    set({ settings });
  },
  toast(kind, text) {
    const id = ++toastSeq;
    // 文字可能带着服务器给的文件名或错误信息
    set((s) => ({ toasts: [...s.toasts, { id, kind, text: displayName(text) }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3500);
  },
}));

// ---------- 自动重连 ----------

/** 每次重试前等待的秒数。服务器重启要一两分钟，所以总共试大约三分钟 */
const RETRY_DELAYS = [2, 5, 10, 20, 30, 30, 30, 30, 30];
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearRetryTimer(id: string) {
  clearTimeout(retryTimers.get(id));
  retryTimers.delete(id);
}

/** 安排下一次自动重连。次数用完后停下来，等用户手动重连 */
export function scheduleReconnect(id: string, message: string) {
  const { tabs, updateTab } = useStore.getState();
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  const attempt = (tab.retry?.attempt ?? 0) + 1;
  const seconds = RETRY_DELAYS[attempt - 1];
  if (seconds === undefined) {
    updateTab(id, { status: "closed", message: msg().terminal.retriesExhausted(message), retry: undefined, autoAttempt: false });
    return;
  }
  updateTab(id, { status: "closed", message, retry: { attempt, seconds }, autoAttempt: false });
  clearRetryTimer(id);
  retryTimers.set(
    id,
    setTimeout(() => {
      retryTimers.delete(id);
      useStore.getState().reconnect(id, true);
    }, seconds * 1000),
  );
}

// ---------- 传输队列 ----------

interface TransferJob {
  run: (transferId: string, onProgress: (p: Progress) => void) => Promise<void>;
  done: (ok: boolean) => void;
  /** 传完（含失败、取消）后才兑现 */
  finished: Promise<boolean>;
}

/** 排队或进行中的传输要做的事（函数放不进状态里） */
const transferJobs = new Map<string, TransferJob>();

function patchTransfer(id: string, patch: Partial<Transfer>) {
  useStore.setState((s) => ({ transfers: s.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

/** 这个会话还有空位就从排队的里面最早的开始 */
function pumpTransfers(tabId: string) {
  const { transfers } = useStore.getState();
  let running = transfers.filter((t) => t.tabId === tabId && t.status === "running").length;
  // 列表里新的在前，所以从后往前就是先排的先开始
  for (const t of [...transfers].reverse()) {
    if (running >= MAX_PARALLEL_TRANSFERS) break;
    if (t.tabId === tabId && t.status === "queued") {
      running++;
      startTransfer(t.id, tabId);
    }
  }
}

function startTransfer(id: string, tabId: string) {
  const job = transferJobs.get(id);
  if (!job) return;
  patchTransfer(id, { status: "running" });
  const finish = (patch: Partial<Transfer>, ok: boolean) => {
    patchTransfer(id, patch);
    transferJobs.delete(id);
    job.done(ok);
    pumpTransfers(tabId);
  };
  job.run(id, (p) => patchTransfer(id, p)).then(
    () => finish({ status: "done" }, true),
    (e) => finish({ status: errorCode(e) === "transfer.cancelled" ? "cancelled" : "failed", error: errorText(e) }, false),
  );
}

/** 左侧列表的分组与排序：按分组名排序，没有分组的（键为空字符串）在最后，显示名由界面按语言决定 */
export function groupHosts(hosts: Host[]): [string, Host[]][] {
  const map = new Map<string, Host[]>();
  for (const h of [...hosts].sort((a, b) => a.name.localeCompare(b.name))) {
    const g = h.group?.trim() || "";
    map.set(g, [...(map.get(g) || []), h]);
  }
  return [...map.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
}

/** 未保存的主机（快速连接，或主机已被删除）上的会话 */
export const temporaryTabs = (hosts: Host[], tabs: Tab[]) => tabs.filter((t) => !hosts.some((h) => h.id === t.target.hostId));

/** 会话在左侧列表中的显示顺序。Ctrl+Tab 和关闭后的切换都按它走，否则选中项会在列表里乱跳 */
function tabsInListOrder(hosts: Host[], tabs: Tab[]): Tab[] {
  const saved = groupHosts(hosts).flatMap(([, items]) => items.flatMap((h) => tabs.filter((t) => t.target.hostId === h.id)));
  return [...temporaryTabs(hosts, tabs), ...saved];
}

/** 切换到列表中的上一个 / 下一个会话 */
export function cycleTab(direction: 1 | -1) {
  const { hosts, tabs, activeTab } = useStore.getState();
  const list = tabsInListOrder(hosts, tabs);
  if (list.length < 2) return;
  const i = list.findIndex((t) => t.id === activeTab);
  useStore.setState({ activeTab: list[(i + direction + list.length) % list.length].id });
}

darkQuery.addEventListener("change", () => useStore.setState({ systemTheme: systemTheme() }));
applyLanguage(useStore.getState().settings.language);

/** 实际生效的主题（已解析“跟随系统”） */
export const resolveTheme = (s: Pick<State, "settings" | "systemTheme">): ResolvedTheme =>
  s.settings.theme === "system" ? s.systemTheme : s.settings.theme;

// ---------- 基于 Promise 的对话框 ----------

type Omit2<T> = T extends unknown ? Omit<T, "resolve" | "type"> : never;
type PromptOf<K extends Prompt["type"]> = Extract<Prompt, { type: K }>;
type ResultOf<K extends Prompt["type"]> = Parameters<PromptOf<K>["resolve"]>[0];

/** 等着显示的对话框。不能直接替换正在显示的：被替换的那个永远等不到回答，比如正在输入密码的连接会一直卡住 */
const waitingPrompts: Prompt[] = [];

function ask<K extends Prompt["type"]>(type: K, opts: Omit2<PromptOf<K>>): Promise<ResultOf<K>> {
  return new Promise((resolve) => {
    const prompt = {
      ...opts,
      type,
      resolve: (v: ResultOf<K>) => {
        useStore.setState({ prompt: waitingPrompts.shift() ?? null });
        resolve(v);
      },
    } as unknown as Prompt;
    if (useStore.getState().prompt) waitingPrompts.push(prompt);
    else useStore.setState({ prompt });
  });
}

export const dialogs = {
  secret: (o: Omit2<PromptOf<"secret">>) => ask("secret", o),
  hostKey: (error: HostKeyError) => ask("hostKey", { error }),
  confirm: (o: Omit2<PromptOf<"confirm">>) => ask("confirm", o),
  input: (o: Omit2<PromptOf<"input">>) => ask("input", o),
  recoveryKey: (recoveryKey: string) => ask("recoveryKey", { recoveryKey }),
};

// ---------- 保险库 ----------

export async function refreshVault() {
  useStore.setState({ vault: await vaultApi.status() });
}

/** 解锁或重置之后：取回主机列表，接着连等解锁的会话，把键盘交还给终端 */
export async function onVaultUnlocked() {
  await refreshVault();
  const state = useStore.getState();
  await state.loadHosts();
  state.tabs.filter((t) => t.waitingUnlock).forEach((t) => state.reconnect(t.id, true));
  if (state.activeTab) terminals.get(state.activeTab)?.focus();
  // 重置时可能发现主机文件有问题
  const issues = await api.storeTakeIssues();
  for (const { title, message } of issues) await dialogs.confirm({ title: renderText(title), message: renderText(message), notice: true, confirmText: msg().common.gotIt });
}

/** 后端已经锁定：主机信息加密时列表也没了 */
export async function onVaultLocked() {
  await refreshVault();
  await useStore.getState().loadHosts();
}

// ---------- 用本地程序编辑 ----------

const parentDir = (path: string) => path.replace(/\/[^/]*$/, "") || "/";

function patchEdit(id: string, patch: Partial<EditItem>) {
  useStore.setState((s) => ({ edits: s.edits.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
}

/** 正在传的时候又保存了一次，传完再传一次 */
const editResync = new Set<string>();
/** 正在等用户回答的文件。这期间又保存不用再问：用户同意后传的就是最新内容，不同意就留在本地 */
const editAsking = new Set<string>();

export async function openForEdit(tabId: string, sessionId: string, name: string, remote: string, withProgram: boolean) {
  const { edits, enqueueTransfer, removeTransfer, toast } = useStore.getState();
  const existing = edits.find((e) => e.tabId === tabId && e.remote === remote);
  if (existing) return editApi.reopen(existing.id, withProgram).catch((e) => toast("error", errorText(e)));
  let editId: string | undefined;
  let failure: string | undefined;
  let failureCode: string | undefined;
  let transfer: string | undefined;
  const ok = await enqueueTransfer({
    tabId,
    name,
    direction: "download",
    run: async (transferId, onProgress) => {
      transfer = transferId;
      try {
        const opened = await editApi.open(
          sessionId,
          transferId,
          remote,
          withProgram,
          (event) => {
            if (!editId) return;
            if (event.kind === "changed") syncEdit(editId);
            else patchEdit(editId, { status: "missing", error: msg().sftp.editStatus.missing });
          },
          onProgress,
        );
        editId = opened.id;
      } catch (e) {
        failure = errorText(e);
        failureCode = errorCode(e);
        throw e;
      }
    },
  });
  if (!ok || !editId) {
    if (failure && failureCode === "edit.blocked") {
      // 没有发生传输，不留在传输列表里。说明比较长，提示框一闪而过读不完
      if (transfer) removeTransfer(transfer);
      await dialogs.confirm({ title: msg().edit.cannotOpenTitle, message: failure, notice: true, confirmText: msg().common.gotIt });
    } else if (failure && failureCode !== "transfer.cancelled") {
      toast("error", failure);
    }
    return;
  }
  // 下面的编辑列表会接着显示这个文件
  if (transfer) removeTransfer(transfer);
  const id = editId;
  testHook()?.edits?.push(id);
  useStore.setState((s) => ({ edits: [...s.edits, { id, tabId, name, remote, status: "synced" }] }));
}

/** 问用户要不要继续传回。回答之前，这个文件的保存都不再弹询问 */
async function askAboutEdit(id: string, question: Parameters<typeof dialogs.confirm>[0]) {
  editResync.delete(id);
  editAsking.add(id);
  try {
    return await dialogs.confirm(question);
  } finally {
    editAsking.delete(id);
  }
}

/** 把本地文件传回服务器。服务器上的文件变过时、文件是只读时先问用户 */
export async function syncEdit(id: string, { force = false, allowReadOnly = false } = {}): Promise<void> {
  const { edits, enqueueTransfer, removeTransfer, toast, tabs, updateTab } = useStore.getState();
  const item = edits.find((e) => e.id === id);
  if (!item || editAsking.has(id)) return;
  if (item.status === "syncing") {
    editResync.add(id);
    return;
  }
  // 连接断开时没法传，保留状态，重新连接后再传
  if (!tabs.find((t) => t.id === item.tabId)?.sessionId) {
    patchEdit(id, { status: "failed", error: msg().edit.offline });
    return;
  }
  patchEdit(id, { status: "syncing", error: undefined });
  let result: Awaited<ReturnType<typeof editApi.upload>>["result"] | undefined;
  let transfer: string | undefined;
  let failure: string | undefined;
  const dir = parentDir(item.remote);
  const ok = await enqueueTransfer({
    tabId: item.tabId,
    name: item.name,
    direction: "upload",
    dir,
    run: async (transferId, onProgress) => {
      transfer = transferId;
      try {
        result = (await editApi.upload(id, transferId, force, allowReadOnly, onProgress)).result;
      } catch (e) {
        failure = errorText(e);
        throw e;
      }
    },
  });
  // 编辑的文件每次保存都传一次，传完的不留在列表里
  if (transfer && ok) removeTransfer(transfer);
  if (!useStore.getState().edits.some((e) => e.id === id)) return;
  if (!ok) {
    patchEdit(id, { status: "failed", error: failure ?? msg().edit.notSynced });
  } else if (result === "done" || result === "unchanged") {
    patchEdit(id, { status: "synced", error: undefined });
    if (result === "done") {
      toast("success", msg().edit.synced(item.name));
      const tab = useStore.getState().tabs.find((t) => t.id === item.tabId);
      if (tab) updateTab(tab.id, { changedDir: { dir, n: (tab.changedDir?.n ?? 0) + 1 } });
    }
  } else if (result === "readOnly") {
    patchEdit(id, { status: "readOnly", error: undefined });
    const m = msg();
    const replace = await askAboutEdit(id, {
      title: m.edit.readOnlyTitle,
      message: m.edit.readOnlyMessage(displayName(item.name)),
      danger: true,
      confirmText: m.sftp.replace,
      cancelText: m.edit.notNow,
    });
    // 如果是覆盖“别人也改过”时问到这里，那个回答还有效
    if (replace) return syncEdit(id, { force, allowReadOnly: true });
    return;
  } else {
    const deleted = result === "deletedOnServer";
    patchEdit(id, { status: deleted ? "deleted" : "conflict", error: undefined });
    const m = msg();
    const overwrite = await askAboutEdit(id, {
      title: deleted ? m.edit.deletedTitle : m.edit.changedTitle,
      message: deleted ? m.edit.deletedMessage(displayName(item.name)) : m.edit.changedMessage(displayName(item.name)),
      danger: true,
      confirmText: deleted ? m.sftp.recreate : m.sftp.overwrite,
      cancelText: m.edit.notNow,
    });
    if (overwrite) return syncEdit(id, { force: true });
    return;
  }
  if (editResync.delete(id)) return syncEdit(id);
}

/** 停止编辑。还有没传回去的修改时，告诉用户文件留在哪里 */
export async function stopEdit(id: string) {
  const item = useStore.getState().edits.find((e) => e.id === id);
  useStore.setState((s) => ({ edits: s.edits.filter((e) => e.id !== id) }));
  editResync.delete(id);
  const kept = await editApi.stop(id).catch(() => null);
  if (kept) {
    const m = msg();
    await dialogs.confirm({
      title: m.edit.unsyncedTitle,
      message: m.edit.unsyncedMessage(displayName(item?.name ?? "")),
      detail: kept,
      notice: true,
      confirmText: m.common.gotIt,
    });
  }
}

/** 重新连接后接回正在编辑的文件，把断线期间保存的修改传回去 */
export async function attachEdits(tabId: string, sessionId: string) {
  for (const item of useStore.getState().edits.filter((e) => e.tabId === tabId)) {
    try {
      await editApi.attach(item.id, sessionId);
      if (item.status === "failed") await syncEdit(item.id);
    } catch (e) {
      patchEdit(item.id, { status: "failed", error: errorText(e) });
    }
  }
}

// ---------- 向终端输入命令 ----------

/** 每个会话的终端，由 TerminalView 登记。放不进状态里：状态变化太频繁，也不需要驱动界面 */
export interface TerminalControl {
  shellStatus(): ShellStatus;
  focus(): void;
}
export const terminals = new Map<string, TerminalControl>();

/**
 * 替用户往终端输入一条命令。Shell 不一定在等命令：可能开着 vim，可能在等密码，当前行也可能打了一半，
 * 所以先判断。全屏程序和打了一半的行直接拒绝；判断不了时让用户确认。
 * requested：用户刚点了专门做这件事的按钮，判断不了时不再确认
 */
export async function runInShell(tabId: string, command: string, shownCommand: string, requested = false): Promise<boolean> {
  const { toast, tabs } = useStore.getState();
  const m = msg().shell;
  const control = terminals.get(tabId);
  const status = control?.shellStatus() ?? "unknown";
  if (status === "fullscreen") {
    toast("error", m.fullscreen);
    return false;
  }
  if (status === "typing") {
    toast("error", m.typing);
    return false;
  }
  if (status === "busy" || (status === "unknown" && !requested)) {
    const ok = await dialogs.confirm({
      title: m.confirmTitle,
      message: status === "busy" ? m.busy : m.unknown,
      detail: shownCommand,
      confirmText: m.type,
    });
    if (!ok) return false;
  }
  const [now, before] = [useStore.getState().tabs.find((t) => t.id === tabId), tabs.find((t) => t.id === tabId)];
  const sessionId = now?.sessionId ?? before?.sessionId;
  if (!sessionId) return false;
  await api.write(sessionId, `${command}\r`, (now ?? before)?.encoding);
  control?.focus();
  return true;
}

/** 解析快速连接字符串：`user@host:port` */
export function parseQuickConnect(input: string): ConnectTarget | null {
  const m = input.trim().match(/^(?:ssh\s+)?([^@\s]+)@([^:\s]+)(?::(\d+))?$/);
  if (!m) return null;
  return { host: m[2], port: m[3] ? Number(m[3]) : 22, username: m[1], auth: "password" };
}
