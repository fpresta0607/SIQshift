import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type MeStatsResponse } from "@siqshift/shared";
import { buildAppRows, recordedBasis } from "@siqshift/shared/ui";
import { App, rangeQuery } from "./App.js";
import { ClientError, type Client } from "./client.js";
import { macInstallerUrl, windowsInstallerUrl } from "./DownloadInstaller.js";

// jsdom has no WebGL context; the shader is decorative.
vi.mock("@siqshift/shared/webgl-shader", () => ({ WebGLShader: () => null }));

const organization = { id: "00000000-0000-4000-8000-000000000001", name: "Lumen Studio", inviteCode: "ACDEF-GHJKM" };

/// The App's own Today-card tick, which these tests drive by hand.
const TODAY_REFRESH_MS = 60_000;

/// Two projects, so the filing header has something to change to.
const pickableProjects = [
  { id: "p1", name: "General", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false, isDefault: true },
  { id: "p2", name: "Client", createdAt: "2026-08-11T12:00:00.000Z", isArchived: false, isDefault: false },
];

const teamMembers = [
  { rank: 1, user: { id: "u1", name: "Sam" }, activeSeconds: 8_040, agentSeconds: 10_800, project: { id: "p1", name: "General" } },
  { rank: 2, user: { id: "u2", name: "Alex" }, activeSeconds: 3_600, agentSeconds: 0, project: { id: "p2", name: "Client" } },
];

/// The team view's one read, as `/reports/workspace` serves it: every total
/// already added up on the server.
const workspaceReport = {
  filters: {},
  activeSeconds: 11_640,
  agentSeconds: 10_800,
  hourly: [
    { hourStart: "2026-08-06T13:00:00.000Z", activeSeconds: 3_000, agentSeconds: 3_600 },
    { hourStart: "2026-08-06T14:00:00.000Z", activeSeconds: 1_800, agentSeconds: 0 },
  ],
  projects: [
    { project: { id: "p1", name: "General", icon: "grid", color: "#a3b3c2" }, durationSeconds: 8_040 },
    { project: { id: "p2", name: "Client", icon: "rocket", color: "#ff9d8a" }, durationSeconds: 3_600 },
  ],
  agents: [{ source: "claude_code", durationSeconds: 10_800 }],
  members: teamMembers,
};

/// Alex alone: the whole team is the viewer.
const workspaceOfOne = {
  ...workspaceReport,
  activeSeconds: 3_600,
  agentSeconds: 0,
  hourly: [{ hourStart: "2026-08-06T13:00:00.000Z", activeSeconds: 3_600, agentSeconds: 0 }],
  projects: [{ project: { id: "p2", name: "Client" }, durationSeconds: 3_600 }],
  agents: [],
  members: [{ ...teamMembers[1]!, rank: 1 }],
};

/// A workspace whose roster recorded nothing in the range: the server still
/// lists every member, at zero.
const quietWorkspace = {
  ...workspaceReport,
  activeSeconds: 0,
  agentSeconds: 0,
  hourly: [],
  projects: [],
  agents: [],
  members: [{ rank: 1, user: { id: "u2", name: "Alex" }, activeSeconds: 0, agentSeconds: 0, project: null }],
};

/// The signed-in viewer is Alex, so the board highlights u2 by default.
const self = { id: "u2", email: "alex@example.com", name: "Alex" };

