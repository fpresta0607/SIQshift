import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { load as parseYaml } from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DownloadInstaller,
  InstallerLink,
  installerNote,
  macInstallerNote,
  macInstallerUrl,
  windowsInstallerUrl,
} from "./DownloadInstaller.js";

const MAC_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

const browseFromAMac = (): void => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_USER_AGENT);
};

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The contract under test is the releases the workflows publish, which are
 * machine-consumed declarative artifacts read by GitHub Actions. Both links
 * are the signed release: `release.yml`'s `publish` job decides each file name
 * behind `releases/latest/download/<name>` and that the release becomes the
 * repository's latest. `unsigned-test-installers.yml`'s `publish` job decides
 * which files a run leaves on the `unsigned-latest` test release, which the
 * site never links. Nothing else checks that the two sides agree. The rendered-href tests below
 * compare the constant to itself, so a rename on either side alone would leave
 * every test green and 404 the Download button in production.
 *
 * So each workflow is parsed into a model and asked what it actually
 * publishes, rather than searched for strings, and each workflow's publish
 * scripts are run to see what the release holds and how it is published.
 */
const repositoryPath = (relative: string): string => {
  // Walked up from the vitest root rather than `import.meta.url`, which Vite
  // rewrites to a non-file URL, and rather than a fixed number of `..` hops.
  for (let dir = process.cwd(); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find ${relative} above ${process.cwd()}`);
};
const workflowPath = repositoryPath(".github/workflows/unsigned-test-installers.yml");
const releaseWorkflowPath = repositoryPath(".github/workflows/release.yml");

type Step = { name?: string; env?: Record<string, string>; run?: string };
type Job = { env?: Record<string, string>; steps?: Step[] };

const stagingStepName = "Stage the release assets under their permanent names";
const publishStepName = "Publish the release";

const publishJobOf = (workflowFile: string): Job => {
  const workflow = parseYaml(readFileSync(workflowFile, "utf8")) as { jobs?: Record<string, Job> };
  const publish = workflow.jobs?.publish;
  expect(publish, `${workflowFile} has no \`publish\` job`).toBeDefined();
  return publish ?? {};
};

const stepOf = (job: Job, stepName: string): Step => job.steps?.find((step) => step.name === stepName) ?? {};

const releaseStateFile = "release-state.txt";
const ghCallsFile = "gh-calls.txt";

/**
 * `gh` for the publish scripts, against one release whose asset names live in
 * `release-state.txt`. Every call's arguments are logged, tab-separated, to
 * `gh-calls.txt`. Like the real CLI, `release create` and `release upload`
 * upload each file they name under its base name and fail on a missing one.
 */
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
state=${releaseStateFile}
(IFS=$'\\t'; printf '%s\\n' "$*") >> ${ghCallsFile}
case "$1 $2" in
  "release view") if [ "$#" -gt 3 ]; then assets="$(cat "$state")"; printf '%s\\n' "$assets"; fi ;;
  "release edit") ;;
  "release create" | "release upload")
    shift 3
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --target | --title | --notes-file) shift 2 ;;
        --*) shift ;;
        *)
          if [ ! -f "$1" ]; then echo "no such file: $1" >&2; exit 1; fi
          name="$(basename -- "$1")"
          if ! grep -qxF -- "$name" "$state"; then echo "$name" >> "$state"; fi
          shift ;;
      esac
    done ;;
  "release delete-asset") assets="$(grep -vxF -- "$4" "$state" || true)"; printf '%s\\n' "$assets" > "$state" ;;
  *) echo "unexpected: gh $*" >&2; exit 1 ;;
