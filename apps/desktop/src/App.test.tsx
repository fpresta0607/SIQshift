import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { sourceLabel } from "./agent-sources.js";
import type { LiveAgentSessions, OrganizationOverview, PermissionStatus, TimerBridge, WorkspaceReport } from "./bridge.js";

vi.mock("@siqshift/shared/webgl-shader", () => ({ WebGLShader: () => null }));

const windowControls = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  // The stats tick asks the window whether anyone can see it before it reads
  // the server. Shown and not minimized is the default so existing tests,
  // which are all about a window someone is looking at, keep ticking.
  isVisible: vi.fn(async () => true),
  isMinimized: vi.fn(async () => false),
  focusHandlers: [] as ((event: { payload: boolean }) => void)[],
  onFocusChanged: vi.fn(async function (this: void, handler: (event: { payload: boolean }) => void) {
    windowControls.focusHandlers.push(handler);
    return () => {
      windowControls.focusHandlers = windowControls.focusHandlers.filter((entry) => entry !== handler);
    };
  }),
}));

/** Puts the window in the tray, the state it spends most of its life in. */
const hideWindow = (): void => {
  windowControls.isVisible.mockResolvedValue(false);
};

/** Brings it back, the way showing it from the tray does. */
const showWindow = (): void => {
  windowControls.isVisible.mockResolvedValue(true);
  for (const handler of windowControls.focusHandlers) handler({ payload: true });
};

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowControls }));

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "timer@example.com",
  name: "Timer User",
};

const project = { id: "00000000-0000-4000-8000-000000000010", name: "Field work", color: "#d89a34" };
const otherProject = { id: "00000000-0000-4000-8000-000000000011", name: "Client work", color: null };
const newProject = { id: "00000000-0000-4000-8000-000000000012", name: "Fresh", color: null };

const account = {
  kind: "ready" as const,
  user,
  projects: [project, otherProject],
  defaultProjectId: project.id,
  selectedProjectId: null,
};

const settings = {
  enabled: true,
  awayThresholdMinutes: 10,
  agentOverrideEnabled: true,
  browserAutoInstall: true,
  agentUsageCapture: true,
  deviceId: "00000000-0000-4000-8000-000000000300",
};

const status = {
  enabled: true,
  running: true,
  observing: true,
  lastPollAgeSeconds: 12,
  lastUploadAt: "2026-08-06T14:55:00.000Z",
  segmentBacklog: 0,
  agentBacklog: 0,
  sessionBacklog: 0,
  hooks: [
    { source: "claude_code", detected: true, installed: true, needsYou: false, configPath: "C:/Users/dev/.claude/settings.json" },
    { source: "codex", detected: false, installed: true, needsYou: false, configPath: "C:/Users/dev/.codex/config.toml" },
  ],
  agentActive: null,
  currentSession: null,
  openSpan: null,
  agentSessions: [],
  selectedProjectId: null,
};

const recording = {
  ...status,
  currentSession: {
    projectId: project.id,
    attribution: "agent" as const,
    since: "2026-08-06T14:00:00.000Z",
    idleSeconds: 0,
    apps: [],
  },
};

const noMeasurement = {
  activeSeconds: 0,
  agentSeconds: 0,
  concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
  byAgent: [] as never[],
};

const meStats = {
  filters: {},
  totalDurationSeconds: 7_200,
  attributedSeconds: 5_400,
  unattributedSeconds: 1_800,
  ...noMeasurement,
  hourly: [],
  projects: [{
    project: { id: project.id, name: project.name },
    durationSeconds: 7_200,
    attributedSeconds: 5_400,
    unattributedSeconds: 1_800,
    sessionCount: 3,
  }],
  apps: [
    { processName: "Code.exe", durationSeconds: 4_800 },
    { processName: "chrome.exe", durationSeconds: 1_200 },
  ],
};

const mapping = {
  id: "00000000-0000-4000-8000-000000000400",
  pathPrefix: "C:/dev/SIQshift",
  repoUrl: null,
  projectId: project.id,
};

/// The shifts behind each group, keyed the way the API serves them: the heads
/// carry none of these, and a drawer asks for one group's page.
const agentShiftRowsByGroup: Record<string, readonly Record<string, unknown>[]> = {
  siqshift: [
    {
      id: "00000000-0000-4000-8000-000000000601",
      source: "claude_code",
      owner: { id: user.id, name: user.name },
      model: "claude-opus-5",
      startedAt: "2026-08-06T15:00:00.000Z",
      endedAt: "2026-08-06T16:00:00.000Z",
      agentSeconds: 3_600,
      commitCount: 2,
    },
    {
      id: "00000000-0000-4000-8000-000000000602",
      source: "claude_code",
      owner: { id: user.id, name: user.name },
      model: null,
      startedAt: "2026-08-06T13:00:00.000Z",
      endedAt: "2026-08-06T13:30:00.000Z",
      agentSeconds: 1_800,
      commitCount: 0,
    },
  ],
  "null:unidentified-run-directory": [{
    id: "00000000-0000-4000-8000-000000000603",
    source: "pi",
    owner: { id: user.id, name: user.name },
    model: "deepseek-v4-pro",
    startedAt: "2026-08-06T12:00:00.000Z",
    endedAt: "2026-08-06T12:30:00.000Z",
    agentSeconds: 1_800,
    commitCount: 1,
  }],
};

/// The hour buckets the server folds over those shifts, contiguous from the
/// first one onward so the quiet 14:00 reads as quiet rather than vanishing.
const agentShiftsHourly = [12, 13, 14, 15].map((hour) => ({
  hourStart: `2026-08-06T${String(hour).padStart(2, "0")}:00:00.000Z`,
  activeSeconds: 0,
  agentSeconds: hour === 15 ? 3_600 : hour === 14 ? 0 : 1_800,
}));

/// The Agents tab's map: two codebases, three shifts, one decided commit.
/// Heads only - the shifts hang behind `groupKey`.
const agentShifts = {
  totalAgentSeconds: 7_200,
  hourly: agentShiftsHourly,
  groups: [
    {
      groupKey: "siqshift",
      repo: "siqshift",
      nullCause: null,
      agentSeconds: 5_400,
      shiftCount: 2,
      heldRate: 0.5,
    },
    {
      groupKey: "null:unidentified-run-directory",
      repo: null,
      nullCause: "unidentified-run-directory",
      agentSeconds: 1_800,
      shiftCount: 1,
      heldRate: null,
    },
  ],
};

/// One group's page, cut from the cursor the way the command cuts it: the
/// first row strictly after the named one in the group's own ordering.
const agentShiftRowsFor = (groupKey: string, after: { id: string } | null, pageSize = 50) => {
  const all = agentShiftRowsByGroup[groupKey] ?? [];
  const start = after === null ? 0 : all.findIndex((row) => row.id === after.id) + 1;
  const shifts = all.slice(start, start + pageSize);
  const last = shifts.at(-1);
  return {
    shifts,
    nextCursor: last === undefined || start + shifts.length >= all.length
      ? null
      : { startedAt: last.startedAt, id: last.id },
  };
};

const sam = { id: "b1c7e513-b094-4d4c-ae55-21790ae019a4", name: "Sam" };

/// The team view's one read: Sam leads, the signed-in member follows, and
/// every total is the server's, added up there.
const workspaceReport = {
  activeSeconds: 10_600,
  agentSeconds: 5_400,
  hourly: [
    { hourStart: "2026-08-06T13:00:00.000Z", activeSeconds: 3_000, agentSeconds: 3_600 },
    { hourStart: "2026-08-06T14:00:00.000Z", activeSeconds: 2_400, agentSeconds: 1_800 },
  ],
  projects: [
    { project: { id: project.id, name: project.name }, durationSeconds: 7_000 },
    { project: { id: otherProject.id, name: otherProject.name }, durationSeconds: 3_600 },
  ],
  agents: [{ source: "claude_code", durationSeconds: 5_400 }],
  members: [
    { rank: 1, user: sam, activeSeconds: 7_000, agentSeconds: 3_600, project: { id: project.id, name: project.name } },
    { rank: 2, user: { id: user.id, name: user.name }, activeSeconds: 3_600, agentSeconds: 1_800, project: { id: otherProject.id, name: otherProject.name } },
  ],
} satisfies WorkspaceReport;

const bridgeFor = (overrides: Partial<TimerBridge> = {}): TimerBridge => ({
  bootstrap: vi.fn().mockResolvedValue(account),
  login: vi.fn().mockResolvedValue(account),
  signup: vi.fn().mockResolvedValue(account),
  logout: vi.fn().mockResolvedValue(undefined),
  preferencesGet: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
  preferencesSet: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
  orgOverview: vi.fn().mockResolvedValue({
    organization: { id: "00000000-0000-4000-8000-000000000900", name: "SIQstack", inviteCode: "ACDEF-GHJKM" },
  }),
  orgJoin: vi.fn().mockResolvedValue({
    organization: { id: "00000000-0000-4000-8000-000000000901", name: "Joined Team", inviteCode: "PQRTU-VWXY3" },
  }),
  orgRename: vi.fn().mockResolvedValue({
    organization: { id: "00000000-0000-4000-8000-000000000900", name: "Field Crew", inviteCode: "ACDEF-GHJKM" },
  }),
  // The default is "the host cannot report": every recording surface stays
  // quiet rather than claiming something it cannot see.
  monitorStatus: vi.fn().mockRejectedValue({ kind: "unknown", message: "Recording unavailable" }),
  browserStatus: vi.fn().mockResolvedValue([]),
  browserRepair: vi.fn().mockRejectedValue({ kind: "unknown", message: "Repair unavailable" }),
  browserOpenStore: vi.fn().mockResolvedValue(undefined),
  // Every platform but macOS reports no permissions.
  permissionsStatus: vi.fn().mockResolvedValue([]),
  permissionRequest: vi.fn().mockResolvedValue([]),
  permissionDecline: vi.fn().mockResolvedValue([]),
  permissionOpenSettings: vi.fn().mockResolvedValue(undefined),
  sessionSelectProject: vi.fn().mockResolvedValue(status),
  hookRegister: vi.fn().mockResolvedValue({ status: "registered", configPath: "C:/Users/dev/.claude/settings.json" }),
  monitorSetEnabled: vi.fn().mockResolvedValue(settings),
  settingsGet: vi.fn().mockResolvedValue(settings),
  settingsUpdate: vi.fn().mockResolvedValue(settings),
  meStats: vi.fn().mockResolvedValue(meStats),
  workspaceReport: vi.fn().mockResolvedValue(workspaceReport),
  // An unbounded range gets no hourly series, which is what the server
  // answers: per-hour resolution over all of history means nothing.
  agentShifts: vi.fn().mockImplementation(async (fromAt?: string) => (
    fromAt === undefined ? { ...agentShifts, hourly: [] } : agentShifts
  )),
  liveAgentSessions: vi.fn().mockResolvedValue({ people: [] } satisfies LiveAgentSessions),
  agentShiftRows: vi.fn().mockImplementation(async (groupKey: string, after: { id: string } | null) => agentShiftRowsFor(groupKey, after)),
  projectCreate: vi.fn().mockResolvedValue(newProject),
  projectUpdate: vi.fn().mockResolvedValue(project),
  projectUsage: vi.fn().mockResolvedValue({ sessionCount: 0, durationSeconds: 0, agentSessionCount: 0 }),
  projectDelete: vi.fn().mockResolvedValue(undefined),
  appIcons: vi.fn().mockResolvedValue({}),
  quotaStatus: vi.fn().mockResolvedValue({ status: "ready", checkedAt: null, detail: null, providers: [] }),
  onUpdateAvailable: vi.fn().mockResolvedValue(() => undefined),
  ...overrides,
});

