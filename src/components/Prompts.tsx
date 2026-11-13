import { KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { msg } from "../i18n";
import { Rich } from "../i18n/rich";
import { Prompt, useStore } from "../lib/store";
import { Modal, Switch } from "./ui";
import { RecoveryKeyPrompt } from "./Vault";

/** 渲染当前挂起的对话框（密码、指纹确认、确认、输入） */
export function Prompts() {
  const prompt = useStore((s) => s.prompt);
  if (!prompt) return null;
  switch (prompt.type) {
    case "secret":
      return <SecretPrompt p={prompt} />;
    case "hostKey":
      return <HostKeyPrompt p={prompt} />;
    case "confirm":
      return <ConfirmPrompt p={prompt} />;
    case "input":
      return <InputPrompt p={prompt} />;
    case "recoveryKey":
      return <RecoveryKeyPrompt p={prompt} />;
  }
}

function SecretPrompt({ p }: { p: Extract<Prompt, { type: "secret" }> }) {
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(false);
  const inVault = useStore((s) => s.vault?.enabled);
  const m = msg();
  const ok = () => p.resolve({ secret, remember: p.canRemember && !!inVault && remember });
  return (
    <Modal
      title={p.title}
      icon={<KeyRound size={18} color="var(--accent)" />}
      onClose={() => p.resolve(null)}
      width={400}
      footer={
        <>
          <button className="btn ghost" onClick={() => p.resolve(null)}>
            {m.common.cancel}
          </button>
          <button className="btn primary" onClick={ok}>
            {m.common.connect}
          </button>
        </>
      }
    >
      <div className="hint" style={{ fontSize: 13 }}>
        {p.message}
      </div>
      <div className="field">
        <label>{p.label}</label>
        <input
          className="input"
          type="password"
          autoFocus
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ok()}
        />
      </div>
      {p.canRemember && inVault && <Switch checked={remember} onChange={setRemember} label={m.prompts.saveToVault} />}
      {p.canRemember && !inVault && <div className="hint">{m.vault.savingNeedsVault}</div>}
    </Modal>
  );
}

function HostKeyPrompt({ p }: { p: Extract<Prompt, { type: "hostKey" }> }) {
  const e = p.error;
  const changed = e.kind === "hostKeyChanged";
  const [typed, setTyped] = useState("");
  // 指纹变化时要输入主机地址才能继续，防止顺手点掉中间人警告
  const confirmed = !changed || typed.trim() === e.host;
  const m = msg();
  return (
    <Modal
      title={changed ? m.prompts.changedTitle : m.prompts.verifyTitle}
      icon={changed ? <ShieldAlert size={18} color="var(--danger)" /> : <ShieldCheck size={18} color="var(--accent)" />}
      onClose={() => p.resolve(false)}
      width={480}
      footer={
        <>
          <button className="btn ghost" onClick={() => p.resolve(false)}>
            {m.common.cancel}
          </button>
          <button className={`btn ${changed ? "danger" : "primary"}`} disabled={!confirmed} onClick={() => p.resolve(true)}>
            {changed ? m.prompts.acceptRisk : m.prompts.trust}
          </button>
        </>
      }
    >
      {changed ? (
        <div className="alert">
          <ShieldAlert size={18} style={{ flex: "none", marginTop: 1 }} />
          <div>
            <Rich text={m.prompts.changedBody(`${e.host}:${e.port}`)} />
          </div>
        </div>
      ) : (
        <div className="hint" style={{ fontSize: 13 }}>
          <Rich text={m.prompts.unknownBody(`${e.host}:${e.port}`)} boldStyle={{ color: "var(--text)" }} />
        </div>
      )}
      <div className="field">
        <label>{e.keyType}</label>
        <div className="fingerprint">{e.fingerprint}</div>
      </div>
      {changed && (
        <div className="field">
          <label>{m.prompts.typeHost(e.host)}</label>
          <input
            className="input"
            autoFocus
            spellCheck={false}
            placeholder={e.host}
            value={typed}
            onChange={(ev) => setTyped(ev.target.value)}
            onKeyDown={(ev) => ev.key === "Enter" && confirmed && p.resolve(true)}
          />
        </div>
      )}
    </Modal>
  );
}

function ConfirmPrompt({ p }: { p: Extract<Prompt, { type: "confirm" }> }) {
  return (
    <Modal
      title={p.title}
      onClose={() => p.resolve(false)}
      width={400}
      footer={
        <>
          {!p.notice && (
            // 危险操作默认聚焦在取消上，避免一按回车就执行
            <button className="btn ghost" autoFocus={p.danger} onClick={() => p.resolve(false)}>
              {p.cancelText || msg().common.cancel}
            </button>
          )}
          <button className={`btn ${p.danger ? "danger" : "primary"}`} autoFocus={!p.danger} onClick={() => p.resolve(true)}>
            {p.confirmText || msg().common.confirm}
          </button>
        </>
      }
    >
      <div style={{ color: "var(--text-2)", overflowWrap: "anywhere" }}>{p.message}</div>
      {p.detail && <pre className="detail">{p.detail}</pre>}
    </Modal>
  );
}

function InputPrompt({ p }: { p: Extract<Prompt, { type: "input" }> }) {
  const [value, setValue] = useState(p.value);
  const ok = () => p.resolve(value.trim() || null);
  return (
    <Modal
      title={p.title}
      onClose={() => p.resolve(null)}
      width={400}
      footer={
        <>
          <button className="btn ghost" onClick={() => p.resolve(null)}>
            {msg().common.cancel}
          </button>
          <button className="btn primary" onClick={ok}>
            {msg().common.confirm}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{p.label}</label>
        <input
          className="input"
          autoFocus
          spellCheck={false}
          value={value}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ok()}
        />
      </div>
    </Modal>
  );
}