const memberStats = {
  filters: {},
  totalDurationSeconds: 7_200,
  attributedSeconds: 5_400,
  unattributedSeconds: 1_800,
  activeSeconds: 7_200,
  agentSeconds: 3_600,
  concurrency: { t0Seconds: 3_600, t1Seconds: 3_600, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
  byAgent: [
    { source: "claude_code", model: "claude-fable-5", durationSeconds: 3_000, sessionCount: 4, maxConcurrent: 2, medianSeconds: 750 },
    { source: "claude_code", model: null, durationSeconds: 600, sessionCount: 1, maxConcurrent: 1, medianSeconds: 600 },
  ],
  hourly: [],
  projects: [
    { project: { id: "p1", name: "General" }, durationSeconds: 7_200, attributedSeconds: 5_400, unattributedSeconds: 1_800, sessionCount: 3 },
  ],
  apps: [
    { processName: "claude.exe", durationSeconds: 3_600 },
    { processName: "Code.exe", durationSeconds: 1_800 },
  ],
  sites: [],
  agents: [],
};

const rosterAgent = {
  id: "00000000-0000-4000-8000-0000000000a1",
  name: "Claude Code @ General",
  source: "claude_code",
  status: "anonymous" as const,
  owner: { id: "u2", name: "Alex" },
  project: { id: "p1", name: "General" },
  repoName: "siqshift",
  repoRoot: "C:/dev/siqshift",
  createdAt: "2026-08-01T00:00:00.000Z",
};

/// The shifts behind each group, keyed the way the API serves them: a drawer
/// asks for one group's page, and the heads carry none of this.
const agentShiftRowsByGroup: Record<string, readonly Record<string, unknown>[]> = {
  siqshift: [
    {
      id: "00000000-0000-4000-8000-000000000601",
      source: "claude_code",
      owner: { id: "u2", name: "Alex" },
      model: "claude-opus-5",
      startedAt: "2026-08-06T15:00:00.000Z",
      endedAt: "2026-08-06T16:00:00.000Z",
      agentSeconds: 3_600,
      commitCount: 2,
    },
    {
      id: "00000000-0000-4000-8000-000000000602",
      source: "claude_code",
      owner: { id: "u2", name: "Alex" },
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
    owner: { id: "u2", name: "Alex" },
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
  inputTokens: null,
  outputTokens: null,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
}));

/// The Agents tab's map: two codebases, three shifts, one decided commit.
/// Heads only - the shifts hang behind `groupKey`.
const agentShiftsResponse = {
  filters: {},
  totalAgentSeconds: 7_200,
  /// Heaviest first, summing back to the total the way the server builds it.
  people: [
    { owner: { id: "u2", name: "Alex" }, agentSeconds: 5_400, shiftCount: 2 },
    { owner: { id: "u3", name: "Sam" }, agentSeconds: 1_800, shiftCount: 1 },
  ],
  hourly: agentShiftsHourly,
  groups: [
    {
      groupKey: "siqshift",
      repo: "siqshift",
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

/// One group's page, cut from the cursor the way the endpoint cuts it: the
/// first row strictly after the named one in the group's own ordering.
const agentShiftRowsFor = (query = "", pageSize = 50) => {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  const all = agentShiftRowsByGroup[params.get("groupKey") ?? ""] ?? [];
  const afterId = params.get("afterId");
  const start = afterId === null ? 0 : all.findIndex((row) => row.id === afterId) + 1;
  const shifts = all.slice(start, start + pageSize);
  const last = shifts.at(-1);
  return {
    filters: {},
    shifts,
    nextCursor: last === undefined || start + shifts.length >= all.length
      ? null
      : { startedAt: last.startedAt, id: last.id },
  };
};

function clientFor(overrides: Partial<Client> = {}): Client {
  return {
    hasSession: false,
    signIn: vi.fn().mockResolvedValue(undefined),
    signUp: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    organization: vi.fn().mockResolvedValue({ organization }),
    claimAdmin: vi.fn().mockRejectedValue(new ClientError("validation", "A workspace administrator already exists.")),
    workspace: vi.fn().mockResolvedValue(workspaceReport),
    me: vi.fn().mockResolvedValue({ user: self }),
    meStats: vi.fn().mockResolvedValue(memberStats),
    projects: vi.fn().mockResolvedValue({ projects: [{ id: "p1", name: "General", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false, isDefault: true }], selectedProjectId: null }),
    preferences: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
    updatePreferences: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
    report: vi.fn().mockResolvedValue({ rows: [], totalDurationSeconds: 0, filters: {}, pagination: { page: 1, pageSize: 25, totalRows: 0, totalPages: 0 } }),
    joinOrganization: vi.fn().mockResolvedValue(undefined),
    restoreSession: vi.fn().mockResolvedValue(false),
    // An unbounded range gets no hourly series, which is what the server
    // answers: per-hour resolution over all of history means nothing.
    agentShifts: vi.fn().mockImplementation((query: string = "") => Promise.resolve(
      new URLSearchParams(query.replace(/^\?/, "")).has("fromAt")
        ? agentShiftsResponse
        : { ...agentShiftsResponse, hourly: [] },
    )),
    agentShiftRows: vi.fn().mockImplementation((query: string = "") => Promise.resolve(agentShiftRowsFor(query))),
    liveAgentSessions: vi.fn().mockResolvedValue({ people: [] }),
    uploadPicture: vi.fn().mockResolvedValue({ user: self }),
    removePicture: vi.fn().mockResolvedValue({ user: self }),
    // No fixture names a picture, so nothing asks for one unless a test does.
    memberPicture: vi.fn().mockRejectedValue(new ClientError("validation", "Picture not found.")),
    ...overrides,
  } as unknown as Client;
}

type Person = ReturnType<typeof userEvent.setup>;

async function signIn(client: Client, person: Person = userEvent.setup()) {
  render(<App client={client} />);
  await person.click(await screen.findByRole("button", { name: "Sign in" }));
  await person.type(await screen.findByLabelText("Email"), "alex@example.com");
  await person.type(screen.getByLabelText("Password"), "long-enough-password");
  await person.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sign in" }));
  return person;
}

/// The board, the breakdowns and the history live behind the foot button, the
/// way the desktop app files everything historical behind "All stats".
async function openAllStats(person: Person) {
  await person.click(await screen.findByRole("button", { name: "All stats" }));
  return within(await screen.findByRole("dialog", { name: "All stats" }));
}

/// The dialog's Humans or Agents switch.
const agentsTab = (dialog: ReturnType<typeof within>) =>
  within(dialog.getByRole("group", { name: "Humans or agents" })).getByRole("button", { name: "Agents" });

/// One figure on the totals row that opens each team view page.
const teamTotal = (view: ReturnType<typeof within>, label: string) =>
  within(view.getByLabelText("Totals")).getByText(label).nextElementSibling?.querySelector("b");

/// Projects, the team's invite code and signing out live in the settings
/// panel, the way the desktop app files them.
async function openSettings(person: Person) {
  await person.click(await screen.findByRole("button", { name: "Settings" }));
  return within(await screen.findByRole("dialog", { name: "Settings" }));
}

describe("app row folding", () => {
  it("never folds an agent runtime into Everything else", () => {
    // Nine heavy apps outrank a lightly-used Claude Code; the fold must not
    // swallow the agent row that anchors its by-agent note.
    const apps = [
      ...Array.from({ length: 9 }, (_, index) => ({ processName: `app-${index}.exe`, durationSeconds: 9_000 - index })),
      { processName: "claude.exe", durationSeconds: 60 },
    ];

    const rows = buildAppRows(apps);

    expect(rows.map((row) => row.key)).toContain("agent-clis");
    const fold = rows.find((row) => row.key === "everything-else");
    // The fold keeps only the non-agent tail.
    expect(fold?.durationSeconds).toBe(9_000 - 8);
    expect(rows.filter((row) => row.agent)).toHaveLength(1);
  });

  // The Overlord's report: All stats printed a project list summing to the
  // recorded total beside an app list summing to presence, with nothing saying
  // they were measured on different bases, so an hour read as vanished.
  it("closes the app list against the total it is read under", () => {
    const rows = buildAppRows([
      { processName: "WindowsTerminal.exe", durationSeconds: 1_200 },
      { processName: "chrome.exe", durationSeconds: 720 },
    ], 6_960);

    expect(rows.map((row) => row.label)).toContain("Quiet time");
    expect(rows.reduce((sum, row) => sum + row.durationSeconds, 0)).toBe(6_960);
  });

  it("leaves a list with nothing in front of it to its empty state", () => {
    // A remainder needs something to be the remainder of; a lone "Quiet time"
    // row is not a breakdown, and the surface has an empty state for this.
    expect(buildAppRows([], 6_960)).toEqual([]);
    // Under a minute is rounding, not a gap.
    expect(buildAppRows([{ processName: "chrome.exe", durationSeconds: 1_200 }], 1_230))
      .toEqual([{ key: "chrome.exe", label: "Google Chrome", durationSeconds: 1_200, agent: false }]);
  });
});

describe("recorded basis", () => {
  // The contradiction this fixes: the sentence fired on `recorded > active`
  // alone and named the whole gap agent time, on days whose measured agent
  // time was zero.
  it("names the gap as time away, and claims an agent only where one was measured", () => {
    expect(recordedBasis(6_960, 2_220, 0)).toBe("1h 19m of it away from the keyboard");
    expect(recordedBasis(6_960, 2_220, 3_420))
      .toBe("1h 19m of it away from the keyboard, 57m of that with an agent running");
    // Agent time is summed, so parallel agents can out-run the wall clock they
    // ran in; the claim is clamped to the gap rather than exceeding it.
    expect(recordedBasis(6_960, 2_220, 99_999))
      .toBe("1h 19m of it away from the keyboard, 1h 19m of that with an agent running");
    // Nothing to explain: recorded is presence.
    expect(recordedBasis(2_220, 2_220, 0)).toBeNull();
  });
});

describe("dashboard", () => {
  it("lays the team out as the home page's example workspace", async () => {
    // Arrange
    const workspace = vi.fn().mockResolvedValue(workspaceReport);
    const person = await signIn(clientFor({ workspace }));
    expect(await screen.findByRole("heading", { name: "Lumen Studio" })).toBeInTheDocument();

    // Act
    const stats = await openAllStats(person);
    await stats.findByLabelText("Totals");

    // Assert
    expect(stats.getByRole("heading", { name: "Lumen Studio" })).toBeInTheDocument();
    expect(stats.getByText(/^Last 30 days · /)).toBeInTheDocument();
    expect(teamTotal(stats, "Active time")).toHaveTextContent("3h 14m");
    expect(teamTotal(stats, "Agent time")).toHaveTextContent("3h 00m");
    expect(teamTotal(stats, "People")).toHaveTextContent(/^2$/);
    expect(teamTotal(stats, "Projects")).toHaveTextContent(/^2$/);
    const graph = within(stats.getByRole("region", { name: "Over time" })).getByTestId("hourly-graph");
    expect(graph.querySelector('[data-series="agent"]')).not.toBeNull();
    expect(graph.querySelector('[data-series="human"]')).not.toBeNull();
    const [, first, second] = within(stats.getByRole("table", { name: "People" })).getAllByRole("row");
    expect(first).toHaveTextContent(/^1SSamGeneral2h 14m3h 00m$/);
    expect(second).toHaveTextContent(/^2AAlexYouClient1h 00m0s$/);
    // Both lists at once, with no switch between them.
    const projects = within(stats.getByRole("region", { name: "Projects" }));
    expect(projects.getAllByRole("listitem").map((row) => row.textContent)).toEqual(["General2h 14m", "Client1h 00m"]);
    expect(projects.getByText("Recorded time")).toBeInTheDocument();
    const agents = within(stats.getByRole("region", { name: "Agents" }));
    expect(agents.getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Claude Code3h 00m"]);
    expect(agents.getByText("Agent time")).toBeInTheDocument();
    expect(stats.queryByRole("group", { name: "Projects or agents" })).toBeNull();
    expect(stats.queryByText("Local agents, shared visibility")).toBeNull();
    expect(workspace.mock.calls.at(-1)?.[0]).toContain("fromAt=");
  });

  it("wears each project's own icon and color on the board, the Projects list and the person card", async () => {
    // Arrange
    const person = await signIn(clientFor());
    const tiles = (scope: HTMLElement) => [...scope.querySelectorAll(".project-icon")]
      .map((tile) => [tile.getAttribute("data-icon"), tile.querySelector("rect")?.getAttribute("fill")]);

    // Act
    const stats = await openAllStats(person);
    await stats.findByLabelText("Totals");
    const ownProjects = await stats.findByTestId("member-project-list");

    // Assert: the pair the server sent, General's own among them.
    expect(tiles(stats.getByRole("table", { name: "People" }))).toEqual([["grid", "#a3b3c2"], ["rocket", "#ff9d8a"]]);
    expect(tiles(stats.getByRole("region", { name: "Projects" }))).toEqual([["grid", "#a3b3c2"], ["rocket", "#ff9d8a"]]);
    expect(tiles(ownProjects)).toEqual([["grid", "#a3b3c2"]]);
  });

  it("wears the project list's own pair on the person card for a project the board has not listed yet", async () => {
    // Arrange: the board is still on its way, so only the viewer's project
    // list, which says General is the default, can draw it.
    const person = await signIn(clientFor({ workspace: vi.fn().mockReturnValue(new Promise(() => undefined)) }));

    // Act
    const ownProjects = await (await openAllStats(person)).findByTestId("member-project-list");

    // Assert
    const tile = ownProjects.querySelector(".project-icon");
    expect(tile).toHaveAttribute("data-icon", "grid");
    expect(tile?.querySelector("rect")).toHaveAttribute("fill", "#a3b3c2");
  });

  it.each([
    ["Both", "Hourly active and agent time", ["agent", "human"]],
    ["Active time", "Hourly active time", ["human"]],
    ["Agent time", "Hourly agent time", ["agent"]],
  ])("draws only what the team chart's one toggle picks: %s", async (choice, chartName, lines) => {
    // Arrange
    const person = await signIn(clientFor());
    const stats = await openAllStats(person);
    const chart = within(await stats.findByRole("region", { name: "Over time" }));
    const toggle = within(chart.getByRole("group", { name: "What the chart shows" }));

    // Act
    await person.click(toggle.getByRole("button", { name: choice }));

    // Assert
    expect(toggle.getByRole("button", { name: choice })).toHaveAttribute("aria-pressed", "true");
    const graph = chart.getByRole("img", { name: chartName });
    expect([...graph.querySelectorAll("path[data-series]")].map((line) => line.getAttribute("data-series"))).toEqual(lines);
  });

  it("orders the board only by what its rows show, active or agent time", async () => {
    // Arrange
    const person = await signIn(clientFor());

    // Act
    const stats = await openAllStats(person);
    const sort = await stats.findByRole("combobox", { name: /Sort by/ });

    // Assert: each choice is a column on the row; leverage is not one.
    expect(within(sort).getAllByRole("option").map((option) => option.textContent)).toEqual(["By active time", "By agent time"]);
  });

  it("draws the team totals the server added up, never a sum of the rows", async () => {
    // Arrange
    const person = await signIn(clientFor({
      workspace: vi.fn().mockResolvedValue({ ...workspaceReport, activeSeconds: 12_000, agentSeconds: 20_000 }),
    }));

    // Act
    const stats = await openAllStats(person);
    await stats.findByLabelText("Totals");

    // Assert
    expect(teamTotal(stats, "Active time")).toHaveTextContent("3h 20m");
    expect(teamTotal(stats, "Agent time")).toHaveTextContent("5h 33m");
  });

  it("shows a workspace of one as a single row, the viewer's own", async () => {
    // Arrange
    const person = await signIn(clientFor({ workspace: vi.fn().mockResolvedValue(workspaceOfOne) }));

    // Act
    const stats = await openAllStats(person);
    await stats.findByLabelText("Totals");

    // Assert
    expect(teamTotal(stats, "People")).toHaveTextContent(/^1$/);
    expect(teamTotal(stats, "Projects")).toHaveTextContent(/^1$/);
    expect(teamTotal(stats, "Active time")).toHaveTextContent("1h 00m");
    const [, only, ...rest] = within(stats.getByRole("table", { name: "People" })).getAllByRole("row");
    expect(rest).toEqual([]);
    expect(only).toHaveTextContent(/^1AAlexYouClient1h 00m0s$/);
    expect(within(only!).getByRole("button", { name: "Show Alex's work" })).toHaveAttribute("aria-pressed", "true");
    // Nobody else to pick, so the board does not offer to.
    expect(stats.queryByText("Select a teammate to explore their work.")).toBeNull();
  });

  it("shows the invite code and copies it on request", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);
    expect(await settings.findByText("ACDEF-GHJKM")).toBeInTheDocument();

    // userEvent.setup() installs a getter-only clipboard stub, so spy on it
    // rather than replacing the property.
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await person.click(settings.getByRole("button", { name: "Copy code" }));

    expect(writeText).toHaveBeenCalledWith("ACDEF-GHJKM");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("renames the workspace from the Team section, and the new name shows at once", async () => {
    // Arrange
    const renameOrganization = vi.fn().mockResolvedValue({ organization: { ...organization, name: "Field Crew" } });
    const person = await signIn(clientFor({ renameOrganization }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);

    // Act
    await person.click(settings.getByRole("button", { name: "Rename the workspace" }));
    const input = settings.getByRole("textbox", { name: "New name for the workspace" });
    await person.clear(input);
    await person.type(input, "  Field Crew  ");
    await person.click(settings.getByRole("button", { name: "Save" }));

    // Assert: trimmed before it is sent; the page heading follows without a reload.
    expect(renameOrganization).toHaveBeenCalledWith("Field Crew");
    expect(await screen.findByRole("heading", { name: "Field Crew" })).toBeInTheDocument();
    expect(settings.getByText("Field Crew")).toBeInTheDocument();
    expect(settings.queryByRole("textbox", { name: "New name for the workspace" })).not.toBeInTheDocument();
  });

  it("shows a member why the server refused a rename, and keeps them signed in with the old name", async () => {
    // Arrange: a 403 reaches the page as an auth error carrying the server's sentence.
    const refusal = "Only a workspace administrator can rename the workspace.";
    const renameOrganization = vi.fn().mockRejectedValue(new ClientError("auth", refusal));
    const person = await signIn(clientFor({ renameOrganization }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);

    // Act
    await person.click(settings.getByRole("button", { name: "Rename the workspace" }));
    await person.type(settings.getByRole("textbox", { name: "New name for the workspace" }), " Crew");
    await person.click(settings.getByRole("button", { name: "Save" }));

    // Assert
    expect(await settings.findByRole("alert")).toHaveTextContent(refusal);
    expect(screen.getByRole("heading", { name: "Lumen Studio" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("leaves the name as it was when the rename is cancelled", async () => {
    // Arrange
    const renameOrganization = vi.fn();
    const person = await signIn(clientFor({ renameOrganization }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);

    // Act
    await person.click(settings.getByRole("button", { name: "Rename the workspace" }));
    await person.type(settings.getByRole("textbox", { name: "New name for the workspace" }), " Crew");
    await person.click(settings.getByRole("button", { name: "Cancel" }));

    // Assert
    expect(renameOrganization).not.toHaveBeenCalled();
    expect(settings.getByText("Lumen Studio")).toBeInTheDocument();
  });

  it("says the workspace is the team and anyone with the code joins it, on any email domain", async () => {
    // Arrange
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });

    // Act
    const settings = await openSettings(person);

    // Assert
    expect(settings.getByText(/This workspace is your team\. Anyone who enters this code joins it, whatever their email domain\./)).toBeInTheDocument();
  });

  it("reports a denied clipboard inside the settings panel that covers the page", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);

    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await person.click(settings.getByRole("button", { name: "Copy code" }));

    expect(await settings.findByRole("alert")).toHaveTextContent(
      "Could not copy. Select the code and copy it manually.",
    );
  });

  it("keeps a board that fails after a successful join clear of the join form", async () => {
    const workspace = vi.fn().mockResolvedValue(workspaceReport);
    const person = await signIn(clientFor({ workspace }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);

    workspace.mockRejectedValueOnce(new ClientError("transient", "The board is taking a break."));
    await person.type(settings.getByLabelText("Their invite code"), "ZZZZZ-YYYYY");
    await person.click(settings.getByRole("button", { name: "Join this team" }));

    // The join itself succeeded, so the message belongs to the panel, not to
    // the Team group where a refused code is reported.
    const message = await settings.findByText("The board is taking a break.");
    expect(message.closest("details")).toBeNull();
  });

  it("repoints the page at the new workspace's projects after a join", async () => {
    const newWorkspaceProjects = [
      { id: "p9", name: "Migration", createdAt: "2026-08-20T12:00:00.000Z", isArchived: false, isDefault: true },
    ];
    const projects = vi.fn()
      .mockResolvedValueOnce({ projects: pickableProjects, selectedProjectId: null })
      .mockResolvedValue({ projects: newWorkspaceProjects, selectedProjectId: null });
    const workspace = vi.fn().mockResolvedValue(workspaceReport);
    const person = await signIn(clientFor({
      projects,
      workspace,
      preferences: vi.fn().mockResolvedValue({ scope: "p2", range: "30d" }),
    }));
    await waitFor(() => expect(screen.getByTestId("filing-where")).toHaveTextContent("Client"));

    const settings = await openSettings(person);
    await person.type(settings.getByLabelText("Their invite code"), "ZZZZZ-YYYYY");
    await person.click(settings.getByRole("button", { name: "Join this team" }));

    // The old workspace's project is gone, so the page reads everything rather
    // than sending a scope the new workspace will refuse.
    await waitFor(() => expect(screen.getByTestId("filing-where")).toHaveTextContent("All projects"));
    expect(workspace.mock.calls.at(-1)?.[0]).not.toContain("scope=p2");
    expect(settings.queryByRole("alert")).toBeNull();

    await person.click(settings.getByRole("button", { name: "Close settings" }));
    await person.click(screen.getByTestId("filing-change"));
    const picker = within(screen.getByTestId("project-picker"));
    expect(picker.getByRole("radio", { name: /Migration/ })).toBeInTheDocument();
    expect(picker.queryByRole("radio", { name: /Client/ })).toBeNull();
  });

  it("rereads the day for the workspace just joined", async () => {
    const meStats = vi.fn()
      .mockResolvedValueOnce(memberStats)
      .mockResolvedValue({
        ...memberStats,
        projects: [{ project: { id: "b1", name: "Onboarding" }, durationSeconds: 3_600, attributedSeconds: 3_600, unattributedSeconds: 0, sessionCount: 1 }],
      });
    const person = await signIn(clientFor({
      meStats,
      organization: vi.fn()
        .mockResolvedValueOnce({ organization })
        .mockResolvedValue({ organization: { ...organization, id: "00000000-0000-4000-8000-0000000000b2", name: "Nightshift" } }),
    }));
    expect(await within(await screen.findByTestId("project-list")).findByText("General")).toBeInTheDocument();

    const settings = await openSettings(person);
    await person.type(settings.getByLabelText("Their invite code"), "ZZZZZ-YYYYY");
    await person.click(settings.getByRole("button", { name: "Join this team" }));

    // /me/stats answers for whichever workspace the viewer is in, so the old
    // one's hours may not sit under the new one's name.
    expect(await within(screen.getByTestId("project-list")).findByText("Onboarding")).toBeInTheDocument();
    expect(within(screen.getByTestId("project-list")).queryByText("General")).toBeNull();
  });

  it("leaves the old workspace's people behind when the viewer joins another", async () => {
    const meStats = vi.fn().mockResolvedValue(memberStats);
    const person = await signIn(clientFor({ meStats }));

    const board = await openAllStats(person);
    await person.click(await board.findByRole("button", { name: /Sam/ }));
    await screen.findByRole("region", { name: /^Sam/ });
    await person.click(screen.getByRole("button", { name: "Close all stats" }));

    const settings = await openSettings(person);
    await person.type(settings.getByLabelText("Their invite code"), "ZZZZZ-YYYYY");
    await person.click(settings.getByRole("button", { name: "Join this team" }));
    await person.click(settings.getByRole("button", { name: "Close settings" }));

    // Sam belongs to the workspace just left, so the id must not go on being
    // sent as a filter the new workspace's API refuses.
    const reopened = await openAllStats(person);
    expect(await reopened.findByRole("region", { name: /^Alex/ })).toBeInTheDocument();
    const query = new URLSearchParams((meStats.mock.calls.at(-1)?.[0] as string).replace(/^\?/, ""));
    expect(query.get("userId")).toBe("u2");
  });

  it("drops the old workspace's project scope even when the new list fails to load", async () => {
    const projects = vi.fn()
      .mockResolvedValueOnce({ projects: pickableProjects, selectedProjectId: null })
      .mockRejectedValue(new ClientError("transient", "The project list is taking a break."));
    const workspace = vi.fn().mockResolvedValue(workspaceReport);
    const person = await signIn(clientFor({
      projects,
      workspace,
      preferences: vi.fn().mockResolvedValue({ scope: "p2", range: "30d" }),
    }));
    await waitFor(() => expect(workspace.mock.calls.at(-1)?.[0]).toContain("scope=p2"));
    const callsBeforeJoin = workspace.mock.calls.length;

    const settings = await openSettings(person);
    await person.type(settings.getByLabelText("Their invite code"), "ZZZZZ-YYYYY");
    await person.click(settings.getByRole("button", { name: "Join this team" }));
    await settings.findByText("The project list is taking a break.");

    // The join went through, so p2 is a project of the workspace just left and
    // the new one's API refuses it. Not one request may still carry it.
    await waitFor(() => expect(screen.getByTestId("filing-where")).toHaveTextContent("All projects"));
    await waitFor(() => expect(workspace.mock.calls.length).toBeGreaterThan(callsBeforeJoin));
    const queriesAfterJoin = workspace.mock.calls.slice(callsBeforeJoin).map((call) => call[0] as string);
    expect(queriesAfterJoin.filter((query) => query.includes("scope=p2"))).toEqual([]);
  });

  it("keeps a project list that fails after a successful join clear of the join form", async () => {
    const projects = vi.fn()
      .mockResolvedValueOnce({ projects: pickableProjects, selectedProjectId: null })
      .mockRejectedValue(new ClientError("transient", "The project list is taking a break."));
    const person = await signIn(clientFor({ projects }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);

    await person.type(settings.getByLabelText("Their invite code"), "ZZZZZ-YYYYY");
    await person.click(settings.getByRole("button", { name: "Join this team" }));

    // The code was accepted, so nothing under the form may read as a refusal.
    const message = await settings.findByText("The project list is taking a break.");
    expect(message.closest("details")).toBeNull();
  });

  it("asks the new workspace for a board rather than calling it empty", async () => {
    const projects = vi.fn()
      .mockResolvedValueOnce({ projects: pickableProjects, selectedProjectId: null })
      .mockRejectedValue(new ClientError("transient", "The project list is taking a break."));
    const workspace = vi.fn()
      .mockResolvedValueOnce(workspaceReport)
      .mockRejectedValue(new ClientError("transient", "The board is taking a break."));
    const person = await signIn(clientFor({ projects, workspace }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const settings = await openSettings(person);
    await person.type(settings.getByLabelText("Their invite code"), "ZZZZZ-YYYYY");
    await person.click(settings.getByRole("button", { name: "Join this team" }));
    await settings.findByText("The project list is taking a break.");
    await person.click(settings.getByRole("button", { name: "Close settings" }));

    // The old workspace's people are gone, but nothing has measured the new
    // workspace, so the board may not claim it recorded nothing.
    const board = await openAllStats(person);
    expect(await board.findByText("Could not load hours for this range.")).toBeInTheDocument();
    expect(board.queryByText(/No recorded time in this range yet/)).toBeNull();
  });

  it("takes the old workspace's board down when the join's project refresh fails", async () => {
    const projects = vi.fn()
      .mockResolvedValueOnce({ projects: pickableProjects, selectedProjectId: null })
      .mockRejectedValue(new ClientError("transient", "The project list is taking a break."));
    const workspace = vi.fn()
      .mockResolvedValueOnce(workspaceReport)
      .mockResolvedValue({
        ...workspaceOfOne,
        members: [{ rank: 1, user: { id: "u9", name: "Robin" }, activeSeconds: 3_600, agentSeconds: 0, project: null }],
      });
    const person = await signIn(clientFor({ projects, workspace }));
    const board = await openAllStats(person);
    expect(await board.findByRole("button", { name: /Sam/ })).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Close all stats" }));

    const settings = await openSettings(person);
    await person.type(settings.getByLabelText("Their invite code"), "ZZZZZ-YYYYY");
    await person.click(settings.getByRole("button", { name: "Join this team" }));
    await settings.findByText("The project list is taking a break.");
    await person.click(settings.getByRole("button", { name: "Close settings" }));

    // Sam keeps time with the workspace just left; the masthead already names
    // the new one, so its board lists the new one's people instead.
    const reopened = await openAllStats(person);
    expect(await reopened.findByRole("button", { name: /Robin/ })).toBeInTheDocument();
    expect(reopened.queryByRole("button", { name: /Sam/ })).toBeNull();
  });

  it("shows a board that fails on the retired scope after a join inside the panel", async () => {
    const newWorkspaceProjects = [
      { id: "p9", name: "Migration", createdAt: "2026-08-20T12:00:00.000Z", isArchived: false, isDefault: true },
    ];
    const projects = vi.fn()
      .mockResolvedValueOnce({ projects: pickableProjects, selectedProjectId: null })
      .mockResolvedValue({ projects: newWorkspaceProjects, selectedProjectId: null });
    const workspace = vi.fn()
      .mockResolvedValueOnce(workspaceReport)
      .mockRejectedValue(new ClientError("transient", "The board is taking a break."));
    const person = await signIn(clientFor({
      projects,
      workspace,
      preferences: vi.fn().mockResolvedValue({ scope: "p2", range: "30d" }),
    }));
    await waitFor(() => expect(screen.getByTestId("filing-where")).toHaveTextContent("Client"));

    const settings = await openSettings(person);
    await person.type(settings.getByLabelText("Their invite code"), "ZZZZZ-YYYYY");
    await person.click(settings.getByRole("button", { name: "Join this team" }));

    // The scope was retired, so the reload runs from the scope effect - and its
    // failure still has to reach the panel that covers the page banner.
    expect(await settings.findByText("The board is taking a break.")).toBeInTheDocument();
  });

  it("lets the download menu keep an Escape press to itself inside the settings panel", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);
    await person.click(settings.getByRole("button", { name: /download/i }));
    expect(settings.getByRole("link", { name: "Download for Windows" })).toBeInTheDocument();

    await person.keyboard("{Escape}");

    expect(settings.queryByRole("link", { name: "Download for Windows" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("waits for today's hours before saying there are none", async () => {
    let releaseStats = (_stats: unknown): void => {};
    const meStats = vi.fn().mockReturnValue(new Promise((resolve) => { releaseStats = resolve; }));
    await signIn(clientFor({ meStats }));
    await screen.findByRole("heading", { name: "Today" });

    // Nothing has been loaded yet, so nothing can be claimed about it - the
    // clock included, where 00:00:00 would be a claim about the hours.
    expect(screen.queryByTestId("today-panel-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("elapsed-time")).toHaveTextContent("-");
    expect(screen.getByTestId("elapsed-time")).not.toHaveTextContent("00:00:00");
    expect(screen.getByText("Loading hours…")).toBeInTheDocument();

    releaseStats({ ...memberStats, totalDurationSeconds: 0, projects: [], apps: [], byAgent: [], hourly: [] });

    // A day that loaded and holds nothing is a real zero, and reads as one.
    expect(await screen.findByTestId("today-panel-empty")).toBeInTheDocument();
    expect(screen.getByTestId("elapsed-time")).toHaveTextContent("00:00:00");
  });

  it("says the refresh failed rather than emptying the Today card down to its heading", async () => {
    const meStats = vi.fn().mockResolvedValue({
      ...memberStats, totalDurationSeconds: 0, projects: [], apps: [], byAgent: [], hourly: [],
    });
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: pickableProjects, selectedProjectId: null }),
      meStats,
    }));
    expect(await screen.findByTestId("today-panel-empty")).toBeInTheDocument();

    meStats.mockRejectedValueOnce(new ClientError("transient", "Today is taking a break."));
    await person.click(screen.getByTestId("filing-change"));
    await person.click(within(screen.getByTestId("project-picker")).getByRole("radio", { name: /Client/ }));

    expect(await screen.findByText("Could not load today's hours.")).toBeInTheDocument();
  });

  it("keeps the last good rows when the refresh tick fails over an unchanged project", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const meStats = vi.fn().mockResolvedValue(memberStats);
      await signIn(clientFor({ meStats }));
      await screen.findByTestId("session-app-list");

      meStats.mockRejectedValueOnce(new ClientError("transient", "Today is taking a break."));
      await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS);
      await waitFor(() => expect(meStats).toHaveBeenCalledTimes(2));

      // The question did not change, so the answer on screen is still an answer.
      expect(screen.getByTestId("session-app-list")).toBeInTheDocument();
      expect(screen.queryByText("Could not load today's hours.")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks nothing while the tab is hidden, and catches up the moment it is looked at", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const visibility = vi.spyOn(document, "visibilityState", "get");
    try {
      const meStats = vi.fn().mockResolvedValue(memberStats);
      await signIn(clientFor({ meStats }));
      await screen.findByTestId("session-app-list");
      const afterSignIn = meStats.mock.calls.length;

      // Nobody is reading it, so nobody is served by the rows it would cost.
      // The advance is acted on, because a tick that did fire would otherwise
      // leave its render queued and this count would pass without meaning it.
      visibility.mockReturnValue("hidden");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS * 3);
      });
      expect(meStats).toHaveBeenCalledTimes(afterSignIn);

      // Read again, and the panel is current before it is looked at twice.
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(meStats).toHaveBeenCalledTimes(afterSignIn + 1));
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it("still refreshes on its own clock while the tab is being looked at", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const meStats = vi.fn().mockResolvedValue(memberStats);
      await signIn(clientFor({ meStats }));
      await screen.findByTestId("session-app-list");
      const afterSignIn = meStats.mock.calls.length;

      await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS);
      await waitFor(() => expect(meStats).toHaveBeenCalledTimes(afterSignIn + 1));
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the old project's rows when the day fails to load for a newly picked one", async () => {
    const meStats = vi.fn().mockResolvedValue(memberStats);
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: pickableProjects, selectedProjectId: null }),
      meStats,
    }));
    await screen.findByTestId("session-app-list");

    meStats.mockRejectedValueOnce(new ClientError("transient", "Today is taking a break."));
    await person.click(screen.getByTestId("filing-change"));
    await person.click(within(screen.getByTestId("project-picker")).getByRole("radio", { name: /Client/ }));

    // The header now says Client, so General's hours may not sit under it.
    expect(await screen.findByText("Could not load today's hours.")).toBeInTheDocument();
    expect(screen.queryByTestId("session-app-list")).toBeNull();
    expect(screen.queryByTestId("project-list")).toBeNull();
    // The card calls the day unknown, so the biggest thing on the page cannot
    // call it zero in the same breath.
    expect(screen.getByTestId("elapsed-time")).not.toHaveTextContent("00:00:00");
  });

  it("says the day failed without also claiming it was empty", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const meStats = vi.fn().mockResolvedValue({
        ...memberStats, totalDurationSeconds: 0, projects: [], apps: [], byAgent: [], hourly: [],
      });
      await signIn(clientFor({ meStats }));
      expect(await screen.findByTestId("today-panel-empty")).toBeInTheDocument();

      meStats.mockRejectedValueOnce(new ClientError("transient", "Today is taking a break."));
      await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS);

      // One card cannot call the number unknown and zero in the same breath.
      await waitFor(() => expect(screen.getByText("Could not load today's hours.")).toBeInTheDocument());
      expect(screen.queryByTestId("today-panel-empty")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains how the app works from the dashboard help button", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });

    await person.click(screen.getByRole("button", { name: "How SIQshift works" }));

    const dialog = screen.getByRole("dialog", { name: "How SIQshift works" });
    expect(dialog).toHaveTextContent("Install the desktop app");
    expect(within(dialog).getByRole("link", { name: /download/i })).toBeInTheDocument();

    // The same story the desktop app's "what's recorded" panel tells.
    expect(dialog).toHaveTextContent("There is no timer to start and none to forget.");
    expect(dialog).toHaveTextContent("Hours are filed under a project.");
    const kept = within(dialog).getByRole("heading", { name: "SIQshift writes down" }).nextElementSibling;
    expect(kept).toHaveTextContent("The name only.");
    // Identity is keyed on the repository and the repository is named by its
    // remote, so the remote leaves the machine too and the sentence says so.
    expect(kept).toHaveTextContent("origin remote URL with any embedded credentials removed");
    const never = within(dialog).getByRole("heading", { name: "SIQshift never writes down" }).nextElementSibling;
    expect(never).toHaveTextContent("Not one keystroke.");
    // The remote is a repository name, not browsing, and the never-list says so
    // rather than claiming a category the code no longer honours.
    expect(never).toHaveTextContent("Browsing addresses, history, or page content.");
    expect(never).toHaveTextContent("is not browsing");
    expect(never).toHaveTextContent("Anything you type into a form, chat, or document.");
    expect(never).toHaveTextContent("SIQshift never reaches inside or controls your other apps.");
    expect(dialog).toHaveTextContent("Everyone sees the same numbers.");
    // What counts as active on a Mac, which the home page no longer lists.
    const counted = within(dialog).getByRole("heading", { name: "How time is counted" }).nextElementSibling;
    expect(counted).toHaveTextContent("On a Mac, music on its own does not keep you active. Video and calls do.");
    expect(counted).toHaveTextContent("On a Mac, a live microphone keeps you active on macOS 14 or later.");

    await person.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await person.click(screen.getByRole("button", { name: "How SIQshift works" }));
    await person.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reloads with device-local instant bounds when the range changes", async () => {
    const workspace = vi.fn().mockResolvedValue(workspaceReport);
    const person = await signIn(clientFor({ workspace }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    const callsBefore = workspace.mock.calls.length;
    await person.click(stats.getByRole("button", { name: "7d" }));

    await waitFor(() => expect(workspace.mock.calls.length).toBeGreaterThan(callsBefore));
    const query = new URLSearchParams(workspace.mock.calls.at(-1)?.[0]);
    expect(query.get("fromAt")).not.toBeNull();
    expect(query.get("toExclusiveAt")).not.toBeNull();
  });

  it("asks for everything by sending no bounds on all time", async () => {
    const workspace = vi.fn().mockResolvedValue(workspaceReport);
    const person = await signIn(clientFor({ workspace }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(stats.getByRole("button", { name: "All time" }));

    await waitFor(() => expect(workspace).toHaveBeenLastCalledWith(""));
  });

  it("draws the range on screen, never an older range's answer that lands late", async () => {
    // Arrange: all time answers only when told to, after the 7-day read asked later.
    const allTime = { ...workspaceReport, activeSeconds: 90_000 };
    const lastSevenDays = { ...workspaceReport, activeSeconds: 1_800 };
    let answerAllTime: ((report: typeof allTime) => void) | undefined;
    const workspace = vi.fn().mockImplementation((query: string = "") => {
      if (query === "") return new Promise((resolve) => { answerAllTime = resolve; });
      const params = new URLSearchParams(query.replace(/^\?/, ""));
      const days = Math.round((Date.parse(params.get("toExclusiveAt")!) - Date.parse(params.get("fromAt")!)) / 86_400_000);
      return Promise.resolve(days === 7 ? lastSevenDays : workspaceReport);
    });
    const person = await signIn(clientFor({ workspace }));
    const stats = await openAllStats(person);
    await stats.findByLabelText("Totals");

    // Act
    await person.click(stats.getByRole("button", { name: "All time" }));

    // Assert: the 30 days already drawn do not stand in for all time.
    expect(stats.queryByLabelText("Totals")).not.toBeInTheDocument();

    // Act
    await person.click(stats.getByRole("button", { name: "7d" }));
    await stats.findByLabelText("Totals");
    await act(async () => answerAllTime?.(allTime));

    // Assert
    expect(stats.getByText(/^Last 7 days · /)).toBeInTheDocument();
    expect(teamTotal(stats, "Active time")).toHaveTextContent(/^30m$/);
  });

  it("uses local calendar midnights across a daylight-saving boundary", () => {
    // 2026-03-08 is the US spring-forward Sunday; the week began Monday the 2nd.
    const now = new Date(2026, 2, 8, 12);
    const query = new URLSearchParams(rangeQuery("7d", now));
    const from = new Date(query.get("fromAt")!);
    const toExclusive = new Date(query.get("toExclusiveAt")!);

    expect(from.getHours()).toBe(0);
    expect(toExclusive.getHours()).toBe(0);
    expect(from.getDate()).toBe(2);
    expect(toExclusive.getDate()).toBe(9);
  });

  it("passes the invite code through sign-up and omits it when blank", async () => {
    const signUp = vi.fn().mockResolvedValue(undefined);
    const person = userEvent.setup();
    render(<App client={clientFor({ signUp })} />);

    await person.click((await screen.findAllByRole("button", { name: "Create account" }))[0]!);
    await person.type(screen.getByLabelText("Name"), "Alex Morgan");
    await person.type(screen.getByLabelText("Email"), "alex@example.com");
    await person.type(screen.getByLabelText("Password"), "long-enough-password");
    await person.type(screen.getByLabelText(/Invite code/), "  ACDEF-GHJKM ");
    await person.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signUp).toHaveBeenCalledWith({
      email: "alex@example.com",
      password: "long-enough-password",
      name: "Alex Morgan",
      inviteCode: "ACDEF-GHJKM",
    }));
  });

  it("walks a brand-new account through the download step before the dashboard", async () => {
    const person = userEvent.setup();
    render(<App client={clientFor()} />);

    await person.click((await screen.findAllByRole("button", { name: "Create account" }))[0]!);
    await person.type(screen.getByLabelText("Name"), "Alex Morgan");
    await person.type(screen.getByLabelText("Email"), "alex@example.com");
    await person.type(screen.getByLabelText("Password"), "long-enough-password");
    await person.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("heading", { name: /the app/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download for Windows" })).toHaveAttribute("href", windowsInstallerUrl);

    await person.click(screen.getByRole("button", { name: "Skip to your dashboard" }));
    expect(await screen.findByRole("heading", { name: "Lumen Studio" })).toBeInTheDocument();
  });

  it("names the new workspace when no invite code is given", async () => {
    const signUp = vi.fn().mockResolvedValue(undefined);
    const person = userEvent.setup();
    render(<App client={clientFor({ signUp })} />);

    await person.click((await screen.findAllByRole("button", { name: "Create account" }))[0]!);
    await person.type(screen.getByLabelText("Name"), "Alex Morgan");
    await person.type(screen.getByLabelText("Email"), "alex@example.com");
    await person.type(screen.getByLabelText("Password"), "long-enough-password");
    await person.type(screen.getByLabelText(/Workspace name/), "  Lumen Studio  ");
    await person.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signUp).toHaveBeenCalledWith({
      email: "alex@example.com",
      password: "long-enough-password",
      name: "Alex Morgan",
      workspaceName: "Lumen Studio",
    }));
  });

  it("hides the workspace name field once an invite code is entered", async () => {
    const person = userEvent.setup();
    render(<App client={clientFor()} />);

    await person.click((await screen.findAllByRole("button", { name: "Create account" }))[0]!);
    expect(screen.getByLabelText(/Workspace name/)).toBeInTheDocument();

    await person.type(screen.getByLabelText(/Invite code/), "ACDEF-GHJKM");
    expect(screen.queryByLabelText(/Workspace name/)).not.toBeInTheDocument();
  });

  it("takes a returning account straight to the dashboard", async () => {
    await signIn(clientFor());

    expect(await screen.findByRole("heading", { name: "Lumen Studio" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /the app/i })).not.toBeInTheDocument();
  });

  it("restores a live session on load and skips the sign-in form", async () => {
    const client = clientFor({ restoreSession: vi.fn().mockResolvedValue(true) });
    render(<App client={client} />);

    expect(await screen.findByRole("heading", { name: "Lumen Studio" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("returns to sign-in with a readable message when the session expires", async () => {
    const client = clientFor({
      workspace: vi.fn().mockRejectedValue(new ClientError("auth", "Your session expired. Sign in again.")),
    });
    await signIn(client);

    expect(await screen.findByText(/session expired/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("keeps the dashboard up and reports a transient failure without signing out", async () => {
    const client = clientFor({
      workspace: vi.fn().mockRejectedValue(new ClientError("transient", "The server is unavailable. Try again shortly.")),
    });
    await signIn(client);

    expect(await screen.findByText(/unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("shows an actionable error for a wrong password and stays on the form", async () => {
    const signInMock = vi.fn().mockRejectedValue(new ClientError("auth", "Incorrect email or password."));
    await signIn(clientFor({ signIn: signInMock }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("keeps the workspace on screen when the API refuses the report calls", async () => {
    // The live failure: a deployed API that predates the instant-bound filters
    // 400s both report calls. Promise.all threw the successful /organization
    // away with them, so a server-side refusal read as an empty account.
    const refused = () => new ClientError("validation", "The server would not accept that request.");
    const person = await signIn(clientFor({
      workspace: vi.fn().mockRejectedValue(refused()),
      meStats: vi.fn().mockRejectedValue(refused()),
    }));

    expect(await screen.findByRole("heading", { name: "Lumen Studio" })).toBeInTheDocument();
    expect(await screen.findByText(/would not accept/)).toBeInTheDocument();
    const settings = await openSettings(person);
    expect(await settings.findByText("ACDEF-GHJKM")).toBeInTheDocument();
  });

  it("distinguishes a card that failed to load from a range with nothing in it", async () => {
    const refused = () => new ClientError("validation", "The server would not accept that request.");
    const person = await signIn(clientFor({
      workspace: vi.fn().mockRejectedValue(refused()),
      meStats: vi.fn().mockRejectedValue(refused()),
    }));

    const board = await openAllStats(person);
    expect(await board.findByText("Could not load hours for this range.")).toBeInTheDocument();
    // A zero total is a claim about the data; nothing was loaded to claim it from.
    expect(board.queryByText(/No recorded time in this range yet/)).not.toBeInTheDocument();
    expect(await board.findByText("Could not load this member's breakdown.")).toBeInTheDocument();
  });

  it("says so plainly when a range has no recorded time", async () => {
    const person = await signIn(clientFor({
      workspace: vi.fn().mockResolvedValue(quietWorkspace),
      meStats: vi.fn().mockResolvedValue({ ...memberStats, totalDurationSeconds: 0, projects: [], apps: [], byAgent: [] }),
    }));

    // The home screen says it about today, in the desktop app's own words.
    expect(await screen.findByTestId("today-panel-empty")).toHaveTextContent("Nothing has been added up yet.");
    const stats = await openAllStats(person);
    expect(await stats.findByText(/No recorded time in this range yet/)).toBeInTheDocument();
    expect(await stats.findByText("No recorded time in this range.")).toBeInTheDocument();
  });

  it("keeps the install hint beside a roster-only zero row", async () => {
    const person = await signIn(clientFor({
      workspace: vi.fn().mockResolvedValue(quietWorkspace),
    }));

    const board = await openAllStats(person);
    expect(await board.findByText(/No recorded time in this range yet/)).toBeInTheDocument();
    expect(await board.findByRole("row", { name: /Alex/ })).toHaveTextContent("0s");
  });

  it("claims the first admin role once on sign-in and swallows the existing-admin refusal", async () => {
    const claimAdmin = vi.fn().mockRejectedValue(new ClientError("validation", "A workspace administrator already exists."));
    await signIn(clientFor({ claimAdmin }));

    expect(await screen.findByRole("heading", { name: "Lumen Studio" })).toBeInTheDocument();
    expect(claimAdmin).toHaveBeenCalledTimes(1);
    // A 409 once an admin exists is a silent no-op, never an error on screen.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/administrator already exists/)).not.toBeInTheDocument();
  });

  it("opens on your own breakdown, with agent tools folded into named rows", async () => {
    const person = await signIn(clientFor());

    const board = await openAllStats(person);
    // You are the highlighted row from the start.
    expect(await board.findByRole("button", { name: /Alex/ })).toHaveAttribute("aria-pressed", "true");
    const stats = within(await screen.findByRole("region", { name: /^Alex/ }));
    // The breakdown leads with active time and splits it into human work and
    // the agent-assisted buckets that actually have time in them.
    const breakdown = stats.getByTestId("breakdown");
    expect(breakdown).toHaveTextContent("Active time");
    expect(breakdown).toHaveTextContent("2h 00m");
    expect(breakdown).toHaveTextContent("Human work");
    expect(breakdown).toHaveTextContent("With 1 agent");
    expect(breakdown).not.toHaveTextContent("With 2 agents");
    // What the agents themselves added up to is the agent's number, not the
    // person's; it lives on the Agents tab now, with its own table.
    expect(breakdown).not.toHaveTextContent("while away");
    expect(breakdown).not.toHaveTextContent("Total agent time");
    expect(stats.queryByTestId("agent-sessions")).not.toBeInTheDocument();
    expect(stats.getByText("General")).toBeInTheDocument();
    // claude.exe reads as the tool it is, so the team sees Claude usage plainly.
    expect(stats.getAllByText("Claude Code").length).toBeGreaterThan(0);
    expect(stats.getByText("VS Code")).toBeInTheDocument();
    // The half hour nothing named a project for was filed under General, and
    // counts as General's: one row, no separate unattributed line.
    const projectRows = within(stats.getByTestId("member-project-list")).getAllByRole("listitem");
    expect(projectRows.map((row) => row.textContent)).toEqual(["General2h 00m"]);
    expect(stats.queryByTestId("unattributed-foot")).not.toBeInTheDocument();
  });

  it("states the agent time limit word for word under both the Humans and the Agents page", async () => {
    // Arrange
    const person = await signIn(clientFor());
    const stats = await openAllStats(person);
    await stats.findByLabelText("Totals");

    // Act
    const onHumans = stats.getByTestId("agent-time-limit").textContent;
    await person.click(agentsTab(stats));
    await screen.findByTestId("agent-shifts");

    // Assert
    const note = "A shift that goes 30 minutes without activity stops counting and cannot resume; later work in that session is not included.";
    expect(onHumans).toBe(note);
    expect(stats.getByTestId("agent-time-limit")).toHaveTextContent(note);
  });

  it("names the project a session was filed under in the history, also when nothing named one", async () => {
    const sessionRow = {
      user: { id: "u2", name: "Alex" },
      project: { id: "p1", name: "General" },
      description: null,
      status: "stopped",
      startedAt: "2026-08-06T15:00:00.000Z",
      stoppedAt: "2026-08-06T16:00:00.000Z",
      idleSeconds: 0,
      durationSeconds: 3_600,
    };
    const person = await signIn(clientFor({
      report: vi.fn().mockResolvedValue({
        rows: [
          { ...sessionRow, id: "00000000-0000-4000-8000-000000000701", attribution: "default", attributedSeconds: 0, unattributedSeconds: 3_600 },
          { ...sessionRow, id: "00000000-0000-4000-8000-000000000702", attribution: "agent", attributedSeconds: 3_600, unattributedSeconds: 0 },
        ],
        totalDurationSeconds: 7_200,
        filters: {},
        pagination: { page: 1, pageSize: 25, totalRows: 2, totalPages: 1 },
      }),
    }));

    const stats = await openAllStats(person);
    const drawer = stats.getByText(/Recent sessions/).closest("details")!;
    await person.click(within(drawer).getByText(/Recent sessions/));
    const table = await within(drawer).findByRole("table");
    const projectCells = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[1]!.textContent);
    expect(projectCells).toEqual(["General", "General"]);
  });

  it("renders an older API response that lacks the hourly series", async () => {
    const olderStats = { ...memberStats, hourly: undefined } as unknown as MeStatsResponse;
    const person = await signIn(clientFor({ meStats: vi.fn().mockResolvedValue(olderStats) }));

    expect(await screen.findByRole("heading", { name: "Lumen Studio" })).toBeInTheDocument();
    await openAllStats(person);
    const stats = within(await screen.findByRole("region", { name: /^Alex/ }));
    expect(stats.getByTestId("breakdown")).toHaveTextContent("Active time");
    expect(stats.queryByTestId("hourly-graph")).not.toBeInTheDocument();
  });

  it("draws the hourly chart as real path geometry once the API sends buckets", async () => {
    const person = await signIn(clientFor({
      meStats: vi.fn().mockResolvedValue({
        ...memberStats,
        hourly: [
          { hourStart: "2026-08-15T09:00:00.000Z", activeSeconds: 600, agentSeconds: 300, inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null },
          { hourStart: "2026-08-15T10:00:00.000Z", activeSeconds: 1_800, agentSeconds: 900, inputTokens: 12_000, outputTokens: 800, cacheCreationInputTokens: 400, cacheReadInputTokens: 60_000 },
          { hourStart: "2026-08-15T11:00:00.000Z", activeSeconds: 300, agentSeconds: 0, inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null },
        ],
      }),
    }));

    await openAllStats(person);
    const stats = within(await screen.findByRole("region", { name: /^Alex/ }));
    // Pin the series by their hooks, never by a path count: gradient areas
    // are paths too. The chart must emit <path d="M… L…"> elements, not
    // polylines fed a path string: `points` cannot parse path commands, so a
    // polyline would hold zero points and the graph would be an empty frame.
    const graph = stats.getByTestId("hourly-graph");
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

  // Issue 101: the graph is time and only time, the person in gray against
  // agents in green, even when the hours the API sends still carry tokens.
  it("draws exactly two lines, human and agent, and no token series", async () => {
    // Arrange
    const person = await signIn(clientFor({
      meStats: vi.fn().mockResolvedValue({
        ...memberStats,
        hourly: [
          { hourStart: "2026-08-15T09:00:00.000Z", activeSeconds: 600, agentSeconds: 300, inputTokens: 4_000, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 8_000 },
          { hourStart: "2026-08-15T10:00:00.000Z", activeSeconds: 1_800, agentSeconds: 900, inputTokens: 12_000, outputTokens: 800, cacheCreationInputTokens: 400, cacheReadInputTokens: 60_000 },
        ],
      }),
    }));

    // Act
    await openAllStats(person);
    const stats = within(await screen.findByRole("region", { name: /^Alex/ }));
    const graph = stats.getByTestId("hourly-graph");

    // Assert
    const series = [...graph.querySelectorAll("path[data-series]")].map((line) => line.getAttribute("data-series"));
    expect(series).toEqual(["agent", "human"]);
    expect(within(graph).queryByRole("button", { name: "Tokens" })).not.toBeInTheDocument();
    expect(graph).not.toHaveTextContent(/token/i);
  });

  it("labels 3+ concurrency in plain words and leaves the agents' own totals to their tab", async () => {
    const person = await signIn(clientFor({
      meStats: vi.fn().mockResolvedValue({
        ...memberStats,
        concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 5_400, awaySeconds: 1_800 },
      }),
    }));

    await openAllStats(person);
    const stats = within(await screen.findByRole("region", { name: /^Alex/ }));
    const breakdown = stats.getByTestId("breakdown");
    expect(breakdown).toHaveTextContent("With 3+ agents");
    expect(breakdown).toHaveTextContent("1h 30m");
    expect(breakdown).not.toHaveTextContent("With 2 agents");
    expect(breakdown).not.toHaveTextContent("With 1 agent");
    expect(breakdown).not.toHaveTextContent("while away");
  });

  // The Overlord's card, to the minute: 1h56m recorded, 37m active, no agent
  // time measured anywhere in the window. The header used to call the 1h19m
  // difference "unattended agent time" while the board beside it read
  // "Agent 0s", and the app list under it summed to 37m against a project list
  // summing to 1h56m.
  it("explains the gap between recorded and active without inventing agent time", async () => {
    const person = await signIn(clientFor({
      meStats: vi.fn().mockResolvedValue({
        ...memberStats,
        totalDurationSeconds: 6_960,
        activeSeconds: 2_220,
        agentSeconds: 0,
        concurrency: { t0Seconds: 2_220, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
        byAgent: [],
        projects: [
          { project: { id: "p2", name: "Atlas Portal" }, durationSeconds: 5_640, attributedSeconds: 5_640, unattributedSeconds: 0, sessionCount: 2 },
          { project: { id: "p1", name: "General" }, durationSeconds: 1_320, attributedSeconds: 0, unattributedSeconds: 1_320, sessionCount: 1 },
        ],
        apps: [
          { processName: "WindowsTerminal.exe", durationSeconds: 1_200 },
          { processName: "chrome.exe", durationSeconds: 720 },
          { processName: "explorer.exe", durationSeconds: 300 },
        ],
      }),
    }));

    await openAllStats(person);
    const stats = within(await screen.findByRole("region", { name: /^Alex/ }));

    // No agent claim on a window whose measured agent time is zero.
    const total = stats.getByText(/recorded/).closest("p");
    expect(total).not.toHaveTextContent(/agent/i);
    expect(total).toHaveTextContent("1h 56m");
    expect(total).toHaveTextContent("1h 19m of it away from the keyboard");

    // Both lists now close on the same total: 1h 34m + 22m of projects, and
    // 20m + 12m + 5m of apps with the 1h 19m nobody was in front of anything.
    const projects = stats.getByTestId("member-project-list");
    expect(projects).toHaveTextContent("Atlas Portal1h 34m");
    expect(projects).toHaveTextContent("General22m");
    expect(projects).not.toHaveTextContent("Unattributed");
    const apps = stats.getByTestId("member-app-list");
    expect(apps).toHaveTextContent("Quiet time");
    expect(within(apps).getByText("Quiet time").closest("li")).toHaveTextContent("1h 19m");
  });

  it("keeps the breakdown quiet when there is nothing recorded", async () => {
    const person = await signIn(clientFor({
      meStats: vi.fn().mockResolvedValue({
        ...memberStats,
        activeSeconds: 0,
        agentSeconds: 0,
        concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
        byAgent: [],
      }),
    }));

    await openAllStats(person);
    const stats = within(await screen.findByRole("region", { name: /^Alex/ }));
    const breakdown = stats.getByTestId("breakdown");
    expect(breakdown).toHaveTextContent("Human work");
    expect(breakdown).not.toHaveTextContent("Total agent time");
    expect(stats.queryByTestId("agent-sessions")).not.toBeInTheDocument();
  });

  it("follows whichever member gets picked on the board", async () => {
    const meStats = vi.fn().mockResolvedValue(memberStats);
    const person = await signIn(clientFor({ meStats }));

    const board = await openAllStats(person);
    await person.click(await board.findByRole("button", { name: /Sam/ }));

    expect(await screen.findByRole("region", { name: /^Sam/ })).toBeInTheDocument();
    const query = new URLSearchParams((meStats.mock.calls.at(-1)?.[0] as string).replace(/^\?/, ""));
    expect(query.get("userId")).toBe("u1");
    expect(query.get("fromAt")).not.toBeNull();
  });

  it("offers a way back to your own breakdown after picking a teammate", async () => {
    const person = await signIn(clientFor());

    const board = await openAllStats(person);
    await person.click(await board.findByRole("button", { name: /Sam/ }));
    await screen.findByRole("region", { name: /^Sam/ });

    await person.click(screen.getByRole("button", { name: "Show my own" }));
    expect(await screen.findByRole("region", { name: /^Alex/ })).toBeInTheDocument();
  });

  it("lets a stranded account join a teammate's workspace and reloads", async () => {
    const joinOrganization = vi.fn().mockResolvedValue(undefined);
    const organizationCall = vi.fn().mockResolvedValue({ organization });
    const person = await signIn(clientFor({
      joinOrganization,
      organization: organizationCall,
      workspace: vi.fn().mockResolvedValue(workspaceOfOne),
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);

    await person.type(settings.getByLabelText("Their invite code"), "acdef-ghjkm");
    await person.click(settings.getByRole("button", { name: "Join this team" }));

    await waitFor(() => expect(joinOrganization).toHaveBeenCalledWith("acdef-ghjkm"));
    // The dashboard reloads so the new workspace replaces the old one on screen.
    await waitFor(() => expect(organizationCall.mock.calls.length).toBeGreaterThan(1));
  });

  it("explains why an account with recorded time cannot move", async () => {
    const joinOrganization = vi.fn().mockRejectedValue(
      new ClientError("validation", "This account already recorded time here, so it cannot move."),
    );
    const person = await signIn(clientFor({
      joinOrganization,
      workspace: vi.fn().mockResolvedValue(workspaceOfOne),
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);

    await person.type(settings.getByLabelText("Their invite code"), "ACDEF-GHJKM");
    await person.click(settings.getByRole("button", { name: "Join this team" }));

    // A refused code is the Team group's own business, beside the form that
    // sent it.
    const refusal = await settings.findByText(/cannot move/);
    expect(refusal.closest("details")).not.toBeNull();
  });
});

describe("the home screen", () => {
  it("leads with today's total under today's date, the way the app does", async () => {
    await signIn(clientFor());

    await screen.findByRole("heading", { name: "Lumen Studio" });
    // The clock is the page: one accumulated figure for the day, and the date
    // it belongs to above it.
    await waitFor(() => expect(screen.getByTestId("elapsed-time")).toHaveTextContent("02:00:00"));
    const today = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    expect(screen.getByRole("heading", { name: today })).toBeInTheDocument();
  });

  it("reads today alone, for the viewer, whatever range All stats is set to", async () => {
    const meStats = vi.fn().mockResolvedValue(memberStats);
    await signIn(clientFor({ meStats, preferences: vi.fn().mockResolvedValue({ scope: "all", range: "90d" }) }));
    // The clock renders before the stored preferences land, so the assertion
    // waits for the read itself rather than for the element it fills.
    await waitFor(() => expect(meStats).toHaveBeenCalled());

    const query = new URLSearchParams((meStats.mock.calls[0]?.[0] as string).replace(/^\?/, ""));
    const from = new Date(query.get("fromAt")!);
    const toExclusive = new Date(query.get("toExclusiveAt")!);
    // One local day, not the stored 90-day range: the heading names a date,
    // so the number under it has to be that date's.
    expect(toExclusive.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1_000);
    expect(from.getHours()).toBe(0);
    expect(query.has("userId")).toBe(false);
  });

  it("gives each app the desktop's meter row: a mark, the name, its share, its duration", async () => {
    await signIn(clientFor());

    const rows = within(await screen.findByTestId("session-app-list")).getAllByRole("listitem");
    // An agent CLI reads as the tool it is, with its runtime mark, and the
    // heaviest row anchors the bars at 100%.
    expect(rows[0]).toHaveTextContent("Claude Code");
    expect(rows[0]!.querySelector(".agent-mark")).not.toBeNull();
    expect(rows[0]!.querySelector<HTMLElement>(".meter-bar")?.style.getPropertyValue("--share")).toBe("100%");
    expect(rows[1]).toHaveTextContent("VS Code");
    expect(rows[1]!.querySelector<HTMLElement>(".meter-bar")?.style.getPropertyValue("--share")).toBe("50%");
    for (const row of rows.slice(0, 2)) {
      expect(row).toHaveClass("meter-row");
      expect(row.children).toHaveLength(4);
    }
  });

  it("names the day's unaccounted minutes as quiet time rather than losing them", async () => {
    await signIn(clientFor());

    // 2h recorded against 1h30m in front of an app: the difference is a row,
    // not a column that quietly does not add up.
    const quiet = await screen.findByTestId("quiet-row");
    expect(quiet).toHaveTextContent("Quiet time");
    expect(quiet).toHaveTextContent("30m");
  });

  it("files the day under its projects, each with its share of the total", async () => {
    await signIn(clientFor());

    const rows = within(await screen.findByTestId("project-list")).getAllByRole("listitem");
    // The half hour nothing named a project for was filed under General and
    // counts as General's, so the day is one row.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("General");
    expect(rows[0]).toHaveTextContent("2h 00m");
    expect(rows[0]!.querySelector<HTMLElement>(".meter-bar")?.style.getPropertyValue("--share")).toBe("100%");
  });

  it("plots the day's hours against its agents on the home screen", async () => {
    await signIn(clientFor({
      meStats: vi.fn().mockResolvedValue({
        ...memberStats,
        hourly: [
          { hourStart: "2026-08-15T09:00:00.000Z", activeSeconds: 600, agentSeconds: 300, inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null },
          { hourStart: "2026-08-15T10:00:00.000Z", activeSeconds: 1_800, agentSeconds: 900, inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null },
        ],
      }),
    }));

    const graph = await within(await screen.findByRole("region", { name: "Today" })).findByTestId("hourly-graph");
    expect(graph.querySelector('path[data-series="agent"]')).not.toBeNull();
    expect(graph.querySelector('path[data-series="human"]')).not.toBeNull();
    expect(graph).toHaveTextContent("You");
  });
});

describe("getting the desktop app", () => {
  it("leaves the hero to the download and the header to Sign in and Sign up alone", async () => {
    // Arrange
    render(<App client={clientFor()} />);

    // Act
    const hero = within(await screen.findByRole("region", { name: /Measure the work/ }));
    const header = within(screen.getByRole("navigation", { name: "SIQshift navigation" }));

    // Assert
    expect(hero.queryByRole("button", { name: /Create account|Log in|Sign in|Sign up/ })).not.toBeInTheDocument();
    expect(header.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(header.getByRole("button", { name: "Sign up" })).toBeInTheDocument();
    expect(header.getAllByRole("button")).toHaveLength(2);
    expect(header.queryAllByRole("link")).toHaveLength(0);
  });

  it.each([
    { control: "Sign in", dialogName: "Sign in" },
    { control: "Sign up", dialogName: "Create your account" },
  ])("opens the $dialogName window from the header's $control", async ({ control, dialogName }) => {
    // Arrange
    const person = userEvent.setup();
    render(<App client={clientFor()} />);
    const header = within(await screen.findByRole("navigation", { name: "SIQshift navigation" }));

    // Act
    await person.click(header.getByRole("button", { name: control }));

    // Assert
    expect(screen.getByRole("dialog", { name: dialogName })).toBeInTheDocument();
  });

  it("offers both signed installers in the landing hero before sign-in, never the unsigned test release", async () => {
    // Arrange
    const { container } = render(<App client={clientFor()} />);

    // Act
    const hero = within(await screen.findByRole("region", { name: /Measure the work/ }));

    // Assert
    expect(hero.getByRole("tablist", { name: "Choose your computer" })).toBeInTheDocument();
    expect(hero.getByRole("link", { name: "Download for Windows" })).toHaveAttribute("href", windowsInstallerUrl);
    expect(container.querySelector(`.landing-install a[href="${macInstallerUrl}"]`)).not.toBeNull();
    expect(container.querySelector('a[href*="unsigned-latest"]')).toBeNull();
    // The dashboard's masthead menu stays on the dashboard.
    expect(container.querySelector(".download-menu, .download-corner")).toBeNull();
  });

  it("keeps the same installer one pill wide in the dashboard masthead", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const trigger = screen.getByRole("button", { name: /download/i });
    expect(trigger.closest(".masthead-actions")).not.toBeNull();
    // Nothing of the download's own is in the header row until it is asked for.
    expect(screen.queryByRole("link", { name: /installer|download/i })).not.toBeInTheDocument();

    await person.click(trigger);
    expect(screen.getByRole("link", { name: "Download for Windows" }))
      .toHaveAttribute("href", windowsInstallerUrl);
  });

  it("hands out one installer everywhere, including from the help dialog", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });
    await person.click(screen.getByRole("button", { name: "How SIQshift works" }));

    const dialog = screen.getByRole("dialog", { name: "How SIQshift works" });
    expect(within(dialog).getByRole("link", { name: "Download for Windows" }))
      .toHaveAttribute("href", windowsInstallerUrl);
  });
});

describe("project management", () => {
  const webProjects = [
    { id: "p1", name: "General", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false, isDefault: true },
    { id: "p2", name: "Client", createdAt: "2026-08-11T12:00:00.000Z", isArchived: false, isDefault: false },
  ];

  it("drops the Unassigned scope and reads a stored unassigned as everything", async () => {
    const workspace = vi.fn().mockResolvedValue(workspaceReport);
    const person = await signIn(clientFor({
      preferences: vi.fn().mockResolvedValue({ scope: "unassigned", range: "30d" }),
      workspace,
    }));

    // The filing header says where the page is pointed, in the desktop app's
    // own line above the clock.
    await waitFor(() => expect(screen.getByTestId("filing-where")).toHaveTextContent("All projects"));
    await person.click(screen.getByTestId("filing-change"));
    const picker = within(screen.getByTestId("project-picker"));
    expect(picker.getByRole("radio", { name: /All projects/ })).toHaveAttribute("aria-checked", "true");
    expect(picker.queryByRole("radio", { name: "Unassigned" })).not.toBeInTheDocument();
    // The board fetched the unscoped view rather than passing "unassigned" through.
    await waitFor(() => {
      const query = workspace.mock.calls.at(-1)?.[0] ?? "";
      expect(query).not.toContain("scope=unassigned");
      expect(query).not.toContain("scope=");
    });
  });

  it("points every surface at one project when the filing header picks one", async () => {
    const workspace = vi.fn().mockResolvedValue(workspaceReport);
    const meStats = vi.fn().mockResolvedValue(memberStats);
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
      workspace,
      meStats,
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    await person.click(screen.getByTestId("filing-change"));
    await person.click(within(screen.getByTestId("project-picker")).getByRole("radio", { name: /Client/ }));

    expect(screen.getByTestId("filing-where")).toHaveTextContent("Client");
    await waitFor(() => expect(workspace.mock.calls.at(-1)?.[0]).toContain("scope=p2"));
    await waitFor(() => expect(meStats.mock.calls.at(-1)?.[0]).toContain("scope=p2"));
  });

  it("renames a project from the settings panel", async () => {
    const updateProject = vi.fn().mockResolvedValue(webProjects[1]);
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
      updateProject,
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);

    const row = settings.getByText("Client").closest("li");
    await person.click(within(row as HTMLElement).getByRole("button", { name: "Rename" }));
    const field = settings.getByLabelText("New name for Client");
    await person.clear(field);
    await person.type(field, "Client work");
    await person.click(settings.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateProject).toHaveBeenCalledWith("p2", { name: "Client work" }));
  });

  it("rereads the day so a renamed project is not called two names at once", async () => {
    const meStats = vi.fn()
      .mockResolvedValueOnce(memberStats)
      .mockResolvedValue({
        ...memberStats,
        projects: [{ project: { id: "p1", name: "Ops" }, durationSeconds: 7_200, attributedSeconds: 5_400, unattributedSeconds: 1_800, sessionCount: 3 }],
      });
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
      updateProject: vi.fn().mockResolvedValue({ ...webProjects[0], name: "Ops" }),
      meStats,
    }));
    expect(await within(await screen.findByTestId("project-list")).findByText("General")).toBeInTheDocument();
    const settings = await openSettings(person);

    const row = settings.getByText("General").closest("li");
    await person.click(within(row as HTMLElement).getByRole("button", { name: "Rename" }));
    const field = settings.getByLabelText("New name for General");
    await person.clear(field);
    await person.type(field, "Ops");
    await person.click(settings.getByRole("button", { name: "Save" }));

    // The meter row names the project from the day's own response, so the day
    // has to be reread at the same moment the header is.
    expect(await within(screen.getByTestId("project-list")).findByText("Ops")).toBeInTheDocument();
  });

  it("tags the default project and hides its delete button", async () => {
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const defaultRow = within(settings.getByTestId("project-manage-list")).getByText("General").closest("li");
    expect(defaultRow).not.toBeNull();
    expect(within(defaultRow as HTMLElement).getByText("default")).toBeInTheDocument();
    expect(within(defaultRow as HTMLElement).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

    const otherRow = within(dialog).getByText("Client").closest("li");
    expect(otherRow).not.toBeNull();
    expect(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("deletes an empty project on the click, with no confirmation panel", async () => {
    const deleteProject = vi.fn().mockResolvedValue(undefined);
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
      projectUsage: vi.fn().mockResolvedValue({ sessionCount: 0, durationSeconds: 0, agentSessionCount: 0, agentCount: 0 }),
      deleteProject,
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);

    const otherRow = settings.getByText("Client").closest("li");
    await person.click(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("p2", { reassignTo: null }));
    expect(settings.queryByText("What happens to its sessions?")).not.toBeInTheDocument();
  });

  it("shows counts and a move-or-delete choice instead of a typed name", async () => {
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
      projectUsage: vi.fn().mockResolvedValue({ sessionCount: 2, durationSeconds: 3_600, agentSessionCount: 5, agentCount: 3 }),
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);
    const dialog = screen.getByRole("dialog", { name: "Settings" });

    const otherRow = settings.getByText("Client").closest("li");
    await person.click(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" }));

    await settings.findByText("What happens to its sessions?");
    expect(dialog).toHaveTextContent("2 sessions");
    expect(dialog).toHaveTextContent("5 agent sessions");
    // The roster identities hold the project through a restrict FK, so the
    // admin sees them before confirming rather than after a 500.
    expect(dialog).toHaveTextContent("3 roster agents move with it");
    expect(within(dialog).queryByLabelText(/type the project's name to confirm/i)).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete Client" })).toBeEnabled());
  });

  it("gives the default project its own icon before anyone picks one", async () => {
    // Arrange
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    // Act
    const settings = await openSettings(person);

    // Assert: General's pair is one no other project is given unasked.
    const list = within(settings.getByTestId("project-manage-list"));
    expect(list.getByText("General").closest("li")?.querySelector(".project-icon")).toHaveAttribute("data-icon", "grid");
    expect(list.getByText("Client").closest("li")?.querySelector(".project-icon")).not.toHaveAttribute("data-icon", "grid");
  });

  it("saves the icon and color a member picks for the whole team", async () => {
    // Arrange
    const updateProject = vi.fn().mockResolvedValue({ ...webProjects[1], icon: "bolt", color: "#f5c26b" });
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
      updateProject,
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);
    const row = settings.getByText("Client").closest("li");

    // Act
    await person.click(within(row as HTMLElement).getByRole("button", { name: "Change icon" }));
    const picker = within(settings.getByRole("form", { name: "Icon for Client" }));
    await person.click(picker.getByRole("button", { name: "Bolt" }));
    await person.click(picker.getByRole("button", { name: "Amber" }));
    await person.click(picker.getByRole("button", { name: "Save" }));

    // Assert: the pair goes out, and the list comes back once it is stored.
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith("p2", { icon: "bolt", color: "#f5c26b" }));
    expect(await settings.findByTestId("project-manage-list")).toBeInTheDocument();
    expect(settings.queryByRole("form", { name: "Icon for Client" })).not.toBeInTheDocument();
  });

  it("keeps the icon picker open and says why when the pick cannot be saved", async () => {
    // Arrange
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
      updateProject: vi.fn().mockRejectedValue(new ClientError("validation", "Pick an icon and a color from the lists.")),
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const settings = await openSettings(person);
    const row = settings.getByText("Client").closest("li");

    // Act
    await person.click(within(row as HTMLElement).getByRole("button", { name: "Change icon" }));
    await person.click(within(settings.getByRole("form", { name: "Icon for Client" })).getByRole("button", { name: "Save" }));

    // Assert
    expect(await settings.findByText("Pick an icon and a color from the lists.")).toHaveAttribute("role", "alert");
    expect(settings.getByRole("form", { name: "Icon for Client" })).toBeInTheDocument();
  });
});

describe("the agents tab", () => {
  /// The server's token bars over three hours. Every total is deliberately not
  /// in + out, and no project's bars add up to the period's, so a client that
  /// summed anything itself would draw different bars than these.
  const hours = ["2026-08-15T09:00:00.000Z", "2026-08-15T10:00:00.000Z", "2026-08-15T11:00:00.000Z"];
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
      { project: { id: "p1", name: "General" }, tokens: 777, buckets: bars([[7, 7, 700], null, [1, 1, 77]]) },
      { project: { id: "p2", name: "Ledger" }, tokens: 0, buckets: bars([null, null, null]) },
    ],
  };
  const drawnTokens = (chart: HTMLElement): number[] =>
    [...chart.querySelectorAll("rect[data-tokens]")].map((bar) => Number(bar.getAttribute("data-tokens")));
  const openTokenChart = async (): Promise<{ person: Person; chart: HTMLElement }> => {
    const person = await signIn(clientFor({ agentShifts: vi.fn().mockResolvedValue({ ...agentShiftsResponse, tokenChart }) }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    return { person, chart: within(await screen.findByTestId("agent-shifts")).getByTestId("token-chart") };
  };

  it("draws the server's token bars as given, adding nothing up", async () => {
    // Act
    const { chart } = await openTokenChart();

    // Assert: one bar per hour that burned anything, at the server's total.
    expect(drawnTokens(chart)).toEqual([999, 3_000]);
  });

  it("switches the chart from tokens to agent time with its one toggle", async () => {
    // Arrange
    const { person } = await openTokenChart();
    const chart = within(within(screen.getByTestId("agent-shifts")).getByRole("region", { name: "Over time" }));
    const toggle = within(chart.getByRole("group", { name: "What the chart shows" }));
    expect(toggle.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true");
    expect(chart.queryByRole("combobox")).not.toBeInTheDocument();

    // Act
    await person.click(toggle.getByRole("button", { name: "Agent time" }));

    // Assert: agent time alone, in place of the bars.
    expect(chart.queryByTestId("token-chart")).not.toBeInTheDocument();
    const graph = chart.getByRole("img", { name: "Hourly agent time" });
    expect([...graph.querySelectorAll("path[data-series]")].map((line) => line.getAttribute("data-series"))).toEqual(["agent"]);
    expect(chart.getByText("Each point is one hour.")).toBeInTheDocument();
  });

  it("maps every shift under its codebase, with the total recorded on top", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));

    const panel = within(await screen.findByTestId("agent-shifts"));
    // The totals row leads with the recorded agent time, then the codebases,
    // heaviest first.
    await panel.findByLabelText("Totals");
    expect(teamTotal(panel, "Agent time")).toHaveTextContent(/^2h 00m$/);
    const groups = panel.getAllByTestId("shift-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent("siqshift");
    expect(groups[0]).toHaveTextContent("50% held");
    // The label-less group's commits are all pending: it says nothing rather
    // than "pending", because a rate with no decided commits is not a fact.
    // And its cause is named: these shifts worked a run worktree whose
    // repository nothing identified, not a capture that saw nothing at all.
    expect(groups[1]).toHaveTextContent("Run worktree, codebase not identified");
    expect(groups[1]).not.toHaveTextContent("No codebase recorded");
    expect(groups[1]!.textContent).not.toMatch(/held|pending/);
  });

  it("names each codebase-less cause, so a capture gap never reads like a run worktree", async () => {
    // Two codebase-less groups are siblings with no repo to key on, so React
    // sees one identity unless the cause distinguishes them, and a viewer's
    // open drawer follows the wrong group home across a refetch.
    const consoleError = vi.spyOn(console, "error");
    const person = await signIn(clientFor({
      agentShifts: vi.fn().mockResolvedValue({
        ...agentShiftsResponse,
        groups: [
          { ...agentShiftsResponse.groups[1], groupKey: "null:no-working-directory", nullCause: "no-working-directory" },
          // An API that names no cause keeps the original wording.
          { ...agentShiftsResponse.groups[1], groupKey: "null:none", nullCause: undefined },
        ],
      }),
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));

    const groups = within(await screen.findByTestId("agent-shifts")).getAllByTestId("shift-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent("No working directory recorded");
    expect(groups[1]).toHaveTextContent("No codebase recorded");
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    consoleError.mockRestore();
  });

  it("emits the repo row the layout suite styles, six cells to a row", async () => {
    // tests/browser/harness.ts hand-writes this markup to measure it in a real
    // browser, because jsdom has no layout engine. That only holds while the
    // app really does emit these classes, so this is the pin between the two.
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    const heads = (await within(await screen.findByTestId("agent-shifts")).findAllByTestId("shift-group"))
      .map((group) => group.querySelector(".shift-group-head"));

    for (const head of heads) {
      expect(head).not.toBeNull();
      expect(head!).toHaveClass("tv-row");
      expect(head!.children).toHaveLength(6);
      // The drawer's own contract, and the reason the count above must stay
      // six: the head is the `summary` and it is the `details`' first child.
      // jsdom only treats the first `summary` as the toggle, so a wrapper
      // would silently disable opening in tests while still working in
      // Chromium, and a seventh cell would wrap the six-track grid.
      expect(head!.tagName).toBe("SUMMARY");
      expect(head!.parentElement!.tagName).toBe("DETAILS");
      expect(head!.parentElement!.firstElementChild).toBe(head);
    }
  });

  it("opens on a board of the people whose agents ran, heaviest first", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    const board = within(await screen.findByTestId("agent-people"));

    const rows = board.getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Alex"),
      expect.stringContaining("Sam"),
    ]);
    // Two measures, and the shift count is the one that says a row can be
    // several agents at once rather than one worker's long day.
    expect(rows[0]).toHaveTextContent("1h 30m");
    expect(rows[0]).toHaveTextContent("2 shifts");
    expect(rows[1]).toHaveTextContent("1 shift");
    expect(rows.every((row) => row.getAttribute("aria-pressed") === "false")).toBe(true);
    // No bar, deliberately: the board is computed before the filter, so a
    // person's seconds over the filtered total would read past 100%. This
    // asserts the omission, because adding one back would otherwise pass
    // every suite silently.
    expect(rows.every((row) => row.querySelector(".meter-bar") === null)).toBe(true);
  });

  it("shows who is running an agent right now, with the server's own description", async () => {
    const person = await signIn(clientFor({
      liveAgentSessions: vi.fn().mockResolvedValue({
        people: [
          {
            owner: { id: "u2", name: "Alex" },
            sessions: [
              { id: "00000000-0000-4000-8000-000000000701", source: "claude_code", repo: "siqshift", description: "Claude Code in siqshift, running 12m" },
              { id: "00000000-0000-4000-8000-000000000702", source: "pi", repo: null, description: "Pi on deepseek-v4-pro in no codebase recorded, running 3h 5m" },
            ],
          },
          {
            owner: { id: "u3", name: "Sam" },
            sessions: [
              { id: "00000000-0000-4000-8000-000000000703", source: "codex", repo: "quartermaster", description: "Codex in quartermaster, running 45s" },
              { id: "00000000-0000-4000-8000-000000000704", source: "codex", repo: "siqshift", description: "Codex in siqshift, running 12m" },
            ],
          },
        ],
      }),
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));

    const live = await screen.findByTestId("live-sessions");
    // The description renders verbatim, never re-derived: every clause is a
    // captured fact, and the codebase label rides beside it.
    expect(live).toHaveTextContent("Claude Code in siqshift, running 12m");
    expect(live).toHaveTextContent("Pi on deepseek-v4-pro in no codebase recorded, running 3h 5m");
    expect(live).toHaveTextContent("siqshift");
    expect(live).toHaveTextContent("Sam");
    expect(live).toHaveTextContent("Codex in quartermaster, running 45s");
    expect(live).toHaveTextContent("quartermaster");
    expect(live).toHaveTextContent("Codex in siqshift, running 12m");
    expect(within(live).getAllByText(/Codex in (quartermaster|siqshift)/)).toHaveLength(2);
  });

  it("narrows the live view to whoever is picked, with an honest empty state", async () => {
    const person = await signIn(clientFor({
      liveAgentSessions: vi.fn().mockResolvedValue({
        people: [
          {
            owner: { id: "u2", name: "Alex" },
            sessions: [
              { id: "00000000-0000-4000-8000-000000000704", source: "claude_code", repo: "siqshift", description: "Claude Code in siqshift, running 12m" },
            ],
          },
        ],
      }),
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    await screen.findByTestId("live-sessions");
    // Sam has no live session, so picking him reads as "nobody", never as
    // Alex's rows filed under the wrong name.
    await person.click(within(screen.getByTestId("agent-people")).getByRole("button", { name: /Sam/ }));
    expect(await screen.findByTestId("live-sessions-empty")).toHaveTextContent("No agent is running right now.");
  });

  it("keeps the way out of a filter even when the filtered request fails", async () => {
    const agentShifts = vi.fn()
      .mockResolvedValueOnce(agentShiftsResponse)
      .mockRejectedValue(new Error("nope"));
    const person = await signIn(clientFor({ agentShifts }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    await person.click(within(await screen.findByTestId("agent-people")).getByRole("button", { name: /Sam/ }));

    // The failure is reported, but "All people" outlives it: without it a
    // deterministically failing filter would strand the tab with no control
    // to clear the filter that is causing the failure.
    expect(await screen.findByText("Could not load the shifts for this range.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All people" })).toBeInTheDocument();
  });

  it("narrows the tab to whoever is picked on the board, and offers a way back", async () => {
    // Echoes the filter the way the API does, so the heading and the numbers
    // under it are read from the same response rather than from the click.
    const agentShifts = vi.fn().mockImplementation((query: string = "") => {
      const userId = new URLSearchParams(query.replace(/^\?/, "")).get("userId");
      return Promise.resolve(userId === null ? agentShiftsResponse : {
        ...agentShiftsResponse,
        filters: { userId },
        totalAgentSeconds: 1_800,
        groups: [agentShiftsResponse.groups[1]!],
      });
    });
    const person = await signIn(clientFor({ agentShifts }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    await screen.findByTestId("agent-people");
    const before = agentShifts.mock.calls.length;

    await person.click(within(screen.getByTestId("agent-people")).getByRole("button", { name: /Sam/ }));

    await waitFor(() => expect(agentShifts.mock.calls.length).toBeGreaterThan(before));
    const query = new URLSearchParams((agentShifts.mock.calls.at(-1)?.[0] as string).replace(/^\?/, ""));
    expect(query.get("userId")).toBe("u3");
    // The heading names who the tab is narrowed to, over that person's own
    // total, and the board that picked them is still there to unpick them with.
    expect(await screen.findByRole("heading", { level: 4, name: "People · Sam" })).toBeInTheDocument();
    expect(teamTotal(stats, "Agent time")).toHaveTextContent(/^30m$/);
    expect(within(screen.getByTestId("agent-people")).getAllByRole("button")).toHaveLength(2);

    await person.click(screen.getByRole("button", { name: "All people" }));

    await waitFor(() => {
      const latest = new URLSearchParams((agentShifts.mock.calls.at(-1)?.[0] as string).replace(/^\?/, ""));
      expect(latest.has("userId")).toBe(false);
    });
    expect(await screen.findByRole("heading", { level: 4, name: "People" })).toBeInTheDocument();
  });

  it("shows no board when one person's agents did all the work", async () => {
    const soloResponse = { ...agentShiftsResponse, people: [agentShiftsResponse.people[0]!] };
    const person = await signIn(clientFor({ agentShifts: vi.fn().mockResolvedValue(soloResponse) }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    await screen.findByTestId("agent-shifts");

    // A board of one ranks nothing and filters nothing.
    expect(screen.queryByTestId("agent-people")).not.toBeInTheDocument();
  });

  it("keeps each codebase's shifts in a drawer that starts closed", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    const group = within(await screen.findByTestId("agent-shifts")).getAllByTestId("shift-group")[0]!;

    // Never a visibility assertion here: jsdom has no rule hiding a closed
    // `details`, so the rows are in the document either way. The browser
    // suite is where the hiding itself is checked.
    expect(group).not.toHaveAttribute("open");
    // The head carries the count, so a closed drawer still says how much is
    // inside it.
    expect(group).toHaveTextContent("2 shifts");

    await person.click(group.querySelector("summary")!);

    expect(group).toHaveAttribute("open");
  });

  it("gives each codebase a board row: its rank, a mark, the name, its tokens and its agent time", async () => {
    // Arrange
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const stats = await openAllStats(person);

    // Act
    await person.click(agentsTab(stats));
    const groups = await within(await screen.findByTestId("agent-shifts")).findAllByTestId("shift-group");

    // Assert: the head reads on the People board's columns, so the two pages
    // scan alike. An API that sends no tokens gets a dash, never a zero.
    const cells = groups.map((group) => [...group.querySelector("summary.shift-group-head")?.children ?? []].map((cell) => cell.textContent));
    expect(cells).toEqual([
      ["1", "S", "siqshift50% held · 2 shifts", "-", "1h 30m", ""],
      ["2", "?", "Run worktree, codebase not identified1 shift", "-", "30m", ""],
    ]);
  });

  it("ranks the codebases and the agents by tokens when the server sends them, in short form", async () => {
    // Arrange: the label-less group burned the most, and still comes last.
    const ledger = { groupKey: "ledger", repo: "ledger", agentSeconds: 600, shiftCount: 1, heldRate: null, tokens: 900_000 };
    const person = await signIn(clientFor({
      agentShifts: vi.fn().mockResolvedValue({
        ...agentShiftsResponse,
        tokenTotals: { tokensIn: 900_000, tokensOut: 300_000, tokens: 1_200_000 },
        groups: [
          { ...agentShiftsResponse.groups[0]!, tokens: 50_000 },
          { ...agentShiftsResponse.groups[1]!, tokens: 2_000_000 },
          ledger,
        ],
        runtimes: [
          { source: "claude_code", agentSeconds: 5_400, shiftCount: 2, tokens: 300_000 },
          { source: "pi", agentSeconds: 1_800, shiftCount: 1, tokens: 950 },
        ],
      }),
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });
    const stats = await openAllStats(person);

    // Act
    await person.click(agentsTab(stats));
    const panel = within(await screen.findByTestId("agent-shifts"));
    await panel.findByLabelText("Totals");

    // Assert
    expect(teamTotal(panel, "Tokens")).toHaveTextContent(/^1.2M$/);
    expect(within(panel.getByLabelText("Totals")).getByText("900k in · 300k out")).toBeInTheDocument();
    const repos = panel.getAllByTestId("shift-group").map((group) => group.querySelector(".tv-name > span")?.textContent);
    expect(repos).toEqual(["ledger", "siqshift", "Run worktree, codebase not identified"]);
    expect(panel.getAllByTestId("shift-group")[0]!.querySelector(".tv-num")).toHaveAttribute("title", "900,000 tokens");
    const agents = within(panel.getByRole("region", { name: "Agents" })).getAllByRole("listitem");
    expect(agents.map((row) => row.textContent)).toEqual(["Claude Code2 shifts300k1h 30m", "Pi1 shift95030m"]);
  });

  it("shows no hourly graph on all time, keeping the groups and total", async () => {
    vi.setSystemTime(new Date("2026-08-06T20:00:00.000Z"));
    try {
      const person = await signIn(clientFor());
      await screen.findByRole("heading", { name: "Lumen Studio" });

      const stats = await openAllStats(person);
      await person.click(agentsTab(stats));
      const panel = within(await screen.findByTestId("agent-shifts"));
      // A bounded range folds an hourly line from the shifts on screen.
      expect(panel.getByTestId("hourly-graph")).toBeInTheDocument();

      await person.click(stats.getByRole("button", { name: "All time" }));

      // Per-hour resolution over an unbounded range is meaningless, so the graph
      // goes away - but the codebase map and its total stay put.
      await waitFor(() => expect(panel.queryByTestId("hourly-graph")).not.toBeInTheDocument());
      expect(panel.getByText("2h 00m")).toBeInTheDocument();
      expect(panel.getAllByTestId("shift-group")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each shift its own line: when, who, what model, what commits", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));

    const panel = within(await screen.findByTestId("agent-shifts"));
    const group = panel.getAllByTestId("shift-group")[0]!;
    // The rows are not in the response that drew the head: opening the drawer
    // is what asks for them.
    await person.click(group.querySelector("summary")!);

    await waitFor(() => expect(within(group).getAllByRole("listitem")).toHaveLength(2));
    const rows = within(group).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Claude Code");
    expect(rows[0]).toHaveTextContent("Alex");
    expect(rows[0]).toHaveTextContent("claude-opus-5");
    expect(rows[0]).toHaveTextContent("2 commits");
    // A shift that named no model says nothing - absence is absence.
    expect(rows[1]!.textContent).not.toMatch(/not recorded/);
  });

  it("asks for a group's shifts only when its drawer opens, under the filters the head was totalled with", async () => {
    const agentShiftRows = vi.fn().mockImplementation((query: string = "") => Promise.resolve(agentShiftRowsFor(query)));
    const person = await signIn(clientFor({ agentShiftRows }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    const panel = within(await screen.findByTestId("agent-shifts"));

    // The whole point of the change: drawing the heads costs no rows at all.
    expect(agentShiftRows).not.toHaveBeenCalled();

    await person.click(panel.getAllByTestId("shift-group")[0]!.querySelector("summary")!);

    await waitFor(() => expect(agentShiftRows).toHaveBeenCalledTimes(1));
    const asked = new URLSearchParams((agentShiftRows.mock.calls[0]?.[0] as string).replace(/^\?/, ""));
    expect(asked.get("groupKey")).toBe("siqshift");
    // The first page names no cursor at all: there is no row to start after.
    expect(asked.has("afterStartedAt")).toBe(false);
    expect(asked.has("afterId")).toBe(false);
    // Same selection the head was totalled under, or a drawer lists shifts its
    // own head never counted.
    expect(asked.has("fromAt")).toBe(true);
    expect(asked.has("toExclusiveAt")).toBe(true);
  });

  it("pages a long drawer rather than pulling the whole group at once", async () => {
    const agentShiftRows = vi.fn().mockImplementation((query: string = "") => Promise.resolve(agentShiftRowsFor(query, 1)));
    const person = await signIn(clientFor({ agentShiftRows }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    const panel = within(await screen.findByTestId("agent-shifts"));
    const group = panel.getAllByTestId("shift-group")[0]!;
    await person.click(group.querySelector("summary")!);

    // One row of two, and the drawer offers the rest.
    await person.click(await within(group).findByRole("button", { name: "Show more" }));

    await waitFor(() => expect(within(group).getAllByRole("listitem")).toHaveLength(2));
    const asked = new URLSearchParams((agentShiftRows.mock.calls.at(-1)?.[0] as string).replace(/^\?/, ""));
    // The second page starts after the row the first one ended on, named by
    // the pair the rows are ordered by rather than by a position in the list.
    expect(asked.get("afterId")).toBe("00000000-0000-4000-8000-000000000601");
    expect(asked.get("afterStartedAt")).toBe("2026-08-06T15:00:00.000Z");
    // Exhausted, so the control retires rather than asking for an empty page.
    expect(within(group).queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("neither repeats nor drops a shift when a newer one lands between two page reads", async () => {
    // The case an offset cannot survive: the server re-sorts the group on every
    // read, so a shift arriving at the head moves every row below it down by
    // one. A cursor names a shift rather than a position, so the second page
    // still starts below the row the drawer already holds.
    const started = {
      id: "00000000-0000-4000-8000-000000000600",
      source: "claude_code",
      owner: { id: "u2", name: "Alex" },
      model: "claude-sonnet-5",
      startedAt: "2026-08-06T17:00:00.000Z",
      endedAt: "2026-08-06T17:30:00.000Z",
      agentSeconds: 1_800,
      commitCount: 0,
    };
    const settled = agentShiftRowsByGroup.siqshift!;
    let all: readonly Record<string, unknown>[] = settled;
    const agentShiftRows = vi.fn().mockImplementation((query: string = "") => {
      const params = new URLSearchParams(query.replace(/^\?/, ""));
      const serving = params.get("groupKey") === "siqshift" ? all : [];
      all = [started, ...settled];
      const afterId = params.get("afterId");
      const start = afterId === null ? 0 : serving.findIndex((row) => row.id === afterId) + 1;
      const shifts = serving.slice(start, start + 1);
      const last = shifts.at(-1);
      return Promise.resolve({
        filters: {},
        shifts,
        nextCursor: last === undefined || start + shifts.length >= serving.length
          ? null
          : { startedAt: last.startedAt, id: last.id },
      });
    });
    const person = await signIn(clientFor({ agentShiftRows }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    const panel = within(await screen.findByTestId("agent-shifts"));
    const group = panel.getAllByTestId("shift-group")[0]!;
    await person.click(group.querySelector("summary")!);

    await person.click(await within(group).findByRole("button", { name: "Show more" }));

    // Two distinct shifts in order - an offset would have served the first one
    // twice and never reached the second. The newer arrival is above both, so
    // paging down cannot reach it; reopening the drawer is what shows it.
    await waitFor(() => expect(group.querySelectorAll(".shift-row .shift-when")).toHaveLength(2));
    expect([...group.querySelectorAll(".shift-facts")].map((row) => row.textContent))
      .toEqual(["Claude Code · Alex · claude-opus-5 · 2 commits", "Claude Code · Alex"]);
    // Spent, so the control retires rather than sitting there asking again for
    // a row the drawer already holds.
    expect(within(group).queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("says so inside the drawer when a page fails, and asks again on the next open", async () => {
    // Deliberately not a retry on a timer: a failing page that re-fetches
    // itself would hammer the endpoint this whole split exists to quieten. The
    // reader reopening the drawer is the retry.
    const agentShiftRows = vi.fn()
      .mockRejectedValueOnce(new Error("nope"))
      .mockImplementation((query: string = "") => Promise.resolve(agentShiftRowsFor(query)));
    const person = await signIn(clientFor({ agentShiftRows }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));
    const panel = within(await screen.findByTestId("agent-shifts"));
    const group = panel.getAllByTestId("shift-group")[0]!;
    const head = group.querySelector("summary")!;
    await person.click(head);

    expect(await within(group).findByRole("alert")).toHaveTextContent("These shifts could not be loaded.");
    // The head is read from the aggregate, so a failed drawer cannot empty it.
    expect(group).toHaveTextContent("2 shifts");
    expect(group).toHaveTextContent("50% held");

    await person.click(head);
    await person.click(head);

    await waitFor(() => expect(within(group).getAllByRole("listitem")).toHaveLength(2));
    expect(within(group).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says nobody worked rather than rendering an empty map", async () => {
    const person = await signIn(clientFor({
      agentShifts: vi.fn().mockResolvedValue({ filters: {}, totalAgentSeconds: 0, people: [], hourly: [], groups: [] }),
    }));
    await screen.findByRole("heading", { name: "Lumen Studio" });

    const stats = await openAllStats(person);
    await person.click(agentsTab(stats));

    expect(await screen.findByText("No agent worked in this range.")).toBeInTheDocument();
  });
});

/// The leading bytes of a JPEG, which is all the picture checks read.
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
const JPEG_DATA_URL = `data:image/jpeg;base64,${btoa(String.fromCharCode(...JPEG_BYTES))}`;
const PICTURE_VERSION = "0123456789abcdef";

const jpegFile = (): File => new File([new Uint8Array(JPEG_BYTES)], "me.jpg", { type: "image/jpeg" });

/// The team view with Sam wearing a picture.
const reportWithSamsPicture = {
  ...workspaceReport,
  members: teamMembers.map((member) => (
    member.user.id === "u1" ? { ...member, user: { ...member.user, pictureVersion: PICTURE_VERSION } } : member
  )),
};

/// Opens settings and unfolds its Profile picture group, returning the group.
async function openPictureGroup(person: Person) {
  const summary = (await openSettings(person)).getByText("Profile picture");
  await person.click(summary);
  const group = summary.closest("details");
  if (group === null) throw new Error("The Profile picture summary is outside its group.");
  return group;
}

/// Opens the sign-up form, picks a picture first, then fills and sends it.
async function signUpWithPicture(person: Person) {
  await person.click((await screen.findAllByRole("button", { name: "Create account" }))[0]!);
  await person.upload(screen.getByLabelText("Add a picture"), jpegFile());
  await screen.findByLabelText("Change picture");
  await person.type(screen.getByLabelText("Name"), "Alex Morgan");
  await person.type(screen.getByLabelText("Email"), "alex@example.com");
  await person.type(screen.getByLabelText("Password"), "long-enough-password");
  await person.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create account" }));
}

describe("profile pictures", () => {
  // jsdom draws nothing, so the crop runs on stand-ins: any picture opens as
  // 400 by 300, and the canvas hands back the small JPEG above.
  let restoreDrawing = (): void => undefined;
  beforeEach(() => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 400, height: 300, close: vi.fn() })));
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation((callback) => callback(new Blob([new Uint8Array(JPEG_BYTES)], { type: "image/jpeg" })));
    restoreDrawing = () => {
      getContext.mockRestore();
      toBlob.mockRestore();
      vi.unstubAllGlobals();
    };
  });
  afterEach(() => restoreDrawing());

  it("shows a teammate's picture on the board and their card, read once, with initials for anyone without one", async () => {
    // Arrange
    const memberPicture = vi.fn().mockResolvedValue(new Uint8Array(JPEG_BYTES));
    const person = await signIn(clientFor({ memberPicture, workspace: vi.fn().mockResolvedValue(reportWithSamsPicture) }));

    // Act
    const stats = await openAllStats(person);
    const [, samRow, ownRow] = within(await stats.findByRole("table", { name: "People" })).getAllByRole("row");
    await person.click(stats.getByRole("button", { name: /Sam/ }));

    // Assert
    await waitFor(() => expect(samRow?.querySelector("img.member-avatar")).toHaveAttribute("src", JPEG_DATA_URL));
    expect(ownRow?.querySelector(".member-avatar")).toHaveTextContent(/^A$/);
    const card = stats.getByTestId("member-stats");
    await waitFor(() => expect(card.querySelector("h4 img.member-avatar")).toHaveAttribute("src", JPEG_DATA_URL));
    expect(memberPicture).toHaveBeenCalledTimes(1);
    expect(memberPicture).toHaveBeenCalledWith("u1", PICTURE_VERSION);
  });

  it("keeps a teammate's initials when their picture cannot be read", async () => {
    // Arrange
    const memberPicture = vi.fn().mockRejectedValue(new ClientError("transient", "Cannot reach the server."));
    const person = await signIn(clientFor({ memberPicture, workspace: vi.fn().mockResolvedValue(reportWithSamsPicture) }));

    // Act
    const stats = await openAllStats(person);
    const [, samRow] = within(await stats.findByRole("table", { name: "People" })).getAllByRole("row");
    await waitFor(() => expect(memberPicture).toHaveBeenCalled());

    // Assert
    expect(samRow?.querySelector(".member-avatar")).toHaveTextContent(/^S$/);
    expect(samRow?.querySelector("img")).toBeNull();
  });

  it("asks again for a picture whose read failed at the next refresh, and shows it once it arrives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Arrange: the first read meets a server that is briefly out of reach.
      const memberPicture = vi.fn()
        .mockRejectedValueOnce(new ClientError("transient", "Cannot reach the server."))
        .mockResolvedValue(new Uint8Array(JPEG_BYTES));
      const person = await signIn(clientFor({ memberPicture, workspace: vi.fn().mockResolvedValue(reportWithSamsPicture) }));
      const stats = await openAllStats(person);
      const [, samRow] = within(await stats.findByRole("table", { name: "People" })).getAllByRole("row");
      await waitFor(() => expect(memberPicture).toHaveBeenCalledTimes(1));

      // Act: the page's next refresh.
      await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS);

      // Assert
      await waitFor(() => expect(samRow?.querySelector("img.member-avatar")).toHaveAttribute("src", JPEG_DATA_URL));
      expect(memberPicture).toHaveBeenCalledTimes(2);
      expect(memberPicture).toHaveBeenLastCalledWith("u1", PICTURE_VERSION);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "put up", before: null, after: PICTURE_VERSION, control: "Change picture", removeButtons: 1 },
    { label: "taken down", before: PICTURE_VERSION, after: null, control: "Add a picture", removeButtons: 0 },
  ])("shows in settings a picture $label from another device since the page loaded", async ({ before, after, control, removeButtons }) => {
    // Arrange: /me answers the page's load before the change, and every read after it.
    const person = await signIn(clientFor({
      me: vi.fn()
        .mockResolvedValueOnce({ user: { ...self, pictureVersion: before } })
        .mockResolvedValue({ user: { ...self, pictureVersion: after } }),
      memberPicture: vi.fn().mockResolvedValue(new Uint8Array(JPEG_BYTES)),
    }));

    // Act
    const group = within(await openPictureGroup(person));

    // Assert
    expect(await group.findByLabelText(control)).toBeInTheDocument();
    expect(group.queryAllByRole("button", { name: "Remove" })).toHaveLength(removeButtons);
  });

  it("puts up the picture a member picks in settings as a small square and shows it as theirs", async () => {
    // Arrange: /me names whatever picture the server holds.
    let held: string | null = null;
    const uploadPicture = vi.fn().mockImplementation(async () => {
      held = PICTURE_VERSION;
      return { user: { ...self, pictureVersion: PICTURE_VERSION } };
    });
    const memberPicture = vi.fn().mockResolvedValue(new Uint8Array(JPEG_BYTES));
    const person = await signIn(clientFor({
      uploadPicture,
      memberPicture,
      me: vi.fn().mockImplementation(async () => ({ user: { ...self, pictureVersion: held } })),
    }));
    const group = within(await openPictureGroup(person));

    // Act
    await person.upload(group.getByLabelText("Add a picture"), jpegFile());

    // Assert
    await waitFor(() => expect(uploadPicture).toHaveBeenCalledWith(new Uint8Array(JPEG_BYTES)));
    expect(await group.findByLabelText("Change picture")).toBeInTheDocument();
    expect(group.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    await waitFor(() => expect(memberPicture).toHaveBeenCalledWith(self.id, PICTURE_VERSION));
  });

  it.each([
    ["a text file", new File(["not a picture"], "notes.txt", { type: "text/plain" })],
    ["a file named as a JPEG whose bytes are not one", new File(["not a picture"], "me.jpg", { type: "image/jpeg" })],
  ])("refuses %s before sending anything", async (_case, file) => {
    // Arrange: a person can pick any file once the dialog shows all files.
    const uploadPicture = vi.fn();
    const person = await signIn(clientFor({ uploadPicture }), userEvent.setup({ applyAccept: false }));
    const group = within(await openPictureGroup(person));

    // Act
    await person.upload(group.getByLabelText("Add a picture"), file);

    // Assert
    expect(await screen.findByText("Pick a JPG, PNG or WebP picture.")).toHaveAttribute("role", "alert");
    expect(uploadPicture).not.toHaveBeenCalled();
  });

  it("says why a picture could not be put up and keeps the field as it was", async () => {
    // Arrange
    const uploadPicture = vi.fn().mockRejectedValue(new ClientError("transient", "The server is unavailable. Try again shortly."));
    const person = await signIn(clientFor({ uploadPicture }));
    const group = within(await openPictureGroup(person));

    // Act
    await person.upload(group.getByLabelText("Add a picture"), jpegFile());

    // Assert
    expect(await screen.findByText("The server is unavailable. Try again shortly.")).toHaveAttribute("role", "alert");
    await waitFor(() => expect(group.getByLabelText("Add a picture")).toBeEnabled());
    expect(group.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("takes the member's picture down and shows their initials again", async () => {
    // Arrange: /me names whatever picture the server holds.
    let held: string | null = PICTURE_VERSION;
    const removePicture = vi.fn().mockImplementation(async () => {
      held = null;
      return { user: { ...self, pictureVersion: null } };
    });
    const person = await signIn(clientFor({
      me: vi.fn().mockImplementation(async () => ({ user: { ...self, pictureVersion: held } })),
      memberPicture: vi.fn().mockResolvedValue(new Uint8Array(JPEG_BYTES)),
      removePicture,
    }));
    const group = await openPictureGroup(person);
    await waitFor(() => expect(group.querySelector("img.member-avatar")).toHaveAttribute("src", JPEG_DATA_URL));

    // Act
    await person.click(within(group).getByRole("button", { name: "Remove" }));

    // Assert
    expect(await within(group).findByLabelText("Add a picture")).toBeInTheDocument();
    expect(removePicture).toHaveBeenCalledTimes(1);
    expect(group.querySelector(".member-avatar")).toHaveTextContent(/^A$/);
  });

  it("puts up the picture picked at sign-up once the account exists", async () => {
    // Arrange
    const signUp = vi.fn().mockResolvedValue(undefined);
    const uploadPicture = vi.fn().mockResolvedValue({ user: { ...self, pictureVersion: PICTURE_VERSION } });
    const person = userEvent.setup();
    render(<App client={clientFor({ signUp, uploadPicture })} />);

    // Act
    await signUpWithPicture(person);

    // Assert
    expect(await screen.findByRole("heading", { name: /the app/i })).toBeInTheDocument();
    expect(uploadPicture).toHaveBeenCalledWith(new Uint8Array(JPEG_BYTES));
    expect(signUp.mock.invocationCallOrder[0]).toBeLessThan(uploadPicture.mock.invocationCallOrder[0] ?? 0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the new account and says so when the sign-up picture does not go up", async () => {
    // Arrange
    const uploadPicture = vi.fn().mockRejectedValue(new ClientError("transient", "The server is unavailable. Try again shortly."));
    const person = userEvent.setup();
    render(<App client={clientFor({ uploadPicture })} />);

    // Act
    await signUpWithPicture(person);

    // Assert
    expect(await screen.findByRole("heading", { name: /the app/i })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your picture did not upload: The server is unavailable. Try again shortly. Add it again in settings.",
    );
  });
});
