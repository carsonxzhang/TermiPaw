import { Settings as SettingsIcon } from "lucide-react";
import { detectLanguage, LanguageChoice, LANGUAGES, msg } from "../i18n";
import { Settings, useStore } from "../lib/store";
import { HelpLabel, Modal, Switch, withHelp } from "./ui";
import { StartupCheckSwitch } from "./Update";
import { VaultSection } from "./Vault";

const fonts = [
  { label: "Cascadia Mono", value: '"Cascadia Mono", Consolas, monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", "Cascadia Mono", monospace' },
  { label: "Consolas", value: "Consolas, monospace" },
  { label: "Fira Code", value: '"Fira Code", "Cascadia Mono", monospace' },
];

export function SettingsDialog() {
  const { settings, updateSettings, set } = useStore();
  const close = () => set("settingsOpen", false);
  const m = msg().settings;
  const help = m.help;
  const systemName = LANGUAGES.find((l) => l.id === detectLanguage())?.name ?? "English";

  return (
    <Modal title={m.title} icon={<SettingsIcon size={18} color="var(--accent)" />} onClose={close} width={460}>
      <div className="field">
        <HelpLabel text={m.language} help={help.language} />
        <select className="input settings-language" value={settings.language} onChange={(e) => updateSettings({ language: e.target.value as LanguageChoice })}>
          <option value="system">{m.followSystem(systemName)}</option>
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id} lang={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <HelpLabel text={m.theme} help={help.theme} />
        <div className="segmented">
          {(
            [
              ["system", m.system],
              ["light", m.light],
              ["dark", m.dark],
            ] as [Settings["theme"], string][]
          ).map(([t, label]) => (
            <button key={t} className={settings.theme === t ? "on" : ""} onClick={() => updateSettings({ theme: t })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="row">
        <div className="field">
          <HelpLabel text={m.font} help={help.font} />
          <select
            className="input"
            value={fonts.find((f) => f.value === settings.fontFamily)?.value ?? settings.fontFamily}
            onChange={(e) => updateSettings({ fontFamily: e.target.value })}
          >
            {fonts.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: "0 0 110px" }}>
          <HelpLabel text={m.fontSize} help={help.fontSize} />
          <input
            className="input"
            type="number"
            min={9}
            max={32}
            value={settings.fontSize}
            onChange={(e) => updateSettings({ fontSize: Math.min(32, Math.max(9, Number(e.target.value) || 14)) })}
          />
        </div>
      </div>

      <div className="field">
        <HelpLabel text={m.cursor} help={help.cursor} />
        <div className="segmented">
          {(
            [
              ["bar", m.bar],
              ["block", m.block],
              ["underline", m.underline],
            ] as [Settings["cursorStyle"], string][]
          ).map(([v, l]) => (
            <button key={v} className={settings.cursorStyle === v ? "on" : ""} onClick={() => updateSettings({ cursorStyle: v })}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <Switch checked={settings.copyOnSelect} onChange={(v) => updateSettings({ copyOnSelect: v })} label={withHelp(m.copyOnSelect, help.copyOnSelect)} />
      <Switch
        checked={settings.confirmMultilinePaste}
        onChange={(v) => updateSettings({ confirmMultilinePaste: v })}
        label={withHelp(m.confirmPaste, help.confirmPaste)}
      />
      <Switch checked={settings.autoReconnect} onChange={(v) => updateSettings({ autoReconnect: v })} label={withHelp(m.autoReconnect, help.autoReconnect)} />
      <StartupCheckSwitch />

      <div className="settings-section">
        <h4>{withHelp(msg().vault.section, help.vault)}</h4>
        <VaultSection />
      </div>
    </Modal>
  );
}
