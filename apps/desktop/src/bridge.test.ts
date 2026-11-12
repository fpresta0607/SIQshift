import { defaultBridge } from "./bridge.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { describe, expect, it, vi } from "vitest";

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  project: "00000000-0000-4000-8000-000000000010",
  other: "00000000-0000-4000-8000-000000000011",
};

describe("defaultBridge", () => {
  it("rejects malformed account kinds and projects as unknown bridge errors", async () => {
    invoke.mockResolvedValueOnce({ kind: "unexpected" });

    await expect(defaultBridge.bootstrap()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({
      kind: "ready",
      user: { id: ids.user, email: "timer@example.com", name: "Timer" },
      projects: [{ id: ids.project, name: "Field work", color: 42 }],
      defaultProjectId: ids.project,
      selectedProjectId: null,
    });

    await expect(defaultBridge.bootstrap()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("decodes the signed-in account with where its time lands", async () => {
    invoke.mockResolvedValueOnce({
      kind: "ready",
      user: { id: ids.user, email: "timer@example.com", name: "Timer" },
      projects: [{ id: ids.project, name: "Field work", color: null }],
      defaultProjectId: ids.project,
      selectedProjectId: ids.other,
    });

    await expect(defaultBridge.bootstrap()).resolves.toEqual({
      kind: "ready",
      user: { id: ids.user, email: "timer@example.com", name: "Timer" },
      projects: [{ id: ids.project, name: "Field work", color: null }],
      defaultProjectId: ids.project,
      selectedProjectId: ids.other,
    });
  });

  const statusPayload = {
    enabled: true,
    running: true,
    observing: true,
    lastPollAgeSeconds: 12,
    lastUploadAt: "2026-08-06T15:00:00.000Z",
    segmentBacklog: 3,
    agentBacklog: 1,
    sessionBacklog: 2,
    hooks: [{ source: "claude_code", detected: true, installed: true, needsYou: false, configPath: "C:/Users/dev/.claude/settings.json" }],
    agentActive: { source: "kimi_code", since: "2026-08-06T14:40:00.000Z" },
    currentSession: {
      projectId: ids.project,
      attribution: "agent",
      since: "2026-08-06T14:30:00.000Z",
      idleSeconds: 120,
    apps: [],
    },
    openSpan: { processName: "WindowsTerminal.exe", since: "2026-08-06T14:58:00.000Z" },
    agentSessions: [],
    selectedProjectId: null,
  };

  it("decodes the monitor status payload and rejects malformed shapes", async () => {
    invoke.mockResolvedValueOnce(statusPayload);

    await expect(defaultBridge.monitorStatus()).resolves.toEqual(statusPayload);

    invoke.mockResolvedValueOnce({ ...statusPayload, hooks: "nope" });
    await expect(defaultBridge.monitorStatus()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({
      ...statusPayload,
      currentSession: { ...statusPayload.currentSession, attribution: "manual" },
    });
    await expect(defaultBridge.monitorStatus()).rejects.toMatchObject(
      { kind: "unknown" },
    );

    invoke.mockResolvedValueOnce({ ...statusPayload, sessionBacklog: -1 });
    await expect(defaultBridge.monitorStatus()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("pins a project and clears the pin with an explicit null", async () => {
    invoke.mockResolvedValueOnce({ ...statusPayload, selectedProjectId: ids.project });
    await expect(defaultBridge.sessionSelectProject(ids.project)).resolves.toMatchObject({
      selectedProjectId: ids.project,
    });
    expect(invoke).toHaveBeenLastCalledWith("session_select_project", { projectId: ids.project });

    invoke.mockResolvedValueOnce(statusPayload);
    await defaultBridge.sessionSelectProject(null);
    expect(invoke).toHaveBeenLastCalledWith("session_select_project", { projectId: null });
  });

  it("decodes the hook registration outcomes and rejects unknown statuses", async () => {
    invoke.mockResolvedValueOnce({ status: "registered", configPath: "C:/Users/dev/.claude/settings.json" });
    await expect(defaultBridge.hookRegister("claude_code")).resolves.toEqual({
      status: "registered",
      configPath: "C:/Users/dev/.claude/settings.json",
    });

    invoke.mockResolvedValueOnce({
      status: "manual",
      configPath: "C:/Users/dev/.codex/config.toml",
      snippet: "notify = [\"siqshift-hook\"]",
    });
    await expect(defaultBridge.hookRegister("codex")).resolves.toMatchObject({ status: "manual" });

    invoke.mockResolvedValueOnce({ status: "sideways", configPath: "C:/Users/dev/.codex/config.toml" });
    await expect(defaultBridge.hookRegister("codex")).rejects.toMatchObject({ kind: "unknown" });
  });

  it("round-trips settings and switches recording with a plain boolean", async () => {
    const settings = {
      enabled: true,
      awayThresholdMinutes: 10,
      agentOverrideEnabled: true,
      browserAutoInstall: true,
      agentUsageCapture: true,
      deviceId: "00000000-0000-4000-8000-000000000300",
    };
    invoke.mockResolvedValueOnce(settings);
    await expect(defaultBridge.settingsGet()).resolves.toEqual(settings);

    invoke.mockResolvedValueOnce({ ...settings, enabled: false });
    await expect(defaultBridge.monitorSetEnabled(false)).resolves.toMatchObject({ enabled: false });
    expect(invoke).toHaveBeenLastCalledWith("monitor_set_enabled", { enabled: false });

    invoke.mockResolvedValueOnce({ ...settings, awayThresholdMinutes: "ten" });
    await expect(defaultBridge.settingsGet()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("sends only the provided stats filters and validates the attributed split", async () => {
    const stats = {
      filters: { from: "2026-08-06" },
      totalDurationSeconds: 7_200,
      attributedSeconds: 5_400,
      unattributedSeconds: 1_800,
      projects: [{
        project: { id: ids.project, name: "Field work" },
        durationSeconds: 7_200,
        attributedSeconds: 5_400,
        unattributedSeconds: 1_800,
        sessionCount: 3,
      }],
      apps: [{ processName: "Code.exe", durationSeconds: 4_800 }],
      activeSeconds: 7_000,
      agentSeconds: 3_600,
      concurrency: { t0Seconds: 3_400, t1Seconds: 3_600, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
      byAgent: [{ source: "claude_code", model: null, durationSeconds: 3_600 }],
      hourly: [],
    };
    invoke.mockResolvedValueOnce(stats);

    // Instant bounds, not calendar dates: a bare date is read as a UTC day.
    const fromAt = "2026-08-06T05:00:00.000Z";
    const toExclusiveAt = "2026-08-07T05:00:00.000Z";
    await expect(defaultBridge.meStats(fromAt, toExclusiveAt)).resolves.toEqual(stats);
    expect(invoke).toHaveBeenLastCalledWith("me_stats", { fromAt, toExclusiveAt, userId: undefined });

    // Attributed time can never exceed the time it is part of.
    invoke.mockResolvedValueOnce({ ...stats, attributedSeconds: 9_000 });
    await expect(defaultBridge.meStats(fromAt, toExclusiveAt)).rejects.toMatchObject({ kind: "unknown" });
  });

  it("asks for a teammate's stats, and for all time, by leaving bounds off", async () => {
    const empty = {
      filters: {},
      totalDurationSeconds: 0,
      attributedSeconds: 0,
      unattributedSeconds: 0,
      activeSeconds: 0,
      agentSeconds: 0,
      concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
      byAgent: [],
      hourly: [],
      projects: [],
      apps: [],
    };
    invoke.mockResolvedValueOnce(empty);
    await expect(defaultBridge.meStats(undefined, undefined, ids.user)).resolves.toEqual(empty);
    expect(invoke).toHaveBeenLastCalledWith("me_stats", {
      fromAt: undefined,
      toExclusiveAt: undefined,
      userId: ids.user,
    });
  });

  it("tolerates a stats payload from an API that predates the hourly series", async () => {
    invoke.mockResolvedValueOnce({
      filters: {},
      totalDurationSeconds: 0,
      attributedSeconds: 0,
      unattributedSeconds: 0,
      activeSeconds: 0,
      agentSeconds: 0,
      concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
      byAgent: [{ source: "claude_code", model: null, durationSeconds: 0 }],
      projects: [],
      apps: [],
    });

    await expect(defaultBridge.meStats(undefined, undefined)).resolves.toMatchObject({
      hourly: [],
      byAgent: [{ source: "claude_code", model: null, durationSeconds: 0 }],
    });
  });

  it("decodes the token bars as the server sent them, and their absence as none", async () => {
    // Arrange
    const tokenChart = {
      bucketSeconds: 3_600,
      buckets: [{ start: "2026-08-06T15:00:00.000Z", tokensIn: 100, tokensOut: 50, tokens: 999 }],
      projects: [{
        project: { id: "00000000-0000-4000-8000-000000000010", name: "Ledger" },
        tokens: 0,
        buckets: [{ start: "2026-08-06T15:00:00.000Z", tokensIn: null, tokensOut: null, tokens: null }],
      }],
    };
    const negative = { ...tokenChart, buckets: [{ ...tokenChart.buckets[0]!, tokens: -1 }] };
    invoke
      .mockResolvedValueOnce({ groups: [], tokenChart })
      .mockResolvedValueOnce({ groups: [] })
      .mockResolvedValueOnce({ groups: [], tokenChart: negative });

    // Act
    const sent = await defaultBridge.agentShifts();
    const older = await defaultBridge.agentShifts();
    const broken = defaultBridge.agentShifts();

    // Assert: a total that is not in + out stays the server's.
    expect(sent.tokenChart).toEqual(tokenChart);
    expect(older.tokenChart).toBeUndefined();
    await expect(broken).rejects.toMatchObject({ kind: "unknown" });
  });

  it("decodes the shifts-by-codebase map, and reads absence as empty rather than a crash", async () => {
    invoke.mockResolvedValueOnce({
      totalAgentSeconds: 5_400,
      hourly: [{
        hourStart: "2026-08-06T15:00:00.000Z",
        activeSeconds: 0,
        agentSeconds: 5_400,
      }],
      groups: [{
        groupKey: "siqshift",
        repo: "siqshift",
        nullCause: null,
        agentSeconds: 5_400,
        shiftCount: 1,
        heldRate: 0.5,
      }],
    });
    await expect(defaultBridge.agentShifts("2026-08-01T00:00:00.000Z", "2026-08-08T00:00:00.000Z")).resolves.toMatchObject({
      totalAgentSeconds: 5_400,
      hourly: [{ hourStart: "2026-08-06T15:00:00.000Z", agentSeconds: 5_400 }],
      groups: [{ groupKey: "siqshift", repo: "siqshift", shiftCount: 1, heldRate: 0.5 }],
    });
    // The command name and argument keys are the seam between this bundle and
    // the Rust command Tauri registers: a typo on either side compiles fine
    // and leaves the tab on "Loading…" forever, so it is pinned here.
    expect(invoke).toHaveBeenLastCalledWith("agent_shifts", {
      fromAt: "2026-08-01T00:00:00.000Z",
      toExclusiveAt: "2026-08-08T00:00:00.000Z",
    });

    // An API older than this build sends no groups at all: an empty map, not
    // an error, is what keeps the tab alive across the deploy window.
    invoke.mockResolvedValueOnce({});
    await expect(defaultBridge.agentShifts()).resolves.toEqual({ totalAgentSeconds: 0, hourly: [], groups: [] });

    // A group with a label-less repo and no decided commit keeps both nulls.
    invoke.mockResolvedValueOnce({ groups: [{ repo: null, shifts: [] }] });
    const bare = await defaultBridge.agentShifts();
    expect(bare.groups[0]).toMatchObject({ repo: null, nullCause: null, heldRate: null, agentSeconds: 0 });

    // An API old enough to have sent the shifts inline names no group at all.
    // The host deserializes that absence into a String, so it reaches the
    // decoder as "" rather than as nothing - the shape the real transport can
    // actually emit. The drawer keys React and its open state on the result, so
    // every group still has to come back with its own: one shared key would
    // open them all on a single click.
    invoke.mockResolvedValueOnce({
      groups: [
        { groupKey: "", repo: "siqshift" },
        { groupKey: "", repo: null, nullCause: "no-working-directory" },
        { groupKey: "", repo: null, nullCause: "unidentified-run-directory" },
        { groupKey: "", repo: null },
      ],
    });
    const keyless = await defaultBridge.agentShifts();
    expect(keyless.groups.map((group) => group.groupKey)).toEqual([
      "siqshift",
      "null:no-working-directory",
      "null:unidentified-run-directory",
      "null:none",
    ]);
    // Two codebase-less groups are the case that collides if the key is not
    // rebuilt: they differ only by their cause, and both arrive keyless.
    expect(new Set(keyless.groups.slice(1, 3).map((group) => group.groupKey)).size).toBe(2);

    // The cause travels when a newer API sends it, and stays null when it does
    // not - absence keeps the old wording rather than inventing an answer.
    invoke.mockResolvedValueOnce({ groups: [{ repo: null, nullCause: "unidentified-run-directory" }] });
    const caused = await defaultBridge.agentShifts();
    expect(caused.groups[0]!.nullCause).toBe("unidentified-run-directory");
  });

  it("rejects a held rate outside [0, 1] rather than rendering a nonsense percent", async () => {
    invoke.mockResolvedValueOnce({ groups: [{ repo: "x", heldRate: 1.5 }] });
    await expect(defaultBridge.agentShifts()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("reads one group's page of shifts, and an absent cursor as a spent group", async () => {
    const cursor = { startedAt: "2026-08-06T15:00:00.000Z", id: "00000000-0000-4000-8000-000000000601" };
    invoke.mockResolvedValueOnce({
      shifts: [{
        id: "00000000-0000-4000-8000-000000000601",
        source: "claude_code",
        owner: { id: "00000000-0000-4000-8000-000000000001", name: "Alex" },
        model: "claude-opus-5",
        startedAt: "2026-08-06T15:00:00.000Z",
        endedAt: "2026-08-06T16:00:00.000Z",
        agentSeconds: 5_400,
        commitCount: 3,
      }],
      nextCursor: cursor,
    });
    await expect(
      defaultBridge.agentShiftRows("siqshift", null, "2026-08-01T00:00:00.000Z", "2026-08-08T00:00:00.000Z"),
    ).resolves.toMatchObject({
      shifts: [{ model: "claude-opus-5", commitCount: 3 }],
      nextCursor: cursor,
    });
    // The same seam as `agent_shifts`: a typo in the command name or an
    // argument key compiles fine and leaves every drawer empty. The first page
    // names no cursor, so both halves travel as undefined rather than as a
    // half cursor the API would refuse.
    expect(invoke).toHaveBeenLastCalledWith("agent_shift_rows", {
      groupKey: "siqshift",
      afterStartedAt: undefined,
      afterId: undefined,
      fromAt: "2026-08-01T00:00:00.000Z",
      toExclusiveAt: "2026-08-08T00:00:00.000Z",
    });

    // A cursor travels split across the two arguments the command takes.
    invoke.mockResolvedValueOnce({ shifts: [], nextCursor: null });
    await expect(defaultBridge.agentShiftRows("siqshift", cursor)).resolves.toEqual({ shifts: [], nextCursor: null });
    expect(invoke).toHaveBeenLastCalledWith("agent_shift_rows", {
      groupKey: "siqshift",
      afterStartedAt: cursor.startedAt,
      afterId: cursor.id,
      fromAt: undefined,
      toExclusiveAt: undefined,
    });

    // An API that has no such endpoint answers nothing useful; an empty drawer
    // beats a tab that dies decoding one.
    invoke.mockResolvedValueOnce({});
    await expect(defaultBridge.agentShiftRows("siqshift", null)).resolves.toEqual({ shifts: [], nextCursor: null });
  });

  it("round-trips the project tie on a shift row and its cursor, and reads absence as untied", async () => {
    const cursor = {
      startedAt: "2026-08-06T15:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000601",
      projectTied: true,
    };
    invoke.mockResolvedValueOnce({
      shifts: [{
        id: "00000000-0000-4000-8000-000000000601",
        source: "claude_code",
        owner: { id: "00000000-0000-4000-8000-000000000001", name: "Alex" },
        model: null,
        startedAt: "2026-08-06T15:00:00.000Z",
        endedAt: "2026-08-06T16:00:00.000Z",
        agentSeconds: 5_400,
        commitCount: 0,
        project: { id: "00000000-0000-4000-8000-000000000010", name: "Field work" },
      }],
      nextCursor: cursor,
    });
    const page = await defaultBridge.agentShiftRows("siqshift", null);
    // The tie reads off the row (the drawer prints the project's name) and the
    // cursor round-trips it, so the next page is cut under the same ordering.
    expect(page.shifts[0]).toMatchObject({ project: { name: "Field work" } });
    expect(page.nextCursor).toEqual(cursor);
    // The tie rides with the pair, as one value split across three arguments.
    expect(invoke).toHaveBeenLastCalledWith("agent_shift_rows", expect.objectContaining({
      afterStartedAt: undefined,
      afterId: undefined,
      projectTied: undefined,
    }));

    // Absence on an older API is untied, never a crash: the rows that were
    // ordered before the tie existed already sat in the untied partition.
    invoke.mockResolvedValueOnce({ shifts: [{
      id: "00000000-0000-4000-8000-000000000602",
      source: "pi",
      owner: { id: "00000000-0000-4000-8000-000000000001", name: "Alex" },
      model: null,
      startedAt: "2026-08-06T15:00:00.000Z",
      endedAt: "2026-08-06T16:00:00.000Z",
      agentSeconds: 1_800,
      commitCount: 0,
    }], nextCursor: null });
    const untied = await defaultBridge.agentShiftRows("siqshift", null);
    expect(untied.shifts[0]!.project).toBeNull();
  });

  it("decodes the live sessions read and pins the command name", async () => {
    invoke.mockResolvedValueOnce({
      people: [{
        owner: { id: "00000000-0000-4000-8000-000000000001", name: "Alex" },
        sessions: [{
          id: "00000000-0000-4000-8000-000000000601",
          source: "claude_code",
          description: "Claude Code in siqshift, running 12m",
          repo: "siqshift",
          aFieldFromTheFuture: true,
        }],
      }],
    });
    await expect(defaultBridge.liveAgentSessions()).resolves.toEqual({
      people: [{
        owner: { id: "00000000-0000-4000-8000-000000000001", name: "Alex" },
        sessions: [{
          id: "00000000-0000-4000-8000-000000000601",
          source: "claude_code",
          description: "Claude Code in siqshift, running 12m",
          repo: "siqshift",
        }],
      }],
    });
    // The command name and argument keys are the same seam the other polls
    // pin: a typo on either side compiles fine and leaves the live view dark.
    expect(invoke).toHaveBeenLastCalledWith("agent_live_sessions", undefined);

    // An API older than this build sends no people at all: nobody running, an
    // honest empty state, not an error.
    invoke.mockResolvedValueOnce({});
    await expect(defaultBridge.liveAgentSessions()).resolves.toEqual({ people: [] });
  });

  it("reads the workspace's name and invite code with no range", async () => {
    // Arrange
    const organization = { id: ids.project, name: "Field team", inviteCode: "ACDEF-GHJKM" };
    invoke.mockResolvedValueOnce({ organization });

    // Act
    const overview = await defaultBridge.orgOverview();

    // Assert
    expect(overview).toEqual({ organization });
    expect(invoke).toHaveBeenLastCalledWith("org_overview", undefined);
  });

  it("renames the workspace under the command name and input the host reads", async () => {
    // Arrange
    const organization = { id: ids.project, name: "Atlas Studio", inviteCode: "ACDEF-GHJKM" };
    invoke.mockResolvedValueOnce({ organization });

    // Act
    const overview = await defaultBridge.orgRename("Atlas Studio");

    // Assert
    expect(overview).toEqual({ organization });
    expect(invoke).toHaveBeenLastCalledWith("org_rename", { input: { name: "Atlas Studio" } });
  });

  it("decodes the workspace report with a member who has no project, and pins the command", async () => {
    // Arrange
    const report = {
      activeSeconds: 3_600,
      agentSeconds: 1_800,
      hourly: [{ hourStart: "2026-08-06T13:00:00.000Z", activeSeconds: 3_000, agentSeconds: 1_800 }],
      projects: [{ project: { id: ids.project, name: "Field work" }, durationSeconds: 3_600 }],
      // A runtime this build has never heard of still reads.
      agents: [{ source: "a_runtime_from_the_future", durationSeconds: 1_800 }],
      members: [
        { rank: 1, user: { id: ids.user, name: "Timer" }, activeSeconds: 3_600, agentSeconds: 1_800, project: { id: ids.project, name: "Field work" } },
        { rank: 2, user: { id: ids.other, name: "Alex" }, activeSeconds: 0, agentSeconds: 0, project: null },
      ],
    };
    invoke.mockResolvedValueOnce({ filters: {}, ...report });

    // Act
    const decoded = await defaultBridge.workspaceReport("2026-08-06T00:00:00.000Z", "2026-08-07T00:00:00.000Z");

    // Assert
    expect(decoded).toEqual(report);
    expect(invoke).toHaveBeenLastCalledWith("workspace_report", {
      fromAt: "2026-08-06T00:00:00.000Z",
      toExclusiveAt: "2026-08-07T00:00:00.000Z",
    });
  });

  it.each([
    ["a missing member list", { members: undefined }],
    ["a negative total", { activeSeconds: -1 }],
    ["a member without a name", { members: [{ rank: 1, user: { id: ids.user }, activeSeconds: 0, agentSeconds: 0, project: null }] }],
  ])("rejects a workspace report with %s", async (_case, broken) => {
    // Arrange
    invoke.mockResolvedValueOnce({ activeSeconds: 0, agentSeconds: 0, hourly: [], projects: [], agents: [], members: [], ...broken });

    // Act
    const read = defaultBridge.workspaceReport();

    // Assert
    await expect(read).rejects.toMatchObject({ kind: "unknown" });
  });

  it("decodes the macOS permissions and names the permission on every action", async () => {
    // Arrange
    invoke.mockResolvedValueOnce([
      { id: "login-item", state: "granted" },
      { id: "protected-folders", state: "not-asked" },
    ]);
    invoke.mockResolvedValueOnce([
      { id: "login-item", state: "missing" },
      { id: "protected-folders", state: "granted" },
    ]);
    invoke.mockResolvedValueOnce([{ id: "protected-folders", state: "declined" }]);
    invoke.mockResolvedValueOnce(null);

    // Act
    const statuses = await defaultBridge.permissionsStatus();
    const requested = await defaultBridge.permissionRequest("protected-folders");
    const declined = await defaultBridge.permissionDecline("protected-folders");
    await defaultBridge.permissionOpenSettings("login-item");

    // Assert
    expect(statuses).toEqual([
      { id: "login-item", state: "granted" },
      { id: "protected-folders", state: "not-asked" },
    ]);
    expect(requested).toEqual([
      { id: "login-item", state: "missing" },
      { id: "protected-folders", state: "granted" },
    ]);
    expect(declined).toEqual([{ id: "protected-folders", state: "declined" }]);
    expect(invoke.mock.calls.slice(-4)).toEqual([
      ["permissions_status", undefined],
      ["permission_request", { permissionId: "protected-folders" }],
      ["permission_decline", { permissionId: "protected-folders" }],
      ["permission_open_settings", { permissionId: "login-item" }],
    ]);
  });

  it.each([
    ["an unknown permission", [{ id: "screen-recording", state: "granted" }]],
    ["an unknown state", [{ id: "login-item", state: "maybe" }]],
    ["no list at all", { id: "login-item", state: "granted" }],
  ])("rejects a permission list with %s", async (_case, payload) => {
    // Arrange
    invoke.mockResolvedValueOnce(payload);

    // Act
    const result = defaultBridge.permissionsStatus();

    // Assert
    await expect(result).rejects.toMatchObject({ kind: "unknown" });
  });
});