esac
`;

type PublishRun = { assetsAfter: string[]; ghCalls: string[][] };

/** What each installer leg uploads as its run artifact. */
const LEG_ARTIFACTS = {
  windows: ["TEST-SIQshift_0.0.0_x64-setup.exe", "TEST-SIQshift_0.0.0_x64-setup.exe.sig", "TEST-BUILD.txt"],
  macos: ["TEST-SIQshift_0.0.0_universal.dmg", "TEST-SIQshift.app.tar.gz", "TEST-SIQshift.app.tar.gz.sig", "TEST-BUILD.txt"],
} as const;

/**
 * What a workflow's `publish` job does after a run that built the given legs:
 * the asset names the release holds afterwards, and every `gh` call that put
 * them there. The job's own staging and publishing steps run under bash, as on
 * its ubuntu runner, over each leg's artifact, with the job's and the step's
 * env. `gh` is the one external boundary, so a stand-in plays the release.
 */
const publishAfterRun = (
  workflowFile: string,
  { legs, assetsBefore = [] }: { legs: readonly (keyof typeof LEG_ARTIFACTS)[]; assetsBefore?: readonly string[] },
): PublishRun => {
  const publish = publishJobOf(workflowFile);
  const runDir = mkdtempSync(join(tmpdir(), "siqshift-publish-"));
  try {
    for (const leg of legs) {
      const artifactDir = join(runDir, "downloaded", `TEST-BUILD-${leg}-1`);
      mkdirSync(artifactDir, { recursive: true });
      for (const name of LEG_ARTIFACTS[leg]) writeFileSync(join(artifactDir, name), "");
    }
    mkdirSync(join(runDir, "bin"));
    writeFileSync(join(runDir, "bin", "gh"), fakeGh, { mode: 0o755 });
    writeFileSync(join(runDir, releaseStateFile), assetsBefore.map((name) => `${name}\n`).join(""));
    writeFileSync(join(runDir, ghCallsFile), "");

    // The runner substitutes every `${{ }}` expression before bash sees the script or its env.
    const substituted = (text: string): string => text.replaceAll(/\$\{\{[^}]*\}\}/g, "0");
    for (const stepName of [stagingStepName, publishStepName]) {
      const step = stepOf(publish, stepName);
      expect(step.run, `the publish job has no \`${stepName}\` step`).toBeDefined();
      const stepEnv = Object.entries({ ...publish.env, ...step.env })
        .map(([name, value]): [string, string] => [name, substituted(value)]);
      const { status, stderr } = spawnSync("bash", ["-c", substituted(step.run ?? "")], {
        cwd: runDir,
        encoding: "utf8",
        env: {
          ...process.env,
          // The test workflow hands it to later steps from its release notes step, through GITHUB_ENV.
          VERSION: "0.0.0-test.1",
          ...Object.fromEntries(stepEnv),
          PATH: `${join(runDir, "bin")}${delimiter}${process.env.PATH ?? ""}`,
        },
      });
      expect(status, stderr).toBe(0);
    }
    const linesOf = (file: string): string[] =>
      readFileSync(join(runDir, file), "utf8").split("\n").filter((line) => line !== "");
    return { assetsAfter: linesOf(releaseStateFile), ghCalls: linesOf(ghCallsFile).map((line) => line.split("\t")) };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
};

/**
 * The notes the publish job's notes step writes, run under bash as on its
 * ubuntu runner, with what bash printed to stderr while writing them.
 */
const releaseNotesOfRun = (): { notes: string; stderr: string } => {
  const workflow = parseYaml(readFileSync(workflowPath, "utf8")) as { jobs?: Record<string, Job> };
  const script = workflow.jobs?.publish?.steps?.find((step) => step.name === "Write the release notes")?.run ?? "";
  expect(script, "the publish job has no `Write the release notes` step").not.toBe("");

  const runDir = mkdtempSync(join(tmpdir(), "siqshift-notes-"));
  try {
    const configDir = join(runDir, "apps", "desktop", "src-tauri");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "tauri.conf.json"), JSON.stringify({ version: "0.0.0" }));

    // The runner substitutes every `${{ }}` expression before bash sees the script.
    const { status, stderr } = spawnSync("bash", ["-c", script.replaceAll(/\$\{\{[^}]*\}\}/g, "0")], {
      cwd: runDir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_ENV: join(runDir, "github-env") },
    });
    expect(status, stderr).toBe(0);
    return { notes: readFileSync(join(runDir, "release-notes.md"), "utf8"), stderr };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
};

/** `https://…/releases/download/<tag>/<asset>` split back into its two halves. */
const releaseRefOf = (url: string): { tag: string; assetName: string } => {
  const segments = new URL(url).pathname.split("/");
  return { tag: segments.at(-2) ?? "", assetName: segments.at(-1) ?? "" };
};

