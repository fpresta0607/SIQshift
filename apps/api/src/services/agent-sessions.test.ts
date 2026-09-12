import { describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentRecord,
  AgentRepository,
  AgentSessionEndShift,
  AgentSessionRecord,
  AgentSessionRepository,
  InsertEndedAgentSession,
  PathMappingRecord,
  PathMappingRepository,
  SessionRecord,
  SessionRepository,
  UpsertAgentForKey,
  UpsertStartedAgentSession,
} from "../repositories.js";
import { createAgentSessionReaper, createAgentSessionService, type AgentSessionEventInput } from "./agent-sessions.js";
import { identityRepoKey } from "./attribution.js";
import { foldableDays } from "./rollups.js";
import { RETENTION_WINDOW_MS } from "./utc-days.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherProject: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
  timer: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const subject: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user, role: "member" };
const now = new Date("2026-08-06T14:00:00.000Z");

/** Where the report path stops measuring a session, as the repository defines it. */
const knownEnd = (row: AgentSessionRecord): Date => row.endedAt ?? row.lastEventAt;

class MemoryAgentSessions implements AgentSessionRepository {
  public readonly records: AgentSessionRecord[] = [];

  private find(current: AuthenticatedSubject, source: string, externalSessionId: string): AgentSessionRecord | undefined {
    return this.records.find((record) => record.organizationId === current.organizationId
      && record.userId === current.userId
      && record.source === source
      && record.externalSessionId === externalSessionId);
  }

  public async findByExternalKey(current: AuthenticatedSubject, source: AgentSessionRecord["source"], externalSessionId: string): Promise<AgentSessionRecord | null> {
    return this.find(current, source, externalSessionId) ?? null;
  }

  /** Mirrors the upsert: insert running; on replay refresh lastEventAt only, never reopen. */
  public async upsertStarted(input: UpsertStartedAgentSession): Promise<AgentSessionEndShift> {
    const existing = this.find({ organizationId: input.organizationId, userId: input.userId, role: "member" }, input.source, input.externalSessionId);
    if (existing !== undefined) {
      const previousEnd = knownEnd(existing);
      if (input.occurredAt > existing.lastEventAt) existing.lastEventAt = input.occurredAt;
      // Mirrors coalesce(agent_id, $new): the first assignment wins.
      existing.agentId ??= input.agentId;
      return { session: existing, previousEnd };
    }
    const record: AgentSessionRecord = {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      source: input.source,
      model: input.model,
      externalSessionId: input.externalSessionId,
      projectId: input.projectId,
      cwd: input.cwd,
      ruleId: input.ruleId,
      agentId: input.agentId,
      status: "running",
      startedAt: input.occurredAt,
      endedAt: null,
      lastEventAt: input.occurredAt,
      linkedSessionId: input.linkedSessionId,
    };
    this.records.push(record);
    return { session: record, previousEnd: null };
  }

  public async closeRunning(current: AuthenticatedSubject, source: AgentSessionRecord["source"], externalSessionId: string, endedAt: Date): Promise<AgentSessionEndShift | null> {
    const existing = this.find(current, source, externalSessionId);
    if (existing === undefined || existing.status !== "running") return null;
    const previousEnd = knownEnd(existing);
    existing.status = "ended";
    existing.endedAt = endedAt;
    if (endedAt > existing.lastEventAt) existing.lastEventAt = endedAt;
    return { session: existing, previousEnd };
  }

  /** Mirrors the tolerated end-before-start insert (ON CONFLICT DO NOTHING). */
  public async insertEnded(input: InsertEndedAgentSession): Promise<void> {
    const existing = this.find({ organizationId: input.organizationId, userId: input.userId, role: "member" }, input.source, input.externalSessionId);
    if (existing !== undefined) return;
    this.records.push({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      source: input.source,
      model: input.model,
      externalSessionId: input.externalSessionId,
      projectId: input.projectId,
      cwd: input.cwd,
      ruleId: input.ruleId,
      agentId: input.agentId,
      status: "ended",
      startedAt: input.occurredAt,
      endedAt: input.occurredAt,
      lastEventAt: input.occurredAt,
      linkedSessionId: null,
    });
  }