/// Opens the "All stats" overlay, where everything historical now lives: the
/// main surface is the record card and this session, and nothing else.
const openAllStats = async (person: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await person.click(await screen.findByTestId("all-stats-trigger"));
  // The overlay is titled by the workspace it shows.
  return screen.getByRole("dialog", { name: /SIQstack|All stats/ });
};

/// The dialog's Humans or Agents switch. The team view's breakdown has an
/// Agents toggle of its own, so the dialog holds two buttons by that name.
const agentsTab = (panel: HTMLElement): HTMLElement =>
  within(within(panel).getByRole("group", { name: "Humans or agents" })).getByRole("button", { name: "Agents" });

/// One figure on the totals row that opens each team view page.
const teamTotal = (panel: HTMLElement, label: string) =>
  within(within(panel).getByLabelText("Totals")).getByText(label).nextElementSibling?.querySelector("b");

/// Opens All stats and switches to the Agents tab, returning the dialog.
const openAgentsTab = async (person: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  const panel = await openAllStats(person);
  await person.click(agentsTab(panel));
  await within(panel).findByTestId("agent-shifts");
  return panel;
};

/// Opens the settings overlay from the titlebar gear and returns the dialog.
const openSettings = async (person: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await person.click(await screen.findByRole("button", { name: "Settings" }));
  return screen.getByRole("dialog", { name: "Settings" });
};

/// Opens settings and unfolds its Team group, returning the group.
const openTeamGroup = async (person: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  const summary = await within(await openSettings(person)).findByText("Team");
  await person.click(summary);
  const group = summary.closest("details");
  if (group === null) throw new Error("The Team summary is outside its group.");
  return group;
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  // `clearAllMocks` forgets calls but keeps implementations, so a test that
  // put the window in the tray would leave it there for every test after it.
  windowControls.isVisible.mockResolvedValue(true);
  windowControls.isMinimized.mockResolvedValue(false);
  windowControls.focusHandlers = [];
});

describe("sign-in", () => {
  it("shows a labelled sign-in form after a signed-out bootstrap", async () => {
    render(<App bridge={bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }) })} />);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("surfaces a failed sign-in without losing the form", async () => {
    const login = vi.fn().mockRejectedValue({ kind: "auth", message: "Those details did not match." });
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }), login })} />);

    await screen.findByRole("heading", { name: "Sign in" });
    await person.type(screen.getByLabelText("Email"), user.email);
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Those details did not match.");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  // Issue 84: a sign-up for an email the sign-in service already holds, with
  // a password that did not sign in, ended on a generic error.
  it("moves a sign-up for a taken email to sign-in with the email kept", async () => {
    // Arrange
    const message = "This email can't start a new account, so sign in with it or check it for a typo.";
    const signup = vi.fn().mockRejectedValue({ kind: "account_exists", message });
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }), signup })} />);
    await screen.findByRole("heading", { name: "Sign in" });
    await person.click(screen.getByRole("button", { name: "New here? Create an account" }));

    // Act
    await person.type(screen.getByLabelText("Name"), "Sam Example");
    await person.type(screen.getByLabelText("Email"), "new.person@example.test");
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.click(screen.getByRole("button", { name: "Create account" }));

    // Assert
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByLabelText("Email")).toHaveValue("new.person@example.test");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("signs in and lands on the recording screen", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }),
      monitorStatus: vi.fn().mockResolvedValue(recording),
    })} />);

    await screen.findByRole("heading", { name: "Sign in" });
    await person.type(screen.getByLabelText("Email"), user.email);
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Recording on")).toBeInTheDocument();
  });

  it("wires the titlebar window controls to the current window", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    await person.click(await screen.findByRole("button", { name: "Minimize" }));
    expect(windowControls.minimize).toHaveBeenCalledTimes(1);
    await person.click(screen.getByRole("button", { name: "Maximize" }));
    expect(windowControls.toggleMaximize).toHaveBeenCalledTimes(1);
    await person.click(screen.getByRole("button", { name: "Close" }));
    expect(windowControls.close).toHaveBeenCalledTimes(1);
  });
});

describe("recording", () => {
  it("shows the stretch of work in progress with nothing to press", async () => {
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    // One accumulated figure for the day, under the date: a second timer for
    // the open stretch only ever raised the question of which was the total.
    expect(await screen.findByTestId("elapsed-time")).toBeInTheDocument();
    expect(screen.queryByTestId("today-line")).not.toBeInTheDocument();
    expect(screen.queryByText(/Filed here because/)).not.toBeInTheDocument();
    // Nothing in the product starts or stops time any more.
    expect(screen.queryByRole("button", { name: /start/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument();
  });

  it("explains an idle machine instead of pretending to record", async () => {
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) })} />);

    // The clock still shows the day's total; the note says why nothing is
    // being added to it right now.
    expect(await screen.findByTestId("elapsed-time")).toBeInTheDocument();
    expect(await screen.findByText(/There is nothing to press/)).toBeInTheDocument();
  });

  it("says recording is off, and never implies otherwise", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({ ...status, enabled: false, running: false, observing: false }),
    })} />);

    // Recording state is a dot and a spoken label beside the project now, so
    // the surface never has to repeat itself in a heading.
    expect(await screen.findByText("Recording off")).toBeInTheDocument();
    expect(screen.getByText(/Turn recording on/)).toBeInTheDocument();
  });

  // The screenshot bug: the timer said RECORDING while the card under it said
  // "Turn on recording in settings". Both now read the one shared state, so no
  // arrangement of props can make them disagree.
  it("never tells you to turn recording on while it is recording", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      // Recording is demonstrably on, but nothing has been added up yet.
      meStats: vi.fn().mockResolvedValue({ ...meStats, totalDurationSeconds: 0, apps: [], projects: [] }),
    })} />);

    const person = userEvent.setup();
    expect(await screen.findByText(/^Recording on/)).toBeInTheDocument();
    expect(await screen.findByTestId("elapsed-time")).toBeInTheDocument();

    // The live surface shows the open stretch on its project's row rather
    // than an empty state telling anyone to do anything.
    expect(await screen.findByTestId("project-list")).not.toHaveTextContent(/turn (on )?recording/i);
    expect(screen.queryByTestId("today-panel-empty")).not.toBeInTheDocument();

    // And the historical one behind "All stats", which is where the
    // contradiction used to be printed.
    const empty = within(await openAllStats(person)).getByTestId("today-empty");
    expect(empty).not.toHaveTextContent(/turn (on )?recording/i);
    expect(empty).toHaveTextContent("Nothing has been added up yet.");
  });

  // A poll task that dies leaves `running` true. Reading "on" from that alone
  // is what let the app look healthy while it recorded nothing for days.
  it("says recording stopped responding when the machine is no longer sampled", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({ ...recording, observing: false, lastPollAgeSeconds: 900 }),
    })} />);

    expect(await screen.findByText("Recording stopped responding")).toBeInTheDocument();
    expect(screen.queryByText("Recording on")).not.toBeInTheDocument();
  });

  it("gives every running agent session its own row, named by its project", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({
        ...recording,
        // Two terminals of the same tool, working in different folders.
        agentSessions: [
          { source: "claude_code", externalSessionId: "one", projectId: project.id, since: new Date(Date.now() - 600_000).toISOString() },
          { source: "claude_code", externalSessionId: "two", projectId: otherProject.id, since: new Date(Date.now() - 120_000).toISOString() },
        ],
      }),
    })} />);

    const rows = within(await screen.findByTestId("session-app-list")).getAllByRole("listitem");
    const claude = rows.filter((row) => row.textContent?.includes("Claude Code"));
    // One row for the tool, naming every project its sessions are in. Five
    // terminals are one tool, not five slices of the day.
    expect(claude).toHaveLength(1);
    expect(claude[0]).toHaveTextContent(project.name);
    expect(claude[0]).toHaveTextContent(otherProject.name);
    // No minutes of its own: an agent runs beside the editor it lives in, so
    // its wall-clock would double-count time already counted there. The row
    // being there is what says the tool is connected (issue 101): it prints
    // no state word, and leaves no empty duration cell for the dial to stop at.
    expect(claude[0]).not.toHaveTextContent(/connected|working/);
    expect(claude[0]!.querySelector(".meter-duration")).toBeNull();
  });

  it("renders no recording surfaces when the host cannot report status", async () => {
    render(<App bridge={bridgeFor()} />);

    // A host that cannot answer is its own state: the screen says it is still
    // checking rather than borrowing the wording of a healthy idle machine.
    expect(await screen.findByText(/asking this computer what it is doing/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/^Recording (on|paused|off)$/)).not.toBeInTheDocument());
  });

  it("names the workspace and project above the clock, with the picker behind Change", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    // The header says where time is landing, in words rather than an icon.
    const where = await screen.findByTestId("filing-where");
    await waitFor(() => expect(where).toHaveTextContent("SIQstack"));
    expect(where).toHaveTextContent(project.name);

    // Collapsed by default: no dropdown competing with the clock.
    expect(screen.queryByLabelText("File my time under")).not.toBeInTheDocument();

    await person.click(screen.getByTestId("filing-change"));
    expect(screen.getByLabelText("File my time under")).toBeVisible();

    await person.click(screen.getByTestId("filing-change"));
    expect(screen.queryByLabelText("File my time under")).not.toBeInTheDocument();
  });

  it("names the default project above the clock for a stretch nothing else named a project for", async () => {
    // Arrange
    const defaultAttributed = { ...recording, currentSession: { ...recording.currentSession, attribution: "default" as const } };

    // Act
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(defaultAttributed) })} />);

    // Assert: "Work it out for me" files under the default project, so the
    // header says that project rather than "Unattributed", and its dot wears
    // the color that project's row wears below.
    const where = await screen.findByTestId("filing-where");
    await waitFor(() => expect(where).toHaveTextContent(project.name));
    expect(where).not.toHaveTextContent("Unattributed");
    expect(where.querySelector<HTMLElement>(".monitor-dot")).toHaveStyle({ background: project.color });
  });

  it("offers the default project once, as the work it out for me choice", async () => {
    // Arrange
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    // Act
    await person.click(await screen.findByTestId("filing-change"));

    // Assert
    const choices = within(screen.getByRole("radiogroup", { name: "File my time under" })).getAllByRole("radio");
    expect(choices).toHaveLength(2);
    expect(choices[0]).toHaveAccessibleName(`Work it out for me (${project.name})`);
    expect(choices[1]).toHaveAccessibleName(otherProject.name);
  });

  it("pins time to a project and hands the choice back to the host", async () => {
    const sessionSelectProject = vi.fn().mockResolvedValue({ ...recording, selectedProjectId: otherProject.id });
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording), sessionSelectProject })} />);

    await person.click(await screen.findByTestId("filing-change"));
    const picker = screen.getByRole("radiogroup", { name: "File my time under" });
    // The default choice is "work it out for me", naming where that lands,
    // and exactly one row carries the tick.
    expect(within(picker).getByRole("radio", { name: /Work it out for me \(Field work\)/ })).toHaveAttribute("aria-checked", "true");
    expect(within(picker).getAllByRole("radio", { checked: true })).toHaveLength(1);

    await person.click(within(picker).getByRole("radio", { name: otherProject.name }));
    await waitFor(() => expect(sessionSelectProject).toHaveBeenCalledWith(otherProject.id));

    // Choosing collapses the picker and the header names the pinned project.
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "File my time under" })).not.toBeInTheDocument());
    expect(screen.getByTestId("filing-where")).toHaveTextContent(otherProject.name);
  });

  it("lists the account's projects with no team row - one login is one team", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    await person.click(await screen.findByTestId("filing-change"));
    const picker = await screen.findByRole("radiogroup", { name: "File my time under" });
    expect(screen.queryByLabelText("Team")).not.toBeInTheDocument();
    expect(within(picker).getByRole("radio", { name: `Work it out for me (${project.name})` })).toBeInTheDocument();
    expect(within(picker).getByRole("radio", { name: otherProject.name })).toBeInTheDocument();
  });

  it("creates a project and pins recording to it", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByTestId("filing-change"));
    await person.click(await screen.findByRole("button", { name: "New project…" }));
    await person.type(screen.getByLabelText("New project name"), "Fresh");
    await person.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(bridge.projectCreate).toHaveBeenCalledWith({ name: "Fresh" }));
    await waitFor(() => expect(bridge.sessionSelectProject).toHaveBeenCalledWith(newProject.id));
  });

  it("says nothing about syncing, which happens on its own", async () => {
    const backlogged = { ...recording, segmentBacklog: 2, sessionBacklog: 1 };
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(backlogged) })} />);

    await screen.findByTestId("elapsed-time");
    // A backlog is the app's problem, not the reader's: it drains by itself
    // and never earns a banner on the record surface.
    expect(screen.queryByTestId("sync-line")).not.toBeInTheDocument();
    expect(screen.queryByText(/still on this computer/i)).not.toBeInTheDocument();
  });
});

