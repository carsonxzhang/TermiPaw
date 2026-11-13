import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, X } from "lucide-react";

/** 说明框最宽 280px，靠近窗口边缘时往里挪，不超出窗口 */
const HELP_HALF_WIDTH = 148;

/**
 * 设置项旁边的问号，鼠标悬停或用 Tab 键移到上面时显示说明。
 * 说明框放在页面最外层：设置窗口的内容区会滚动，放在里面会被裁掉
 */
export function HelpTip({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // 上方空间不够时显示在下方
    const below = r.top < 160;
    const x = Math.min(Math.max(r.left + r.width / 2, HELP_HALF_WIDTH + 8), window.innerWidth - HELP_HALF_WIDTH - 8);
    setPos({ x, y: below ? r.bottom + 6 : r.top - 6, below });
  };
  const hide = () => setPos(null);
  return (
    <span
      ref={ref}
      className="help-tip"
      tabIndex={0}
      role="img"
      aria-label={text}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      // 放在开关的文字里时，点问号不能顺带切换开关
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <CircleHelp size={13} />
      {pos &&
        createPortal(
          <div className={`help-pop ${pos.below ? "below" : ""}`} role="tooltip" style={{ left: pos.x, top: pos.y }}>
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** 带问号说明的标题 */
export function HelpLabel({ text, help }: { text: ReactNode; help: string }) {
  return (
    <label className="help-label">
      {text}
      <HelpTip text={help} />
    </label>
  );
}

/** 开关等处的文字，后面跟问号说明 */
export function withHelp(text: ReactNode, help: string) {
  return (
    <span className="help-label">
      {text}
      <HelpTip text={help} />
    </span>
  );
}

export function Modal(props: {
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 对话框叠加时，Esc 只关闭最上面的一个
    const onKey = (e: KeyboardEvent) => {
      const open = document.querySelectorAll(".modal");
      // 锁定时下面的对话框不能被关掉：比如正在等密码的连接会被取消
      if (document.querySelector(".lock-screen")) return;
      if (e.key === "Escape" && ref.current === open[open.length - 1]) props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={ref} className="modal" style={props.width ? { width: props.width } : undefined}>
        <div className="modal-head">
          {props.icon}
          <h3>{props.title}</h3>
          <button className="icon-btn" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={"switch" + (props.disabled ? " disabled" : "")}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="track" />
      <span>{props.label}</span>
    </label>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function ContextMenu(props: { x: number; y: number; items: (MenuItem | "sep")[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.min(props.x, window.innerWidth - width - 8),
      y: Math.min(props.y, window.innerHeight - height - 8),
    });
  }, [props.x, props.y]);

  useEffect(() => {
    const close = () => props.onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [props.onClose]);

  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {props.items.map((it, i) =>
        it === "sep" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            className={it.danger ? "danger" : ""}
            disabled={it.disabled}
            onClick={() => {
              props.onClose();
              it.onClick();
            }}
          >
            {it.icon}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

const avatarColors = ["#5b8cff", "#3ecf8e", "#f5a524", "#e05d9b", "#8b5cf6", "#14b8a6", "#f97316", "#64748b"];

export function Avatar({ name, size }: { name: string; size?: number }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const style = { background: avatarColors[h % avatarColors.length], ...(size ? { width: size, height: size } : {}) };
  return (
    <div className="host-avatar" style={style}>
      {(name.trim()[0] || "?").toUpperCase()}
    </div>
  );
}