describe("installer URLs", () => {
  // The publish jobs run on ubuntu-latest; on Windows `bash` is WSL's launcher, not that shell.
  it.skipIf(process.platform === "win32")(
    "send Windows to the installer the signed release uploads, once that release is published as latest",
    () => {
      // Act
      const { assetsAfter, ghCalls } = publishAfterRun(releaseWorkflowPath, { legs: ["windows"] });

      // Assert: GitHub serves releases/latest/download/<name> from the latest release's asset of that name,
      // so the signed release must hold that asset and then be published, out of draft, as the latest.
      expect(new URL(windowsInstallerUrl).pathname).toMatch(/^\/[^/]+\/[^/]+\/releases\/latest\/download\/[^/]+$/);
      expect(assetsAfter).toContain(releaseRefOf(windowsInstallerUrl).assetName);
      const created = ghCalls.findIndex(([group, command]) => group === "release" && command === "create");
      expect(created, "the publish job never creates the release").not.toBe(-1);
      const createdTag = ghCalls[created]?.[2];
      const isPublishedAsLatest = ghCalls.slice(created + 1).some(([group, command, tag, ...flags]) =>
        group === "release" && command === "edit" && tag === createdTag
        && flags.includes("--draft=false") && flags.includes("--latest"));
      expect(isPublishedAsLatest).toBe(true);
    },
  );

  it("send Mac to the newest signed release, never the unsigned test release", () => {
    // Act
    const { pathname } = new URL(macInstallerUrl);

    // Assert
    expect(pathname).toMatch(/^\/[^/]+\/[^/]+\/releases\/latest\/download\/[^/]+\.dmg$/);
  });

  // The publish jobs run on ubuntu-latest; on Windows `bash` is WSL's launcher, not that shell.
  it.skipIf(process.platform === "win32")(
    "send Mac to the installer the signed release uploads, once that release is published as latest",
    () => {
      // Act
      const { assetsAfter, ghCalls } = publishAfterRun(releaseWorkflowPath, { legs: ["windows", "macos"] });

      // Assert
      expect(assetsAfter).toContain(releaseRefOf(macInstallerUrl).assetName);
      const created = ghCalls.findIndex(([group, command]) => group === "release" && command === "create");
      expect(created, "the publish job never creates the release").not.toBe(-1);
      const createdTag = ghCalls[created]?.[2];
      const isPublishedAsLatest = ghCalls.slice(created + 1).some(([group, command, tag, ...flags]) =>
        group === "release" && command === "edit" && tag === createdTag
        && flags.includes("--draft=false") && flags.includes("--latest"));
      expect(isPublishedAsLatest).toBe(true);
    },
  );

  // The publish job runs on ubuntu-latest; on Windows `bash` is WSL's launcher, not that shell.
  it.skipIf(process.platform === "win32")(
    "keep the test release's Mac file when a run there builds no signed Mac one",
    () => {
      // Arrange: the release already holds a Mac file from an earlier run and an asset no run stages any more.
      // DEPLOY.md documents the test release's files as unsigned-latest/SIQshift-windows-x64-setup.exe and
      // unsigned-latest/SIQshift-macos-universal.dmg.
      const unsignedWindowsAssetName = "SIQshift-windows-x64-setup.exe";
      const unsignedMacAssetName = "SIQshift-macos-universal.dmg";
      const retiredAssetName = "SIQshift-retired.zip";

      // Act
      const { assetsAfter } = publishAfterRun(workflowPath, {
        legs: ["windows"],
        assetsBefore: [unsignedMacAssetName, retiredAssetName],
      });

      // Assert: the run really published and cleaned up, and left the Mac file in place.
      expect(assetsAfter).toContain(unsignedWindowsAssetName);
      expect(assetsAfter).not.toContain(retiredAssetName);
      expect(assetsAfter).toContain(unsignedMacAssetName);
    },
  );
});

describe("the release notes the publish job writes", () => {
  // The publish job runs on ubuntu-latest; on Windows `bash` is WSL's launcher, not that shell.
  it.skipIf(process.platform === "win32")("show inline code as written instead of running it as a command", () => {
    // Arrange: the notes put `.dmg` in backticks, which an unquoted heredoc would run.
    const expectedLine = "rather than the `.dmg` this workflow builds.";

    // Act
    const { notes, stderr } = releaseNotesOfRun();

    // Assert
    expect(stderr).toBe("");
    expect(notes).toContain(expectedLine);
  });
});