  public async advanceLastEvent(current: AuthenticatedSubject, source: AgentSessionRecord["source"], externalSessionId: string, model: string | null, occurredAt: Date): Promise<AgentSessionEndShift | null> {
    const existing = this.find(current, source, externalSessionId);
    if (existing === undefined) return null;
    const previousEnd = knownEnd(existing);
    if (existing.status === "running") {
      if (occurredAt > existing.lastEventAt) existing.lastEventAt = occurredAt;
      // Mirrors coalesce(model, $new): the first assignment wins.
      existing.model ??= model;
      return { session: existing, previousEnd };
    }
    if (model === null) return null;
    // A model-bearing heartbeat also fills a still-null model on an ended row.
    existing.model ??= model;
    return { session: existing, previousEnd };
  }

  /** Mirrors staleness reaping: running rows older than the cutoff end at lastEventAt. */
  public async reapStale(current: AuthenticatedSubject, cutoff: Date): Promise<number> {
    let reaped = 0;
    for (const record of this.records) {
      if (record.organizationId !== current.organizationId || record.userId !== current.userId) continue;
      if (record.status === "running" && record.lastEventAt < cutoff) {
        record.status = "ended";
        record.endedAt = record.lastEventAt;
        reaped += 1;
      }
    }
    return reaped;
  }
}

class MemoryPathMappings implements PathMappingRepository {
  public constructor(public readonly records: PathMappingRecord[] = []) {}

  public async listForSubject(current: AuthenticatedSubject): Promise<PathMappingRecord[]> {
    return this.records.filter((record) => record.organizationId === current.organizationId && record.userId === current.userId);
  }
  public async findById(): Promise<PathMappingRecord | null> { throw new Error("not used"); }
  public async findByPathPrefix(): Promise<PathMappingRecord | null> { throw new Error("not used"); }
  public async create(): Promise<PathMappingRecord> { throw new Error("not used"); }
  public async update(): Promise<PathMappingRecord | null> { throw new Error("not used"); }
  public async remove(): Promise<boolean> { throw new Error("not used"); }
}

/** Records every roster upsert and answers each (source, repo) key with one stable id. */
class MemoryAgents implements AgentRepository {
  public readonly upserts: UpsertAgentForKey[] = [];
  private readonly idsByKey = new Map<string, string>();

  public async upsertForKey(input: UpsertAgentForKey): Promise<{ id: string }> {
    this.upserts.push(input);
    // The fake answers the way the real repository does: one id per identity,
    // which is the remote when there is one and the root otherwise.
    const key = `${input.source}|${identityRepoKey(input.repoRoot, input.repoRemote) ?? ""}`;
    let id = this.idsByKey.get(key);
    if (id === undefined) {
      id = crypto.randomUUID();
      this.idsByKey.set(key, id);
    }
    return { id };
  }

  public async listForOrganization(): Promise<AgentRecord[]> { throw new Error("not used"); }
  public async findById(): Promise<AgentRecord | null> { throw new Error("not used"); }
  public async update(): Promise<AgentRecord | null> { throw new Error("not used"); }
  public async merge(): Promise<void> { throw new Error("not used"); }
  public async listSessionsForAgent(): Promise<never> { throw new Error("not used"); }
  public async restampSession(): Promise<void> { throw new Error("not used"); }
  public async retireIfSessionless(): Promise<boolean> { throw new Error("not used"); }
}

class MemoryTimers implements Pick<SessionRepository, "findRunning"> {
  public running: SessionRecord | null = null;
  public async findRunning(): Promise<SessionRecord | null> { return this.running; }
}

function runningTimer(projectId: string): SessionRecord {
  return {
    id: ids.timer,
    organizationId: ids.organization,
    userId: ids.user,
    clientId: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
    projectId,
    description: null,
    status: "running",
    startedAt: new Date("2026-08-06T13:00:00.000Z"),
    stoppedAt: null,
    idleSeconds: 0,
    durationSeconds: null,
  };
}

