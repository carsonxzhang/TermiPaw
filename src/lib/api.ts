import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BackendText, formatNumber, msg, renderText } from "../i18n";
import { encodeText, Encoding } from "./encoding";

export type AuthMethod = "password" | "key" | "agent";

export interface Host {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath?: string | null;
  saveSecret: boolean;
  lastConnected?: number | null;
  /** 服务器用的编码，没有就是 UTF-8 */
  encoding?: string | null;
}

export interface ConnectTarget {
  hostId?: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath?: string | null;
}

export interface ConnectResult {
  sessionId: string;
  /** 连接成功，但有需要告诉用户的问题 */
  warnings: BackendText[];
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  modified?: number | null;
  permissions?: number | null;
}

export interface LocalFile {
  /** 一次性的授权令牌，上传或下载时凭它换回路径 */
  token: string;
  name: string;
  isDir: boolean;
}

export interface Progress {
  transferred: number;
  total: number;
}

export interface StoreIssue {
  title: BackendText;
  message: BackendText;
}

/** 与 Rust 端 `AppError` 对应的结构化错误。给用户看的文字是代码和参数，由界面翻译 */
export type AppError =
  | ({ kind: "message" } & BackendText)
  | ({ kind: "secretRequired" } & BackendText)
  | ({ kind: "authFailed" } & BackendText)
  | ({ kind: "knownHostsBlocked"; canReset: boolean } & BackendText)
  | ({ kind: "vaultLocked" } & BackendText)
  | HostKeyError;

export interface HostKeyError {
  kind: "unknownHostKey" | "hostKeyChanged";
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "kind" in e) return e as AppError;
  return { kind: "message", code: "raw", args: { detail: String(e) } };
}

/** 错误的代码。判断是哪一种错误时用它，不看文字 */
export function errorCode(e: unknown): string {
  const err = toAppError(e);
  return "code" in err ? err.code : "hostKey.failed";
}

export function errorText(e: unknown): string {
  const err = toAppError(e);
  return "code" in err ? renderText(err) : renderText({ code: "hostKey.failed", args: { fingerprint: err.fingerprint } });
}