describe("DownloadInstaller in the masthead", () => {
  const openMenu = async () => {
    const person = userEvent.setup();
    render(<DownloadInstaller />);
    await person.click(screen.getByRole("button", { name: /download/i }));
    return person;
  };

  it("is one control, with nothing else of its own on screen beside it", () => {
    const { container } = render(<DownloadInstaller />);

    // The whole point of the rework: the header row holds a single element from
    // this component, not a button plus a wrapped note plus a stacked link.
    const trigger = screen.getByRole("button", { name: /download/i });
    expect(container.querySelector(".download-menu")?.children).toHaveLength(1);
    expect(trigger).toHaveClass("ghost");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.textContent).toBe("Download");
  });

  it("says who signed the build before anything is downloaded", async () => {
    // Discoverable without opening anything…
    render(<DownloadInstaller />);
    expect(screen.getByRole("button", { name: /download/i })).toHaveAttribute("title", installerNote);

    // …and stated in the panel, each installer tied to how it is signed.
    const person = userEvent.setup();
    await person.click(screen.getByRole("button", { name: /download/i }));
    expect(screen.getByRole("link", { name: "Download for Windows" })).toHaveAccessibleDescription(installerNote);
    expect(screen.getByRole("link", { name: "Mac installer (Apple silicon and Intel)" }))
      .toHaveAccessibleDescription(macInstallerNote);
  });

  it("offers Windows as the primary download with the newest build's URL", async () => {
    await openMenu();

    const windows = screen.getByRole("link", { name: "Download for Windows" });
    expect(windows).toHaveAttribute("href", windowsInstallerUrl);
    expect(windows).toHaveClass("is-primary");
  });

  it("carries the Mac build in the same panel, secondary to Windows", async () => {
    await openMenu();

    const mac = screen.getByRole("link", { name: "Mac installer (Apple silicon and Intel)" });
    expect(mac).toHaveAttribute("href", macInstallerUrl);
    expect(mac).not.toHaveClass("is-primary");
    expect(screen.getAllByRole("link", { name: /download/i })).toHaveLength(1);
  });

  it("offers a Mac visitor the Mac build first, and Windows beside it", async () => {
    // Arrange
    browseFromAMac();

    // Act
    await openMenu();

    // Assert
    expect(screen.getByRole("button", { name: /download/i })).toHaveAttribute("title", macInstallerNote);
    const mac = screen.getByRole("link", { name: "Download for Mac" });
    expect(mac).toHaveAttribute("href", macInstallerUrl);
    expect(mac).toHaveClass("is-primary");
    expect(mac).toHaveAccessibleDescription(macInstallerNote);
    const windows = screen.getByRole("link", { name: "Windows installer (64-bit)" });
    expect(windows).toHaveAttribute("href", windowsInstallerUrl);
    expect(windows).not.toHaveClass("is-primary");
    expect(windows).toHaveAccessibleDescription(installerNote);
    expect(screen.getAllByRole("link", { name: /download/i })).toHaveLength(1);
  });

  it("says whether the panel is open, and closes again", async () => {
    const person = await openMenu();
    const trigger = screen.getByRole("button", { name: /download/i });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", screen.getByRole("link", { name: "Download for Windows" }).closest(".download-panel")?.id);

    await person.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Download for Windows" })).not.toBeInTheDocument();
  });

  it("closes when the click lands anywhere else", async () => {
    const person = await openMenu();

    await person.click(document.body);

    expect(screen.getByRole("button", { name: /download/i })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("DownloadInstaller in the welcome hero", () => {
  it("still says everything at once, because that page is the download", () => {
    const { container } = render(<DownloadInstaller placement="hero" />);

    expect(container.querySelector(".download-corner")).toHaveClass("is-hero");
    const windows = screen.getByRole("link", { name: "Download for Windows" });
    expect(windows).toHaveAttribute("href", windowsInstallerUrl);
    expect(windows).toHaveClass("download-button");
    expect(windows).toHaveAccessibleDescription(installerNote);
    const mac = screen.getByRole("link", { name: "Mac installer (Apple silicon and Intel)" });
    expect(mac).toHaveAttribute("href", macInstallerUrl);
    expect(mac).toHaveAccessibleDescription(macInstallerNote);
  });

  it("hands a Mac visitor the Mac build as the download", () => {
    // Arrange
    browseFromAMac();

    // Act
    render(<DownloadInstaller placement="hero" />);

    // Assert
    const mac = screen.getByRole("link", { name: "Download for Mac" });
    expect(mac).toHaveAttribute("href", macInstallerUrl);
    expect(mac).toHaveClass("download-button");
    expect(mac).toHaveAccessibleDescription(macInstallerNote);
    expect(screen.getByRole("link", { name: "Windows installer (64-bit)" })).toHaveAttribute("href", windowsInstallerUrl);
  });
});

describe("InstallerLink", () => {
  it("hands out the same installer as the button", () => {
    render(<InstallerLink />);

    expect(screen.getByRole("link", { name: "Download for Windows" }))
      .toHaveAttribute("href", windowsInstallerUrl);
  });
});
