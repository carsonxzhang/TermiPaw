import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { KeyRound, Lock, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { msg, renderText } from "../i18n";
import { Rich } from "../i18n/rich";
import { errorText, vaultApi } from "../lib/api";
import { dialogs, onVaultUnlocked, Prompt, refreshVault, useStore } from "../lib/store";
import { WindowControls } from "./TitleBar";
import { HelpLabel, Modal, Switch, withHelp } from "./ui";

/** 自动锁定的选项（分钟），0 表示从不 */
const IDLE_OPTIONS = [5, 15, 30, 60, 0];

/** 后端返回的密码类错误显示在表单里，其余的也一样，用户正看着这里 */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, submit };
}

function PasswordField(props: { label: string; value: string; onChange: (v: string) => void; onEnter?: () => void; autoFocus?: boolean; className?: string }) {
  return (
    <div className="field">
      <label>{props.label}</label>
      <input
        className={`input ${props.className ?? ""}`}
        type="password"
        autoFocus={props.autoFocus}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && props.onEnter?.()}
      />
    </div>
  );
}

// ---------- 锁定界面 ----------

/** 遮住整个窗口。会话在后台继续运行，解锁后恢复 */
export function LockScreen() {
  const vault = useStore((s) => s.vault);
  const [view, setView] = useState<"unlock" | "recover" | "reset">("unlock");
  const show = vault?.problem ? (view === "reset" ? "reset" : "problem") : view;
  const m = msg().vault;
  return (
    <div className="lock-screen">
      <div className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <img src="/logo.svg" alt="" draggable={false} />
          <span data-tauri-drag-region>TermiPaw</span>
        </div>
        <div className="drag" data-tauri-drag-region />
        <WindowControls />
      </div>
      {vault && (
        <div className="lock-body">
          <div className="lock-card">
            {show === "unlock" && <UnlockForm canRecover={vault.hasRecovery} go={setView} />}
            {show === "recover" && <RecoverForm go={setView} />}
            {show === "reset" && <ResetForm encrypted={vault.encryptMetadata || !!vault.problem} go={setView} />}
            {show === "problem" && (
              <>
                <h2>
                  <ShieldAlert size={18} color="var(--danger)" /> {m.cannotOpen}
                </h2>
                <div className="alert">
                  <div>{vault.problem && renderText(vault.problem)}</div>
                </div>
                {vault.canReset && (
                  <div className="lock-links">
                    <button className="link" onClick={() => setView("reset")}>
                      {m.resetLink}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function UnlockForm({ canRecover, go }: { canRecover: boolean; go: (v: "recover" | "reset") => void }) {
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit();
  const m = msg().vault;
  const unlock = () =>
    submit(async () => {
      try {
        await vaultApi.unlock(password);
      } finally {
        setPassword("");
      }
      await onVaultUnlocked();
    });
  return (
    <>
      <h2>
        <Lock size={18} color="var(--accent)" /> {m.locked}
      </h2>
      <div className="hint">{m.sessionsRunning}</div>
      <PasswordField label={m.masterPassword} className="lock-password" value={password} onChange={setPassword} onEnter={unlock} autoFocus />
      {error && <div className="lock-error">{error}</div>}
      <button className="btn primary lock-submit" disabled={busy || !password} onClick={unlock}>
        {busy ? m.unlocking : m.unlock}
      </button>
      <div className="lock-links">
        {canRecover && (
          <button className="link" onClick={() => go("recover")}>
            {m.useRecovery}
          </button>
        )}
        <button className="link" onClick={() => go("reset")}>
          {m.forgot}
        </button>
      </div>
    </>
  );
}

function RecoverForm({ go }: { go: (v: "unlock" | "reset") => void }) {
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const { busy, error, setError, submit } = useSubmit();
  const m = msg().vault;
  const recover = () => {
    if (password !== again) return setError(m.mismatch);
    submit(async () => {
      const { recoveryKey } = await vaultApi.recover(key, password);
      await onVaultUnlocked();
      if (recoveryKey) await dialogs.recoveryKey(recoveryKey);
    });
  };
  return (
    <>
      <h2>
        <KeyRound size={18} color="var(--accent)" /> {m.recoverTitle}
      </h2>
      <div className="hint">{m.recoverHint}</div>
      <div className="field">
        <label>{m.recoveryKey}</label>
        <input className="input lock-recovery" autoFocus spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      <PasswordField label={m.newPassword} className="lock-new" value={password} onChange={setPassword} />
      <PasswordField label={m.again} className="lock-again" value={again} onChange={setAgain} onEnter={recover} />
      {error && <div className="lock-error">{error}</div>}
      <button className="btn primary lock-submit" disabled={busy || !key || !password} onClick={recover}>
        {busy ? m.processing : m.recoverSubmit}
      </button>
      <div className="lock-links">
        <button className="link" onClick={() => go("unlock")}>
          {msg().common.back}
        </button>
      </div>
    </>
  );
}

function ResetForm({ encrypted, go }: { encrypted: boolean; go: (v: "unlock") => void }) {
  const [typed, setTyped] = useState("");
  const { busy, error, submit } = useSubmit();
  const m = msg().vault;
  // 和后端的确认词一致（单元测试核对），后端还会再核对一次
  const word = m.resetWord;
  const reset = () =>
    submit(async () => {
      const backup = await vaultApi.reset(typed);
      await onVaultUnlocked();
      await dialogs.confirm({
        title: msg().vault.resetDoneTitle,
        message: msg().vault.resetDoneMessage,
        detail: backup,
        notice: true,
        confirmText: msg().common.gotIt,
      });
    });
  return (
    <>
      <h2>
        <ShieldAlert size={18} color="var(--danger)" /> {m.resetTitle}
      </h2>
      <div className="alert">
        <div>
          <Rich text={m.resetWarning} />
          {encrypted && ` ${m.resetWarningMetadata}`}
        </div>
      </div>
      <div className="field">
        <label>{m.typeToConfirm(word)}</label>
        <input className="input lock-confirm" autoFocus spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
      </div>
      {error && <div className="lock-error">{error}</div>}
      <button className="btn danger lock-submit" disabled={busy || typed !== word} onClick={reset}>
        {m.reset}
      </button>
      <div className="lock-links">
        <button className="link" onClick={() => go("unlock")}>
          {msg().common.back}
        </button>
      </div>
    </>
  );
}

// ---------- 恢复密钥 ----------

/** 只显示这一次。确认保存之后才能关 */
export function RecoveryKeyPrompt({ p }: { p: Extract<Prompt, { type: "recoveryKey" }> }) {
  const [saved, setSaved] = useState(false);
  const toast = useStore((s) => s.toast);
  const m = msg().vault;
  return (
    <Modal
      title={m.saveRecoveryTitle}
      icon={<KeyRound size={18} color="var(--accent)" />}
      onClose={() => {}}
      width={460}
      footer={
        <button className="btn primary" disabled={!saved} onClick={() => p.resolve()}>
          {m.done}
        </button>
      }
    >
      <div className="alert">
        <div>
          <Rich text={m.recoveryOnlyOnce} />
        </div>
      </div>
      <div className="fingerprint recovery-key">{p.recoveryKey}</div>
      <div>
        <button
          className="btn sm"
          onClick={() =>
            writeText(p.recoveryKey).then(
              () => toast("info", m.copied),
              (e) => toast("error", errorText(e)),
            )
          }
        >
          {msg().common.copy}
        </button>
      </div>
      <div className="hint">{m.recoveryAdvice}</div>
      <Switch checked={saved} onChange={setSaved} label={m.savedIt} />
    </Modal>
  );
}

// ---------- 设置 ----------

async function offerToDeleteBackups(names: string[]) {
  if (names.length === 0) return;
  const m = msg();
  const remove = await dialogs.confirm({
    title: m.vault.oldBackupsTitle,
    message: m.vault.oldBackupsMessage,
    detail: names.join("\n"),
    danger: true,
    confirmText: m.common.delete,
    cancelText: m.vault.keep,
  });
  if (remove) await vaultApi.deleteOldBackups();
}

export function VaultSection() {
  const vault = useStore((s) => s.vault);
  const toast = useStore((s) => s.toast);
  const [dialog, setDialog] = useState<"enable" | "change" | "disable" | null>(null);
  const close = () => setDialog(null);
  const fail = (e: unknown) => toast("error", errorText(e));
  const m = msg().vault;
  const help = msg().settings.help;

  const setEncrypt = async (on: boolean) => {
    if (!on) {
      const ok = await dialogs.confirm({
        title: m.stopEncryptTitle,
        message: m.stopEncryptMessage,
        danger: true,
        confirmText: m.stopEncrypt,
      });
      if (!ok) return;
    }
    try {
      const backups = await vaultApi.setEncryptMetadata(on);
      await refreshVault();
      await offerToDeleteBackups(backups);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="field vault-section">
      {!vault?.enabled ? (
        <div>
          <button className="btn sm vault-enable" onClick={() => setDialog("enable")}>
            {m.enable}
          </button>
        </div>
      ) : (
        <>
          <div className="hint vault-state">{m.stateOn(vault.hasRecovery)}</div>
          <div className="field" style={{ marginTop: 8 }}>
            <HelpLabel text={m.idleLabel} help={help.vaultIdle} />
            <select
              className="input vault-idle"
              value={vault.idleMinutes}
              onChange={(e) =>
                vaultApi
                  .setIdle(Number(e.target.value))
                  .then((status) => useStore.setState({ vault: status }))
                  .catch(fail)
              }
            >
              {IDLE_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes === 0 ? m.never : m.minutes(minutes)}
                </option>
              ))}
            </select>
          </div>
          <Switch checked={vault.encryptMetadata} onChange={setEncrypt} label={withHelp(m.encryptMetadata, help.vaultEncrypt)} />
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button
              className="btn sm vault-lock"
              onClick={() =>
                vaultApi
                  .lock()
                  .then((status) => {
                    useStore.setState({ vault: status, settingsOpen: false });
                    return useStore.getState().loadHosts();
                  })
                  .catch(fail)
              }
            >
              {m.lockNow}
            </button>
            <button className="btn sm vault-change" onClick={() => setDialog("change")}>
              {m.change}
            </button>
            <button className="btn sm ghost vault-disable" onClick={() => setDialog("disable")}>
              {m.disable}
            </button>
          </div>
        </>
      )}
      {dialog === "enable" && <EnableDialog onClose={close} />}
      {dialog === "change" && <ChangeDialog onClose={close} hadRecovery={!!vault?.hasRecovery} />}
      {dialog === "disable" && <DisableDialog onClose={close} />}
    </div>
  );
}

/** onEnabled：开启成功后调用，比如新建主机窗口借此打开“保存密码” */
export function EnableDialog({ onClose, onEnabled }: { onClose: () => void; onEnabled?: () => void }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [recovery, setRecovery] = useState(true);
  const [encrypt, setEncrypt] = useState(false);
  const { busy, error, setError, submit } = useSubmit();
  const m = msg().vault;
  const enable = () => {
    if (password !== again) return setError(m.mismatch);
    submit(async () => {
      const report = await vaultApi.enable(password, recovery, encrypt);
      await refreshVault();
      await useStore.getState().loadHosts();
      onClose();
      onEnabled?.();
      if (report.recoveryKey) await dialogs.recoveryKey(report.recoveryKey);
      if (report.missing.length > 0) {
        await dialogs.confirm({
          title: msg().vault.missingTitle,
          message: msg().vault.missingMessage,
          detail: report.missing.join("\n"),
          notice: true,
          confirmText: msg().common.gotIt,
        });
      }
      await offerToDeleteBackups(report.oldBackups);
    });
  };
  return (
    <Modal
      title={m.enableTitle}
      icon={<Lock size={18} color="var(--accent)" />}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {msg().common.cancel}
          </button>
          <button className="btn primary vault-confirm" disabled={busy || !password} onClick={enable}>
            {busy ? m.enabling : m.enableSubmit}
          </button>
        </>
      }
    >
      <div className="hint" style={{ fontSize: 13 }}>
        {m.enableHint}
      </div>
      <PasswordField label={m.masterPasswordNew} className="vault-new" value={password} onChange={setPassword} autoFocus />
      <PasswordField label={m.again} className="vault-again" value={again} onChange={setAgain} onEnter={enable} />
      <Switch checked={recovery} onChange={setRecovery} label={m.generateRecovery} />
      {!recovery && (
        <div className="alert">
          <div>
            <Rich text={m.noRecoveryWarning} />
          </div>
        </div>
      )}
      <Switch checked={encrypt} onChange={setEncrypt} label={withHelp(m.alsoEncrypt, msg().settings.help.vaultEncrypt)} />
      {error && <div className="lock-error">{error}</div>}
    </Modal>
  );
}

function ChangeDialog({ onClose, hadRecovery }: { onClose: () => void; hadRecovery: boolean }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [recovery, setRecovery] = useState(hadRecovery);
  const { busy, error, setError, submit } = useSubmit();
  const toast = useStore((s) => s.toast);
  const m = msg().vault;
  const change = () => {
    if (password !== again) return setError(m.newMismatch);
    submit(async () => {
      const { recoveryKey } = await vaultApi.changePassword(current, password, recovery);
      await refreshVault();
      onClose();
      if (recoveryKey) await dialogs.recoveryKey(recoveryKey);
      toast("success", msg().vault.changed);
    });
  };
  return (
    <Modal
      title={m.changeTitle}
      icon={<KeyRound size={18} color="var(--accent)" />}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {msg().common.cancel}
          </button>
          <button className="btn primary vault-confirm" disabled={busy || !current || !password} onClick={change}>
            {busy ? m.changing : m.changeSubmit}
          </button>
        </>
      }
    >
      <div className="hint" style={{ fontSize: 13 }}>
        {m.changeHint}
      </div>
      <PasswordField label={m.currentPassword} className="vault-current" value={current} onChange={setCurrent} autoFocus />
      <PasswordField label={m.newPassword} className="vault-new" value={password} onChange={setPassword} />
      <PasswordField label={m.again} className="vault-again" value={again} onChange={setAgain} onEnter={change} />
      <Switch checked={recovery} onChange={setRecovery} label={m.generateNewRecovery} />
      {error && <div className="lock-error">{error}</div>}
    </Modal>
  );
}

function DisableDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit();
  const toast = useStore((s) => s.toast);
  const m = msg().vault;
  const disable = () =>
    submit(async () => {
      await vaultApi.disable(password);
      await refreshVault();
      onClose();
      toast("success", msg().vault.disabled);
    });
  return (
    <Modal
      title={m.disableTitle}
      icon={<ShieldAlert size={18} color="var(--danger)" />}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {msg().common.cancel}
          </button>
          <button className="btn danger vault-confirm" disabled={busy || !password} onClick={disable}>
            {busy ? m.disabling : m.disableSubmit}
          </button>
        </>
      }
    >
      <div className="hint" style={{ fontSize: 13 }}>
        {m.disableHint}
      </div>
      <PasswordField label={m.masterPassword} className="vault-current" value={password} onChange={setPassword} onEnter={disable} autoFocus />
      {error && <div className="lock-error">{error}</div>}
    </Modal>
  );
}
