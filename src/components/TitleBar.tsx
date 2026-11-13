import { getCurrentWindow } from "@tauri-apps/api/window";
import { CircleHelp, Copy, Info, Menu, Minus, Moon, Settings, Square, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { msg } from "../i18n";
import { api, errorText } from "../lib/api";
import { helpUrl } from "../lib/links";
import { resolveTheme, useStore } from "../lib/store";

/** 用系统浏览器打开项目的网页 */
export const openLink = (url: string) => api.openUrl(url).catch((e) => useStore.getState().toast("error", errorText(e)));
import { ContextMenu } from "./ui";

const win = getCurrentWindow();

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const m = msg().titleBar;

  useEffect(() => {
    const sync = () => win.isMaximized().then(setMaximized);
    sync();
    const un = win.onResized(sync);
    return () => {
      un.then((f) => f());
    };
  }, []);

  return (
    <div className="winctl">
      <button onClick={() => win.minimize()} title={m.minimize}>
        <Minus size={15} />
      </button>
      <button onClick={() => win.toggleMaximize()} title={maximized ? m.restore : m.maximize}>
        {maximized ? <Copy size={12} style={{ transform: "scaleX(-1)" }} /> : <Square size={12} />}
      </button>
      <button className="close" onClick={() => win.close()} title={m.close}>
        <X size={16} />
      </button>
    </div>
  );
}

export function TitleBar() {
  const set = useStore((s) => s.set);
  const updateSettings = useStore((s) => s.updateSettings);
  const theme = useStore(resolveTheme);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const m = msg();
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <img src="/logo.svg" alt="" draggable={false} />
        <span data-tauri-drag-region>TermiPaw</span>
      </div>

      <div className="drag" data-tauri-drag-region />

      <div className="titlebar-tools">
        <button
          className="icon-btn"
          title={msg().sidebar.toggleTheme}
          onClick={() => updateSettings({ theme: theme === "dark" ? "light" : "dark" })}
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        {/* 按下时不让 ContextMenu 的“点别处关闭”先把菜单关掉，否则再点一次变成关了又开 */}
        <button
          className="icon-btn menu-btn"
          title={m.titleBar.menu}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
          }}
        >
          <Menu size={16} />
        </button>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: m.common.settings, icon: <Settings size={14} />, onClick: () => set("settingsOpen", true) },
            // 说明放在 GitHub 上，用系统浏览器打开
            { label: m.titleBar.help, icon: <CircleHelp size={14} />, onClick: () => openLink(helpUrl()) },
            { label: m.titleBar.about, icon: <Info size={14} />, onClick: () => set("aboutOpen", true) },
          ]}
        />
      )}

      <WindowControls />
    </div>
  );
}