function event(overrides: Partial<AgentSessionEventInput> = {}): AgentSessionEventInput {
  return {
    source: "claude_code",
    model: null,
    externalSessionId: "session-1",
    event: "started",
    occurredAt: new Date("2026-08-06T13:30:00.000Z"),
    cwd: "C:/dev/siqshift",
    // A desktop old enough to have no repo probe is the default here, so the
    // suite keeps exercising the degradation path as well as the v2 one.
    repoRoot: null,
    // The remote is likewise absent by default, so the degradation path stays
    // the suite's baseline rather than the exception.
    repoRemote: null,
    ruleId: null,
    ...overrides,
  };
}

function createService(options: {
  mappings?: PathMappingRecord[];
  runningTimer?: SessionRecord | null;
  staleThresholdMs?: number;
  agents?: AgentRepository;
  onUploaded?: (subject: AuthenticatedSubject, instants: readonly Date[]) => Promise<void>;
  clock?: () => Date;
} = {}) {
  const agentSessions = new MemoryAgentSessions();
  const timers = new MemoryTimers();
  timers.running = options.runningTimer ?? null;
  const service = createAgentSessionService({
    agentSessions,
    pathMappings: new MemoryPathMappings(options.mappings ?? []),
    sessions: timers as SessionRepository,
    clock: options.clock ?? (() => now),
    ...(options.staleThresholdMs === undefined ? {} : { staleThresholdMs: options.staleThresholdMs }),
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    ...(options.onUploaded === undefined ? {} : { onUploaded: options.onUploaded }),
  });
  return { agentSessions, service };
}

const mapped: PathMappingRecord = { id: "f1c7e513-b094-4d4c-ae55-21790ae019a4", organizationId: ids.organization, userId: ids.user, kind: "path_prefix", pathPrefix: "C:/dev/siqshift", repoUrl: null, projectId: ids.project };

