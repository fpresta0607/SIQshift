import { useEffect, useId, useRef, useState } from "react";

const repositoryUrl = "https://github.com/fpresta0607/SIQshift";

/**
 * The permanent links to the newest desktop installers.
 *
 * They are constants, not a GitHub API lookup, because both are published
 * under file names that never change. `.github/workflows/release.yml`
 * publishes every release under the same names and makes it the repository's
 * latest, so `releases/latest/download/<name>` always serves the newest signed
 * release build. That buys us a link with no request, no loading state, no
 * empty-href flash, and nothing to break when GitHub's 60-per-hour anonymous
 * rate limit is spent by whoever shares the visitor's IP. The `unsigned-latest`
 * test release is never linked.
 *
 * Workflow-run artifacts cannot be used here at all: GitHub requires
 * authentication to download one, and the people who need this button are
 * signed out.
 */
export const windowsInstallerUrl = `${repositoryUrl}/releases/latest/download/SIQshift-windows-x64-setup.exe`;
export const macInstallerUrl = `${repositoryUrl}/releases/latest/download/SIQshift-macos-universal.dmg`;

/// Said once, in one place, so the site cannot end up warning about the
/// SmartScreen prompt in one corner and staying quiet about it in another.
/// A new signing certificate has no download reputation yet, so SmartScreen
/// can still ask on a signed build.
export const installerNote = "Signed by SIQstack LLC. Windows may still ask you to confirm.";

/// The Mac build's Developer ID is not SIQstack LLC's, so this names no
/// company, and it stays true if signing moves to one.
export const macInstallerNote = "Signed with an Apple Developer ID and notarized by Apple, for Apple silicon and Intel Macs.";

export type System = "windows" | "mac";

/** The visitor's own system, read from the browser. Anything that is not a Mac counts as Windows. */
export const visitorSystem = (): System => (/Macintosh|Mac OS X/.test(navigator.userAgent) ? "mac" : "windows");

/**
 * Each installer as a download control offers it: the visitor's own system as
 * the one link that reads like the download, the other beside it.
 */
const INSTALLERS = {
  windows: { url: windowsInstallerUrl, note: installerNote, download: "Download for Windows", alternative: "Windows installer (64-bit)" },
  mac: { url: macInstallerUrl, note: macInstallerNote, download: "Download for Mac", alternative: "Mac installer (Apple silicon and Intel)" },
} as const satisfies Record<System, { url: string; note: string; download: string; alternative: string }>;

/** The visitor's installer first, then the other one. */
const installersForVisitor = () => {
  const system = visitorSystem();
  return { primary: INSTALLERS[system], secondary: INSTALLERS[system === "mac" ? "windows" : "mac"] };
};

/**
 * Where the button is sitting, which decides how loud it is allowed to be:
 *
 * - `header` is the dashboard masthead, a single row of small controls it has
 *   to sit inside without breaking. There it is one compact pill matching its
 *   neighbours, and everything else it has to say lives behind that pill.
 * - `hero` is the post-sign-up screen, whose whole job is handing out the app,
 *   so there the button is the page and says all of it at once.
 *
 * There is deliberately no floating variant: a download control pinned over a
 * sign-in card is nobody's next step on that page.
 */
type Placement = "header" | "hero";

type DownloadInstallerProps = { placement?: Placement };

export const DownloadIcon = () => (
  <svg className="download-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path
      d="M8 1.75v8.5m0 0L4.75 7M8 10.25L11.25 7M2.5 12.75h11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * The masthead pill. One control the height of the Sign out button beside it,
 * opening everything that used to be stacked underneath it in the header: the
 * signing note and both installers.
 */
const HeaderMenu = () => {
  const panelId = useId();
  const noteId = useId();
  const [open, setOpen] = useState(false);
  const { primary, secondary } = installersForVisitor();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // The menu opens inside the settings overlay, which listens on window.
      // Whoever is innermost consumes the press.
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="download-menu" ref={root}>
      <button
        className="ghost download-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        // The signing note is still on the control itself, not only inside
        // the panel: a visitor who never opens the panel can still meet it on
        // hover, and it is what the button is described by either way.
        title={primary.note}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <DownloadIcon />
        Download
        <span className="download-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="card glass download-panel" id={panelId}>
          <p className="download-note" id={noteId}>{primary.note}</p>
          <a className="download-choice is-primary" href={primary.url} rel="noreferrer" aria-describedby={noteId}>
            {primary.download}
          </a>
          {/* Secondary on purpose, and deliberately not called "download":
              the visitor's own system is the one that matters, and only one
              link in here should read like the download. */}
          <a className="download-choice" href={secondary.url} rel="noreferrer" title={secondary.note}>
            {secondary.alternative}
          </a>
        </div>
      )}
    </div>
  );
};

/**
 * The download control of the dashboard masthead and the post-sign-up screen.
 * Every surface that offers an installer, the landing hero's `InstallTabs`
 * included, takes its link from `windowsInstallerUrl` or `macInstallerUrl`, so
 * there is no second link quietly serving a different build.
 */
export const DownloadInstaller = ({ placement = "header" }: DownloadInstallerProps) => {
  const noteId = useId();
  if (placement === "header") return <HeaderMenu />;
  const { primary, secondary } = installersForVisitor();
  return (
    <div className="download-corner is-hero">
      <a className="download-button" href={primary.url} rel="noreferrer" aria-describedby={noteId}>
        {primary.download}
      </a>
      <p className="download-note" id={noteId}>{primary.note}</p>
      <a className="download-secondary" href={secondary.url} rel="noreferrer" title={secondary.note}>
        {secondary.alternative}
      </a>
    </div>
  );
};

/**
 * The visitor's own installer as a plain link, for running prose. Kept beside
 * the button so both read from `installersForVisitor`.
 */
export const InstallerLink = () => {
  const { primary } = installersForVisitor();
  return (
    <a className="link" href={primary.url} rel="noreferrer">
      {primary.download}
    </a>
  );
};