export const api = {
  hostsList: () => invoke<Host[]>("hosts_list"),
  hostsSave: (host: Host, secret?: string) => invoke<Host>("hosts_save", { host, secret: secret || null }),
  hostsDelete: (id: string) => invoke<void>("hosts_delete", { id }),
  /** 信任服务器最近一次出示的指纹。要信任哪一把由后端记着，这里不能指定 */
  trustHostKey: (host: string, port: number) => invoke<void>("known_hosts_trust", { host, port }),
  resetKnownHosts: () => invoke<void>("known_hosts_reset"),
  /** 取走启动时发现的配置问题，每个问题只返回一次 */
  storeTakeIssues: () => invoke<StoreIssue[]>("store_take_issues"),

  connect(
    target: ConnectTarget,
    opts: { secret?: string; remember: boolean; cols: number; rows: number },
    onData: (data: Uint8Array) => void,
  ) {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => onData(new Uint8Array(buf));
    return invoke<ConnectResult>("ssh_connect", {
      target,
      secret: opts.secret || null,
      remember: opts.remember,
      cols: opts.cols,
      rows: opts.rows,
      onData: channel,
    });
  },
  /** 发给终端的输入，按服务器的编码转换 */
  write: (sessionId: string, data: string, encoding: Encoding = "utf-8") =>
    encoding === "utf-8"
      ? invoke<void>("ssh_write", { sessionId, data })
      : invoke<void>("ssh_write_bytes", { sessionId, data: Array.from(encodeText(data, encoding)) }),
  resize: (sessionId: string, cols: number, rows: number) => invoke<void>("ssh_resize", { sessionId, cols, rows }),
  /** 用系统浏览器打开链接，后端只放行 http 和 https */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  /** 告诉后端这么多字节的终端输出已经处理完 */
  ack: (sessionId: string, bytes: number) => invoke<void>("ssh_ack", { sessionId, bytes }),
  close: (sessionId: string) => invoke<void>("ssh_close", { sessionId }),
  /** 这个连接所在机器的名字，单独的通道查询，不经过终端。查不到时为 null */
  remoteHostname: (sessionId: string) => invoke<string | null>("ssh_hostname", { sessionId }),
  onClosed: (cb: (e: { sessionId: string; reason: BackendText; lost: boolean }) => void) =>
    listen<{ sessionId: string; reason: BackendText; lost: boolean }>("ssh-closed", (ev) => cb(ev.payload)),

  sftpRealpath: (sessionId: string, path: string) => invoke<string>("sftp_realpath", { sessionId, path }),
  sftpList: (sessionId: string, path: string) => invoke<FileEntry[]>("sftp_list", { sessionId, path }),
  sftpMkdir: (sessionId: string, path: string) => invoke<void>("sftp_mkdir", { sessionId, path }),
  sftpRename: (sessionId: string, from: string, to: string) => invoke<void>("sftp_rename", { sessionId, from, to }),
  /** 是不是目录由后端自己查：指向目录的链接只删链接 */
  sftpRemove: (sessionId: string, path: string) => invoke<void>("sftp_remove", { sessionId, path }),
  sftpCancel: (transferId: string) => invoke<void>("sftp_cancel", { transferId }),
  // 本地文件只能经由后端的对话框或拖拽拿到，界面手里只有一次性的令牌
  pickUploadFiles: () => invoke<LocalFile[]>("pick_upload_files"),
  pickUploadFolder: () => invoke<LocalFile | null>("pick_upload_folder"),
  pickDownloadFolder: () => invoke<LocalFile | null>("pick_download_folder"),
  pickSaveLocation: (defaultName: string) => invoke<LocalFile | null>("pick_save_location", { defaultName }),
  pickKeyFile: () => invoke<string | null>("pick_key_file"),
  /** 把终端里的内容存成文本文件，位置由用户在对话框里选。返回保存的位置，取消时为 null */
  saveTerminalOutput: (defaultName: string, text: string) => invoke<string | null>("save_terminal_output", { defaultName, text }),
  onFilesDragged: (cb: (p: { x: number; y: number }) => void) => listen<{ x: number; y: number }>("files-drag", (ev) => cb(ev.payload)),
  onFilesDragLeave: (cb: () => void) => listen("files-drag-leave", () => cb()),
  onFilesDropped: (cb: (p: { x: number; y: number; files: LocalFile[] }) => void) =>
    listen<{ x: number; y: number; files: LocalFile[] }>("files-dropped", (ev) => cb(ev.payload)),
  /** 端到端测试用：模拟把文件拖进窗口，发布版里不起作用 */
  debugDrop: (paths: string[], x: number, y: number) => invoke<void>("debug_drop", { paths, x, y }),

  sftpUpload(sessionId: string, transferId: string, localToken: string, remote: string, overwrite: boolean, onProgress: (p: Progress) => void) {
    const channel = new Channel<Progress>();
    channel.onmessage = onProgress;
    return invoke<BackendText[]>("sftp_upload", { sessionId, transferId, localToken, remote, overwrite, onProgress: channel });
  },
  /** 下载目录，返回要告诉用户的情况（比如跳过了哪些条目），没有时为空 */
  sftpDownloadDir(sessionId: string, transferId: string, remote: string, localToken: string, onProgress: (p: Progress) => void) {
    const channel = new Channel<Progress>();
    channel.onmessage = onProgress;
    return invoke<BackendText[]>("sftp_download_dir", { sessionId, transferId, remote, localToken, onProgress: channel });
  },
  sftpDownload(sessionId: string, transferId: string, remote: string, localToken: string, onProgress: (p: Progress) => void) {
    const channel = new Channel<Progress>();
    channel.onmessage = onProgress;
    return invoke<void>("sftp_download", { sessionId, transferId, remote, localToken, onProgress: channel });
  },
};

export interface VaultStatus {
  enabled: boolean;
  locked: boolean;
  encryptMetadata: boolean;
  hasRecovery: boolean;
  /** 保险库文件有问题时的说明 */
  problem?: BackendText | null;
  canReset: boolean;
  idleMinutes: number;
}

export interface UpdateStatus {
  current: string;
  configured: boolean;
}

export interface UpdateInfo {
  version: string;
  notes: string;
}

export const updateApi = {
  status: () => invoke<UpdateStatus>("update_status"),
  check: () => invoke<UpdateInfo | null>("update_check"),
  /** 成功时程序会退出，不会返回 */
  install: (onProgress: (p: { received: number; total: number | null }) => void) => {
    const channel = new Channel<{ received: number; total: number | null }>();
    channel.onmessage = onProgress;
    return invoke<void>("update_install", { onProgress: channel });
  },
};

