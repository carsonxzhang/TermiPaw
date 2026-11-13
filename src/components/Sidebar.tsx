import { ChevronDown, ChevronRight, Copy, Pencil, Play, Plus, Search, Trash2, Unplug, X } from "lucide-react";
import { MouseEvent, ReactNode, useMemo, useState } from "react";
import { msg } from "../i18n";
import { Host } from "../lib/api";
import { DEFAULT_ENCODING } from "../lib/encoding";
import { dialogs, groupHosts, Tab, TabStatus, temporaryTabs, useStore } from "../lib/store";
import { Avatar, ContextMenu, MenuItem } from "./ui";

/** 一台主机有多个会话时，状态点显示其中最值得关注的一个 */
const statusPriority: TabStatus[] = ["connected", "connecting", "error", "closed"];
const overallStatus = (tabs: Tab[]) => statusPriority.find((s) => tabs.some((t) => t.status === s));

function RowButton(props: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className="icon-btn"
      title={props.title}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {props.children}
    </button>
  );
}

export function Sidebar() {
  const { hosts, tabs, activeTab, set, connectHost, newSession, closeTab, deleteHost } = useStore();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | "sep")[] } | null>(null);

  const groups = useMemo(() => groupHosts(hosts), [hosts]);
  const temporary = temporaryTabs(hosts, tabs);
  const sessionsOf = (h: Host) => tabs.filter((t) => t.target.hostId === h.id);
  const m = msg().sidebar;
  const common = msg().common;

  const disconnectItem = (sessions: Tab[]): MenuItem => ({
    label: sessions.length > 1 ? m.disconnectAll : m.disconnect,
    icon: <Unplug size={14} />,
    onClick: () => sessions.forEach((t) => closeTab(t.id)),
  });

  const hostMenu = (h: Host): (MenuItem | "sep")[] => {
    const sessions = sessionsOf(h);
    return [
      sessions.length > 0
        ? { label: m.newSession, icon: <Plus size={14} />, onClick: () => newSession(h) }
        : { label: common.connect, icon: <Play size={14} />, onClick: () => connectHost(h) },
      { label: common.edit, icon: <Pencil size={14} />, onClick: () => set("editor", { open: true, host: h }) },
      {
        label: m.duplicate,
        icon: <Copy size={14} />,
        onClick: () => set("editor", { open: true, host: { ...h, id: "", name: m.copyName(h.name), saveSecret: false } }),
      },
      "sep",
      ...(sessions.length > 0 ? [disconnectItem(sessions)] : []),
      {
        label: common.delete,
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: async () => {
          const ok = await dialogs.confirm({
            title: m.deleteTitle,
            message: m.deleteMessage(h.name),
            danger: true,
            confirmText: common.delete,
          });
          if (ok) await deleteHost(h.id);
        },
      },
    ];
  };

  const temporaryMenu = (t: Tab): (MenuItem | "sep")[] => [
    {
      label: m.saveAsHost,
      icon: <Plus size={14} />,
      onClick: () => {
        const { host, port, username, auth, keyPath } = t.target;
        const encoding = t.encoding === DEFAULT_ENCODING ? null : t.encoding;
        const draft: Host = { id: "", name: t.title, group: "", host, port, username, auth, keyPath, saveSecret: false, encoding };
        set("editor", { open: true, host: draft, tabId: t.id });
      },
    },
    disconnectItem([t]),
  ];

  const openMenu = (e: MouseEvent, items: (MenuItem | "sep")[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const closeOnMiddleClick = (e: MouseEvent, id: string) => {
    if (e.button === 1) closeTab(id);
  };

  const groupHead = (key: string, label: string, count: number, status?: TabStatus) => (
    <div className="group-head" onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}>
      {collapsed[key] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      {label}
      {collapsed[key] && status && <span className={`dot ${status}`} />}
      <span className="count">{count}</span>
    </div>
  );

  const hostRow = (h: Host) => {
    const sessions = sessionsOf(h);
    const single = sessions.length === 1 ? sessions[0] : undefined;
    const status = overallStatus(sessions);
    const state = single?.id === activeTab ? "active" : selected === h.id && !status ? "selected" : "";
    return (
      <div key={h.id}>
        <div
          className={`host-item ${state}`}
          onClick={() => (status ? connectHost(h) : setSelected(h.id))}
          onDoubleClick={() => connectHost(h)}
          onAuxClick={(e) => single && closeOnMiddleClick(e, single.id)}
          onContextMenu={(e) => openMenu(e, hostMenu(h))}
          title={status ? m.clickToSwitch : m.doubleClickToConnect}
        >
          <span className="avatar-wrap">
            <Avatar name={h.name} />
            {status && <span className={`dot ${status}`} />}
          </span>
          <div className="host-meta">
            <div className="name">{h.name}</div>
            <div className="addr">
              {h.username}@{h.host}
              {h.port !== 22 ? `:${h.port}` : ""}
            </div>
          </div>
          {sessions.length > 1 && <span className="session-count">{sessions.length}</span>}
          <span className="row-actions">
            {status ? (
              <RowButton title={m.newSession} onClick={() => newSession(h)}>
                <Plus size={14} />
              </RowButton>
            ) : (
              <RowButton title={common.connect} onClick={() => connectHost(h)}>
                <Play size={13} />
              </RowButton>
            )}
            {single && (
              <RowButton title={m.closeSession} onClick={() => closeTab(single.id)}>
                <X size={14} />
              </RowButton>
            )}
          </span>
        </div>
        {sessions.length > 1 &&
          sessions.map((t) => (
            <div
              key={t.id}
              className={`session-item ${t.id === activeTab ? "active" : ""}`}
              onClick={() => set("activeTab", t.id)}
              onAuxClick={(e) => closeOnMiddleClick(e, t.id)}
            >
              <span className={`dot ${t.status}`} />
              <span className="name">{m.session(t.seq)}</span>
              <span className="row-actions">
                <RowButton title={m.closeSession} onClick={() => closeTab(t.id)}>
                  <X size={13} />
                </RowButton>
              </span>
            </div>
          ))}
      </div>
    );
  };

  const temporaryRow = (t: Tab) => (
    <div
      key={t.id}
      className={`host-item ${t.id === activeTab ? "active" : ""}`}
      onClick={() => set("activeTab", t.id)}
      onAuxClick={(e) => closeOnMiddleClick(e, t.id)}
      onContextMenu={(e) => openMenu(e, temporaryMenu(t))}
      title={m.temporaryHint}
    >
      <span className="avatar-wrap">
        <Avatar name={t.title} />
        <span className={`dot ${t.status}`} />
      </span>
      <div className="host-meta">
        <div className="name">{t.title}</div>
        <div className="addr">
          {t.target.username}@{t.target.host}
          {t.target.port !== 22 ? `:${t.target.port}` : ""}
        </div>
      </div>
      <span className="row-actions">
        <RowButton title={m.closeSession} onClick={() => closeTab(t.id)}>
          <X size={14} />
        </RowButton>
      </span>
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-search">
        <div className="search-trigger" onClick={() => set("paletteOpen", true)}>
          <Search size={13} />
          <span>{msg().titleBar.search}</span>
          <kbd>Ctrl K</kbd>
        </div>
      </div>
      {/* 阻止点击列表时抢走终端的键盘焦点 */}
      <div className="host-list" onMouseDown={(e) => e.preventDefault()}>
        {hosts.length === 0 && temporary.length === 0 && (
          <div className="empty-hint">
            {m.empty}
            <br />
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => set("editor", { open: true })}>
              <Plus size={14} /> {m.addFirst}
            </button>
          </div>
        )}
        {temporary.length > 0 && (
          <div>
            {groupHead("\0temporary", m.temporary, temporary.length, overallStatus(temporary))}
            {!collapsed["\0temporary"] && temporary.map(temporaryRow)}
          </div>
        )}
        {groups.map(([group, items]) => (
          <div key={group}>
            {groupHead(group, group || m.ungrouped, items.length, overallStatus(items.flatMap(sessionsOf)))}
            {!collapsed[group] && items.map(hostRow)}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <button className="btn ghost sm new-host" title={m.newHost} onClick={() => set("editor", { open: true })}>
          <Plus size={14} /> {msg().welcome.newHost}
        </button>
        <span className="hint" style={{ marginLeft: "auto" }}>
          {m.hostCount(hosts.length)}
        </span>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}