describe("macOS permissions", () => {
  it("names an unasked grant on the main screen and adopts macOS's answer", async () => {
    // Arrange
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      permissionsStatus: vi.fn().mockResolvedValue([
        { id: "login-item", state: "granted" },
        { id: "protected-folders", state: "not-asked" },
      ]),
      permissionRequest: vi.fn().mockResolvedValue([
        { id: "login-item", state: "granted" },
        { id: "protected-folders", state: "granted" },
      ]),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    const card = await screen.findByTestId("permissions-card");

    // Act
    await person.click(within(card).getByRole("button", { name: "Ask now" }));

    // Assert: recording goes on regardless, and the card leaves once settled.
    expect(bridge.permissionRequest).toHaveBeenCalledWith("protected-folders");
    await waitFor(() => expect(screen.queryByTestId("permissions-card")).not.toBeInTheDocument());
    expect(screen.getByTestId("elapsed-time")).toBeInTheDocument();
  });

  it("re-reads the grants when the window comes back into focus", async () => {
    // Arrange: switched off, then switched on in System Settings.
    const permissionsStatus = vi.fn()
      .mockResolvedValueOnce([{ id: "login-item", state: "missing" }])
      .mockResolvedValue([{ id: "login-item", state: "granted" }]);
    render(<App bridge={bridgeFor({ permissionsStatus })} />);
    expect(await screen.findByTestId("permissions-card")).toHaveTextContent("Not allowed");

    // Act
    act(() => showWindow());

    // Assert
    await waitFor(() => expect(screen.queryByTestId("permissions-card")).not.toBeInTheDocument());
  });

  it("waits for a grant read macOS is holding behind its prompt before reading again", async () => {
    // Arrange: the first read stays unanswered, as it does while macOS's
    // folders prompt is up.
    vi.useFakeTimers();
    let answerHeldRead: (statuses: PermissionStatus[]) => void = () => undefined;
    const permissionsStatus = vi.fn()
      .mockReturnValueOnce(new Promise<PermissionStatus[]>((resolve) => { answerHeldRead = resolve; }))
      .mockResolvedValue([]);
    render(<App bridge={bridgeFor({ permissionsStatus })} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(permissionsStatus).toHaveBeenCalledTimes(1);

    // Act: a poll tick and a focus change while it is still held.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await act(async () => { showWindow(); await vi.advanceTimersByTimeAsync(0); });

    // Assert
    expect(permissionsStatus).toHaveBeenCalledTimes(1);

    // Once answered, the next tick reads again.
    await act(async () => { answerHeldRead([]); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(permissionsStatus).toHaveBeenCalledTimes(2);
  });

  it("hides the browser auto-install switch on macOS, where it would do nothing", async () => {
    // Arrange
    const userAgent = vi.spyOn(navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) })} />);

    // Act
    const dialog = await openSettings(person);

    // Assert
    expect(await within(dialog).findByLabelText("Keep recording while an AI tool is working")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Add the SIQshift extension to my browsers automatically")).not.toBeInTheDocument();
    userAgent.mockRestore();
  });
});

describe("today", () => {
  it("totals the range with the time nothing named a project for in its project's row", async () => {
    // Arrange: Field work's two hours include half an hour filed there by default.
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) })} />);

    // Act
    const panel = await openAllStats(person);

    // Assert: the card renders before the stats land, so wait for the figure
    // itself. The project row underneath repeats the number, so pin the headline.
    expect(await within(panel).findByText("2h 00m", { selector: "strong" })).toBeInTheDocument();
    const projects = within(within(panel).getByTestId("member-project-list")).getAllByRole("listitem");
    expect(projects.map((row) => row.textContent)).toEqual([`${project.name}2h 00m`]);
    expect(within(panel).queryByTestId("unattributed-foot")).not.toBeInTheDocument();
  });

  it("switches range and refetches from the week's start", async () => {
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    // Opening costs nothing: your own "today" reuses the main screen's read.
    expect(bridge.meStats).toHaveBeenCalledTimes(1);
    await person.click(await within(panel).findByRole("button", { name: "This week" }));

    await waitFor(() => expect(bridge.meStats).toHaveBeenCalledTimes(2));
    expect(await within(panel).findByText(/^This week · /)).toBeInTheDocument();
  });

  it("folds agent CLI processes into one friendly row", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [
          { processName: "claude.exe", durationSeconds: 3_600 },
          { processName: "Code.exe", durationSeconds: 1_800 },
        ],
      }),
    })} />);

    const apps = await within(await openAllStats(person)).findByTestId("member-app-list");
    expect(await within(apps).findByText("Claude Code")).toBeInTheDocument();
    expect(within(apps).getByText("VS Code")).toBeInTheDocument();
  });

  it("keeps the agent session stats off the Humans tab - they belong to the agent", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const panel = await openAllStats(person);
    const stats = await within(panel).findByTestId("member-stats");
    expect(within(stats).queryByTestId("agent-sessions")).not.toBeInTheDocument();
    expect(within(stats).queryByTestId("agent-breakdown")).not.toBeInTheDocument();
    expect(within(stats).getByTestId("breakdown")).not.toHaveTextContent("Total agent time");
  });
});