/** 没有哪个接口会返回解密后的密码。恢复密钥只在生成时返回一次 */
export const vaultApi = {
  status: () => invoke<VaultStatus>("vault_status"),
  enable: (password: string, recovery: boolean, encryptMetadata: boolean) =>
    invoke<{ recoveryKey?: string | null; missing: string[]; oldBackups: string[] }>("vault_enable", { password, recovery, encryptMetadata }),
  unlock: (password: string) => invoke<VaultStatus>("vault_unlock", { password }),
  recover: (recoveryKey: string, newPassword: string) => invoke<{ recoveryKey?: string | null }>("vault_recover", { recoveryKey, newPassword }),
  changePassword: (current: string, newPassword: string, recovery: boolean) => invoke<{ recoveryKey?: string | null }>("vault_change_password", { current, newPassword, recovery }),
  disable: (password: string) => invoke<void>("vault_disable", { password }),
  lock: () => invoke<VaultStatus>("vault_lock"),
  touch: () => invoke<void>("vault_touch"),
  setIdle: (minutes: number) => invoke<VaultStatus>("vault_set_idle", { minutes }),
  setEncryptMetadata: (on: boolean) => invoke<string[]>("vault_set_encrypt_metadata", { on }),
  deleteOldBackups: () => invoke<void>("vault_delete_old_backups"),
  /** 返回备份文件的路径 */
  reset: (confirm: string) => invoke<string>("vault_reset", { confirm }),
  onLocked: (cb: () => void) => listen("vault-locked", () => cb()),
};

export type EditEvent = { kind: "changed" } | { kind: "localMissing" };
export type EditUpload = { result: "done" | "changedOnServer" | "deletedOnServer" | "unchanged" | "readOnly" };

export const editApi = {
  /**
   * 下载到后端决定的工作目录并用本地程序打开，可执行类型会被后端拦截。
   * withProgram：交给用户选过的程序（editorPick），否则用系统默认程序
   */
  open(sessionId: string, transferId: string, remote: string, withProgram: boolean, onEvent: (e: EditEvent) => void, onProgress: (p: Progress) => void) {
    const events = new Channel<EditEvent>();
    events.onmessage = onEvent;
    const progress = new Channel<Progress>();
    progress.onmessage = onProgress;
    return invoke<{ id: string }>("edit_open", { sessionId, transferId, remote, withProgram, onEvent: events, onProgress: progress });
  },
  upload(editId: string, transferId: string, force: boolean, allowReadOnly: boolean, onProgress: (p: Progress) => void) {
    const progress = new Channel<Progress>();
    progress.onmessage = onProgress;
    return invoke<EditUpload>("edit_upload", { editId, transferId, force, allowReadOnly, onProgress: progress });
  },
  attach: (editId: string, sessionId: string) => invoke<void>("edit_attach", { editId, sessionId }),
  /** withProgram 不给时沿用上次的打开方式 */
  reopen: (editId: string, withProgram?: boolean) => invoke<void>("edit_reopen", { editId, withProgram: withProgram ?? null }),
  /** 停止编辑。本地还有没传回去的修改时返回保留的路径 */
  stop: (editId: string) => invoke<string | null>("edit_stop", { editId }),
  /** 上次选过的程序 */
  editorGet: () => invoke<string | null>("editor_get"),
  /** 在系统对话框里选一个程序并记下来，取消时返回 null */
  editorPick: () => invoke<string | null>("editor_pick"),
};

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${formatNumber(v, v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatPerm(mode?: number | null): string {
  if (mode == null) return "";
  const chars = "rwxrwxrwx";
  let s = "";
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? chars[i] : "-";
  return s;
}

export function formatTime(ts?: number | null): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function relativeTime(ts?: number | null): string {
  const m = msg().time;
  if (!ts) return m.never;
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return m.justNow;
  if (diff < 3600) return m.minutesAgo(Math.floor(diff / 60));
  if (diff < 86400) return m.hoursAgo(Math.floor(diff / 3600));
  if (diff < 86400 * 30) return m.daysAgo(Math.floor(diff / 86400));
  return formatTime(ts).slice(0, 10);
}