describe("agent-session service", () => {
  it("starts a running row attributed by cwd and linked to a matching running timer", async () => {
    const { agentSessions, service } = createService({ mappings: [mapped], runningTimer: runningTimer(ids.project) });

    const result = await service.ingest(subject, [event()]);

    expect(result).toEqual({ results: [{ externalSessionId: "session-1", accepted: true }] });
    expect(agentSessions.records[0]).toMatchObject({
      status: "running",
      projectId: ids.project,
      linkedSessionId: ids.timer,
      startedAt: new Date("2026-08-06T13:30:00.000Z"),
      lastEventAt: new Date("2026-08-06T13:30:00.000Z"),
      endedAt: null,
    });
  });

  it("leaves projectId null for unmapped cwds and does not link a timer on another project", async () => {
    const unmapped = createService({ runningTimer: runningTimer(ids.project) });
    await unmapped.service.ingest(subject, [event()]);
    expect(unmapped.agentSessions.records[0]).toMatchObject({ projectId: null, linkedSessionId: null });

    const otherProject = createService({ mappings: [mapped], runningTimer: runningTimer(ids.otherProject) });
    await otherProject.service.ingest(subject, [event()]);
    expect(otherProject.agentSessions.records[0]).toMatchObject({ projectId: ids.project, linkedSessionId: null });
  });

  // The Overlord's shape, end to end: a goblin in `<repo>/.worktrees/gb-<id>`
  // is working the repository the mapping already names, because the desktop
  // resolves the main repository root and the prefix rule matches the
  // worktree beneath it.
  it("attributes a worktree nested under the mapped repo root through the main root", async () => {
    const { agentSessions, service } = createService({ mappings: [mapped] });
    await service.ingest(subject, [
      event({
        cwd: "C:\\dev\\siqshift\\.worktrees\\gb-the-shift",
        repoRoot: "C:\\dev\\siqshift\\.worktrees\\gb-the-shift",
        repoRemote: "git@github.com:acme/siqshift.git",
      }),
    ]);
    expect(agentSessions.records[0]).toMatchObject({ projectId: ids.project });
  });

  // The gap the nested case leaves: a worktree outside every mapped root
  // cannot match by prefix, so the repository's remote is the only signal
  // left, read from the mapping's own repoUrl.
  it("falls back to the repository remote for a worktree no path prefix can reach", async () => {
    const byRemote: PathMappingRecord = {
      ...mapped,
      id: "0b9d1e9e-4d4c-4ae5-a552-1790ae019a40",
      pathPrefix: "C:/dev/anything",
      repoUrl: "git@github.com:acme/siqshift.git",
    };
    const { agentSessions, service } = createService({ mappings: [byRemote] });
    await service.ingest(subject, [
      event({
        cwd: "C:\\Users\\fpres\\.treehouse\\siqshift-4b3191\\siqshift",
        repoRoot: "C:\\Users\\fpres\\.treehouse\\siqshift-4b3191\\siqshift",
        repoRemote: "https://github.com/acme/siqshift.git",
      }),
    ]);
    expect(agentSessions.records[0]).toMatchObject({ projectId: ids.project });
  });

  // Two different remotes are two codebases. A mapping naming one of them
  // must never catch the other, whatever the paths look like.
  it("does not let a remote mapping capture a different repository's session", async () => {
    const byRemote: PathMappingRecord = {
      ...mapped,
      id: "0b9d1e9e-4d4c-4ae5-a552-1790ae019a41",
      pathPrefix: "C:/dev/anything",
      repoUrl: "git@github.com:acme/siqshift.git",
    };
    const { agentSessions, service } = createService({ mappings: [byRemote] });
    await service.ingest(subject, [
      event({
        cwd: "C:\\Users\\fpres\\.treehouse\\unrelated-4b3191\\unrelated",
        repoRoot: "C:\\Users\\fpres\\.treehouse\\unrelated-4b3191\\unrelated",
        repoRemote: "git@github.com:acme/unrelated.git",
      }),
    ]);
    expect(agentSessions.records[0]).toMatchObject({ projectId: null });
  });

  it("treats a repeated start as a lastEventAt refresh", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event()]);
    const result = await service.ingest(subject, [event({ occurredAt: new Date("2026-08-06T13:45:00.000Z") })]);

    expect(result.results).toEqual([{ externalSessionId: "session-1", accepted: true }]);
    expect(agentSessions.records).toHaveLength(1);
    expect(agentSessions.records[0]).toMatchObject({ status: "running", lastEventAt: new Date("2026-08-06T13:45:00.000Z") });
  });

  it("closes a running session at the end event's occurredAt", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event()]);
    await service.ingest(subject, [event({ event: "ended", occurredAt: new Date("2026-08-06T13:50:00.000Z") })]);

    expect(agentSessions.records[0]).toMatchObject({
      status: "ended",
      endedAt: new Date("2026-08-06T13:50:00.000Z"),
      lastEventAt: new Date("2026-08-06T13:50:00.000Z"),
    });
  });

  it("tolerates end-before-start by storing the row directly as ended, attributed from cwd", async () => {
    const { agentSessions, service } = createService({ mappings: [mapped] });

    const result = await service.ingest(subject, [event({ event: "ended" })]);

    expect(result.results).toEqual([{ externalSessionId: "session-1", accepted: true }]);
    expect(agentSessions.records[0]).toMatchObject({
      status: "ended",
      projectId: ids.project,
      startedAt: new Date("2026-08-06T13:30:00.000Z"),
      endedAt: new Date("2026-08-06T13:30:00.000Z"),
    });
  });

  it("accepts an end for an already-ended session without reopening it", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event(), event({ event: "ended", occurredAt: new Date("2026-08-06T13:50:00.000Z") })]);
    const result = await service.ingest(subject, [event({ event: "ended", occurredAt: new Date("2026-08-06T13:55:00.000Z") })]);

    expect(result.results).toEqual([{ externalSessionId: "session-1", accepted: true }]);
    expect(agentSessions.records).toHaveLength(1);
    expect(agentSessions.records[0]).toMatchObject({ status: "ended", endedAt: new Date("2026-08-06T13:50:00.000Z") });
  });

  it("advances lastEventAt on heartbeat and accepts unknown sessions as no-ops", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event()]);
    await service.ingest(subject, [
      event({ event: "heartbeat", occurredAt: new Date("2026-08-06T13:40:00.000Z") }),
      event({ event: "heartbeat", externalSessionId: "ghost", occurredAt: new Date("2026-08-06T13:41:00.000Z") }),
    ]);

    expect(agentSessions.records).toHaveLength(1);
    expect(agentSessions.records[0]).toMatchObject({ lastEventAt: new Date("2026-08-06T13:40:00.000Z") });
  });

  /**
   * A day is folded from the intervals stored for it, and an open session is
   * measured up to its last event - so a day it was still reaching into is not
   * final until that end moves past the day's midnight. The fold therefore has
   * to be told the days each write moved that end across, which is neither the
   * days the events landed in nor the day the session began in.
   *
   * The shape below is the one the review walked: a session opened on day A,
   * still reporting on day B, folded at B's midnight by some other upload, and
   * reporting again just after it. Day B is the day that just became final and
   * the day nothing else will ever name again.
   */
  it("names the day a session's end just crossed, and nothing once it is past", async () => {
    // Each upload is judged against the clock it happened at, because which of
    // the days it names are foldable is exactly what "already over" means.
    const handed: string[][] = [];
    // The staleness window is widened rather than simulated: this session has
    // been reporting all along, and reaping it is not what is under test.
    let current = new Date("2026-08-05T22:00:00.000Z");
    const { service } = createService({
      clock: () => current,
      staleThresholdMs: 7 * 24 * 60 * 60 * 1_000,
      onUploaded: async (_subject, instants) => {
        handed.push(foldableDays(instants, current).map((entry) => entry.toISOString()));
      },
    });
    const ingestAt = async (moment: string, kind: AgentSessionEventInput["event"]): Promise<void> => {
      current = new Date(moment);
      await service.ingest(subject, [event({ event: kind, occurredAt: current })]);
    };
    const dayA = "2026-08-05T00:00:00.000Z";
    const dayB = "2026-08-06T00:00:00.000Z";

    await ingestAt("2026-08-05T22:00:00.000Z", "started");
    await ingestAt("2026-08-06T23:50:00.000Z", "heartbeat");
    await ingestAt("2026-08-07T00:05:00.000Z", "heartbeat");
    await ingestAt("2026-08-07T00:20:00.000Z", "heartbeat");

    expect(handed).toEqual([
      // Day A is still being written when the session opens in it.
      [],
      // The end crossed out of A and into B, so A is final and refolded.
      [dayA],
      // And now out of B: the intermediate day, which no event ever names.
      [dayB],
      // The end is past B's midnight for good, so there is nothing left to fold.
      [],
    ]);
  });

  it("fills a still-null model from a heartbeat that names one", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event()]);

    await service.ingest(subject, [
      event({ event: "heartbeat", model: "claude-opus-4-8", occurredAt: new Date("2026-08-06T13:40:00.000Z") }),
    ]);

    expect(agentSessions.records[0]).toMatchObject({ model: "claude-opus-4-8" });
  });

  // The roster read "Claude Code · <synthetic>": a CLI marks the entries it
  // writes about itself, and a desktop old enough to read one out of a
  // transcript still reports it. A placeholder is not a model.
  it("records no model when the runtime sends a placeholder rather than one", async () => {
    const { agentSessions, service } = createService();

    await service.ingest(subject, [event({ model: "<synthetic>" })]);
    await service.ingest(subject, [
      event({ event: "heartbeat", model: "<synthetic>", occurredAt: new Date("2026-08-06T13:40:00.000Z") }),
    ]);

    expect(agentSessions.records[0]).toMatchObject({ model: null });

    // A real model still lands afterwards - the placeholder never took the slot.
    await service.ingest(subject, [
      event({ event: "heartbeat", model: "claude-opus-4-8", occurredAt: new Date("2026-08-06T13:45:00.000Z") }),
    ]);
    expect(agentSessions.records[0]).toMatchObject({ model: "claude-opus-4-8" });
  });

  it("fills a still-null model from a heartbeat that arrives after the session ended", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event()]);
    await service.ingest(subject, [event({ event: "ended", occurredAt: new Date("2026-08-06T13:50:00.000Z") })]);

    await service.ingest(subject, [
      event({ event: "heartbeat", model: "claude-opus-4-8", occurredAt: new Date("2026-08-06T13:51:00.000Z") }),
    ]);

    expect(agentSessions.records[0]).toMatchObject({ status: "ended", model: "claude-opus-4-8", endedAt: new Date("2026-08-06T13:50:00.000Z") });
  });

  it("never overwrites a model the shift already carries", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event({ model: "claude-opus-4-8" })]);

    await service.ingest(subject, [
      event({ event: "heartbeat", model: "claude-sonnet-4-8", occurredAt: new Date("2026-08-06T13:40:00.000Z") }),
    ]);

    expect(agentSessions.records[0]).toMatchObject({ model: "claude-opus-4-8" });
  });

  it("reaps running sessions stale beyond thirty minutes at their lastEventAt before a batch", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event({ occurredAt: new Date("2026-08-06T07:00:00.000Z") })]);

    const result = await service.ingest(subject, [event({ externalSessionId: "fresh" })]);

    expect(result.results).toEqual([{ externalSessionId: "fresh", accepted: true }]);
    expect(agentSessions.records[0]).toMatchObject({
      externalSessionId: "session-1",
      status: "ended",
      endedAt: new Date("2026-08-06T07:00:00.000Z"),
    });
    expect(agentSessions.records[1]).toMatchObject({ externalSessionId: "fresh", status: "running" });
  });

  it("exposes reaping for read paths", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event({ occurredAt: new Date("2026-08-06T07:30:00.000Z") })]);

    await expect(service.reapStale(subject)).resolves.toBe(1);
    await expect(service.reapStale(subject)).resolves.toBe(0);
    expect(agentSessions.records[0]).toMatchObject({ status: "ended", endedAt: new Date("2026-08-06T07:30:00.000Z") });
  });

  it("refuses an event from the distant past, so one cannot be expanded into a day per year", async () => {
    const { agentSessions, service } = createService();

    // `timestampSchema` accepts any four-digit year, and the day span between a
    // session's old and new known end is expanded one Date per day. Year zero
    // is roughly three quarters of a million of them, allocated on the upload's
    // own request, so the past bound is what keeps that unreachable.
    const result = await service.ingest(subject, [
      event({ externalSessionId: "ancient", occurredAt: new Date("0000-01-01T00:00:00.000Z") }),
      event({ externalSessionId: "fine" }),
    ]);

    expect(result.results).toEqual([
      { externalSessionId: "ancient", accepted: false, reason: "occurredAt is older than the retention window" },
      { externalSessionId: "fine", accepted: true },
    ]);
    expect(agentSessions.records.map((record) => record.externalSessionId)).toEqual(["fine"]);
  });

  /**
   * The other half of the same boundary the activity path pins: the ingest
   * window and the retention window are one number, so an event for a day the
   * sweep will delete is refused at the door rather than stored and swept.
   */
  it("accepts an event just inside the retention window and refuses one just outside", async () => {
    const { agentSessions, service } = createService();
    const oldest = now.getTime() - RETENTION_WINDOW_MS;

    const result = await service.ingest(subject, [
      event({ externalSessionId: "inside", occurredAt: new Date(oldest) }),
      event({ externalSessionId: "outside", occurredAt: new Date(oldest - 1) }),
    ]);

    expect(result.results).toEqual([
      { externalSessionId: "inside", accepted: true },
      { externalSessionId: "outside", accepted: false, reason: "occurredAt is older than the retention window" },
    ]);
    expect(agentSessions.records.map((record) => record.externalSessionId)).toEqual(["inside"]);
  });

  it("rejects invalid or far-future events individually without failing the batch", async () => {
    const { agentSessions, service } = createService();

    const result = await service.ingest(subject, [
      event({ occurredAt: new Date("2026-08-06T14:00:30.001Z") }),
      event({ externalSessionId: "bad-date", occurredAt: new Date("not-a-date") }),
      event({ externalSessionId: "fine" }),
    ]);

    expect(result.results).toEqual([
      { externalSessionId: "session-1", accepted: false, reason: "occurredAt is too far in the future" },
      { externalSessionId: "bad-date", accepted: false, reason: "occurredAt is invalid" },
      { externalSessionId: "fine", accepted: true },
    ]);
    expect(agentSessions.records.map((record) => record.externalSessionId)).toEqual(["fine"]);
  });

  it("scopes sessions to the subject's organization and user", async () => {
    const { agentSessions, service } = createService();
    const other: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.otherUser, role: "member" };
    await service.ingest(subject, [event()]);
    await service.ingest(other, [event()]);

    expect(agentSessions.records).toHaveLength(2);
    await service.ingest(other, [event({ event: "ended" })]);
    expect(agentSessions.records[0]).toMatchObject({ userId: ids.user, status: "running" });
    expect(agentSessions.records[1]).toMatchObject({ userId: ids.otherUser, status: "ended" });
  });
});

