import { FolderTree, PanelLeft, Plus, Search, Server, Settings, SunMoon, Zap } from "lucide-react";
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { msg, useLanguage } from "../i18n";
import { parseQuickConnect, resolveTheme, useStore } from "../lib/store";

interface Item {
  section: string;
  icon: ReactNode;
  label: string;
  sub?: string;
  run: () => void;
}

export function CommandPalette() {
  const s = useStore();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => s.set("paletteOpen", false);
  const lang = useLanguage();

  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    const match = (...v: (string | undefined)[]) => !query || v.some((x) => x?.toLowerCase().includes(query));
    const out: Item[] = [];
    const m = msg().palette;

    const quick = parseQuickConnect(q);
    if (quick)
      out.push({
        section: m.quickConnect,
        icon: <Zap size={16} />,
        label: m.connectTo(`${quick.username}@${quick.host}:${quick.port}`),
        sub: m.enter,
        run: () => s.openTab(quick, `${quick.username}@${quick.host}`),
      });

    for (const h of [...s.hosts].sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0)))
      if (match(h.name, h.host, h.username, h.group))
        out.push({
          section: m.hosts,
          icon: <Server size={16} />,
          label: h.name,
          sub: `${h.username}@${h.host}${h.port !== 22 ? `:${h.port}` : ""}`,
          run: () => s.connectHost(h),
        });

    const tab = s.tabs.find((t) => t.id === s.activeTab);
    const actions: Item[] = [
      { section: m.actions, icon: <Plus size={16} />, label: m.newHost, sub: "Ctrl+N", run: () => s.set("editor", { open: true }) },
      {
        section: m.actions,
        icon: <SunMoon size={16} />,
        label: m.toggleTheme,
        run: () => s.updateSettings({ theme: resolveTheme(s) === "dark" ? "light" : "dark" }),
      },
      { section: m.actions, icon: <PanelLeft size={16} />, label: m.toggleSidebar, sub: "Ctrl+B", run: () => s.updateSettings({ sidebarOpen: !s.settings.sidebarOpen }) },
      { section: m.actions, icon: <Settings size={16} />, label: msg().common.settings, run: () => s.set("settingsOpen", true) },
    ];
    if (tab?.status === "connected")
      actions.unshift({
        section: m.actions,
        icon: <FolderTree size={16} />,
        label: m.toggleFiles,
        sub: "Ctrl+Shift+E",
        run: () => s.updateTab(tab.id, { sftpOpen: !tab.sftpOpen }),
      });
    out.push(...actions.filter((a) => match(a.label)));
    return out;
  }, [q, s.hosts, s.tabs, s.activeTab, s.settings, lang]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const run = (it?: Item) => {
    if (!it) return;
    close();
    it.run();
  };

  return (
    <div className="backdrop top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette">
        <div className="palette-input">
          <Search size={16} />
          <input
            autoFocus
            placeholder={msg().palette.placeholder}
            value={q}
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") run(items[idx]);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="empty-hint">{msg().palette.noResults}</div>}
          {items.map((it, i) => (
            <div key={i}>
              {(i === 0 || items[i - 1].section !== it.section) && <div className="palette-section">{it.section}</div>}
              <div className={`palette-item ${i === idx ? "on" : ""}`} onMouseMove={() => setIdx(i)} onClick={() => run(it)}>
                <span className="pi-icon">{it.icon}</span>
                <span>{it.label}</span>
                {it.sub && <span className="pi-sub">{it.sub}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
