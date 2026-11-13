import { useState, type KeyboardEvent } from "react";

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
 * It only ever offers a signed release build. The hero holds the download
 * alone: each link's signing note is its title, so it shows on hover and is
 * read as the link's description.
 */
export const InstallTabs = () => {
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
      {/* Both panels share one grid cell and the unselected one is only made invisible, so the hero keeps its height when the tab flips. */}
      <div className="landing-install-panels">
        <div role="tabpanel" id="install-panel-windows" aria-labelledby="install-tab-windows" className={panelClass("windows")}>
          <a className="landing-primary landing-install-download" href={windowsInstallerUrl} rel="noreferrer" title={installerNote}>
            <DownloadIcon />
            Download for Windows
          </a>
        </div>
        <div role="tabpanel" id="install-panel-mac" aria-labelledby="install-tab-mac" className={panelClass("mac")}>
          <a className="landing-primary landing-install-download" href={macInstallerUrl} rel="noreferrer" title={macInstallerNote}>
            <DownloadIcon />
            Download for Mac
          </a>
        </div>
      </div>
    </div>
  );
};
