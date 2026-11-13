import { ArrowRight, Plus } from "lucide-react";
import { useState } from "react";
import { msg } from "../i18n";
import { relativeTime } from "../lib/api";
import { parseQuickConnect, useStore } from "../lib/store";
import { Avatar } from "./ui";

export function Welcome() {
  const { hosts, set, connectHost, openTab, toast } = useStore();
  const [quick, setQuick] = useState("");
  const m = msg().welcome;

  const recent = [...hosts].sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0)).slice(0, 8);

  const go = () => {
    const t = parseQuickConnect(quick);
    if (!t) return toast("error", m.badFormat);
    openTab(t, `${t.username}@${t.host}`);
    setQuick("");
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>{m.title}</h1>
        <p className="sub">{m.sub}</p>

        <div className="quick">
          <input
            className="input"
            placeholder="user@host:port"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
            spellCheck={false}
          />
          <button className="btn primary" onClick={go}>
            {msg().common.connect} <ArrowRight size={15} />
          </button>
        </div>

        <div className="section-title">
          <span>{hosts.some((h) => h.lastConnected) ? m.recent : m.hosts}</span>
        </div>
        <div className="cards">
          {recent.map((h) => (
            <div key={h.id} className="card" onClick={() => connectHost(h)}>
              <Avatar name={h.name} />
              <div className="host-meta">
                <div className="name">{h.name}</div>
                <div className="addr">
                  {h.username}@{h.host}
                </div>
                <div className="time">{relativeTime(h.lastConnected)}</div>
              </div>
            </div>
          ))}
          <div className="card add" onClick={() => set("editor", { open: true })}>
            <Plus size={16} /> {m.newHost}
          </div>
        </div>

        <div className="shortcuts">
          <span>
            <kbd>Ctrl</kbd> <kbd>K</kbd> {m.shortcutPalette}
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>N</kbd> {m.shortcutNewHost}
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>Tab</kbd> {m.shortcutSwitch}
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>E</kbd> {m.shortcutFiles}
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>B</kbd> {m.shortcutSidebar}
          </span>
        </div>
      </div>
    </div>
  );
}