describe("settings", () => {
  it("round-trips the recording switch and the quiet-time limit", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    expect(await within(dialog).findByLabelText("Record my work time on this computer")).toBeChecked();

    await person.click(within(dialog).getByLabelText("Record my work time on this computer"));
    await waitFor(() => expect(bridge.monitorSetEnabled).toHaveBeenCalledWith(false));

    await person.click(within(dialog).getByLabelText("Keep recording while an AI tool is working"));
    await waitFor(() => expect(bridge.settingsUpdate).toHaveBeenCalledWith({ agentOverrideEnabled: false }));

    await person.click(within(dialog).getByLabelText("Add the SIQshift extension to my browsers automatically"));
    await waitFor(() => expect(bridge.settingsUpdate).toHaveBeenCalledWith({ browserAutoInstall: false }));

    await person.click(within(dialog).getByLabelText("Count tokens and models in my AI tools' session logs"));
    await waitFor(() => expect(bridge.settingsUpdate).toHaveBeenCalledWith({ agentUsageCapture: false }));

    const quiet = within(dialog).getByLabelText("End a stretch after this many quiet minutes");
    await person.clear(quiet);
    await person.type(quiet, "15");
    await person.tab();
    await waitFor(() => expect(bridge.settingsUpdate).toHaveBeenCalledWith({ awayThresholdMinutes: 15 }));
  });

  it("keeps the overlay open when a settings write is refused", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(status),
      monitorSetEnabled: vi.fn().mockRejectedValue({ kind: "transient", message: "Settings could not be saved" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByLabelText("Record my work time on this computer"));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Settings could not be saved");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("has no folders-and-projects group left to configure", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const dialog = await openSettings(person);
    await within(dialog).findByText("Recording");
    expect(within(dialog).queryByText("Folders and projects")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Folder")).not.toBeInTheDocument();
  });

  it("shows connected tools as badges and connects one through the dropdown", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByText("AI tools"));

    // Connected tools are a fact, not a control; only the add needs buttons.
    const badge = within(within(dialog).getByTestId("hook-connected")).getByText("Claude Code");
    expect(badge).toBeInTheDocument();
    // No session has named a model, so the badge's second line is the dash:
    // absence as absence, never a zero.
    expect(badge.closest("li")).toHaveTextContent("-");
    expect(within(dialog).getAllByRole("button", { name: "Connect" })).toHaveLength(1);

    const picker = within(dialog).getByLabelText("Tool to connect");
    await person.selectOptions(picker, "codex");
    await person.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(bridge.hookRegister).toHaveBeenCalledWith("codex"));
  });

  it("names the models a connected tool has driven and what an unconnected one can report", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(status),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        byAgent: [
          { source: "claude_code", model: "claude-fable-5", durationSeconds: 3_600, sessionCount: 2, maxConcurrent: 1, medianSeconds: 1_800 },
          { source: "claude_code", model: null, durationSeconds: 600, sessionCount: 1, maxConcurrent: 1, medianSeconds: 600 },
        ],
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByText("AI tools"));

    // The badge's second line names the models seen, and a session that
    // named none adds nothing to it.
    const badge = await within(within(dialog).getByTestId("hook-connected")).findByText("Claude Code");
    await waitFor(() => expect(badge.closest("li")).toHaveTextContent("claude-fable-5"));

    // The picker says whether a runtime can report a model at all, straight
    // from the roster's own declaration.
    const picker = within(dialog).getByLabelText("Tool to connect");
    expect(within(picker).getByRole("option", { name: "Codex · can name its model" })).toBeInTheDocument();
  });

  it("opens the what's-recorded panel from the recording group", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByRole("button", { name: /See exactly what's recorded/ }));

    const panel = await screen.findByRole("dialog", { name: "What SIQshift is recording" });
    expect(within(panel).getByText("Recording is on")).toBeInTheDocument();
    // Escape closes the panel it belongs to, leaving settings open behind it.
    await person.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "What SIQshift is recording" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("logs out and returns to the sign-in form", async () => {
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByRole("button", { name: "Log out" }));

    await waitFor(() => expect(bridge.logout).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("the what's-recorded panel", () => {
  it("opens from the recording line and lists every source", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    await person.click(await screen.findByRole("button", { name: "What's recorded?" }));

    const panel = await screen.findByRole("dialog", { name: "What SIQshift is recording" });
    expect(within(panel).getByText("Claude Code").closest("li")).toHaveTextContent("Connected");
    expect(within(panel).getByText("Codex").closest("li")).toHaveTextContent("Not connected");
    expect(within(panel).getByTestId("panel-current")).toHaveTextContent("Field work");

    await person.click(within(panel).getByRole("button", { name: "Close what's recorded" }));
    expect(screen.queryByRole("dialog", { name: "What SIQshift is recording" })).not.toBeInTheDocument();
  });

  it("turns recording on from the panel when it is off", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({ ...status, enabled: false, running: false, observing: false }),
      monitorSetEnabled: vi.fn().mockResolvedValue({ ...settings, enabled: true }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "What's recorded?" }));
    const panel = await screen.findByRole("dialog", { name: "What SIQshift is recording" });
    expect(within(panel).getByText("Recording is off")).toBeInTheDocument();

    await person.click(within(panel).getByRole("button", { name: "Turn recording on" }));
    await waitFor(() => expect(bridge.monitorSetEnabled).toHaveBeenCalledWith(true));
  });

  it("connects an AI tool from the panel and shows what to paste when it cannot", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(status),
      hookRegister: vi.fn().mockResolvedValue({
        status: "manual",
        configPath: "C:/Users/dev/.codex/config.toml",
        snippet: "notify = [\"siqshift-hook\"]",
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "What's recorded?" }));
    const panel = await screen.findByRole("dialog", { name: "What SIQshift is recording" });
    await person.click(within(panel).getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(bridge.hookRegister).toHaveBeenCalledWith("codex"));
    expect(await within(panel).findByText(/can't switch this one on by itself/)).toBeInTheDocument();
    expect(within(panel).getByText('notify = ["siqshift-hook"]')).toBeInTheDocument();
  });
});

describe("the today panel", () => {
  it("lays out where today's time went: projects first, then apps in one row each", async () => {
    render(<App bridge={bridgeFor({
      // No open stretch: the rows below are exactly the server totals.
      monitorStatus: vi.fn().mockResolvedValue({
        ...status,
        agentActive: { source: "claude_code", since: "2026-08-06T14:10:00.000Z" },
      }),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        projects: [
          { project: { id: project.id, name: project.name }, durationSeconds: 5_400, attributedSeconds: 5_400, unattributedSeconds: 0, sessionCount: 2 },
          { project: { id: otherProject.id, name: otherProject.name }, durationSeconds: 900, attributedSeconds: 0, unattributedSeconds: 900, sessionCount: 1 },
        ],
        apps: [
          { processName: "claude.exe", durationSeconds: 3_600 },
          { processName: "chrome.exe", durationSeconds: 1_800 },
          { processName: "Code.exe", durationSeconds: 900 },
        ],
      }),
    })} />);

    // Time consolidates under the projects the monitor filed it into.
    const projects = within(await screen.findByTestId("project-list")).getAllByRole("listitem");
    expect(projects[0]).toHaveTextContent("Field work");
    expect(projects[0]).toHaveTextContent("1h 30m");
    // Client work's quarter hour fell back to it because nothing named a
    // project, and time filed by default counts as that project's time.
    expect(projects[1]).toHaveTextContent("Client work");
    expect(projects[1]).toHaveTextContent("15m");
    expect(screen.getByTestId("project-list")).not.toHaveTextContent("Unattributed");

    const rows = within(screen.getByTestId("session-app-list")).getAllByRole("listitem");
    // Heaviest first, agent CLIs named by their runtime rather than their exe.
    expect(rows[0]).toHaveTextContent("Claude Code");
    expect(rows[0]).toHaveTextContent("1h 00m");
    expect(rows[1]).toHaveTextContent("Google Chrome");
    expect(rows[1]).toHaveTextContent("30m");
    expect(rows[2]).toHaveTextContent("VS Code");
    expect(rows[2]).toHaveTextContent("15m");
  });

  it("draws the hourly chart as real path geometry once the API sends buckets", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        hourly: [
          { hourStart: "2026-08-15T09:00:00.000Z", activeSeconds: 600, agentSeconds: 300 },
          { hourStart: "2026-08-15T10:00:00.000Z", activeSeconds: 1_800, agentSeconds: 900 },
          { hourStart: "2026-08-15T11:00:00.000Z", activeSeconds: 300, agentSeconds: 0 },
        ],
      }),
    })} />);

    // Pin the series by their hooks, never by a path count: gradient areas
    // are paths too. The chart must emit <path d="M… L…"> elements, not
    // polylines fed a path string: `points` cannot parse path commands, so a
    // polyline would hold zero points and the graph would be an empty frame.
    const graph = await screen.findByTestId("hourly-graph");
    const agentLine = graph.querySelector('path[data-series="agent"]');
    const humanLine = graph.querySelector('path[data-series="human"]');
    expect(agentLine).not.toBeNull();
    expect(humanLine).not.toBeNull();
    for (const line of [agentLine, humanLine]) {
      const d = line!.getAttribute("d")!;
      expect(d).toMatch(/^M\d/);
      expect(d).toContain("L");
    }
    // Geometry is measured, not just present: the busiest hour must plot
    // highest (smallest y), and an empty hour must sit on the baseline.
    const points = [...agentLine!.getAttribute("d")!.matchAll(/[ML]([\d.]+),([\d.]+)/g)]
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
    expect(points).toHaveLength(3);
    expect(points[1]!.y).toBeLessThan(points[0]!.y);
    expect(points[2]!.y).toBeGreaterThan(points[1]!.y);
    // Day resolution draws a visible dot per bucket.
    expect(graph.querySelectorAll('circle[data-point="agent"]')).toHaveLength(3);
  });

  // Issue 101: the Today graph is time and only time, the person in gray
  // against agents in green. Tokens moved to the Agents tab's bars.
  it("draws exactly two lines on the Today graph, human and agent, and no token series", async () => {
    // Arrange
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        hourly: [
          { hourStart: "2026-08-15T09:00:00.000Z", activeSeconds: 600, agentSeconds: 300 },
          { hourStart: "2026-08-15T10:00:00.000Z", activeSeconds: 1_800, agentSeconds: 900 },
        ],
      }),
    });

    // Act
    render(<App bridge={bridge} />);
    const graph = await screen.findByTestId("hourly-graph");

    // Assert
    const series = [...graph.querySelectorAll("path[data-series]")].map((line) => line.getAttribute("data-series"));
    expect(series).toEqual(["agent", "human"]);
    expect(within(graph).queryByRole("button", { name: "Tokens" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("token-chart")).not.toBeInTheDocument();
  });

  it("keeps agent runtimes on their own rows instead of folding them together", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [
          { processName: "claude.exe", durationSeconds: 3_600 },
          { processName: "codex.exe", durationSeconds: 1_800 },
        ],
      }),
    })} />);

    const list = await screen.findByTestId("session-app-list");
    // Which tool the time went to is the question this surface answers, so
    // "Agent CLIs" as one row would defeat the point.
    expect(within(list).getByText("Claude Code")).toBeInTheDocument();
    expect(within(list).getByText("Codex")).toBeInTheDocument();
    expect(within(list).queryByText("Agent CLIs")).not.toBeInTheDocument();
  });

  it("adds the open stretch to its project's row so the breakdown ticks with the clock", async () => {
    const live = {
      ...recording,
      currentSession: {
        ...recording.currentSession,
        since: new Date(Date.now() - 30_000).toISOString(),
      },
    };
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(live),
      // The server knows nothing yet; the row below exists purely live.
      meStats: vi.fn().mockResolvedValue({ ...meStats, totalDurationSeconds: 0, apps: [], projects: [] }),
    })} />);

    const projects = within(await screen.findByTestId("project-list")).getAllByRole("listitem");
    expect(projects[0]).toHaveTextContent("Field work");
    expect(projects[0]).toHaveTextContent(/\d+s/);
  });

  it("adds an open stretch filed by default to the default project's row, not a row of its own", async () => {
    // Arrange: nothing named a project for the open stretch, and the server
    // already holds an hour of the default project's time.
    const live = {
      ...recording,
      currentSession: {
        ...recording.currentSession,
        attribution: "default" as const,
        since: new Date(Date.now() - 30_000).toISOString(),
      },
    };
    const projects = [{ project: { id: project.id, name: project.name }, durationSeconds: 3_600, attributedSeconds: 0, unattributedSeconds: 3_600, sessionCount: 1 }];

    // Act
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(live),
      meStats: vi.fn().mockResolvedValue({ ...meStats, totalDurationSeconds: 3_600, apps: [], projects }),
    })} />);

    // Assert
    const rows = within(await screen.findByTestId("project-list")).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(project.name);
    expect(rows[0]).toHaveTextContent("1h 00m");
    expect(screen.getByTestId("project-list")).not.toHaveTextContent("Unattributed");
  });

  it("counts the still-open span so the app in front is neither frozen nor missing", async () => {
    const live = {
      ...recording,
      // In front for two minutes, and no upload covers it yet.
      openSpan: { processName: "WindowsTerminal.exe", since: new Date(Date.now() - 120_000).toISOString() },
    };
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(live),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [{ processName: "Code.exe", durationSeconds: 60 }],
      }),
    })} />);

    const rows = within(await screen.findByTestId("session-app-list")).getAllByRole("listitem");
    // The open app appears at all - the server has never heard of it - and
    // outranks the app the server does know about.
    expect(rows[0]).toHaveTextContent("Windows Terminal");
    expect(rows[0]).toHaveTextContent("2m");
    expect(rows[1]).toHaveTextContent("VS Code");
  });

  it("puts the plan reading on an agent's row instead of a share bar", async () => {
    const quotaStatus = vi.fn().mockResolvedValue({
      status: "ready",
      checkedAt: "2026-08-12T19:00:00.000Z",
      detail: null,
      providers: [{
        provider: "claude",
        label: "Claude",
        sources: ["claude_code"],
        status: "known",
        account: { email: "dev@siqshift.test", organization: null },
        plan: "max",
        percentRemaining: 73,
        bindingWindowId: "five_hour",
        windows: [{ id: "five_hour", label: "session", kind: "session", percentRemaining: 73, resetsAt: null }],
        detail: null,
        reason: null,
        stale: false,
      }],
    });
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      quotaStatus,
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [{ processName: "claude.exe", durationSeconds: 3_600 }],
      }),
    })} />);

    // One row: the agent that is working, its own running time, and its plan
    // reading - not a separate list of every tool that could be installed.
    const rows = within(await screen.findByTestId("session-app-list")).getAllByRole("listitem");
    const row = rows.find((candidate) => candidate.textContent?.includes("Claude Code"));
    expect(row).toBeDefined();
    // The dial carries the whole reading as its label, so the arc is never
    // the only thing saying it.
    expect(await within(row!).findByRole("button", { name: /73% remaining on the max plan/i })).toBeInTheDocument();
  });

  // Pi is a harness, not a billed model: the roster declares no quota provider
  // for it, so nothing will ever read one. "Quota unknown" answered a question
  // that was never asked, and read as a failure the user could go fix.
  it("shows no quota element at all for a runtime that bills nothing", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [
          { processName: "pi.exe", durationSeconds: 3_600 },
          { processName: "claude.exe", durationSeconds: 1_800 },
        ],
      }),
    })} />);

    const rows = within(await screen.findByTestId("session-app-list")).getAllByRole("listitem");
    const pi = rows.find((candidate) => candidate.textContent?.includes(sourceLabel("pi")));
    expect(pi).toBeDefined();
    expect(pi).not.toHaveTextContent(/quota/i);
    expect(within(pi!).queryByRole("button", { name: /quota/i })).not.toBeInTheDocument();
    // Claude Code does bill against a plan, so its dial still says so even
    // when the reading has not landed - that absence is worth reporting.
    const claude = rows.find((candidate) => candidate.textContent?.includes(sourceLabel("claude_code")));
    expect(within(claude!).getByRole("button", { name: /quota unknown/i })).toBeInTheDocument();
  });

  it("asks again while the plan reading is still pending", async () => {
    const pending = { status: "pending" as const, checkedAt: null, detail: null, providers: [] };
    const ready = {
      status: "ready" as const,
      checkedAt: "2026-08-12T19:00:00.000Z",
      detail: null,
      providers: [{
        provider: "claude",
        label: "Claude",
        sources: ["claude_code"],
        status: "known" as const,
        account: null,
        plan: "max",
        percentRemaining: 73,
        bindingWindowId: "five_hour",
        windows: [{ id: "five_hour", label: "session", kind: "session", percentRemaining: 73, resetsAt: null }],
        detail: null,
        reason: null,
        stale: false,
      }],
    };
    // The host answers the first call from an empty cache while it reads the
    // providers behind it; the dial must not sit on "checking" until the slow
    // poll comes round.
    const quotaStatus = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(ready);
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({
        ...recording,
        agentSessions: [{ source: "claude_code", externalSessionId: "one", projectId: project.id, since: new Date().toISOString() }],
      }),
      quotaStatus,
    })} />);

    await screen.findByTestId("session-app-list");
    await waitFor(() => expect(quotaStatus.mock.calls.length).toBeGreaterThan(1), { timeout: 5_000 });
    expect(await screen.findByRole("button", { name: /73% remaining/i })).toBeInTheDocument();
  }, 10_000);

  it("shows the OS icon for an app when the host has one", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      appIcons: vi.fn().mockResolvedValue({ "chrome.exe": "data:image/png;base64,AAAA", "Code.exe": null }),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [
          { processName: "chrome.exe", durationSeconds: 1_800 },
          { processName: "Code.exe", durationSeconds: 900 },
        ],
      }),
    })} />);

    const list = await screen.findByTestId("session-app-list");
    // The real icon when the OS offers one, a quiet placeholder when not.
    await waitFor(() => {
      const image = list.querySelector("img.app-mark");
      expect(image).toHaveAttribute("src", "data:image/png;base64,AAAA");
    });
    expect(list.querySelector(".app-mark.is-plain")).not.toBeNull();
  });

  it("ships a runtime mark for every connector in the roster", async () => {
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    await screen.findByText("Recording on");
    await userEvent.setup().click(screen.getByRole("button", { name: "What's recorded?" }));

    const panel = await screen.findByRole("dialog", { name: "What SIQshift is recording" });
    for (const source of ["claude_code", "codex"]) {
      const mark = within(panel).getByTestId(`agent-mark-${source}`);
      // A real mark, not a letter tile standing in for one.
      expect(mark.querySelector("svg")).not.toBeNull();
      expect(mark).not.toHaveClass("is-generic");
    }
  });
});