describe("roster minting", () => {
  it("mints an identity for a started shift and stamps it on the row", async () => {
    const agents = new MemoryAgents();
    const { agentSessions, service } = createService({ mappings: [mapped], agents });

    await service.ingest(subject, [event()]);

    expect(agents.upserts).toEqual([{
      organizationId: ids.organization,
      ownerUserId: ids.user,
      source: "claude_code",
      repoRoot: null,
      repoRemote: null,
      projectId: ids.project,
      name: "Claude Code",
      now,
    }]);
    expect(agentSessions.records[0]!.agentId).not.toBeNull();
  });

  it("mints for an end-before-start row too", async () => {
    const agents = new MemoryAgents();
    const { agentSessions, service } = createService({ agents });

    await service.ingest(subject, [event({ event: "ended" })]);

    expect(agents.upserts).toHaveLength(1);
    expect(agents.upserts[0]).toMatchObject({ source: "claude_code", projectId: null });
    expect(agentSessions.records[0]!.agentId).not.toBeNull();
  });

  it("mints nothing for browser spans", async () => {
    const agents = new MemoryAgents();
    const { agentSessions, service } = createService({ agents });

    await service.ingest(subject, [event({ source: "browser", cwd: null, ruleId: null })]);

    expect(agents.upserts).toHaveLength(0);
    expect(agentSessions.records[0]!.agentId).toBeNull();
  });

  it("memoizes one upsert per (source, repo) per batch", async () => {
    const agents = new MemoryAgents();
    const { agentSessions, service } = createService({ agents });

    await service.ingest(subject, [
      event({ externalSessionId: "one" }),
      event({ externalSessionId: "two" }),
      event({ externalSessionId: "three", source: "codex" }),
    ]);

    expect(agents.upserts.map((upsert) => upsert.source)).toEqual(["claude_code", "codex"]);
    expect(agentSessions.records[0]!.agentId).toBe(agentSessions.records[1]!.agentId);
    expect(agentSessions.records[2]!.agentId).not.toBe(agentSessions.records[0]!.agentId);
  });

  it("keys the identity on the reported repo, so two repos are two agents", async () => {
    const agents = new MemoryAgents();
    const { agentSessions, service } = createService({ mappings: [mapped], agents });

    await service.ingest(subject, [
      event({ externalSessionId: "one", repoRoot: "C:/dev/siqshift" }),
      event({ externalSessionId: "two", repoRoot: "C:/dev/siqshift" }),
      event({ externalSessionId: "three", repoRoot: "C:/dev/pocket-piggies" }),
    ]);

    expect(agents.upserts.map((upsert) => upsert.repoRoot))
      .toEqual(["C:/dev/siqshift", "C:/dev/pocket-piggies"]);
    expect(agentSessions.records[1]!.agentId).toBe(agentSessions.records[0]!.agentId);
    // Two repos inside one project used to collapse onto one identity.
    expect(agentSessions.records[2]!.agentId).not.toBe(agentSessions.records[0]!.agentId);
  });

  // The batch cache keys on what identity keys on. Two worktrees of one
  // repository arrive as two roots and one remote: cached on the root alone
  // they would race into two upserts for the one identity, and cached on the
  // remote alone a repository with no remote would swallow every other one.
  it("carries the remote to the identity, and shares one upsert across two worktrees", async () => {
    const agents = new MemoryAgents();
    const { agentSessions, service } = createService({ agents });
    const remote = "git@github.com:fpresta0607/precisiondocs.git";

    await service.ingest(subject, [
      event({ externalSessionId: "one", repoRoot: "C:/w/precisiondocs-fdd5f2/1/precisiondocs", repoRemote: remote }),
      event({ externalSessionId: "two", repoRoot: "C:/w/precisiondocs-fdd5f2/2/precisiondocs", repoRemote: remote }),
      event({ externalSessionId: "three", repoRoot: "C:/dev/other", repoRemote: null }),
    ]);

    expect(agents.upserts.map((upsert) => upsert.repoRemote)).toEqual([remote, null]);
    expect(agentSessions.records[1]!.agentId).toBe(agentSessions.records[0]!.agentId);
    expect(agentSessions.records[2]!.agentId).not.toBe(agentSessions.records[0]!.agentId);
  });

  it("mints the operator's unassigned bucket when the desktop reported no repo", async () => {
    const agents = new MemoryAgents();
    const { service } = createService({ agents });

    await service.ingest(subject, [event({ repoRoot: null })]);

    // The designed degradation path for an installer without the probe: a
    // real roster row, whose shifts move onto a codebase one at a time as
    // their own commits name one.
    expect(agents.upserts[0]).toMatchObject({ repoRoot: null, ownerUserId: ids.user });
  });

  it("names the operator from the uploader, whatever the runtime is", async () => {
    const agents = new MemoryAgents();
    const { service } = createService({ agents });
    const other: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.otherUser, role: "member" };

    await service.ingest(other, [event({ source: "kimi_code", repoRoot: "C:/dev/siqshift" })]);

    // No per-runtime work: the day kimi's hooks are wired, its shifts mint
    // under the account whose desktop uploaded them.
    expect(agents.upserts[0]).toMatchObject({ ownerUserId: ids.otherUser, source: "kimi_code" });
  });

  it("attributes the project from the repo first and the working directory second", async () => {
    const agents = new MemoryAgents();
    const { agentSessions, service } = createService({ mappings: [mapped], agents });

    await service.ingest(subject, [
      // The repo is mapped; a deeper cwd inside it resolves the same project.
      event({ externalSessionId: "one", repoRoot: "C:/dev/siqshift", cwd: "C:/dev/siqshift/apps/web" }),
      // No repo reported, so the working directory answers exactly as before.
      event({ externalSessionId: "two", repoRoot: null, cwd: "C:/dev/siqshift/apps/api" }),
      // Neither is mapped: null, never a fallback project.
      event({ externalSessionId: "three", repoRoot: "C:/dev/elsewhere", cwd: "C:/dev/elsewhere" }),
    ]);

    expect(agentSessions.records.map((row) => row.projectId)).toEqual([ids.project, ids.project, null]);
  });

  it("stays safe when the agents dependency is missing", async () => {
    const { agentSessions, service } = createService();

    const result = await service.ingest(subject, [event()]);

    expect(result.results).toEqual([{ externalSessionId: "session-1", accepted: true }]);
    expect(agentSessions.records[0]!.agentId).toBeNull();
  });
});

describe("agent-session reaper", () => {
  it("closes stale running sessions at lastEventAt for report read paths", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event({ occurredAt: new Date("2026-08-06T07:30:00.000Z") })]);
    const reaper = createAgentSessionReaper({ agentSessions, clock: () => now });

    await expect(reaper.reapStale(subject)).resolves.toBe(1);
    await expect(reaper.reapStale(subject)).resolves.toBe(0);
    expect(agentSessions.records[0]).toMatchObject({ status: "ended", endedAt: new Date("2026-08-06T07:30:00.000Z") });
  });
});
