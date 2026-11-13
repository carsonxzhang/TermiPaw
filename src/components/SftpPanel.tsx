import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  CheckCircle2,
  ClipboardCopy,
  Clock,
  AppWindow,
  ExternalLink,
  File,
  FilePen,
  FileSearch,
  Folder,
  FolderPlus,
  FolderUp,
  Home,
  Link2,
  LocateFixed,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { msg, renderTexts } from "../i18n";
import { api, editApi, errorText, FileEntry, formatPerm, formatSize, formatTime, LocalFile } from "../lib/api";
import { cleanName, displayName, hasControlChars, isOddName } from "../lib/names";
import { cdCommand, integrationOneLiner, integrationSnippet } from "../lib/shell";
import { dialogs, EditItem, openForEdit, runInShell, stopEdit, syncEdit, useStore } from "../lib/store";
import { ContextMenu, MenuItem } from "./ui";

const parent = (p: string) => (p === "/" ? "/" : p.replace(/\/[^/]+\/?$/, "") || "/");
const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

/** 超过这个大小，用本地程序打开前先问一下 */
const LARGE_EDIT = 100 * 2 ** 20;
/** 发出开启目录跟随的命令后，等这么久还没收到报告，就说明这个 Shell 不支持 */
const INTEGRATION_WAIT = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function SftpPanel({ tabId, sessionId, active }: { tabId: string; sessionId: string; active: boolean }) {
  const toast = useStore((s) => s.toast);
  const m = msg().sftp;
  const common = msg().common;
  const editStatusText: Record<EditItem["status"], string> = m.editStatus;
  const { enqueueTransfer, cancelTransfer, removeTransfer } = useStore.getState();
  const allTransfers = useStore((s) => s.transfers);
  const transfers = useMemo(() => allTransfers.filter((t) => t.tabId === tabId), [allTransfers, tabId]);
  const updateTab = useStore((s) => s.updateTab);
  const allEdits = useStore((s) => s.edits);
  const edits = useMemo(() => allEdits.filter((e) => e.tabId === tabId), [allEdits, tabId]);
  const changedDir = useStore((s) => s.tabs.find((t) => t.id === tabId)?.changedDir);
  const shellDir = useStore((s) => s.tabs.find((t) => t.id === tabId)?.shellDir);
  const shellElsewhere = useStore((s) => s.tabs.find((t) => t.id === tabId)?.shellElsewhere);
  const shellIntegrated = useStore((s) => !!s.tabs.find((t) => t.id === tabId)?.shellIntegrated);
  const following = useStore((s) => s.settings.followTerminalDir);
  const updateSettings = useStore((s) => s.updateSettings);
  /** 跟随时打不开终端所在的目录（比如 sudo 之后进入了别的用户的目录） */
  const [followError, setFollowError] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: FileEntry } | null>(null);
  /** 上次选过的、用来打开远程文件的程序。右键菜单里直接列出来 */
  const [program, setProgram] = useState<string | null>(null);
  useEffect(() => {
    editApi.editorGet().then((p) => mounted.current && setProgram(p), () => {});
  }, [menu]);
  const [dropping, setDropping] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  // 跟随目录和用户操作可能同时发起读取，只有最后发起的那个算数
  const loadSeq = useRef(0);
  const showDir = (path: string, list: FileEntry[]) => {
    setEntries(list);
    setCwd(path);
    setPathInput(displayName(path));
    setSelected(null);
    setFollowError(null);
    updateTab(tabId, { sftpDir: path });
  };
  const load = useCallback(
    async (path: string) => {
      const seq = ++loadSeq.current;
      setLoading(true);
      try {
        const list = await api.sftpList(sessionId, path);
        if (seq !== loadSeq.current) return true;
        showDir(path, list);
        return true;
      } catch (e) {
        if (seq !== loadSeq.current) return false;
        toast("error", errorText(e));
        setPathInput(displayName(cwdRef.current));
        return false;
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [sessionId],
  );

  const loadHome = () =>
    api
      .sftpRealpath(sessionId, ".")
      .then(load)
      .catch((e) => toast("error", msg().sftp.unavailable(errorText(e))));

  // 打开面板：回到上次看的目录（重新连接后也一样），否则去终端所在的目录或主目录
  useEffect(() => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    const start = tab?.sftpDir ?? (following ? tab?.shellDir : undefined);
    if (start) load(start).then((ok) => ok || loadHome());
    else loadHome();
  }, [sessionId]);

  // 跟随终端的目录。只在终端的目录真的变了才跳：每个提示符都会上报一次，不能把用户自己翻到的目录顶掉。
  // 读取失败不弹提示：终端能进的目录 SFTP 不一定能进，而且上报是服务器说了算的，不能让它刷屏
  useEffect(() => {
    if (!following || !shellDir) return;
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (tab?.followedDir === shellDir) return;
    updateTab(tabId, { followedDir: shellDir });
    if (shellDir === cwdRef.current) return;
    const seq = ++loadSeq.current;
    api.sftpList(sessionId, shellDir).then(
      (list) => {
        if (seq !== loadSeq.current) return;
        setLoading(false);
        showDir(shellDir, list);
      },
      (e) => {
        if (seq !== loadSeq.current) return;
        setLoading(false);
        setFollowError(msg().sftp.followFailed(displayName(shellDir), displayName(errorText(e))));
      },
    );
  }, [following, shellDir, sessionId]);

  // 编辑的文件传回去之后，大小和时间变了
  useEffect(() => {
    if (changedDir && changedDir.dir === cwdRef.current) load(cwdRef.current);
  }, [changedDir]);

  /** withProgram：交给上次选过的程序；否则用系统默认程序 */
  const openLocally = async (e: FileEntry, withProgram: boolean) => {
    if (e.size > LARGE_EDIT) {
      const ok = await dialogs.confirm({
        title: m.bigFileTitle,
        message: m.bigFileMessage(displayName(e.name), formatSize(e.size)),
        confirmText: common.continue,
      });
      if (!ok) return;
    }
    openForEdit(tabId, sessionId, e.name, e.path, withProgram);
  };
  const openWithOther = async (e: FileEntry) => {
    try {
      const picked = await editApi.editorPick();
      if (!picked) return;
      setProgram(picked);
      await openLocally(e, true);
    } catch (err) {
      toast("error", errorText(err));
    }
  };
  const programName = program ? (program.split(/[\\/]/).pop() ?? program) : null;

  const enterInTerminal = (path: string) => {
    const command = cdCommand(path);
    if (!command) return toast("error", common.controlCharsPath);
    runInShell(tabId, command, displayName(command));
  };

  const copyPath = (path: string) => {
    // 控制字符粘贴到终端时会被当作按键，所以复制看得见的版本
    if (hasControlChars(path)) toast("info", m.copiedVisible);
    writeText(hasControlChars(path) ? displayName(path) : path);
  };

  // Shell 默认不报告目录。用户点了跟随按钮才往这个 Shell 输入开启的命令，从不自动输入
  const enableIntegration = async () => {
    const line = integrationOneLiner();
    if (!(await runInShell(tabId, line, line, true))) return;
    updateTab(tabId, { integrationWanted: true });
    // 不是 bash 或 zsh 时命令不起作用，Shell 不会开始报告
    await sleep(INTEGRATION_WAIT);
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (mounted.current && tab?.sessionId === sessionId && !tab.shellIntegrated) toast("info", m.followUnsupported);
  };

  const toggleFollow = () => {
    if (following && shellIntegrated) return updateSettings({ followTerminalDir: false });
    // 开启时立刻跳到终端所在的目录
    updateTab(tabId, { followedDir: undefined });
    if (!following) updateSettings({ followTerminalDir: true });
    if (!shellIntegrated) enableIntegration();
  };

  const showIntegrationSnippet = async () => {
    const snippet = integrationSnippet();
    const copy = await dialogs.confirm({
      title: m.integrationTitle,
      message: m.integrationMessage,
      detail: snippet,
      confirmText: common.copy,
    });
    if (copy) writeText(snippet);
  };

  /** 询问是否覆盖同名文件、合并同名文件夹；重新读取目录，因为列表可能已经过期 */
  const askOverwrite = async (dir: string, files: LocalFile[]) => {
    const remote = await api.sftpList(sessionId, dir);
    const existingFiles = new Set(remote.filter((e) => !e.isDir).map((e) => e.name));
    const existingDirs = new Set(remote.filter((e) => e.isDir).map((e) => e.name));
    const existing = new Set(files.filter((f) => (f.isDir ? existingDirs : existingFiles).has(f.name)).map((f) => f.name));
    const conflicts = [...existing];
    if (conflicts.length === 0) return { existing, overwrite: false };
    const t = msg();
    const shown = conflicts.slice(0, 3).map(displayName).join(t.common.listJoin);
    const hasDir = files.some((f) => f.isDir && existing.has(f.name));
    const onlyDirs = files.filter((f) => existing.has(f.name)).every((f) => f.isDir);
    // 目录可写时只读文件也能被替换（scp 会直接报错），用户可能以为只读能保护它
    const readOnly = remote.filter((e) => !e.isDir && e.permissions != null && (e.permissions & 0o222) === 0 && files.some((f) => !f.isDir && f.name === e.name)).map((e) => displayName(e.name));
    const readOnlyNote =
      readOnly.length === 0 ? "" : t.sftp.readOnlyNote(readOnly.length === 1 && conflicts.length === 1, readOnly.slice(0, 3).join(t.common.listJoin), readOnly.length > 3);
    const overwrite = await dialogs.confirm({
      title: onlyDirs ? t.sftp.existsTitleFolders : t.sftp.existsTitleFiles,
      message:
        conflicts.length === 1
          ? onlyDirs
            ? t.sftp.existsOneFolder(shown)
            : t.sftp.existsOneFile(shown, readOnlyNote)
          : t.sftp.existsMany(conflicts.length, shown, conflicts.length > 3, hasDir, readOnlyNote),
      danger: true,
      confirmText: onlyDirs ? t.sftp.merge : t.sftp.overwrite,
      cancelText: t.sftp.skip,
    });
    return { existing, overwrite };
  };

  const upload = async (files: LocalFile[], dir = cwdRef.current) => {
    let decision: Awaited<ReturnType<typeof askOverwrite>>;
    try {
      decision = await askOverwrite(dir, files);
    } catch (e) {
      return toast("error", errorText(e));
    }
    const { existing, overwrite } = decision;
    const queue = overwrite ? files : files.filter((f) => !existing.has(f.name));
    const results = await Promise.all(
      queue.map((f) =>
        // 只对用户确认过的文件允许覆盖
        enqueueTransfer({
          tabId,
          name: f.name,
          direction: "upload",
          dir,
          run: async (id, onProgress) => {
            const notes = await api.sftpUpload(sessionId, id, f.token, join(dir, f.name), overwrite && existing.has(f.name), onProgress);
            if (notes.length > 0) toast("info", msg().sftp.note(displayName(f.name), renderTexts(notes)));
          },
        }),
      ),
    );
    if (results.some(Boolean) && mounted.current && cwdRef.current === dir) load(dir);
  };

  const pickUpload = async () => {
    // 对话框开着时面板可能跟随终端跳走，文件仍然传到打开对话框时看到的目录
    const dir = cwdRef.current;
    try {
      const files = await api.pickUploadFiles();
      if (files.length > 0) upload(files, dir);
    } catch (e) {
      toast("error", errorText(e));
    }
  };

  const pickUploadFolder = async () => {
    const dir = cwdRef.current;
    try {
      const folder = await api.pickUploadFolder();
      if (folder) upload([folder], dir);
    } catch (e) {
      toast("error", errorText(e));
    }
  };

  const downloadDir = async (e: FileEntry) => {
    let target: LocalFile | null;
    try {
      target = await api.pickDownloadFolder();
    } catch (err) {
      return toast("error", errorText(err));
    }
    if (!target) return;
    const token = target.token;
    const ok = await enqueueTransfer({
      tabId,
      name: e.name,
      direction: "download",
      run: async (id, onProgress) => {
        const notes = await api.sftpDownloadDir(sessionId, id, e.path, token, onProgress);
        if (notes.length > 0) toast("info", msg().sftp.note(displayName(e.name), renderTexts(notes)));
      },
    });
    if (ok) toast("success", msg().sftp.downloaded(displayName(e.name)));
  };

  const download = async (e: FileEntry) => {
    if (e.isDir) return downloadDir(e);
    let target: LocalFile | null;
    try {
      target = await api.pickSaveLocation(e.name);
    } catch (err) {
      return toast("error", errorText(err));
    }
    if (!target) return;
    const token = target.token;
    const ok = await enqueueTransfer({
      tabId,
      name: e.name,
      direction: "download",
      run: (id, onProgress) => api.sftpDownload(sessionId, id, e.path, token, onProgress),
    });
    if (ok) toast("success", msg().sftp.downloaded(displayName(e.name)));
  };

  const open_ = (e: FileEntry) => (e.isDir ? load(e.path) : download(e));

  // 从资源管理器拖入文件上传
  useEffect(() => {
    if (!active) return;
    const inside = (pos: { x: number; y: number }) => {
      const r = panelRef.current?.getBoundingClientRect();
      const x = pos.x / devicePixelRatio;
      const y = pos.y / devicePixelRatio;
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    // 拖进来的文件由后端换成令牌，这里拿不到路径
    const listeners = [
      api.onFilesDragged((p) => setDropping(inside(p))),
      api.onFilesDragLeave(() => setDropping(false)),
      api.onFilesDropped((p) => {
        setDropping(false);
        if (inside(p)) upload(p.files);
      }),
    ];
    return () => {
      listeners.forEach((un) => un.then((f) => f()));
    };
  }, [active]);

  /** 只能是一层名字：带 “/” 会变成建多层目录或移动到别处 */
  const plainName = (name: string) => {
    const ok = !name.includes("/") && name !== "." && name !== "..";
    if (!ok) toast("error", m.badName);
    return ok;
  };

  const mkdir = async () => {
    const name = await dialogs.input({ title: m.newFolder, label: m.name, value: "" });
    if (!name || !plainName(name)) return;
    try {
      await api.sftpMkdir(sessionId, join(cwd, name));
      load(cwd);
    } catch (e) {
      toast("error", errorText(e));
    }
  };

  const rename = async (e: FileEntry) => {
    // 名字里有看不见的字符时，默认值去掉它们，直接确认就能改成干净的名字
    const name = await dialogs.input({ title: m.rename, label: m.newName, value: cleanName(e.name) });
    if (!name || name === e.name || !plainName(name)) return;
    try {
      await api.sftpRename(sessionId, e.path, join(cwd, name));
      load(cwd);
    } catch (err) {
      toast("error", errorText(err));
    }
  };

  const remove = async (e: FileEntry) => {
    // 指向目录的链接只删链接本身，不能说成删除整个文件夹
    const folder = e.isDir && !e.isLink;
    const ok = await dialogs.confirm({
      title: folder ? m.deleteFolder : e.isLink ? m.deleteLink : m.deleteFile,
      message: folder ? m.deleteFolderMessage(displayName(e.name)) : e.isLink ? m.deleteLinkMessage(displayName(e.name)) : m.deleteFileMessage(displayName(e.name)),
      danger: true,
      confirmText: common.delete,
    });
    if (!ok) return;
    try {
      await api.sftpRemove(sessionId, e.path);
      load(cwd);
    } catch (err) {
      toast("error", errorText(err));
    }
  };

  const menuItems = (e?: FileEntry): (MenuItem | "sep")[] =>
    e
      ? [
          e.isDir
            ? { label: m.open, icon: <Folder size={14} />, onClick: () => load(e.path) }
            : { label: m.openDefault, icon: <FilePen size={14} />, onClick: () => openLocally(e, false) },
          ...(e.isDir
            ? []
            : [
                ...(programName ? [{ label: m.openWith(programName), icon: <AppWindow size={14} />, onClick: () => openLocally(e, true) }] : []),
                { label: m.openWithOther, icon: <FileSearch size={14} />, onClick: () => openWithOther(e) },
                "sep" as const,
              ]),
          ...(e.isDir ? [] : [{ label: m.download, icon: <ArrowDownToLine size={14} />, onClick: () => download(e) }]),
          ...(e.isDir
            ? [
                { label: m.downloadFolder, icon: <ArrowDownToLine size={14} />, onClick: () => downloadDir(e) },
                {
                  label: m.enterInTerminal,
                  icon: <SquareTerminal size={14} />,
                  onClick: () => enterInTerminal(e.path),
                },
              ]
            : []),
          { label: m.rename, icon: <Pencil size={14} />, onClick: () => rename(e) },
          { label: m.copyPath, icon: <ClipboardCopy size={14} />, onClick: () => copyPath(e.path) },
          "sep",
          { label: common.delete, icon: <Trash2 size={14} />, danger: true, onClick: () => remove(e) },
        ]
      : [
          { label: m.uploadFiles, icon: <ArrowUpFromLine size={14} />, onClick: pickUpload },
          { label: m.uploadFolder, icon: <FolderUp size={14} />, onClick: pickUploadFolder },
          { label: m.newFolder, icon: <FolderPlus size={14} />, onClick: mkdir },
          { label: m.refresh, icon: <RefreshCw size={14} />, onClick: () => load(cwd) },
          {
            label: m.enterHere,
            icon: <SquareTerminal size={14} />,
            onClick: () => enterInTerminal(cwd),
          },
          { label: m.followAlways, icon: <LocateFixed size={14} />, onClick: showIntegrationSnippet },
        ];

  return (
    <div ref={panelRef} className={`sftp ${dropping ? "drop" : ""}`}>
      <div className="sftp-toolbar">
        <span className="title">{m.title}</span>
        <button className="icon-btn" title={m.up} onClick={() => load(parent(cwd))} disabled={cwd === "/"}>
          <ArrowUp size={15} />
        </button>
        <button
          className={`icon-btn follow-btn ${following && shellIntegrated ? "on" : ""}`}
          title={following && shellIntegrated ? m.followingOn : shellIntegrated ? m.followingOff : m.followEnable}
          onClick={toggleFollow}
        >
          <LocateFixed size={15} />
        </button>
        <button className="icon-btn" title={m.home} onClick={loadHome}>
          <Home size={15} />
        </button>
        <button className="icon-btn" title={m.refresh} onClick={() => load(cwd)}>
          <RefreshCw size={15} className={loading ? "spin" : ""} />
        </button>
        <button className="icon-btn" title={m.newFolder} onClick={mkdir}>
          <FolderPlus size={15} />
        </button>
        <button className="icon-btn" title={m.uploadHint} onClick={pickUpload}>
          <ArrowUpFromLine size={15} />
        </button>
        <button className="icon-btn" title={m.uploadFolder} onClick={pickUploadFolder}>
          <FolderUp size={15} />
        </button>
      </div>
      <div className="pathbar">
        <input
          className="input"
          value={pathInput}
          spellCheck={false}
          onChange={(e) => setPathInput(e.target.value)}
          // 输入框里显示的是处理过的路径，没改动时要用原来的路径
          onKeyDown={(e) => e.key === "Enter" && load(pathInput === displayName(cwd) ? cwd : pathInput.trim() || "/")}
        />
      </div>

      {following && shellElsewhere && <div className="sftp-hint">{m.elsewhere(displayName(shellElsewhere))}</div>}
      {following && !shellElsewhere && followError && <div className="sftp-hint warn">{followError}</div>}

      <div
        className="files"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div className="file-row head">
          <span />
          <span>{m.colName}</span>
          <span className="fsize">{m.colSize}</span>
          <span className="ftime">{m.colModified}</span>
        </div>
        {entries.map((e) => (
          <div
            key={e.path}
            className={`file-row ${selected === e.path ? "selected" : ""}`}
            title={`${displayName(e.name)}${isOddName(e.name) ? `\n${m.oddName}` : ""}\n${formatPerm(e.permissions)}  ${formatSize(e.size)}`}
            onClick={() => setSelected(e.path)}
            onDoubleClick={() => open_(e)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              setSelected(e.path);
              setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
            }}
          >
            <span className={`ficon ${e.isDir ? "dir" : ""}`}>
              {e.isDir ? <Folder size={15} /> : e.isLink ? <Link2 size={15} /> : <File size={15} />}
            </span>
            <span className={`fname ${isOddName(e.name) ? "odd" : ""}`}>{displayName(e.name)}</span>
            <span className="fsize">{e.isDir ? "" : formatSize(e.size)}</span>
            <span className="ftime">{formatTime(e.modified)}</span>
          </div>
        ))}
        {!loading && cwd && entries.length === 0 && <div className="empty-hint">{m.emptyFolder}</div>}
      </div>

      {edits.length > 0 && (
        <div className="edits">
          {edits.map((item) => (
            <div key={item.id} className={`edit-row ${item.status}`} title={item.error && displayName(item.error)}>
              <FilePen size={14} />
              <span className="tname">{displayName(item.name)}</span>
              <span className="tstat">{item.error && item.status === "failed" ? displayName(item.error) : editStatusText[item.status]}</span>
              {(item.status === "conflict" || item.status === "deleted") && (
                <button className="btn sm" onClick={() => syncEdit(item.id, { force: true })}>
                  {item.status === "conflict" ? m.overwrite : m.recreate}
                </button>
              )}
              {item.status === "readOnly" && (
                <button className="btn sm" onClick={() => syncEdit(item.id, { allowReadOnly: true })}>
                  {m.replace}
                </button>
              )}
              {item.status === "failed" && (
                <button className="btn sm" onClick={() => syncEdit(item.id)}>
                  {common.retry}
                </button>
              )}
              <button className="icon-btn" style={{ width: 22, height: 22 }} title={m.openLocally} onClick={() => editApi.reopen(item.id).catch((e) => toast("error", errorText(e)))}>
                <ExternalLink size={12} />
              </button>
              <button className="icon-btn" style={{ width: 22, height: 22 }} title={m.stopEditing} onClick={() => stopEdit(item.id)}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {transfers.length > 0 && (
        <div className="transfers">
          {transfers.map((t) => {
            const pct = t.status === "done" ? 100 : t.total ? (t.transferred / t.total) * 100 : 0;
            return (
              <div key={t.id} className={`transfer ${t.status}`} title={t.error && displayName(t.error)}>
                {t.status === "done" ? (
                  <CheckCircle2 size={14} color="var(--success)" />
                ) : t.status === "failed" || t.status === "cancelled" ? (
                  <XCircle size={14} color="var(--danger)" />
                ) : t.status === "queued" ? (
                  <Clock size={14} color="var(--text-3)" />
                ) : t.direction === "upload" ? (
                  <ArrowUpFromLine size={14} color="var(--accent)" />
                ) : (
                  <ArrowDownToLine size={14} color="var(--accent)" />
                )}
                <span className="tname">{displayName(t.name)}</span>
                <span className="tstat">
                  {t.status === "queued"
                    ? m.queued
                    : t.status === "running"
                      ? t.cancelling
                        ? m.cancelling
                        : `${formatSize(t.transferred)} / ${formatSize(t.total)}`
                      : t.status === "done"
                        ? formatSize(t.total)
                        : t.error && displayName(t.error)}
                </span>
                <button
                  className="icon-btn"
                  style={{ width: 22, height: 22 }}
                  title={t.status === "running" || t.status === "queued" ? common.cancel : m.remove}
                  disabled={t.cancelling}
                  onClick={() => (t.status === "running" || t.status === "queued" ? cancelTransfer(t.id) : removeTransfer(t.id))}
                >
                  <X size={12} />
                </button>
                <span />
                <div className="bar">
                  <div style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
    </div>
  );
}