describe("the all-stats overlay scope", () => {
  it("offers no project scope select and fetches every project", async () => {
    const bridge = bridgeFor({
      preferencesGet: vi.fn().mockResolvedValue({ scope: otherProject.id, range: "30d" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    // The main screen's filing bar already answers "which project"; the
    // overlay reads everything and never touches the shared preference row.
    expect(within(panel).queryByLabelText("Project scope")).not.toBeInTheDocument();
    await waitFor(() => expect(bridge.workspaceReport).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
    ));
    expect(bridge.preferencesGet).not.toHaveBeenCalled();
    expect(bridge.preferencesSet).not.toHaveBeenCalled();
  });
});

describe("the team board", () => {
  it("lays the team out as the home page's example workspace", async () => {
    // Arrange
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    // Act: the board is history, so it sits behind "All stats".
    const panel = await openAllStats(person);
    const view = within(panel);
    await view.findByLabelText("Totals");

    // Assert
    expect(view.getByRole("heading", { name: "SIQstack" })).toBeInTheDocument();
    expect(view.getByText(/^Today · /)).toBeInTheDocument();
    expect(teamTotal(panel, "Active time")).toHaveTextContent("2h 56m");
    expect(teamTotal(panel, "Agent time")).toHaveTextContent("1h 30m");
    expect(teamTotal(panel, "People")).toHaveTextContent(/^2$/);
    expect(teamTotal(panel, "Projects")).toHaveTextContent(/^2$/);
    const graph = within(view.getByRole("region", { name: "Over time" })).getByTestId("hourly-graph");
    expect(graph.querySelector('[data-series="agent"]')).not.toBeNull();
    expect(graph.querySelector('[data-series="human"]')).not.toBeNull();
    const [, first, second] = within(view.getByRole("table", { name: "People" })).getAllByRole("row");
    expect(first).toHaveTextContent(/^1SSamField work1h 56m1h 00m$/);
    expect(second).toHaveTextContent(/^2TUTimer UserYouClient work1h 00m30m$/);
    const breakdown = within(view.getByRole("region", { name: "Projects or agents" }));
    expect(breakdown.getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Field work1h 56m", "Client work1h 00m"]);
    await person.click(within(breakdown.getByRole("group", { name: "Projects or agents" })).getByRole("button", { name: "Agents" }));
    expect(breakdown.getByText("Agent time")).toBeInTheDocument();
    expect(breakdown.getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Claude Code1h 30m"]);
    expect(view.queryByText("Local agents, shared visibility")).toBeNull();
    expect(bridge.workspaceReport).toHaveBeenCalled();
  });

  it("draws the team totals the server added up, never a sum of the rows", async () => {
    // Arrange
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      workspaceReport: vi.fn().mockResolvedValue({ ...workspaceReport, activeSeconds: 12_000, agentSeconds: 20_000 }),
    })} />);

    // Act
    const panel = await openAllStats(person);
    await within(panel).findByLabelText("Totals");

    // Assert
    expect(teamTotal(panel, "Active time")).toHaveTextContent("3h 20m");
    expect(teamTotal(panel, "Agent time")).toHaveTextContent("5h 33m");
  });

  it("shows a workspace of one as a single row, the viewer's own", async () => {
    // Arrange
    const ownProject = { id: otherProject.id, name: otherProject.name };
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      workspaceReport: vi.fn().mockResolvedValue({
        activeSeconds: 3_600,
        agentSeconds: 0,
        hourly: [],
        projects: [{ project: ownProject, durationSeconds: 3_600 }],
        agents: [],
        members: [{ rank: 1, user: { id: user.id, name: user.name }, activeSeconds: 3_600, agentSeconds: 0, project: ownProject }],
      } satisfies WorkspaceReport),
    })} />);

    // Act
    const panel = await openAllStats(person);
    await within(panel).findByLabelText("Totals");

    // Assert
    expect(teamTotal(panel, "People")).toHaveTextContent(/^1$/);
    expect(teamTotal(panel, "Projects")).toHaveTextContent(/^1$/);
    expect(teamTotal(panel, "Active time")).toHaveTextContent("1h 00m");
    const [, only, ...rest] = within(within(panel).getByRole("table", { name: "People" })).getAllByRole("row");
    expect(rest).toEqual([]);
    expect(only).toHaveTextContent(/^1TUTimer UserYouClient work1h 00m0s$/);
    expect(within(only!).getByRole("button", { name: "Show Timer User's work" })).toHaveAttribute("aria-pressed", "true");
    // Nobody else to pick, so the board does not offer to.
    expect(within(panel).queryByText("Select a teammate to explore their work.")).toBeNull();
  });

  it("says so when the workspace read fails, instead of loading forever", async () => {
    // Arrange
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      workspaceReport: vi.fn().mockRejectedValue({ kind: "transient", message: "Could not reach the server." }),
    })} />);

    // Act
    const panel = await openAllStats(person);

    // Assert
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Could not reach the server.");
    expect(within(panel).queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("asks for the team view over the range picked in the overlay", async () => {
    // Arrange: a Thursday afternoon, so the week began on Monday the 3rd.
    vi.setSystemTime(new Date(2026, 7, 6, 15));
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    const panel = await openAllStats(person);

    // Act
    await person.click(within(panel).getByRole("button", { name: "This week" }));

    // Assert: local Monday midnight to the next.
    await waitFor(() => expect(bridge.workspaceReport).toHaveBeenLastCalledWith(
      new Date(2026, 7, 3).toISOString(),
      new Date(2026, 7, 10).toISOString(),
    ));

    // Act
    await person.click(within(panel).getByRole("button", { name: "All time" }));

    // Assert: all time sends no bounds.
    await waitFor(() => expect(bridge.workspaceReport).toHaveBeenLastCalledWith(undefined, undefined));
  });

  it("takes today's team view down when the week's read fails, rather than calling it this week", async () => {
    // Arrange: today's read lands; any read spanning more than a day fails.
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      workspaceReport: vi.fn().mockImplementation((fromAt?: string, toExclusiveAt?: string) => (
        Date.parse(toExclusiveAt ?? "") - Date.parse(fromAt ?? "") > 2 * 86_400_000
          ? Promise.reject({ kind: "transient", message: "Could not reach the server." })
          : Promise.resolve(workspaceReport)
      )),
    })} />);
    const panel = await openAllStats(person);
    await within(panel).findByLabelText("Totals");

    // Act
    await person.click(within(panel).getByRole("button", { name: "This week" }));

    // Assert: the failure shows at once, and today's totals are gone with it.
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Could not reach the server.");
    expect(within(panel).queryByLabelText("Totals")).not.toBeInTheDocument();
  });

  it("opens on your own breakdown and follows whichever member gets picked", async () => {
    const samStats = {
      ...meStats,
      totalDurationSeconds: 5_400,
      apps: [{ processName: "blender.exe", durationSeconds: 5_400 }],
    };
    const bridge = bridgeFor({
      meStats: vi.fn().mockImplementation((_fromAt?: string, _toExclusiveAt?: string, userId?: string) =>
        Promise.resolve(userId === undefined ? meStats : samStats)),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    // You are highlighted and shown by default.
    const stats = within(panel).getByTestId("member-stats");
    expect(within(stats).getByRole("heading", { name: /^Timer User/ })).toBeInTheDocument();

    // Picking Sam swaps the breakdown to Sam, fetched by their id.
    await person.click(within(panel).getByRole("button", { name: /Sam/ }));
    expect(await within(stats).findByRole("heading", { name: /^Sam/ })).toBeInTheDocument();
    await waitFor(() => expect(bridge.meStats).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      "b1c7e513-b094-4d4c-ae55-21790ae019a4",
    ));
    expect(await within(stats).findByText("Blender")).toBeInTheDocument();
  });

  it("states the agent time limit word for word under both the Humans and the Agents page", async () => {
    // Arrange
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);
    const panel = await openAllStats(person);
    await within(panel).findByLabelText("Totals");

    // Act
    const onHumans = within(panel).getByTestId("agent-time-limit").textContent;
    await person.click(agentsTab(panel));
    await within(panel).findByTestId("agent-shifts");

    // Assert
    const note = "A shift that goes 30 minutes without activity stops counting and cannot resume; later work in that session is not included.";
    expect(onHumans).toBe(note);
    expect(within(panel).getByTestId("agent-time-limit")).toHaveTextContent(note);
  });

  it("writes the breakdown in plain words and drops empty agent buckets", async () => {
    const bridge = bridgeFor({
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        activeSeconds: 14_400,
        agentSeconds: 21_600,
        concurrency: { t0Seconds: 3_600, t1Seconds: 3_600, t2Seconds: 0, t3PlusSeconds: 5_400, awaySeconds: 1_800 },
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    const stats = within(panel).getByTestId("member-stats");
    const breakdown = within(stats).getByTestId("breakdown");
    expect(breakdown).toHaveTextContent("Human work");
    expect(breakdown).toHaveTextContent("With 1 agent");
    expect(breakdown).toHaveTextContent("With 3+ agents");
    expect(breakdown).toHaveTextContent("1h 30m");
    expect(breakdown).not.toHaveTextContent("With 2 agents");
    // What the agents themselves added up to is the agent's number, not the
    // person's; it lives on the Agents tab now.
    expect(breakdown).not.toHaveTextContent("while away");
    expect(breakdown).not.toHaveTextContent("Total agent time");
  });

  // The same card as the web's, and the same report: 1h56m recorded against
  // 37m active with no agent time measured anywhere in the window. The header
  // called the difference "unattended agent time" from `recorded > active`
  // alone, and the app list under it summed to presence while the project list
  // above it summed to the total.
  it("explains the gap between recorded and active without inventing agent time", async () => {
    const samStats = {
      ...meStats,
      totalDurationSeconds: 6_960,
      activeSeconds: 2_220,
      agentSeconds: 0,
      concurrency: { t0Seconds: 2_220, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
      byAgent: [],
      projects: [{
        project: { id: project.id, name: project.name },
        durationSeconds: 6_960,
        attributedSeconds: 6_960,
        unattributedSeconds: 0,
        sessionCount: 2,
      }],
      apps: [
        { processName: "WindowsTerminal.exe", durationSeconds: 1_200 },
        { processName: "chrome.exe", durationSeconds: 1_020 },
      ],
    };
    const bridge = bridgeFor({
      meStats: vi.fn().mockImplementation((_fromAt?: string, _toExclusiveAt?: string, userId?: string) =>
        Promise.resolve(userId === undefined ? meStats : samStats)),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    // A teammate's card, so the numbers are the server's rather than this
    // machine's live day.
    const panel = await openAllStats(person);
    await person.click(within(panel).getByRole("button", { name: /Sam/ }));
    const stats = within(panel).getByTestId("member-stats");
    await within(stats).findByRole("heading", { name: /^Sam/ });

    const total = within(stats).getByText(/recorded/).closest("p");
    expect(total).not.toHaveTextContent(/agent/i);
    expect(total).toHaveTextContent("1h 56m");
    expect(total).toHaveTextContent("1h 19m of it away from the keyboard");

    // The app list closes on the same total the project list does.
    const apps = within(stats).getByTestId("member-app-list");
    expect(within(apps).getByText("Quiet time").closest("li")).toHaveTextContent("1h 19m");
    expect(within(stats).getByTestId("member-project-list")).toHaveTextContent("1h 56m");
  });

  it("keeps the breakdown quiet when there is nothing recorded", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const panel = await openAllStats(person);
    const stats = within(panel).getByTestId("member-stats");
    const breakdown = within(stats).getByTestId("breakdown");
    expect(breakdown).toHaveTextContent("Human work");
    expect(breakdown).not.toHaveTextContent("Total agent time");
    expect(within(stats).queryByTestId("agent-sessions")).not.toBeInTheDocument();
  });

  it("offers a way back to your own breakdown after picking a teammate", async () => {
    const samStats = {
      ...meStats,
      totalDurationSeconds: 5_400,
      apps: [{ processName: "blender.exe", durationSeconds: 5_400 }],
    };
    const bridge = bridgeFor({
      meStats: vi.fn().mockImplementation((_fromAt?: string, _toExclusiveAt?: string, userId?: string) =>
        Promise.resolve(userId === undefined ? meStats : samStats)),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    const stats = within(panel).getByTestId("member-stats");
    await person.click(within(panel).getByRole("button", { name: /Sam/ }));
    expect(await within(stats).findByRole("heading", { name: /^Sam/ })).toBeInTheDocument();

    await person.click(within(stats).getByRole("button", { name: "Show my own" }));
    expect(await within(stats).findByRole("heading", { name: /^Timer User/ })).toBeInTheDocument();
  });

  it("surfaces a failed self/today read instead of a blank or endless state", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(status),
      meStats: vi.fn().mockRejectedValue({ kind: "transient", message: "The stats service is unavailable." }),
    })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The stats service is unavailable.");
    expect(screen.queryByTestId("today-panel-empty")).not.toBeInTheDocument();

    const panel = await openAllStats(person);
    const stats = within(panel).getByTestId("member-stats");
    expect(within(stats).getByRole("alert")).toHaveTextContent("The stats service is unavailable.");
    expect(within(stats).queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("rides out fewer than three failed refreshes on last-good data", async () => {
    vi.useFakeTimers();
    const failure = { kind: "transient", message: "The stats service is unavailable." };
    const meStatsMock = vi.fn()
      .mockResolvedValueOnce(meStats)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(meStats);
    render(<App bridge={bridgeFor({ meStats: meStatsMock })} />);

    // The first read lands; the day is on screen.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId("session-app-list")).toBeInTheDocument();

    // Two failed background refreshes keep the numbers and stay quiet.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(meStatsMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-app-list")).toBeInTheDocument();

    // The third consecutive failure earns the banner - beside the data.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("The stats service is unavailable.");
    expect(screen.getByTestId("session-app-list")).toBeInTheDocument();

    // The next success clears it and resets the count.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reads nothing while it sits in the tray, and catches up when it is shown", async () => {
    vi.useFakeTimers();
    const meStatsMock = vi.fn().mockResolvedValue(meStats);
    render(<App bridge={bridgeFor({ meStats: meStatsMock })} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const afterFirstRead = meStatsMock.mock.calls.length;

    // Into the tray. Three ticks' worth of time passes and nobody can see the
    // answer, so nothing is asked for.
    hideWindow();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(meStatsMock.mock.calls.length).toBe(afterFirstRead);

    // Shown again: current before it has been looked at twice.
    await act(async () => { showWindow(); await vi.advanceTimersByTimeAsync(0); });
    expect(meStatsMock.mock.calls.length).toBeGreaterThan(afterFirstRead);
  });

  it("skips the tick while minimized, which is not the same as hidden", async () => {
    vi.useFakeTimers();
    const meStatsMock = vi.fn().mockResolvedValue(meStats);
    render(<App bridge={bridgeFor({ meStats: meStatsMock })} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const afterFirstRead = meStatsMock.mock.calls.length;

    // A minimized window is still "visible" to the platform, so asking only
    // isVisible would keep reading the server for a window on the taskbar.
    windowControls.isMinimized.mockResolvedValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(meStatsMock.mock.calls.length).toBe(afterFirstRead);
  });

  it("keeps refreshing when the window cannot say whether anyone can see it", async () => {
    vi.useFakeTimers();
    const meStatsMock = vi.fn().mockResolvedValue(meStats);
    render(<App bridge={bridgeFor({ meStats: meStatsMock })} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const afterFirstRead = meStatsMock.mock.calls.length;

    // A window that has gone out from under the webview answers nothing at
    // all. Skipping is the optimisation and showing the day is the job, so an
    // unanswerable window is assumed to be on screen rather than leaving the
    // panel on a reading from whenever the probe first broke.
    windowControls.isVisible.mockRejectedValue(new Error("window is gone"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const afterOneTick = meStatsMock.mock.calls.length;
    expect(afterOneTick).toBeGreaterThan(afterFirstRead);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(meStatsMock.mock.calls.length).toBeGreaterThan(afterOneTick);
  });

  it("reads once for two alt-tabs inside a tick, and at once after a long stretch away", async () => {
    vi.useFakeTimers();
    const meStatsMock = vi.fn().mockResolvedValue(meStats);
    render(<App bridge={bridgeFor({ meStats: meStatsMock })} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // Two ticks' worth of time in the tray: the reading on screen is old, so
    // being shown again is worth a read straight away.
    hideWindow();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    const beforeFocus = meStatsMock.mock.calls.length;
    await act(async () => { showWindow(); await vi.advanceTimersByTimeAsync(0); });
    const afterFocus = meStatsMock.mock.calls.length;
    expect(afterFocus).toBeGreaterThan(beforeFocus);

    // Alt-tab away and straight back. The reading is seconds old and one bump
    // fans out to every open report, so this focus asks the server for
    // nothing.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await act(async () => { showWindow(); await vi.advanceTimersByTimeAsync(0); });
    expect(meStatsMock.mock.calls.length).toBe(afterFocus);
  });

  it("counts the refresh a finished stretch triggers against the next focus", async () => {
    vi.useFakeTimers();
    const meStatsMock = vi.fn().mockResolvedValue(meStats);
    const monitorStatusMock = vi.fn().mockResolvedValue(recording);
    render(<App bridge={bridgeFor({ meStats: meStatsMock, monitorStatus: monitorStatusMock })} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    hideWindow();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    const beforeSessionEnd = meStatsMock.mock.calls.length;

    // The stretch ends. That refresh is worth making even in the tray, since
    // the host's own upload of the session has just landed.
    monitorStatusMock.mockResolvedValue(status);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    const afterSessionEnd = meStatsMock.mock.calls.length;
    expect(afterSessionEnd).toBeGreaterThan(beforeSessionEnd);

    // Being shown seconds later asks for nothing: what is on screen was
    // fetched by that refresh, not by whenever the window was last looked at.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await act(async () => { showWindow(); await vi.advanceTimersByTimeAsync(0); });
    expect(meStatsMock.mock.calls.length).toBe(afterSessionEnd);

    // Back into the tray past the interval, and being shown reads again.
    hideWindow();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(meStatsMock.mock.calls.length).toBe(afterSessionEnd);
    await act(async () => { showWindow(); await vi.advanceTimersByTimeAsync(0); });
    expect(meStatsMock.mock.calls.length).toBeGreaterThan(afterSessionEnd);
  });

  it("joins another workspace by invite code from settings", async () => {
    const bridge = bridgeFor({
      preferencesGet: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
  preferencesSet: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
  orgOverview: vi.fn().mockResolvedValue({
        organization: { id: "00000000-0000-4000-8000-000000000900", name: "SIQstack", inviteCode: "ACDEF-GHJKM" },
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    // Team management is settings, not the record surface.
    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Team"));

    await person.type(await screen.findByLabelText("Their invite code"), "PQRTU-VWXY3");
    await person.click(screen.getByRole("button", { name: "Join this team" }));

    await waitFor(() => expect(bridge.orgJoin).toHaveBeenCalledWith("PQRTU-VWXY3"));
    // The group names the team you are now on, in a sentence rather than as a
    // bare heading beside a code. The home header names it too, so the
    // assertion is scoped to the settings dialog.
    expect(await within(dialog).findByText("Joined Team")).toBeInTheDocument();
    expect(within(dialog).getByTestId("invite-code")).toHaveTextContent("PQRTU-VWXY3");
  });

  it("re-reads the account after joining so the picker lists the new workspace's projects", async () => {
    const joinedProject = { id: "00000000-0000-4000-8000-000000000020", name: "Joined project", color: null };
    const joinedAccount = {
      ...account,
      projects: [joinedProject],
      defaultProjectId: joinedProject.id,
    };
    const bootstrap = vi.fn()
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce(joinedAccount);
    const bridge = bridgeFor({ bootstrap });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Team"));
    await person.type(await screen.findByLabelText("Their invite code"), "PQRTU-VWXY3");
    await person.click(screen.getByRole("button", { name: "Join this team" }));

    await waitFor(() => expect(bridge.bootstrap).toHaveBeenCalledTimes(2));
    await person.click(within(dialog).getByRole("button", { name: "Close settings" }));
    await person.click(screen.getByRole("button", { name: "Change" }));

    expect(await screen.findByRole("radio", { name: "Work it out for me (Joined project)" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Field work/ })).not.toBeInTheDocument();
  });

  it("renames the workspace with the trimmed name and shows it in the Team group and the header at once", async () => {
    // Arrange
    const orgRename = vi.fn().mockResolvedValue({
      organization: { id: "00000000-0000-4000-8000-000000000900", name: "Atlas Studio", inviteCode: "ACDEF-GHJKM" },
    });
    const bridge = bridgeFor({ orgRename });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    const team = within(await openTeamGroup(person));
    await person.click(team.getByRole("button", { name: "Rename the workspace" }));
    const field = team.getByLabelText("New name for the workspace");

    // Act
    await person.clear(field);
    await person.type(field, "  Atlas Studio ");
    await person.click(team.getByRole("button", { name: "Save" }));

    // Assert
    expect(orgRename).toHaveBeenCalledWith("Atlas Studio");
    expect(await team.findByText("Atlas Studio")).toBeInTheDocument();
    expect(team.queryByLabelText("New name for the workspace")).not.toBeInTheDocument();
    expect(screen.getByTestId("filing-where")).toHaveTextContent("Atlas Studio");
    expect(screen.getByTestId("filing-where")).not.toHaveTextContent("SIQstack");
    // The answer to the rename is the new name: nothing is read again.
    expect(bridge.orgOverview).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a member who is not an administrator", "auth", "Only a workspace administrator can rename the workspace."],
    ["a name the server will not take", "validation", "A workspace name needs 1 to 80 characters."],
  ])("shows the server's sentence and keeps the old name when it refuses %s", async (_case, kind, message) => {
    // Arrange
    const orgRename = vi.fn().mockRejectedValue({ kind, message });
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ orgRename })} />);
    const team = within(await openTeamGroup(person));
    await person.click(team.getByRole("button", { name: "Rename the workspace" }));

    // Act
    await person.type(team.getByLabelText("New name for the workspace"), " Crew");
    await person.click(team.getByRole("button", { name: "Save" }));

    // Assert
    const alert = await team.findByText(message);
    expect(alert).toHaveAttribute("role", "alert");
    // The sentence sits in the form it answers, which stays open to fix.
    expect(alert.closest("form")).toContainElement(team.getByLabelText("New name for the workspace"));
    expect(screen.getByTestId("filing-where")).toHaveTextContent("SIQstack");
    expect(screen.getByTestId("filing-where")).not.toHaveTextContent("SIQstack Crew");
    // A refusal is not a lost session: the settings stay open, signed in.
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("leaves the name as it was when the rename is cancelled", async () => {
    // Arrange
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    const team = within(await openTeamGroup(person));
    await person.click(team.getByRole("button", { name: "Rename the workspace" }));
    await person.type(team.getByLabelText("New name for the workspace"), " Crew");

    // Act
    await person.click(team.getByRole("button", { name: "Cancel" }));

    // Assert
    expect(bridge.orgRename).not.toHaveBeenCalled();
    expect(team.getByText("SIQstack")).toBeInTheDocument();
    expect(team.queryByLabelText("New name for the workspace")).not.toBeInTheDocument();
    expect(team.getByRole("button", { name: "Rename the workspace" })).toBeInTheDocument();
  });

  it("holds Save while the new name is blank", async () => {
    // Arrange
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);
    const team = within(await openTeamGroup(person));
    await person.click(team.getByRole("button", { name: "Rename the workspace" }));

    // Act
    const field = team.getByLabelText("New name for the workspace");
    await person.clear(field);
    await person.type(field, "   ");

    // Assert
    expect(team.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("reads Saving… and holds Save while the rename is in flight", async () => {
    // Arrange
    const orgRename = vi.fn(() => new Promise<OrganizationOverview>(() => undefined));
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ orgRename })} />);
    const team = within(await openTeamGroup(person));
    await person.click(team.getByRole("button", { name: "Rename the workspace" }));

    // Act
    await person.type(team.getByLabelText("New name for the workspace"), " Crew");
    await person.click(team.getByRole("button", { name: "Save" }));

    // Assert
    expect(await team.findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(orgRename).toHaveBeenCalledTimes(1);
  });
});

describe("the agents tab", () => {
  /// The server's token bars over three hours. Every total is deliberately not
  /// in + out, and no project's bars add up to the period's, so a client that
  /// summed anything itself would draw different bars than these.
  const hours = ["2026-08-06T12:00:00.000Z", "2026-08-06T13:00:00.000Z", "2026-08-06T14:00:00.000Z"];
  const bars = (figures: readonly ([number, number, number] | null)[]) =>
    figures.map((figure, index) => ({
      start: hours[index]!,
      tokensIn: figure?.[0] ?? null,
      tokensOut: figure?.[1] ?? null,
      tokens: figure?.[2] ?? null,
    }));
  const tokenChart = {
    bucketSeconds: 3_600,
    buckets: bars([[100, 50, 999], null, [10, 10, 3_000]]),
    projects: [
      { project: { id: project.id, name: project.name }, tokens: 777, buckets: bars([[7, 7, 700], null, [1, 1, 77]]) },
      { project: { id: otherProject.id, name: otherProject.name }, tokens: 0, buckets: bars([null, null, null]) },
    ],
  };
  const drawnTokens = (chart: HTMLElement): number[] =>
    [...chart.querySelectorAll("rect[data-tokens]")].map((bar) => Number(bar.getAttribute("data-tokens")));

  it("draws the server's token bars as given, adding nothing up", async () => {
    // Arrange
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ agentShifts: vi.fn().mockResolvedValue({ ...agentShifts, tokenChart }) })} />);

    // Act
    const chart = within(await openAgentsTab(person)).getByTestId("token-chart");

    // Assert: one bar per hour that burned anything, at the server's total.
    expect(drawnTokens(chart)).toEqual([999, 3_000]);
    const heights = [...chart.querySelectorAll("rect[data-tokens]")].map((bar) => Number(bar.getAttribute("height")));
    expect(heights[1]!).toBeGreaterThan(heights[0]!);
    expect(chart.querySelectorAll("rect.is-ghost")).toHaveLength(0);
  });

  it("narrows the bars to a picked project, drawn solid over the period's as ghosts", async () => {
    // Arrange
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ agentShifts: vi.fn().mockResolvedValue({ ...agentShifts, tokenChart }) })} />);
    const chart = within(await openAgentsTab(person)).getByTestId("token-chart");

    // Act
    await person.selectOptions(within(chart).getByRole("combobox", { name: "Project" }), project.id);

    // Assert
    expect(drawnTokens(chart)).toEqual([700, 77]);
    expect(chart.querySelectorAll("rect.is-ghost")).toHaveLength(2);
  });

  it("lists a project that burned no tokens in the period without letting it be picked", async () => {
    // Arrange
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ agentShifts: vi.fn().mockResolvedValue({ ...agentShifts, tokenChart }) })} />);

    // Act
    const chart = within(await openAgentsTab(person)).getByTestId("token-chart");

    // Assert
    expect(within(chart).getByRole("option", { name: `${project.name} · 777` })).toBeEnabled();
    expect(within(chart).getByRole("option", { name: `${otherProject.name} · no tokens` })).toBeDisabled();
  });

  it("drops a picked project that the next range lists without tokens, and does not bring it back", async () => {
    // Arrange: this week the picked project ran a shift that reported nothing.
    const weekChart = {
      bucketSeconds: 3_600,
      buckets: bars([[100, 50, 999], [20, 20, 444], [10, 10, 3_000]]),
      projects: [
        { project: { id: otherProject.id, name: otherProject.name }, tokens: 444, buckets: bars([null, [20, 20, 444], null]) },
        { project: { id: project.id, name: project.name }, tokens: 0, buckets: bars([null, null, null]) },
      ],
    };
    const isWeek = (fromAt?: string, toExclusiveAt?: string): boolean =>
      fromAt !== undefined && toExclusiveAt !== undefined && Date.parse(toExclusiveAt) - Date.parse(fromAt) > 2 * 86_400_000;
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      agentShifts: vi.fn().mockImplementation(async (fromAt?: string, toExclusiveAt?: string) => (
        { ...agentShifts, tokenChart: isWeek(fromAt, toExclusiveAt) ? weekChart : tokenChart }
      )),
    })} />);
    const panel = await openAgentsTab(person);
    await person.selectOptions(within(panel).getByRole("combobox", { name: "Project" }), project.id);
    expect(drawnTokens(within(panel).getByTestId("token-chart"))).toEqual([700, 77]);

    // Act
    await person.click(within(panel).getByRole("button", { name: "This week" }));

    // Assert: the period's bars, all solid, under All projects.
    await waitFor(() => expect(drawnTokens(within(panel).getByTestId("token-chart"))).toEqual([999, 444, 3_000]));
    expect(within(panel).getByTestId("token-chart").querySelectorAll("rect.is-ghost")).toHaveLength(0);
    expect(within(panel).getByRole("combobox", { name: "Project" })).toHaveDisplayValue("All projects");

    // Act: back to a range where the project burned tokens.
    await person.click(within(panel).getByRole("button", { name: "Today" }));

    // Assert: the pick was dropped, not held for later.
    await waitFor(() => expect(drawnTokens(within(panel).getByTestId("token-chart"))).toEqual([999, 3_000]));
    expect(within(panel).getByRole("combobox", { name: "Project" })).toHaveDisplayValue("All projects");
  });

  it("names a daily bar that starts at 23:00 after a daylight-saving change by the day it covers", async () => {
    // Arrange: once the clocks fall back, the server's 24-hour bars start at
    // 23:00 the evening before the day each one covers.
    const starts = [new Date(2026, 9, 31), new Date(2026, 10, 1), new Date(2026, 10, 1, 23), new Date(2026, 10, 2, 23)];
    const covered = [new Date(2026, 9, 31, 12), new Date(2026, 10, 1, 12), new Date(2026, 10, 2, 12), new Date(2026, 10, 3, 12)];
    const dailyChart = {
      bucketSeconds: 86_400,
      buckets: starts.map((start) => ({ start: start.toISOString(), tokensIn: 100, tokensOut: 50, tokens: 999 })),
      projects: [],
    };
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ agentShifts: vi.fn().mockResolvedValue({ ...agentShifts, tokenChart: dailyChart }) })} />);
    const chart = within(await openAgentsTab(person)).getByTestId("token-chart");

    // Act: read every bar out from the keyboard.
    act(() => within(chart).getByRole("img", { name: "Tokens burned per day" }).focus());
    const readouts: string[] = [];
    for (const key of ["{Home}", "{ArrowRight}", "{ArrowRight}", "{ArrowRight}"]) {
      await person.keyboard(key);
      readouts.push(chart.querySelector(".graph-tooltip-title")?.textContent ?? "");
    }

    // Assert: each bar's readout and axis tick name its own day, none twice.
    expect(readouts).toEqual(covered.map((day) => day.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })));
    expect([...chart.querySelectorAll("text[text-anchor='middle']")].map((tick) => tick.textContent))
      .toEqual(covered.map((day) => day.toLocaleDateString([], { month: "short", day: "numeric" })));
    expect(within(chart).getByRole("status")).toHaveTextContent(`${readouts[3]}: 999 tokens, 100 in, 50 out`);
  });

  it("draws no token bars from an API that predates them", async () => {
    // Arrange
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    // Act
    const panel = await openAgentsTab(person);

    // Assert
    expect(within(panel).getByTestId("hourly-graph")).toBeInTheDocument();
    expect(within(panel).queryByTestId("token-chart")).not.toBeInTheDocument();
  });

  it("maps every shift under its codebase, with the total recorded on top", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const panel = await openAgentsTab(person);

    // The totals row leads with the recorded agent time, as on the Humans
    // page, then the codebases, heaviest first.
    expect(teamTotal(panel, "Agent time")).toHaveTextContent(/^2h 00m$/);
    const groups = within(panel).getAllByTestId("shift-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent("siqshift");
    expect(groups[0]).toHaveTextContent("1h 30m");
    // Held appears once a commit is decided, and only then: the label-less
    // group's commits are all pending, so it says nothing rather than
    // "pending". And its cause is named - a run worktree whose repository
    // nothing identified, not a capture that saw nothing at all.
    expect(groups[0]).toHaveTextContent("50% held");
    expect(groups[1]).toHaveTextContent("Run worktree, codebase not identified");
    expect(groups[1]).not.toHaveTextContent("No codebase recorded");
    expect(groups[1]!.textContent).not.toMatch(/held|pending/);
    // There is no people board here: nothing on the page picks a person.
    expect(within(panel).queryByTestId("agent-roster-list")).not.toBeInTheDocument();
  });

  it("shows who is running an agent right now, above the range's map", async () => {
    const bridge = bridgeFor({
      liveAgentSessions: vi.fn().mockResolvedValue({
        people: [{
          owner: { id: user.id, name: user.name },
          sessions: [
            { id: "00000000-0000-4000-8000-000000000701", source: "codex", repo: "siqshift", description: "Codex in siqshift, running 12m" },
            { id: "00000000-0000-4000-8000-000000000703", source: "codex", repo: "quartermaster", description: "Codex in quartermaster, running 45s" },
            { id: "00000000-0000-4000-8000-000000000702", source: "pi", repo: null, description: "Pi on deepseek-v4-pro in no codebase recorded, running 3h 5m" },
          ],
        }],
      }),
    });
    render(<App bridge={bridge} />);

    const panel = await openAgentsTab(userEvent.setup());

    // The description renders verbatim, never re-derived: every clause is a
    // captured fact, and the codebase label rides beside it.
    const live = within(panel).getByTestId("live-sessions");
    expect(live).toHaveTextContent("Codex in siqshift, running 12m");
    expect(live).toHaveTextContent("Codex in quartermaster, running 45s");
    expect(live).toHaveTextContent("Pi on deepseek-v4-pro in no codebase recorded, running 3h 5m");
    expect(live).toHaveTextContent("siqshift");
    expect(within(live).getAllByText(/Codex in (siqshift|quartermaster)/)).toHaveLength(2);
  });

  it("says nobody is running rather than drawing an empty live board", async () => {
    render(<App bridge={bridgeFor()} />);

    const panel = await openAgentsTab(userEvent.setup());

    expect(await within(panel).findByTestId("live-sessions-empty")).toHaveTextContent("No agent is running right now.");
  });

  it("emits the meter row the layout suite styles, four cells to a row", async () => {
    // tests/browser/harness.ts hand-writes this markup to measure it in a real
    // browser, because jsdom has no layout engine. That only means anything
    // while the app really does emit these classes, so this is the pin between
    // the two: change a class here and the browser suite is measuring a page
    // this app no longer renders.
    render(<App bridge={bridgeFor()} />);

    const list = await screen.findByTestId("session-app-list");
    expect(list).toHaveClass("meter-list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveClass("meter-row");
      expect(row.querySelector(".meter-name")).not.toBeNull();
      expect(row.querySelector(".meter-duration")).not.toBeNull();
      // The third cell is a share bar or an agent's plan dial, never nothing:
      // the row is a four-column grid and the duration rides in the fourth.
      expect(row.children).toHaveLength(4);
    }
  });

  it("gives each codebase a board row: its rank, a mark, the name, its tokens and its agent time", async () => {
    // Arrange
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    // Act
    const panel = await openAgentsTab(person);
    const groups = within(panel).getAllByTestId("shift-group");

    // Assert: the head reads on the same columns as the web's, so the two apps
    // scan alike. An API that sends no tokens gets a dash, never a zero.
    const cells = groups.map((group) => [...group.querySelector("summary.shift-group-head")?.children ?? []].map((cell) => cell.textContent));
    expect(cells).toEqual([
      ["1", "S", "siqshift50% held · 2 shifts", "-", "1h 30m", ""],
      ["2", "?", "Run worktree, codebase not identified1 shift", "-", "30m", ""],
    ]);
  });

  it("keeps each codebase's shifts in a drawer that starts closed, the way the web does", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const panel = await openAgentsTab(person);
    const group = within(panel).getAllByTestId("shift-group")[0]!;
    const head = group.querySelector("summary");

    // The two apps draw this markup from one component, so the desktop pins
    // the same three facts the web does: the head is the summary, it is the
    // details' first child - jsdom only treats the first one as the toggle -
    // and it stays six cells, because a seventh would wrap the six-track grid.
    expect(group.tagName).toBe("DETAILS");
    expect(head).not.toBeNull();
    expect(group.firstElementChild).toBe(head);
    expect(head!.children).toHaveLength(6);
    // The count rides in the name cell, so a closed drawer still says how
    // much is inside it.
    expect(group).toHaveTextContent("2 shifts");

    expect(group).not.toHaveAttribute("open");
    await person.click(head!);
    expect(group).toHaveAttribute("open");
  });

  it("shows no hourly graph on all time, keeping the groups and total", async () => {
    // Pinned to the afternoon the fixture's shifts ran, so "Today" really does
    // bound them and the folded line has something to draw.
    vi.setSystemTime(new Date("2026-08-06T20:00:00.000Z"));
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const panel = await openAgentsTab(person);
    const shifts = within(panel).getByTestId("agent-shifts");
    // A bounded range folds an hourly line from the shifts on screen.
    expect(within(shifts).getByTestId("hourly-graph")).toBeInTheDocument();

    await person.click(within(panel).getByRole("button", { name: "All time" }));

    // Per-hour resolution over an unbounded range is meaningless, so the graph
    // goes away - but the codebase map and its total stay put.
    await waitFor(() => expect(within(shifts).queryByTestId("hourly-graph")).not.toBeInTheDocument());
    expect(within(shifts).getByText("2h 00m")).toBeInTheDocument();
    expect(within(shifts).getAllByTestId("shift-group")).toHaveLength(2);
  });

  it("gives each shift its own line: when, who, what model, what commits", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const panel = await openAgentsTab(person);
    const group = within(panel).getAllByTestId("shift-group")[0]!;
    // The rows are not in the response that drew the head: opening the drawer
    // is what asks for them.
    await person.click(group.querySelector("summary")!);

    await waitFor(() => expect(within(group).getAllByRole("listitem")).toHaveLength(2));
    const rows = within(group).getAllByRole("listitem");
    // Newest first, as the API orders them.
    expect(rows[0]).toHaveTextContent("Claude Code");
    expect(rows[0]).toHaveTextContent("Timer User");
    expect(rows[0]).toHaveTextContent("claude-opus-5");
    expect(rows[0]).toHaveTextContent("2 commits");
    expect(rows[0]).toHaveTextContent("1h 00m");
    // A shift that named no model says nothing - absence is absence.
    expect(rows[1]!.textContent).not.toMatch(/not recorded/);
  });

  it("asks for a group's shifts only when its drawer opens, under the bounds the head was totalled with", async () => {
    const agentShiftRows = vi.fn().mockImplementation(
      async (groupKey: string, after: { id: string } | null) => agentShiftRowsFor(groupKey, after),
    );
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ agentShiftRows })} />);

    const panel = await openAgentsTab(person);

    // The whole point of the change: drawing the heads costs no rows at all.
    expect(agentShiftRows).not.toHaveBeenCalled();

    await person.click(within(panel).getAllByTestId("shift-group")[0]!.querySelector("summary")!);

    await waitFor(() => expect(agentShiftRows).toHaveBeenCalledTimes(1));
    // Same bounds the head was totalled under, or a drawer lists shifts its own
    // head never counted.
    // The first page names no cursor at all: there is no row to start after.
    expect(agentShiftRows.mock.calls[0]?.slice(0, 2)).toEqual(["siqshift", null]);
    expect(agentShiftRows.mock.calls[0]?.[2]).toEqual(expect.any(String));
    expect(agentShiftRows.mock.calls[0]?.[3]).toEqual(expect.any(String));
  });

  it("pages a long drawer rather than pulling the whole group at once", async () => {
    const agentShiftRows = vi.fn().mockImplementation(
      async (groupKey: string, after: { id: string } | null) => agentShiftRowsFor(groupKey, after, 1),
    );
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ agentShiftRows })} />);

    const panel = await openAgentsTab(person);
    const group = within(panel).getAllByTestId("shift-group")[0]!;
    await person.click(group.querySelector("summary")!);

    // One row of two, and the drawer offers the rest.
    await person.click(await within(group).findByRole("button", { name: "Show more" }));

    await waitFor(() => expect(within(group).getAllByRole("listitem")).toHaveLength(2));
    // The second page starts after the row the first one ended on, named by the
    // pair the rows are ordered by rather than by a position in the list.
    expect(agentShiftRows.mock.calls.at(-1)?.[1]).toEqual({
      startedAt: "2026-08-06T15:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000601",
    });
    // Exhausted, so the control retires rather than asking for an empty page.
    expect(within(group).queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("says so inside the drawer when a page fails, and leaves the head alone", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ agentShiftRows: vi.fn().mockRejectedValue(new Error("nope")) })} />);

    const panel = await openAgentsTab(person);
    const group = within(panel).getAllByTestId("shift-group")[0]!;
    await person.click(group.querySelector("summary")!);

    expect(await within(group).findByRole("alert")).toHaveTextContent("These shifts could not be loaded.");
    // The head is read from the aggregate, so a failed drawer cannot empty it.
    expect(group).toHaveTextContent("2 shifts");
    expect(group).toHaveTextContent("50% held");
  });

  it("says nobody worked rather than rendering an empty map", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      agentShifts: vi.fn().mockResolvedValue({ totalAgentSeconds: 0, hourly: [], groups: [] }),
    })} />);

    const panel = await openAgentsTab(person);

    expect(within(panel).getByText("No agent worked in this range.")).toBeInTheDocument();
  });
});
describe("the update banner", () => {
  it("announces a downloading update and the restart that follows", async () => {
    let announce: ((version: string) => void) | undefined;
    const bridge = bridgeFor({
      onUpdateAvailable: vi.fn().mockImplementation(async (handler: (version: string) => void) => {
        announce = handler;
        return () => undefined;
      }),
    });
    render(<App bridge={bridge} />);
    await screen.findByRole("button", { name: "Settings" });

    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
    act(() => announce?.("0.9.9"));

    const banner = await screen.findByTestId("update-banner");
    expect(banner).toHaveTextContent("Version 0.9.9");
    expect(banner).toHaveTextContent("restarts itself");
  });
});

