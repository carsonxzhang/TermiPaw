import { ArrowUpCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { formatNumber, msg } from "../i18n";
import { errorText, updateApi, UpdateStatus } from "../lib/api";
import { useStore } from "../lib/store";
import { whatUpdateInterrupts } from "../lib/update";
import { Modal, Switch, withHelp } from "./ui";

const mib = (bytes: number) => formatNumber(bytes / 1024 / 1024, 1);

/** 只在用户点击后才打开。自动弹出会抢走焦点，正在输入的命令可能落到对话框的按钮上 */
export function UpdateDialog() {
  const update = useStore((s) => s.availableUpdate);
  const interrupted = useStore((s) => whatUpdateInterrupts(s, msg()).join("\n"));
  const m = msg().update;
  const set = useStore((s) => s.set);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ received: number; total: number | null } | null>(null);
  const [error, setError] = useState("");
  if (!update) return null;

  // 开始之后关不掉：下载完就会退出，对话框消失反而让人以为没有在安装
  const close = () => !installing && set("updateOpen", false);
  const install = async () => {
    setInstalling(true);
    setError("");
    setProgress(null);
    try {
      await updateApi.install(setProgress);
    } catch (e) {
      setError(errorText(e));
    }
    setInstalling(false);
  };

  return (
    <Modal
      title={m.newVersion(update.version)}
      icon={<ArrowUpCircle size={18} color="var(--accent)" />}
      onClose={close}
      width={460}
      footer={
        <>
          <button className="btn" disabled={installing} onClick={close}>
            {m.later}
          </button>
          <button className={`btn update-install ${interrupted ? "danger" : "primary"}`} disabled={installing} onClick={install}>
            {installing ? m.installing : interrupted ? m.interruptAndInstall : m.downloadAndInstall}
          </button>
        </>
      }
    >
      {update.notes && <div className="update-notes">{update.notes}</div>}
      <div className="hint">{m.exitHint}</div>
      {interrupted && (
        <div className="update-warning">
          <strong>{m.interruptsTitle}</strong>
          {interrupted.split("\n").map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
      {installing && (
        <div className="update-progress">
          {progress
            ? progress.total
              ? m.downloadedOf(mib(progress.received), mib(progress.total))
              : m.downloaded(mib(progress.received))
            : m.connecting}
        </div>
      )}
      {error && <div className="update-error">{error}</div>}
    </Modal>
  );
}

/** 设置里的开关：启动时是否检查更新。这个构建没有更新地址时不显示（关于窗口里会说明） */
export function StartupCheckSwitch() {
  const enabled = useStore((s) => s.settings.checkUpdates);
  const updateSettings = useStore((s) => s.updateSettings);
  const [configured, setConfigured] = useState(false);
  const m = msg().update;
  useEffect(() => {
    updateApi.status().then((s) => setConfigured(s.configured));
  }, []);
  if (!configured) return null;
  return (
    <div className="field update-startup">
      <Switch
        checked={enabled}
        onChange={(v) => updateSettings({ checkUpdates: v })}
        label={withHelp(m.checkOnStartup, msg().settings.help.checkUpdates)}
      />
    </div>
  );
}

/** 关于窗口里的版本和手动检查 */
export function UpdateSection() {
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const m = msg().update;
  useEffect(() => {
    updateApi.status().then(setStatus);
  }, []);

  const check = async () => {
    setChecking(true);
    try {
      const found = await updateApi.check();
      useStore.setState(found ? { availableUpdate: found, updateOpen: true, aboutOpen: false } : { availableUpdate: null });
      if (!found) toast("success", msg().update.upToDate);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="field update-section">
      <div className="update-row">
        <span>{m.current(status?.current ?? "")}</span>
        <button className="btn sm update-check" disabled={checking || !status?.configured} onClick={check}>
          {checking ? m.checking : m.check}
        </button>
      </div>
      {status && !status.configured && <div className="hint update-unconfigured">{m.unconfigured}</div>}
    </div>
  );
}
