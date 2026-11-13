import { ChevronDown, FolderOpen, KeyRound, KeySquare, Lock, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { msg } from "../i18n";
import { api, errorText, Host } from "../lib/api";
import { DEFAULT_ENCODING, ENCODING_LABELS, ENCODINGS, isEncoding } from "../lib/encoding";
import { dialogs, useStore } from "../lib/store";
import { HelpLabel, Modal, Switch, withHelp } from "./ui";
import { EnableDialog } from "./Vault";

const DEFAULT_PORT = 22;

// 新建时用户名和端口都留空：没有通用的默认用户名，端口留空就用 22
const blank = (): Host => ({
  id: "",
  name: "",
  group: "",
  host: "",
  port: DEFAULT_PORT,
  username: "",
  auth: "password",
  keyPath: "",
  saveSecret: false,
});

/** 端口输入框的内容：空的或 1–65535 的整数 */
function parsePort(text: string): number | null {
  if (!text.trim()) return DEFAULT_PORT;
  const port = Number(text.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function HostEditor() {
  const { editor, hosts, tabs, set, saveHost, connectHost, updateTab, toast } = useStore();
  const editing = !!editor.host?.id;
  const [h, setH] = useState<Host>(() => ({ ...blank(), ...editor.host }));
  const [portText, setPortText] = useState(() => (editor.host?.port ? String(editor.host.port) : ""));
  const [secret, setSecret] = useState("");
  const inVault = useStore((s) => s.vault?.enabled);
  const [enablingVault, setEnablingVault] = useState(false);
  const [busy, setBusy] = useState(false);
  const groups = [...new Set(hosts.map((x) => x.group).filter(Boolean))];
  const close = () => set("editor", { open: false });
  const up = (p: Partial<Host>) => setH((v) => ({ ...v, ...p }));
  const m = msg().hostEditor;
  const common = msg().common;
  const auth = msg().auth;
  const help = m.help;

  const submit = async (connect: boolean) => {
    if (!h.host.trim()) return toast("error", m.hostRequired);
    const port = parsePort(portText);
    if (port === null) return toast("error", m.portInvalid);
    if (!h.username.trim()) return toast("error", m.usernameRequired);
    setBusy(true);
    try {
      const host: Host = {
        ...h,
        id: h.id || crypto.randomUUID(),
        name: h.name.trim() || h.host.trim(),
        host: h.host.trim(),
        username: h.username.trim(),
        port,
        // Agent 不需要保存任何东西，这里关掉会让后端清除之前保存的密码或口令
        saveSecret: h.auth !== "agent" && h.saveSecret && !!inVault,
        group: h.group.trim(),
      };
      // 已保存的密码属于原来的连接信息，改了之后可能发给另一台服务器
      const before = editor.host;
      const changed =
        editing &&
        before &&
        (before.host !== host.host || before.port !== host.port || before.username !== host.username || before.auth !== host.auth);
      if (changed && before.saveSecret && host.saveSecret && !secret) {
        const keep = await dialogs.confirm({
          title: m.keepTitle(before.auth === "key"),
          message: m.keepMessage(`${host.username}@${host.host}:${host.port}`),
          danger: true,
          confirmText: m.keep,
          cancelText: m.clear,
        });
        if (!keep) host.saveSecret = false;
      }
      await saveHost(host, host.auth === "agent" ? "" : secret);
      close();
      // 由临时连接保存而来：把现有会话归到新主机下，不重复连接
      const source = tabs.find((t) => t.id === editor.tabId);
      if (source) updateTab(source.id, { title: host.name, target: { ...source.target, hostId: host.id } });
      // 改了编码：这台主机已经打开的会话马上用新的编码
      const encoding = isEncoding(host.encoding) ? host.encoding : DEFAULT_ENCODING;
      if (editing && (before?.encoding ?? null) !== (host.encoding ?? null))
        tabs.filter((t) => t.target.hostId === host.id).forEach((t) => updateTab(t.id, { encoding }));
      if (connect) connectHost(host);
      else toast("success", editing ? m.saved : m.added);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const pickKey = async () => {
    const p = await api.pickKeyFile();
    if (p) up({ keyPath: p });
  };

  return (
    <Modal
      title={editing ? m.editTitle : m.newTitle}
      icon={<Server size={18} color="var(--accent)" />}
      onClose={close}
      width={500}
      footer={
        <>
          <button className="btn ghost" onClick={close}>
            {common.cancel}
          </button>
          <button className="btn" disabled={busy} onClick={() => submit(false)}>
            {common.save}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => submit(true)}>
            {m.saveAndConnect}
          </button>
        </>
      }
    >
      <div className="row">
        <div className="field">
          <HelpLabel text={m.name} help={help.name} />
          <input className="input host-name" autoFocus value={h.name} onChange={(e) => up({ name: e.target.value })} />
        </div>
        <div className="field" style={{ flex: 0.7 }}>
          <HelpLabel text={m.group} help={help.group} />
          <GroupInput value={h.group} groups={groups} onChange={(group) => up({ group })} />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <HelpLabel text={m.address} help={help.address} />
          <input className="input host-address" spellCheck={false} value={h.host} onChange={(e) => up({ host: e.target.value })} />
        </div>
        <div className="field" style={{ flex: "0 0 90px" }}>
          <HelpLabel text={m.port} help={help.port} />
          <input className="input host-port" inputMode="numeric" spellCheck={false} value={portText} onChange={(e) => setPortText(e.target.value)} />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <HelpLabel text={m.username} help={help.username} />
          <input className="input host-username" spellCheck={false} value={h.username} onChange={(e) => up({ username: e.target.value })} />
        </div>
        <div className="field" style={{ flex: "0 0 170px" }}>
          <HelpLabel text={m.encoding} help={help.encoding} />
          <select
            className="input host-encoding"
            value={isEncoding(h.encoding) ? h.encoding : DEFAULT_ENCODING}
            onChange={(e) => up({ encoding: e.target.value === DEFAULT_ENCODING ? null : e.target.value })}
          >
            {ENCODINGS.map((e) => (
              <option key={e} value={e}>
                {ENCODING_LABELS[e]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <HelpLabel text={m.authMethod} help={help.auth} />
        <div className="segmented">
          <button className={h.auth === "password" ? "on" : ""} onClick={() => up({ auth: "password" })}>
            <Lock size={13} /> {auth.password}
          </button>
          <button className={h.auth === "key" ? "on" : ""} onClick={() => up({ auth: "key" })}>
            <KeyRound size={13} /> {auth.key}
          </button>
          <button className={h.auth === "agent" ? "on" : ""} onClick={() => up({ auth: "agent" })}>
            <KeySquare size={13} /> SSH Agent
          </button>
        </div>
      </div>

      {h.auth === "key" && (
        <div className="field">
          <HelpLabel text={m.keyFile} help={help.keyFile} />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input host-key"
              spellCheck={false}
              value={h.keyPath || ""}
              onChange={(e) => up({ keyPath: e.target.value })}
            />
            <button className="btn" onClick={pickKey}>
              <FolderOpen size={14} /> {m.browse}
            </button>
          </div>
        </div>
      )}

      {h.auth !== "agent" && (
        <>
          <div className="field">
            <HelpLabel text={h.auth === "key" ? m.passphraseLabel : auth.password} help={h.auth === "key" ? help.passphrase : help.password} />
            <input
              className="input host-secret"
              type="password"
              placeholder={editing && h.saveSecret ? m.savedPlaceholder : ""}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>

          <Switch
            checked={h.saveSecret && !!inVault}
            disabled={!inVault}
            onChange={(v) => up({ saveSecret: v })}
            label={withHelp(m.saveSecret(h.auth === "key"), help.saveSecret(h.auth === "key"))}
          />
          {!inVault && (
            <div>
              <button className="btn sm host-enable-vault" onClick={() => setEnablingVault(true)}>
                {msg().vault.enable}
              </button>
            </div>
          )}
        </>
      )}
      {/* 在这里开启保险库，就是为了保存这台主机的密码，开启后直接打开保存 */}
      {enablingVault && <EnableDialog onClose={() => setEnablingVault(false)} onEnabled={() => up({ saveSecret: true })} />}
    </Modal>
  );
}

/** 分组：可以直接输入新组名，也可以点右边的箭头从已有的组里选 */
function GroupInput(props: { value: string; groups: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  // 输入时只列出包含这段文字的组；刚打开时列出全部
  const [filter, setFilter] = useState("");
  const shown = props.groups.filter((g) => g.toLowerCase().includes(filter.toLowerCase()));

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const choose = (g: string) => {
    props.onChange(g);
    setOpen(false);
  };

  return (
    <div className="combo" ref={box}>
      <input
        className="input host-group"
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
          setFilter(e.target.value);
          setActive(-1);
          setOpen(props.groups.length > 0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) {
              setFilter("");
              setOpen(props.groups.length > 0);
            } else setActive((i) => Math.min(i + 1, shown.length - 1));
          } else if (e.key === "ArrowUp" && open) {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && open && active >= 0 && shown[active] !== undefined) {
            e.preventDefault();
            choose(shown[active]);
          } else if (e.key === "Escape" && open) {
            // 只收起列表，不关掉整个编辑窗口
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            setOpen(false);
          }
        }}
      />
      {props.groups.length > 0 && (
        <button
          type="button"
          className="combo-toggle"
          tabIndex={-1}
          onClick={() => {
            setFilter("");
            setActive(-1);
            setOpen((v) => !v);
          }}
        >
          <ChevronDown size={14} />
        </button>
      )}
      {open && shown.length > 0 && (
        <div className="combo-list">
          {shown.map((g, i) => (
            <button key={g} type="button" className={(i === active ? "active " : "") + (g === props.value ? "on" : "")} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(g)}>
              {g}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