describe("the projects list", () => {
  it("tags the default project and hides its delete button", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Projects"));

    const list = within(dialog).getByTestId("project-manage-list");
    const defaultRow = within(list).getByText("Field work").closest("li");
    expect(defaultRow).not.toBeNull();
    expect(within(defaultRow as HTMLElement).getByText("default")).toBeInTheDocument();
    expect(within(defaultRow as HTMLElement).getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(within(defaultRow as HTMLElement).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

    const otherRow = within(list).getByText("Client work").closest("li");
    expect(otherRow).not.toBeNull();
    expect(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("counts agent sessions in the delete confirmation", async () => {
    const bridge = bridgeFor({
      projectUsage: vi.fn().mockResolvedValue({ sessionCount: 2, durationSeconds: 3_600, agentSessionCount: 5 }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Projects"));

    const list = within(dialog).getByTestId("project-manage-list");
    const otherRow = within(list).getByText("Client work").closest("li");
    await person.click(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" }));

    const confirm = await within(dialog).findByTestId("project-delete-confirm");
    expect(confirm).toHaveTextContent("2 sessions");
    expect(confirm).toHaveTextContent("5 agent sessions");
  });

  it("deletes an empty project on the click, with no confirmation panel", async () => {
    const projectDelete = vi.fn().mockResolvedValue(undefined);
    const bridge = bridgeFor({
      projectUsage: vi.fn().mockResolvedValue({ sessionCount: 0, durationSeconds: 0, agentSessionCount: 0 }),
      projectDelete,
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Projects"));

    const list = within(dialog).getByTestId("project-manage-list");
    const otherRow = within(list).getByText("Client work").closest("li");
    await person.click(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(projectDelete).toHaveBeenCalledWith(otherProject.id, null));
    expect(within(dialog).queryByTestId("project-delete-confirm")).not.toBeInTheDocument();
  });

  it("asks for a move-or-delete choice instead of a typed name", async () => {
    const bridge = bridgeFor({
      projectUsage: vi.fn().mockResolvedValue({ sessionCount: 2, durationSeconds: 3_600, agentSessionCount: 5 }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Projects"));

    const list = within(dialog).getByTestId("project-manage-list");
    const otherRow = within(list).getByText("Client work").closest("li");
    await person.click(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" }));

    const confirm = await within(dialog).findByTestId("project-delete-confirm");
    expect(confirm).toHaveTextContent("What happens to its sessions?");
    expect(within(confirm).queryByLabelText(/type the project's name to confirm/i)).not.toBeInTheDocument();
    await waitFor(() => expect(within(confirm).getByRole("button", { name: "Delete Client work" })).toBeEnabled());
  });
});
