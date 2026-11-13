import { msg } from "../i18n";
import { ISSUES_URL, REPO_URL } from "../lib/links";
import { useStore } from "../lib/store";
import { openLink } from "./TitleBar";
import { Modal } from "./ui";
import { UpdateSection } from "./Update";

export function AboutDialog() {
  const set = useStore((s) => s.set);
  const m = msg().about;
  return (
    <Modal
      title={
        <span className="about-head">
          <img src="/logo.svg" alt="" draggable={false} />
          TermiPaw
        </span>
      }
      onClose={() => set("aboutOpen", false)}
      width={420}
    >
      <div className="hint about-tagline">{m.tagline}</div>
      <UpdateSection />
      <div className="about-links">
        <button className="link about-source" onClick={() => openLink(REPO_URL)}>
          {m.source}
        </button>
        <button className="link about-issues" onClick={() => openLink(ISSUES_URL)}>
          {m.issues}
        </button>
      </div>
      <div className="hint about-license">{m.license}</div>
    </Modal>
  );
}
