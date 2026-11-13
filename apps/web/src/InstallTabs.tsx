import { useId, useState, type KeyboardEvent } from "react";

import {
  DownloadIcon,
  installerNote,
  macInstallerNote,
  macInstallerUrl,
  visitorSystem,
  windowsInstallerUrl,
  type System,
} from "./DownloadInstaller.js";

const SYSTEMS = [
  { id: "windows", label: "Windows" },
  { id: "mac", label: "Mac" },
] as const satisfies readonly { id: System; label: string }[];

/**
 * The landing hero's install control: one Windows or Mac selector that opens
 * on the visitor's own system, before anyone has an account.
 *
 * It only ever offers a signed release build.
 */
export const InstallTabs = () => {
  const noteId = useId();
  const macNoteId = useId();
  const [selected, setSelected] = useState<System>(visitorSystem);

  const selectWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = SYSTEMS.findIndex((system) => system.id === selected);
    const last = SYSTEMS.length - 1;
    const target = new Map([
      ["ArrowRight", index === last ? 0 : index + 1],
      ["ArrowLeft", index === 0 ? last : index - 1],
      ["Home", 0],
      ["End", last],
    ]).get(event.key);
    const system = target === undefined ? undefined : SYSTEMS[target];
    if (system === undefined) return;
    event.preventDefault();
    setSelected(system.id);
    document.getElementById(`install-tab-${system.id}`)?.focus();
  };

  const panelClass = (system: System): string => `landing-install-panel${system === selected ? "" : " is-hidden"}`;

  return (
    <div id="install" className="landing-install">
      <div role="tablist" aria-label="Choose your computer" className="landing-install-tabs" onKeyDown={selectWithKeyboard}>
        {SYSTEMS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`install-tab-${id}`}
            className="landing-install-tab"
            aria-selected={id === selected}
            aria-controls={`install-panel-${id}`}
            tabIndex={id === selected ? 0 : -1}
            onClick={() => setSelected(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="landing-install-shared">Install it on each computer you work on and sign in with your account: Windows and Mac hours land in the same workspace.</p>
      {/* Both panels share one grid cell and the unselected one is only made invisible, so the hero keeps its height when the tab flips. */}
      <div className="landing-install-panels">
        <div role="tabpanel" id="install-panel-windows" aria-labelledby="install-tab-windows" className={panelClass("windows")}>
          <a className="landing-secondary landing-install-download" href={windowsInstallerUrl} rel="noreferrer" aria-describedby={noteId}>
            <DownloadIcon />
            Download for Windows
          </a>
          <p className="landing-install-note" id={noteId}>{installerNote}</p>
          <p className="landing-install-note">For 64-bit Windows. Updates install themselves.</p>
        </div>
        <div role="tabpanel" id="install-panel-mac" aria-labelledby="install-tab-mac" className={panelClass("mac")}>
          <a className="landing-secondary landing-install-download" href={macInstallerUrl} rel="noreferrer" aria-describedby={macNoteId}>
            <DownloadIcon />
            Download for Mac
          </a>
          <p className="landing-install-note" id={macNoteId}>{macInstallerNote}</p>
          <ul className="landing-install-differences" aria-label="What is different on a Mac">
            <li>macOS asks once for your Documents, Desktop and Downloads folders. Allow it, or commits in projects kept there are not linked to your hours.</li>
            <li>SIQshift opens at login. Turn that off in System Settings and nothing is recorded until you open it.</li>
            <li>Music on its own does not keep you active. Video and calls do.</li>
            <li>A live microphone keeps you active on macOS 14 or later.</li>
          </ul>
        </div>
      </div>
    </div>
  );
};
