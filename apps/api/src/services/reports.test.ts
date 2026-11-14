import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_APPEARANCE, projectAppearance, summedSeconds, unionSeconds } from "@siqshift/shared";
import type { AgentShiftsFilters, Interval, ReportFilters } from "@siqshift/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentIntervalRecord,
  AgentRecord,
  AgentRepository,
  AgentShiftRecord,
  AgentUsageBucketTotalRecord,
  AgentUsageModelTotalsRecord,
  AgentUsageProjectBucketTotalRecord,
  AgentUsageRepository,
  AgentUsageSessionTotalsRecord,
  AgentUsageTotalsRecord,
  AppTotalRecord,
  LeaderboardRowRecord,
  MemberProjectTotalRecord,
  MemberRecord,
  PresenceIntervalRecord,
  ProjectTotalRecord,
  ReportLookupRecord,
  ReportPageOptions,
  ReportQuery,
  ReportRepository,
  ReportRowRecord,
  SessionIntervalRecord,
  ShiftCommitCountsRecord,
  ShiftCommitRepository,
  ShiftRepoRootRecord,
  RunningAgentSessionRecord,
  SiteTotalRecord,
} from "../repositories.js";
import { createReportService, normalizedQuery, timeSeries, type ReportService } from "./reports.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherProject: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
  session: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherAgent: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const subject: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user, role: "member" };

function row(overrides: Partial<ReportRowRecord> = {}): ReportRowRecord {
  return {
    id: ids.session,
    user: { id: ids.user, name: "Alex" },
    project: { id: ids.project, name: "Timer" },
    repoRoot: null,
    description: "Focused work",
    status: "stopped",
    startedAt: new Date("2026-08-06T14:00:00.000Z"),
    stoppedAt: new Date("2026-08-06T15:00:00.000Z"),
    idleSeconds: 60,
    durationSeconds: 3_540,
    attribution: "agent",
    ...overrides,
  };
}

class Reports implements ReportRepository {
  public lastPage: { query: Parameters<ReportRepository["readPageForOrganization"]>[1]; options: ReportPageOptions } | null = null;
  public lastLeaderboardQuery: ReportQuery | null = null;
  public lastProjectTotalsQuery: ReportQuery | null = null;
  public lastAppTotalsQuery: ReportQuery | null = null;
  public lastSiteTotalsQuery: ReportQuery | null = null;
  public exportReads = 0;
  public leaderboardRows: LeaderboardRowRecord[] = [];
  public projectTotals: ProjectTotalRecord[] = [];
  public appTotals: AppTotalRecord[] = [];
  public siteTotals: SiteTotalRecord[] = [];
  public presenceIntervals: PresenceIntervalRecord[] = [];
  public sessionIntervals: SessionIntervalRecord[] = [];
  public agentIntervals: AgentIntervalRecord[] = [];
  public runningSessions: RunningAgentSessionRecord[] = [];
  public constructor(private readonly rows: ReportRowRecord[] = [], public readonly accessible = new Set([ids.project, ids.user])) {}
  public async readLeaderboardForOrganization(_subject: AuthenticatedSubject, query: ReportQuery) {
    this.lastLeaderboardQuery = query;
    return this.leaderboardRows;
  }
  /**
   * The median moved into SQL, so the fake answers it the way the query does:
   * over the same overlapping sessions, each clipped to the range and rounded
   * before the middle is taken.
   */
  public async readMedianSessionSeconds(_subject: AuthenticatedSubject, query: ReportQuery): Promise<number | null> {
    const range = {
      ...(query.from === undefined ? {} : { start: query.from.getTime() }),
      ...(query.toExclusive === undefined ? {} : { end: query.toExclusive.getTime() }),
    };
    const lengths = this.sessionIntervals
      .filter((session) => query.userId === undefined || session.user.id === query.userId)
      .filter((session) => query.projectId === undefined || session.projectId === query.projectId)
      .filter((session) => query.unassignedOnly !== true || session.attribution === "default")
      .map((session) => summedSeconds([{ start: session.startedAt.getTime(), end: session.stoppedAt.getTime() }], range))
      .filter((seconds) => seconds > 0)
      .sort((a, b) => a - b);
    if (lengths.length === 0) return null;
    const middle = Math.floor(lengths.length / 2);
    return lengths.length % 2 === 1 ? lengths[middle]! : Math.round((lengths[middle - 1]! + lengths[middle]!) / 2);
  }
  public roster: MemberRecord[] = [];
  public async readMembersForOrganization() {
    return this.roster;
  }
  public async readProjectTotalsForMember(_subject: AuthenticatedSubject, query: ReportQuery) {
    this.lastProjectTotalsQuery = query;
    return this.projectTotals;
  }
  public memberProjectTotals: MemberProjectTotalRecord[] = [];
  public lastMemberProjectTotalsQuery: ReportQuery | null = null;
  public async readProjectTotalsByMemberForOrganization(_subject: AuthenticatedSubject, query: ReportQuery) {
    this.lastMemberProjectTotalsQuery = query;
    return this.memberProjectTotals;
  }
  public async readAppTotalsForMember(_subject: AuthenticatedSubject, query: ReportQuery) {
    this.lastAppTotalsQuery = query;
    return this.appTotals;
  }
  public async readSiteTotalsForMember(_subject: AuthenticatedSubject, query: ReportQuery) {
    this.lastSiteTotalsQuery = query;
    return this.siteTotals;
  }
  public async readPresenceIntervals(_subject: AuthenticatedSubject, query: ReportQuery) {
    return this.presenceIntervals.filter((row) => query.userId === undefined || row.user.id === query.userId);
  }
  public async readSessionIntervals(_subject: AuthenticatedSubject, query: ReportQuery) {
    return this.sessionIntervals.filter((row) => query.userId === undefined || row.user.id === query.userId);
  }
  public async readAgentIntervals(_subject: AuthenticatedSubject, query: ReportQuery) {
    return this.agentIntervals.filter((row) =>
      (query.userId === undefined || row.user.id === query.userId)
      && (query.projectId === undefined || row.projectId === query.projectId)
      && (query.unassignedOnly !== true || row.projectId === null)
    );
  }
  public async readNewestEvidenceReceivedAt(): Promise<null> {
    return null;
  }

  public async readRunningAgentSessions(_subject: AuthenticatedSubject, freshSince: Date) {
    return this.runningSessions.filter((row) => row.lastEventAt >= freshSince);
  }
  public async findProjectForOrganization(_subject: AuthenticatedSubject, projectId: string) {
    return this.accessible.has(projectId) ? { id: projectId, name: "Timer" } : null;
  }
  public defaultProject: ReportLookupRecord | null = { id: ids.project, name: "Timer" };
  public async readDefaultProject() {
    return this.defaultProject;
  }
  public async findUserForOrganization(_subject: AuthenticatedSubject, userId: string) {
    return this.accessible.has(userId) ? { id: userId, name: "Alex" } : null;
  }
  private summary() {
    return { totalRows: this.rows.length, totalDurationSeconds: this.rows.reduce((total, record) => total + record.durationSeconds, 0) };
  }
  public async readPageForOrganization(_subject: AuthenticatedSubject, query: Parameters<ReportRepository["readPageForOrganization"]>[1], options: ReportPageOptions) {
    this.lastPage = { query, options };
    return { summary: this.summary(), rows: this.rows.slice(options.offset, options.offset + options.limit) };
  }
  public async readExportForOrganization(_subject: AuthenticatedSubject, _query: Parameters<ReportRepository["readExportForOrganization"]>[1], _maxRows: number) {
    this.exportReads += 1;
    return { summary: this.summary(), rows: this.rows };
  }
}

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const record: AgentRecord = {
    id: ids.session,
    organizationId: ids.organization,
    name: "Claude Code @ Timer",
    source: "claude_code",
    status: "anonymous",
    owner: { id: ids.user, name: "Alex" },
    project: { id: ids.project, name: "Timer" },
    repoRoot: null,
    repoKey: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
  // A fixture that names a root carries the key that root implies, the way
  // upsertForKey composes one - so `repoKey` is never null on a row that knows
  // its repository, which is exactly what "is this the bucket?" reads.
  return record.repoKey === null && record.repoRoot !== null
    ? { ...record, repoKey: `path:${record.repoRoot}` }
    : record;
}

/** The pay-run report's roster; empty by default so existing report/leaderboard/meStats tests are unaffected. */
class Agents implements AgentRepository {
  /** The ids the last `listByIds` asked for, so a test can pin what was read. */
  public lastRequestedIds: readonly string[] | null = null;
  public constructor(public records: AgentRecord[] = []) {}
  public async upsertForKey(): Promise<{ id: string }> {
    throw new Error("not used");
  }
  public async listForOrganization(subject: AuthenticatedSubject): Promise<AgentRecord[]> {
    return this.records.filter((record) => record.organizationId === subject.organizationId);
  }
  public async listByIds(subject: AuthenticatedSubject, agentIds: readonly string[]): Promise<AgentRecord[]> {
    this.lastRequestedIds = agentIds;
    return this.records.filter(
      (record) => record.organizationId === subject.organizationId && agentIds.includes(record.id),
    );
  }
  public async findById(): Promise<AgentRecord | null> {
    throw new Error("not used");
  }
  public async update(): Promise<AgentRecord | null> {
    throw new Error("not used");
  }
  public async merge(): Promise<void> {
    throw new Error("not used");
  }
  public async listSessionsForAgent(): Promise<AgentShiftRecord[]> {
    throw new Error("not used");
  }
}

const agents = new Agents();

type CommitSeed = {
  userId: string;
  agentId: string;
  projectId: string | null;
  verification: "pending" | "merged" | "reverted" | "orphaned";
  authoredAt: Date;
  agentSessionId?: string;
  repoRoot?: string;
  subject?: string;
};

class ShiftCommits implements ShiftCommitRepository {
  public lastCountsQuery: ReportQuery | null = null;
  public constructor(public commits: CommitSeed[] = []) {}
  public async findByClientId(): ReturnType<ShiftCommitRepository["findByClientId"]> {
    throw new Error("not used");
  }
  public async insert(): ReturnType<ShiftCommitRepository["insert"]> {
    throw new Error("not used");
  }
  public async advanceVerification(): ReturnType<ShiftCommitRepository["advanceVerification"]> {
    throw new Error("not used");
  }
  public async countsByAgent(_subject: AuthenticatedSubject, query: ReportQuery): Promise<ShiftCommitCountsRecord[]> {
    this.lastCountsQuery = query;
    const byAgent = new Map<string, ShiftCommitCountsRecord>();
    for (const commit of this.commits) {
      if (query.userId !== undefined && commit.userId !== query.userId) continue;
      if (query.projectId !== undefined && commit.projectId !== query.projectId) continue;
      if (query.unassignedOnly === true && commit.projectId !== null) continue;
      if (query.from !== undefined && commit.authoredAt < query.from) continue;
      if (query.toExclusive !== undefined && commit.authoredAt >= query.toExclusive) continue;
      const record = byAgent.get(commit.agentId) ?? {
        agentId: commit.agentId,
        recorded: 0,
        pending: 0,
        merged: 0,
        reverted: 0,
        orphaned: 0,
      };
      record.recorded += 1;
      if (commit.verification === "pending") record.pending += 1;
      else if (commit.verification === "merged") record.merged += 1;
      else if (commit.verification === "reverted") record.reverted += 1;
      else record.orphaned += 1;
      byAgent.set(commit.agentId, record);
    }
    return [...byAgent.values()];
  }
  public async repoRootsByAgent(_subject: AuthenticatedSubject, query: ReportQuery): Promise<ShiftRepoRootRecord[]> {
    const bySession = new Map<string, { record: ShiftRepoRootRecord; authoredAt: Date }>();
    for (const commit of this.commits) {
      if (commit.agentSessionId === undefined || commit.repoRoot === undefined) continue;
      if (query.userId !== undefined && commit.userId !== query.userId) continue;
      if (query.projectId !== undefined && commit.projectId !== query.projectId) continue;
      if (query.unassignedOnly === true && commit.projectId !== null) continue;
      if (query.from !== undefined && commit.authoredAt < query.from) continue;
      if (query.toExclusive !== undefined && commit.authoredAt >= query.toExclusive) continue;
      const existing = bySession.get(commit.agentSessionId);
      if (existing !== undefined && existing.authoredAt <= commit.authoredAt) continue;
      bySession.set(commit.agentSessionId, {
        record: { agentId: commit.agentId, agentSessionId: commit.agentSessionId, repoRoot: commit.repoRoot },
        authoredAt: commit.authoredAt,
      });
    }
    return [...bySession.values()].map((entry) => entry.record);
  }
  public async listForAgent(): ReturnType<ShiftCommitRepository["listForAgent"]> {
    throw new Error("not used");
  }
  public async listForOrganization(_subject: AuthenticatedSubject, query: ReportQuery): ReturnType<ShiftCommitRepository["listForOrganization"]> {
    let serial = 0;
    return this.commits
      .filter((commit) =>
        (query.from === undefined || commit.authoredAt >= query.from)
        && (query.toExclusive === undefined || commit.authoredAt < query.toExclusive))
      .map((commit) => ({
        id: `commit-${serial += 1}`,
        organizationId: "org",
        userId: commit.userId,
        agentId: commit.agentId,
        agentSessionId: commit.agentSessionId ?? "session-unset",
        clientId: `client-${serial}`,
        repoRoot: commit.repoRoot ?? "C:/dev/somewhere",
        branch: null,
        sha: "a".repeat(40),
        subject: commit.subject ?? "a commit",
        authoredAt: commit.authoredAt,
        verification: commit.verification,
        verifiedAt: null,
      }));
  }
}

type UsageSeed = {
  userId: string;
  agentId: string;
  agentSessionId: string;
  /** The session's runtime and the runtime's own id for it, which the usage is filed under. */
  source: string;
  externalSessionId: string;
  projectId: string | null;
  model: string | null;
  bucketStartAt: Date;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

function usageSeed(overrides: Partial<UsageSeed> = {}): UsageSeed {
  const agentSessionId = overrides.agentSessionId ?? "s1";
  return {
    userId: ids.user,
    agentId: ids.session,
    agentSessionId,
    source: "claude_code",
    externalSessionId: `${agentSessionId}-runtime-id`,
    projectId: ids.project,
    model: null,
    bucketStartAt: new Date("2026-08-06T14:00:00.000Z"),
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides,
  };
}

/** Mirrors the usage sums: same scope predicates as the commit tallies, bucketed by where a bucket's start falls. */
class Usage implements AgentUsageRepository {
  public lastBucketQuery: ReportQuery | null = null;
  public lastAgentQuery: ReportQuery | null = null;
  public constructor(public rows: UsageSeed[] = []) {}
  public async findByClientId(): ReturnType<AgentUsageRepository["findByClientId"]> {
    throw new Error("not used");
  }
  public async upsertBucket(): ReturnType<AgentUsageRepository["upsertBucket"]> {
    throw new Error("not used");
  }
  private scoped(query: ReportQuery): UsageSeed[] {
    return this.rows.filter((row) =>
      (query.userId === undefined || row.userId === query.userId)
      && (query.projectId === undefined || row.projectId === query.projectId)
      && (query.unassignedOnly !== true || row.projectId === null)
      && (query.from === undefined || row.bucketStartAt >= query.from)
      && (query.toExclusive === undefined || row.bucketStartAt < query.toExclusive));
  }
  public async sumByBucket(_subject: AuthenticatedSubject, query: ReportQuery): Promise<AgentUsageBucketTotalRecord[]> {
    this.lastBucketQuery = query;
    const byBucket = new Map<number, AgentUsageBucketTotalRecord>();
    for (const row of this.scoped(query)) {
      const key = row.bucketStartAt.getTime();
      const record = byBucket.get(key) ?? {
        bucketStartAt: row.bucketStartAt,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      record.inputTokens = (record.inputTokens as number) + row.inputTokens;
      record.outputTokens = (record.outputTokens as number) + row.outputTokens;
      record.cacheCreationInputTokens = (record.cacheCreationInputTokens as number) + row.cacheCreationInputTokens;
      record.cacheReadInputTokens = (record.cacheReadInputTokens as number) + row.cacheReadInputTokens;
      byBucket.set(key, record);
    }
    return [...byBucket.values()];
  }
  public projectNames = new Map<string, string>([[ids.project, "Timer"], [ids.otherProject, "Field"]]);
  public projectBucketReads = 0;
  public async sumByBucketAndProject(_subject: AuthenticatedSubject, query: ReportQuery): Promise<AgentUsageProjectBucketTotalRecord[]> {
    this.projectBucketReads += 1;
    const byKey = new Map<string, AgentUsageProjectBucketTotalRecord>();
    for (const row of this.scoped(query)) {
      const key = `${row.bucketStartAt.getTime()}:${row.projectId}`;
      const record = byKey.get(key) ?? {
        bucketStartAt: row.bucketStartAt,
        project: row.projectId === null ? null : { id: row.projectId, name: this.projectNames.get(row.projectId) ?? "Unnamed" },
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      record.inputTokens = (record.inputTokens as number) + row.inputTokens;
      record.outputTokens = (record.outputTokens as number) + row.outputTokens;
      record.cacheCreationInputTokens = (record.cacheCreationInputTokens as number) + row.cacheCreationInputTokens;
      record.cacheReadInputTokens = (record.cacheReadInputTokens as number) + row.cacheReadInputTokens;
      byKey.set(key, record);
    }
    return [...byKey.values()];
  }
  public async sumBySession(_subject: AuthenticatedSubject, query: ReportQuery): Promise<AgentUsageSessionTotalsRecord[]> {
    const bySession = new Map<string, Pick<UsageSeed, "agentSessionId" | "userId" | "source" | "externalSessionId" | "inputTokens" | "outputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens">>();
    for (const row of this.scoped(query)) {
      const totals = bySession.get(row.agentSessionId) ?? {
        agentSessionId: row.agentSessionId,
        userId: row.userId,
        source: row.source,
        externalSessionId: row.externalSessionId,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      totals.inputTokens += row.inputTokens;
      totals.outputTokens += row.outputTokens;
      totals.cacheCreationInputTokens += row.cacheCreationInputTokens;
      totals.cacheReadInputTokens += row.cacheReadInputTokens;
      bySession.set(row.agentSessionId, totals);
    }
    // Strings, the way postgres hands a sum back.
    return [...bySession.values()].map((totals) => ({
      ...totals,
      inputTokens: String(totals.inputTokens),
      outputTokens: String(totals.outputTokens),
      cacheCreationInputTokens: String(totals.cacheCreationInputTokens),
      cacheReadInputTokens: String(totals.cacheReadInputTokens),
    }));
  }
  public async sumByAgent(_subject: AuthenticatedSubject, query: ReportQuery): Promise<AgentUsageTotalsRecord[]> {
    this.lastAgentQuery = query;
    const byAgent = new Map<string, AgentUsageTotalsRecord>();
    for (const row of this.scoped(query)) {
      const record = byAgent.get(row.agentId) ?? {
        agentId: row.agentId,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        rowCount: 0,
      };
      record.inputTokens = (record.inputTokens as number) + row.inputTokens;
      record.outputTokens = (record.outputTokens as number) + row.outputTokens;
      record.cacheCreationInputTokens = (record.cacheCreationInputTokens as number) + row.cacheCreationInputTokens;
      record.cacheReadInputTokens = (record.cacheReadInputTokens as number) + row.cacheReadInputTokens;
      record.rowCount = (record.rowCount as number) + 1;
      byAgent.set(row.agentId, record);
    }
    return [...byAgent.values()];
  }
  public async sumByAgentAndModel(): Promise<AgentUsageModelTotalsRecord[]> {
    throw new Error("not used");
  }
}

/** The token fields an hour nothing reported for carries: nulls, never an invented zero. */
const nullTokens = { inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null };

/** The token block an agent with no usage rows in range carries: zeros under tokensReported false. */
const noTokens = {
  tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  tokensReported: false,
};

/** A /me/stats card with nothing measured: the split and the breakdown are still its own. */
const noMeasurement = {
  activeSeconds: 0,
  agentSeconds: 0,
  concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
  byAgent: [] as never[],
};

/**
 * A board row with nothing measured. The concurrency split and the per-agent
 * breakdown are deliberately absent here: no client ever read either off a
 * board row, and both now ride only on /me/stats, where they are rendered.
 */
const noBoardMeasurement = {
  activeSeconds: 0,
  agentSeconds: 0,
};

describe("report service", () => {
  it("scopes report queries to the authenticated organization and normalizes inclusive UTC calendar bounds", async () => {
    const reports = new Reports([row({ id: ids.otherProject, durationSeconds: 60, startedAt: new Date("2026-08-06T16:00:00.000Z") }), row()]);
    const service = createReportService({ reports, agents });

    await expect(service.list(subject, { from: "2026-08-01", to: "2026-08-06", projectId: ids.project, userId: ids.user, page: 1, pageSize: 50 })).resolves.toMatchObject({
      filters: { from: "2026-08-01", to: "2026-08-06", projectId: ids.project, userId: ids.user, page: 1, pageSize: 50 },
      totalDurationSeconds: 3_600,
      rows: [{ id: ids.otherProject }, { id: ids.session }],
    });
    expect(reports.lastPage).toEqual({
      query: {
        from: new Date("2026-08-01T00:00:00.000Z"),
        toExclusive: new Date("2026-08-07T00:00:00.000Z"),
        projectId: ids.project,
        userId: ids.user,
      },
      options: { limit: 50, offset: 0 },
    });
  });

  it("returns an empty report with a zero total", async () => {
    await expect(createReportService({ reports: new Reports(), agents }).list(subject, { page: 1, pageSize: 50 })).resolves.toEqual({ filters: { page: 1, pageSize: 50 }, totalDurationSeconds: 0, pagination: { page: 1, pageSize: 50, totalRows: 0, totalPages: 0 }, rows: [] });
  });

  it("passes device-local instant bounds as an exact clipped report range", async () => {
    const reports = new Reports([row()]);
    const service = createReportService({ reports, agents });

    const result = await service.list(subject, {
      fromAt: "2026-03-08T06:00:00.000Z",
      toExclusiveAt: "2026-03-09T05:00:00.000Z",
      page: 1,
      pageSize: 50,
    });

    expect(result.filters).toMatchObject({
      fromAt: "2026-03-08T06:00:00.000Z",
      toExclusiveAt: "2026-03-09T05:00:00.000Z",
    });
    expect(reports.lastPage?.query).toEqual({
      from: new Date("2026-03-08T06:00:00.000Z"),
      toExclusive: new Date("2026-03-09T05:00:00.000Z"),
    });
  });

  it("rejects reversed or excessive date ranges", async () => {
    const service = createReportService({ reports: new Reports(), agents });
    await expect(service.list(subject, { from: "2026-08-07", to: "2026-08-06", page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "validation_error" });
    await expect(service.list(subject, { from: "2025-01-01", to: "2026-01-02", page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "validation_error" });
  });

  it("defends the repository from pathological page offsets", async () => {
    const service = createReportService({ reports: new Reports(), agents });
    await expect(service.list(subject, { page: 10_001, pageSize: 1 } as ReportFilters)).rejects.toMatchObject({ code: "validation_error" });
  });

  it("returns stable not_found for project and user filters outside the subject organization", async () => {
    const service = createReportService({ reports: new Reports([], new Set()), agents });
    await expect(service.list(subject, { projectId: ids.otherProject, page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "not_found", message: "Project not found." });
    await expect(service.list(subject, { userId: ids.otherUser, page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "not_found", message: "User not found." });
  });

  it("rejects unsafe report duration totals", async () => {
    const service = createReportService({ reports: new Reports([row({ durationSeconds: Number.MAX_SAFE_INTEGER }), row({ id: ids.otherProject, durationSeconds: 1 })]), agents });
    await expect(service.list(subject, { page: 1, pageSize: 50 })).rejects.toThrow(RangeError);
  });

  it("uses the exact filtered summary while returning only the requested deterministic page", async () => {
    const reports = new Reports([
      row({ id: "b1c7e513-b094-4d4c-ae55-21790ae019a4", startedAt: new Date("2026-08-06T14:00:00.000Z") }),
      row({ id: "a1c7e513-b094-4d4c-ae55-21790ae019a4", startedAt: new Date("2026-08-06T14:00:00.000Z"), durationSeconds: 60 }),
    ]);
    const result = await createReportService({ reports, agents }).list(subject, { page: 2, pageSize: 1 });

    expect(result).toMatchObject({
      totalDurationSeconds: 3_600,
      pagination: { page: 2, pageSize: 1, totalRows: 2, totalPages: 2 },
      rows: [{ id: "a1c7e513-b094-4d4c-ae55-21790ae019a4" }],
    });
  });

  it("uses one snapshot read for export and rejects an oversized export before row materialization", async () => {
    const oversized = new Reports();
    oversized.readExportForOrganization = async () => {
      oversized.exportReads += 1;
      return { summary: { totalRows: 10_001, totalDurationSeconds: 0 }, rows: [] };
    };
    const oversizedService = createReportService({ reports: oversized, agents });
    await expect(oversizedService.export(subject, { page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "validation_error" });
    expect(oversized.exportReads).toBe(1);

    const exported = new Reports([row()]);
    const exportService = createReportService({ reports: exported, agents });
    const result = await exportService.export(subject, { page: 1, pageSize: 50 });
    expect(result.rows).toHaveLength(1);
    expect(exported.exportReads).toBe(1);
  });

  it("splits each row into attributed and unattributed by how it learned its project", async () => {
    const reports = new Reports([
      row({ attribution: "agent" }),
      row({ id: ids.otherProject, attribution: "default" }),
      row({ id: ids.session, attribution: "manual" }),
    ]);
    const result = await createReportService({ reports, agents }).list(subject, { page: 1, pageSize: 50 });

    expect(result.rows.map((record) => [record.attributedSeconds, record.unattributedSeconds])).toEqual([
      [3_540, 0],
      [0, 3_540],
      [3_540, 0],
    ]);
  });

  it("never lets a row's two halves disagree with its duration", async () => {
    const reports = new Reports([row({ durationSeconds: 3_540, attribution: "default" })]);
    const result = await createReportService({ reports, agents }).list(subject, { page: 1, pageSize: 50 });

    const [only] = result.rows;
    expect((only?.attributedSeconds ?? 0) + (only?.unattributedSeconds ?? 0)).toBe(only?.durationSeconds);
  });
});

describe("leaderboard", () => {
  const entry = (id: string, name: string, durationSeconds: number | string | null, sessionCount: number, attributedSeconds: number | string | null = 0): LeaderboardRowRecord => ({
    user: { id, name },
    durationSeconds,
    sessionCount,
    attributedSeconds,
  });

  it("ranks members by recorded time and totals the organization", async () => {
    const reports = new Reports();
    reports.leaderboardRows = [
      entry(ids.user, "Alex", 7_200, 3, 5_400),
      entry(ids.otherUser, "Sam", 3_600, 1, "3600"),
    ];
    const service = createReportService({ reports, agents });

    const result = await service.leaderboard(subject, {});

    expect(result.entries).toEqual([
      { rank: 1, user: { id: ids.user, name: "Alex" }, durationSeconds: 7_200, sessionCount: 3, attributedSeconds: 5_400, unattributedSeconds: 1_800, ...noBoardMeasurement },
      { rank: 2, user: { id: ids.otherUser, name: "Sam" }, durationSeconds: 3_600, sessionCount: 1, attributedSeconds: 3_600, unattributedSeconds: 0, ...noBoardMeasurement },
    ]);
    expect(result.totalDurationSeconds).toBe(10_800);
    expect(result.medianSessionSeconds).toBeNull();
  });

  it("ranks by active wall-clock time and keeps agent parallelism out of the hours", async () => {
    const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
    const reports = new Reports();
    reports.leaderboardRows = [
      entry(ids.user, "Alex", 3_600, 1, 3_600),
      entry(ids.otherUser, "Sam", 7_200, 2, 7_200),
    ];
    // Alex: present two hours straight, three agents in parallel for the first.
    reports.presenceIntervals = [
      { user: { id: ids.user, name: "Alex" }, startedAt: hour(9), endedAt: hour(11) },
      { user: { id: ids.otherUser, name: "Sam" }, startedAt: hour(9), endedAt: hour(10) },
    ];
    reports.sessionIntervals = [
      { user: { id: ids.user, name: "Alex" }, projectId: ids.project, attribution: "agent", startedAt: hour(9), stoppedAt: hour(11) },
      { user: { id: ids.otherUser, name: "Sam" }, projectId: ids.project, attribution: "selected", startedAt: hour(9), stoppedAt: hour(10) },
    ];
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: null, agentRepoRoot: null, agentRepoKey: null, startedAt: hour(9), endedAt: hour(10) },
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: null, agentRepoRoot: null, agentRepoKey: null, startedAt: hour(9), endedAt: hour(10) },
      { user: { id: ids.user, name: "Alex" }, source: "codex", model: null, cwd: null, projectId: ids.project, agentId: null, agentRepoRoot: null, agentRepoKey: null, startedAt: hour(9), endedAt: hour(10) },
    ];
    const service = createReportService({ reports, agents });

    const result = await service.leaderboard(subject, {});

    // Alex worked 2h of wall clock; 3h of agent runtime never inflates it.
    const [alex, sam] = result.entries;
    expect(alex?.user.name).toBe("Alex");
    expect(alex?.rank).toBe(1);
    expect(alex?.activeSeconds).toBe(7_200);
    expect(alex?.agentSeconds).toBe(10_800);
    // The split and the per-agent breakdown are the person's own card, read
    // from the same intervals over the same window, so the board and the card
    // cannot disagree about the hours they share.
    const own = await service.meStats(subject, {});
    expect(own.activeSeconds).toBe(alex?.activeSeconds);
    expect(own.agentSeconds).toBe(alex?.agentSeconds);
    expect(own.concurrency).toEqual({ t0Seconds: 3_600, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 3_600, awaySeconds: 0 });
    // The by-agent split sums to agent time, never to active time.
    expect(own.byAgent).toEqual([
      { source: "claude_code", model: null, durationSeconds: 7_200, sessionCount: 2, maxConcurrent: 2, medianSeconds: 3_600 },
      { source: "codex", model: null, durationSeconds: 3_600, sessionCount: 1, maxConcurrent: 1, medianSeconds: 3_600 },
    ]);
    expect(sam?.rank).toBe(2);
    expect(sam?.activeSeconds).toBe(3_600);
    expect(result.medianSessionSeconds).toBe(5_400);
  });

  // The audit's regression: a browser span held open across a person's
  // presence reclassified every one of those hours as agent-assisted. A tab
  // is attention, not an agent, so the split must read exactly as if the span
  // were not there.
  it("keeps browser spans out of the concurrency split, the roster's own rule", async () => {
    const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
    const reports = new Reports();
    reports.leaderboardRows = [entry(ids.user, "Alex", 7_200, 1, 7_200)];
    reports.presenceIntervals = [
      { user: { id: ids.user, name: "Alex" }, startedAt: hour(9), endedAt: hour(11) },
    ];
    reports.sessionIntervals = [
      { user: { id: ids.user, name: "Alex" }, projectId: ids.project, attribution: "selected", startedAt: hour(9), stoppedAt: hour(11) },
    ];
    reports.agentIntervals = [
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "browser", model: null, cwd: null, projectId: ids.project, agentId: null, agentRepoRoot: null, agentRepoKey: null, startedAt: hour(9), endedAt: hour(11) },
    ];
    const service = createReportService({ reports, agents });

    const result = await service.leaderboard(subject, {});

    const [alex] = result.entries;
    expect(alex?.activeSeconds).toBe(7_200);
    expect(alex?.agentSeconds).toBe(0);
    const own = await service.meStats(subject, {});
    expect(own.concurrency).toEqual({ t0Seconds: 7_200, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 });
    expect(own.byAgent).toEqual([]);
  });

  // The Overlord's report: a day whose header said unattended agent time was
  // included while the board's Agent column read 0s. The two numbers come from
  // different tables - `recorded` is whole `time_sessions`, agent seconds are
  // measured `agent_sessions` - and the header asserted the gap between
  // recorded and active *was* agent time without ever consulting the
  // measurement. Whenever a member really does have both in one window, the
  // board must carry the agent seconds and the split must reconcile against
  // them; there is nothing else for the header to read.
  it("reports agent seconds on the board when a member has human and agent time in one window", async () => {
    const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
    const reports = new Reports();
    // Recorded is 3h of whole sessions; the person was at the keyboard for 1h
    // of it, which is exactly the shape that produced the report.
    reports.leaderboardRows = [entry(ids.user, "Alex", 10_800, 1, 10_800)];
    reports.presenceIntervals = [
      { user: { id: ids.user, name: "Alex" }, startedAt: hour(9), endedAt: hour(10) },
    ];
    reports.sessionIntervals = [
      { user: { id: ids.user, name: "Alex" }, projectId: ids.project, attribution: "agent", startedAt: hour(9), stoppedAt: hour(12) },
    ];
    reports.agentIntervals = [
      // One shift through the person's hour, one entirely after they left.
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: null, agentRepoRoot: null, agentRepoKey: null, startedAt: hour(9), endedAt: hour(10) },
      { sessionId: "s2", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: null, agentRepoRoot: null, agentRepoKey: null, startedAt: hour(10), endedAt: hour(12) },
    ];
    const service = createReportService({ reports, agents });

    const result = await service.leaderboard(subject, { fromAt: hour(9).toISOString(), toExclusiveAt: hour(12).toISOString() });

    const [alex] = result.entries;
    // Not zero, and not folded into the hours: 3h of runtime beside 1h at the desk.
    expect(alex?.activeSeconds).toBe(3_600);
    expect(alex?.agentSeconds).toBe(10_800);
    // /me/stats measures the same window from the same reads, so a member's
    // own card can never disagree with their row on the board - and the split
    // that reconciles against the board's numbers is the card's.
    const own = await service.meStats(subject, { fromAt: hour(9).toISOString(), toExclusiveAt: hour(12).toISOString() });
    expect(own.agentSeconds).toBe(alex?.agentSeconds);
    expect(own.activeSeconds).toBe(alex?.activeSeconds);
    const split = own.concurrency;
    // active = t0 + t1 + t2 + t3plus, the split's own contract.
    expect(split.t0Seconds + split.t1Seconds + split.t2Seconds + split.t3PlusSeconds).toBe(alex!.activeSeconds);
    // agent = Sum(n x tn) + away: the hour they overlapped plus the two they did not.
    expect(split.t1Seconds + 2 * split.t2Seconds + 3 * split.t3PlusSeconds + split.awaySeconds).toBe(alex!.agentSeconds);
    expect(split.awaySeconds).toBe(7_200);
    // The 2h gap between recorded and active is what the header explains, and
    // the measured away runtime is what it may claim of that gap - never the
    // gap itself, and never anything when no agent was measured.
    expect(alex!.durationSeconds - alex!.activeSeconds).toBe(7_200);
  });

  it("shares a rank between members with identical totals", async () => {
    const reports = new Reports();
    reports.leaderboardRows = [
      entry(ids.user, "Alex", 3_600, 2),
      entry(ids.otherUser, "Sam", 3_600, 1),
      entry(ids.project, "Jo", 60, 1),
    ];
    const service = createReportService({ reports, agents });

    const result = await service.leaderboard(subject, {});

    expect(result.entries.map((row) => row.rank)).toEqual([1, 1, 3]);
  });

  it("lists every member on a scoped board, at zero when the scope has none of their time", async () => {
    const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
    const reports = new Reports();
    // Alex worked in the scoped project; Sam only had the machine on.
    reports.presenceIntervals = [
      { user: { id: ids.user, name: "Alex" }, startedAt: hour(9), endedAt: hour(10) },
      { user: { id: ids.otherUser, name: "Sam" }, startedAt: hour(9), endedAt: hour(11) },
    ];
    reports.sessionIntervals = [
      { user: { id: ids.user, name: "Alex" }, projectId: ids.project, attribution: "selected", startedAt: hour(9), stoppedAt: hour(10) },
    ];
    const service = createReportService({ reports, agents });

    const result = await service.leaderboard(subject, { scope: ids.project });

    // A teammate outside the scope reads as a zero row, never as missing.
    expect(result.entries.map((entry) => [entry.user.name, entry.activeSeconds])).toEqual([
      ["Alex", 3_600],
      ["Sam", 0],
    ]);
    expect(reports.lastLeaderboardQuery?.projectId).toBe(ids.project);
  });

  it("lists a roster member with no recorded time at all as a zero row", async () => {
    const reports = new Reports();
    reports.roster = [
      { id: ids.user, name: "Alex", pictureVersion: null },
      { id: ids.otherUser, name: "Sam", pictureVersion: null },
    ];
    const service = createReportService({ reports, agents });

    const result = await service.leaderboard(subject, {});

    expect(result.entries.map((entry) => [entry.user.name, entry.activeSeconds, entry.agentSeconds])).toEqual([
      ["Alex", 0, 0],
      ["Sam", 0, 0],
    ]);
  });

  it("names a roster-only member by id and name alone, whatever else the roster read carries", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex", pictureVersion: "1111111111111111" }];
    const service = createReportService({ reports, agents });

    const result = await service.leaderboard(subject, {});

    // The board's schema is strict: a picture version riding along would fail its route.
    expect(result.entries.map((entry) => entry.user)).toEqual([{ id: ids.user, name: "Alex" }]);
  });

  it("maps the unassigned scope onto default-attributed sessions", async () => {
    const reports = new Reports();
    const service = createReportService({ reports, agents });

    await service.leaderboard(subject, { scope: "unassigned" });

    expect(reports.lastLeaderboardQuery?.unassignedOnly).toBe(true);
    expect(reports.lastLeaderboardQuery?.projectId).toBeUndefined();
  });

  it("refuses a scope naming a project outside the workspace", async () => {
    const service = createReportService({ reports: new Reports([], new Set()), agents });

    await expect(service.leaderboard(subject, { scope: ids.otherProject }))
      .rejects.toMatchObject({ code: "not_found", message: "Project not found." });
  });

  it("carries the dashboard scope into the session list and the export", async () => {
    const reports = new Reports();
    const service = createReportService({ reports, agents });

    await service.list(subject, { scope: ids.project, page: 1, pageSize: 50 });
    expect(reports.lastPage?.query.projectId).toBe(ids.project);

    await service.export(subject, { scope: "unassigned", page: 1, pageSize: 50 });
    // The export reads through the same scoped query the board does.
    expect(reports.exportReads).toBe(1);
  });

  it("reads postgres sum strings and a null total without losing precision", async () => {
    const reports = new Reports();
    reports.leaderboardRows = [entry(ids.user, "Alex", "9007199254740990", 2), entry(ids.otherUser, "Sam", null, 0, null)];
    const service = createReportService({ reports, agents });

    const result = await service.leaderboard(subject, {});

    expect(result.entries[0]?.durationSeconds).toBe(9_007_199_254_740_990);
    expect(result.entries[1]?.durationSeconds).toBe(0);
    expect(result.entries[1]?.attributedSeconds).toBe(0);
    expect(result.entries[1]?.unattributedSeconds).toBe(0);
  });

  it("applies the same inclusive calendar bounds the reports use", async () => {
    const reports = new Reports();
    const service = createReportService({ reports, agents });

    await service.leaderboard(subject, { from: "2026-08-01", to: "2026-08-06" });

    expect(reports.lastLeaderboardQuery?.from).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(reports.lastLeaderboardQuery?.toExclusive).toEqual(new Date("2026-08-07T00:00:00.000Z"));
  });

  it("uses device-local instant bounds for clipped leaderboard totals", async () => {
    const reports = new Reports();
    const service = createReportService({ reports, agents });

    await service.leaderboard(subject, {
      fromAt: "2026-03-08T06:00:00.000Z",
      toExclusiveAt: "2026-03-09T05:00:00.000Z",
    });

    expect(reports.lastLeaderboardQuery).toEqual({
      from: new Date("2026-03-08T06:00:00.000Z"),
      toExclusive: new Date("2026-03-09T05:00:00.000Z"),
    });
  });

  it("rejects a range wider than a year and returns an empty board for no activity", async () => {
    const reports = new Reports();
    const service = createReportService({ reports, agents });

    await expect(service.leaderboard(subject, { from: "2024-01-01", to: "2026-01-01" })).rejects.toMatchObject({
      code: "validation_error",
    });
    await expect(service.leaderboard(subject, {})).resolves.toEqual({
      filters: {},
      totalDurationSeconds: 0,
      medianSessionSeconds: null,
      entries: [],
    });
  });
});

describe("workspace report", () => {
  const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
  const oneDay = { fromAt: "2026-08-05T00:00:00.000Z", toExclusiveAt: "2026-08-06T00:00:00.000Z" };
  const alex = { id: ids.user, name: "Alex" };
  const sam = { id: ids.otherUser, name: "Sam" };
  const riley = { id: "21c7e513-b094-4d4c-ae55-21790ae019a4", name: "Riley" };
  const timer = { id: ids.project, name: "Timer" };
  const side = { id: ids.otherProject, name: "Side" };
  const agentRun = (user: { id: string; name: string }, source: string, start: Date, end: Date): AgentIntervalRecord => ({
    sessionId: `${user.id}-${source}-${start.toISOString()}`,
    user,
    source,
    model: null,
    cwd: null,
    projectId: ids.project,
    agentId: null,
    agentRepoRoot: null,
    agentRepoKey: null,
    externalSessionId: `${user.id}-${source}-${start.toISOString()}-runtime-id`,
    startedAt: start,
    endedAt: end,
  });

  /** Alex works 9-11 with two agents through 9-10; Sam works 9-10 with one agent through 10-12; Riley records nothing. */
  const team = (): Reports => {
    const reports = new Reports();
    reports.roster = [
      { ...alex, pictureVersion: "1111111111111111" },
      { ...sam, pictureVersion: null },
      { ...riley, pictureVersion: "3333333333333333" },
    ];
    reports.leaderboardRows = [
      { user: alex, durationSeconds: 7_200, sessionCount: 2, attributedSeconds: 7_200 },
      { user: sam, durationSeconds: 4_200, sessionCount: 2, attributedSeconds: 4_200 },
    ];
    reports.presenceIntervals = [
      { user: alex, startedAt: hour(9), endedAt: hour(11) },
      { user: sam, startedAt: hour(9), endedAt: hour(10) },
    ];
    reports.agentIntervals = [
      agentRun(alex, "claude_code", hour(9), hour(10)),
      agentRun(alex, "codex", hour(9), hour(10)),
      agentRun(sam, "codex", hour(10), hour(12)),
    ];
    reports.memberProjectTotals = [
      { userId: alex.id, project: timer, durationSeconds: "5400" },
      { userId: alex.id, project: side, durationSeconds: 1_800 },
      { userId: sam.id, project: side, durationSeconds: 3_600 },
      { userId: sam.id, project: timer, durationSeconds: 600 },
    ];
    return reports;
  };

  it("adds the team's totals, graph, projects and agents up on the server", async () => {
    const service = createReportService({ reports: team(), agents });

    const result = await service.workspace(subject, oneDay);

    expect(result.filters).toEqual(oneDay);
    // Team hours: Alex's two and Sam's one, though Sam's hour is one Alex also worked.
    expect(result.activeSeconds).toBe(10_800);
    expect(result.agentSeconds).toBe(14_400);
    expect(result.hourly).toHaveLength(24);
    expect(result.hourly[8]).toEqual({ hourStart: hour(8).toISOString(), activeSeconds: 0, agentSeconds: 0 });
    expect(result.hourly[9]).toEqual({ hourStart: hour(9).toISOString(), activeSeconds: 7_200, agentSeconds: 7_200 });
    expect(result.hourly[10]).toEqual({ hourStart: hour(10).toISOString(), activeSeconds: 3_600, agentSeconds: 3_600 });
    expect(result.hourly[11]).toEqual({ hourStart: hour(11).toISOString(), activeSeconds: 0, agentSeconds: 3_600 });
    expect(result.projects).toEqual([
      { project: { ...timer, ...DEFAULT_PROJECT_APPEARANCE }, durationSeconds: 6_000 },
      { project: { ...side, ...projectAppearance({ id: side.id, isDefault: false, icon: null, color: null }) }, durationSeconds: 5_400 },
    ]);
    expect(result.agents).toEqual([
      { source: "codex", durationSeconds: 10_800 },
      { source: "claude_code", durationSeconds: 3_600 },
    ]);
    expect(result.members).toEqual([
      { rank: 1, user: { ...alex, pictureVersion: "1111111111111111" }, activeSeconds: 7_200, agentSeconds: 7_200, project: timer },
      { rank: 2, user: { ...sam, pictureVersion: null }, activeSeconds: 3_600, agentSeconds: 7_200, project: side },
      { rank: 3, user: { ...riley, pictureVersion: "3333333333333333" }, activeSeconds: 0, agentSeconds: 0, project: null },
    ]);
  });

  it("lists the members the leaderboard lists, in its order and with its numbers, ties included", async () => {
    const reports = team();
    // Sam now matches Alex on every ranking key, so the two share a rank.
    reports.presenceIntervals = [
      { user: alex, startedAt: hour(9), endedAt: hour(11) },
      { user: sam, startedAt: hour(12), endedAt: hour(14) },
    ];
    reports.leaderboardRows = [
      { user: alex, durationSeconds: 7_200, sessionCount: 2, attributedSeconds: 7_200 },
      { user: sam, durationSeconds: 7_200, sessionCount: 2, attributedSeconds: 7_200 },
    ];
    const service = createReportService({ reports, agents });

    const [workspace, board] = await Promise.all([service.workspace(subject, oneDay), service.leaderboard(subject, oneDay)]);

    expect(workspace.members.map(({ rank, user, activeSeconds, agentSeconds }) => ({ rank, userId: user.id, activeSeconds, agentSeconds })))
      .toEqual(board.entries.map(({ rank, user, activeSeconds, agentSeconds }) => ({ rank, userId: user.id, activeSeconds, agentSeconds })));
    expect(workspace.members.map((member) => member.rank)).toEqual([1, 1, 3]);
  });

  it("shows a workspace of one as one row, theirs, with totals and graph equal to their own card", async () => {
    const reports = team();
    reports.roster = reports.roster.filter((member) => member.id === alex.id);
    reports.leaderboardRows = reports.leaderboardRows.filter((row) => row.user.id === alex.id);
    reports.presenceIntervals = reports.presenceIntervals.filter((row) => row.user.id === alex.id);
    reports.agentIntervals = reports.agentIntervals.filter((row) => row.user.id === alex.id);
    reports.memberProjectTotals = reports.memberProjectTotals.filter((row) => row.userId === alex.id);
    const service = createReportService({ reports, agents });

    const [workspace, card] = await Promise.all([service.workspace(subject, oneDay), service.meStats(subject, oneDay)]);

    expect(workspace.members).toEqual([{ rank: 1, user: { ...alex, pictureVersion: "1111111111111111" }, activeSeconds: 7_200, agentSeconds: 7_200, project: timer }]);
    expect(workspace.activeSeconds).toBe(card.activeSeconds);
    expect(workspace.agentSeconds).toBe(card.agentSeconds);
    expect(workspace.hourly).toEqual(card.hourly.map(({ hourStart, activeSeconds, agentSeconds }) => ({ hourStart, activeSeconds, agentSeconds })));
  });

  it("narrows every part to a project scope the way the board does", async () => {
    const reports = team();
    reports.sessionIntervals = [
      { user: alex, projectId: ids.project, attribution: "selected", startedAt: hour(10), stoppedAt: hour(11) },
    ];
    const service = createReportService({ reports, agents });

    const result = await service.workspace(subject, { ...oneDay, scope: ids.project });

    // Presence carries no project, so the scope keeps only the hour Alex's session was open.
    expect(result.activeSeconds).toBe(3_600);
    expect(result.hourly[9]?.activeSeconds).toBe(0);
    expect(result.hourly[10]?.activeSeconds).toBe(3_600);
    expect(reports.lastMemberProjectTotalsQuery).toEqual({
      from: new Date(oneDay.fromAt),
      toExclusive: new Date(oneDay.toExclusiveAt),
      projectId: ids.project,
    });
  });

  it("refuses a project from outside the caller's workspace before reading anything", async () => {
    const reports = team();
    const service = createReportService({ reports, agents });

    await expect(service.workspace(subject, { ...oneDay, scope: "91c7e513-b094-4d4c-ae55-21790ae019a4" }))
      .rejects.toMatchObject({ code: "not_found", message: "Project not found." });
    expect(reports.lastMemberProjectTotalsQuery).toBeNull();
  });

  it("draws no graph over all time and still adds the rest up", async () => {
    const service = createReportService({ reports: team(), agents });

    const result = await service.workspace(subject, {});

    expect(result.hourly).toEqual([]);
    expect(result.activeSeconds).toBe(10_800);
    expect(result.members).toHaveLength(3);
  });

  it("draws each project row with its picked pair, else its assigned one, and the default project's own by the report rule", async () => {
    const reports = team();
    const ledger = { id: "c2c7e513-b094-4d4c-ae55-21790ae019a4", name: "Ledger" };
    // The rule's answer, not a flag: Timer is the oldest active project here.
    reports.defaultProject = timer;
    reports.memberProjectTotals = [
      { userId: alex.id, project: { ...timer, icon: null, color: null }, durationSeconds: 5_400 },
      { userId: sam.id, project: { ...side, icon: "rocket", color: "#85c6ff" }, durationSeconds: 3_600 },
      { userId: riley.id, project: { ...ledger, icon: null, color: null }, durationSeconds: 1_800 },
    ];
    const service = createReportService({ reports, agents });

    const result = await service.workspace(subject, oneDay);

    expect(result.projects).toEqual([
      { project: { ...timer, ...DEFAULT_PROJECT_APPEARANCE }, durationSeconds: 5_400 },
      { project: { ...side, icon: "rocket", color: "#85c6ff" }, durationSeconds: 3_600 },
      { project: { ...ledger, ...projectAppearance({ id: ledger.id, isDefault: false, icon: null, color: null }) }, durationSeconds: 1_800 },
    ]);
    // A board row names its project alone; the pair belongs to the project rows.
    expect(result.members.map((member) => member.project)).toEqual([timer, side, ledger]);
  });
});

describe("time series", () => {
  const hourMs = 60 * 60 * 1_000;
  const dayMs = 24 * hourMs;
  const rangeStart = Date.UTC(2026, 7, 1, 4);

  it.each([
    { name: "hours across ninety days", bucketMs: hourMs, rangeEnd: rangeStart + 90 * dayMs, tileCount: 2_160 },
    { name: "days across a range with a spare daylight-saving hour", bucketMs: dayMs, rangeEnd: rangeStart + 40 * dayMs + hourMs, tileCount: 40 },
  ])("matches the plain union and sum per tile over $name", ({ bucketMs, rangeEnd, tileCount }) => {
    // Arrange: many overlapping, unsorted intervals and usage buckets, some
    // crossing tile edges and some reaching past either end of the range.
    const spanMs = rangeEnd - rangeStart + 4 * hourMs;
    const spread = (index: number, multiplier: number, maxLengthMs: number): Interval => {
      const start = rangeStart - 2 * hourMs + ((index * multiplier) % spanMs);
      return { start, end: start + ((index * 104_729) % maxLengthMs) };
    };
    const working = [
      ...Array.from({ length: 600 }, (_, index) => spread(index, 1_000_003_987, 3 * hourMs)),
      { start: rangeStart + 5 * dayMs + 30 * 60 * 1_000, end: rangeStart + 7 * dayMs + 10 * 60 * 1_000 },
    ];
    const agents = [
      ...Array.from({ length: 400 }, (_, index) => spread(index, 2_999_999_929, 10 * hourMs)),
      { start: rangeStart - dayMs, end: rangeEnd + dayMs },
      { start: rangeStart - dayMs, end: rangeStart },
      { start: rangeEnd, end: rangeEnd + hourMs },
    ];
    const usage: AgentUsageBucketTotalRecord[] = Array.from({ length: 300 }, (_, index) => ({
      bucketStartAt: new Date(spread(index, 1_999_999_973, 1).start),
      inputTokens: index,
      outputTokens: 1,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: String(index * 10),
    }));
    const expected = Array.from({ length: tileCount }, (_, tileIndex) => {
      const tile = {
        start: rangeStart + tileIndex * bucketMs,
        end: tileIndex === tileCount - 1 ? rangeEnd : rangeStart + (tileIndex + 1) * bucketMs,
      };
      const indices = usage.flatMap((bucket, index) =>
        bucket.bucketStartAt.getTime() >= tile.start && bucket.bucketStartAt.getTime() < tile.end ? [index] : []);
      const indexSum = indices.reduce((sum, index) => sum + index, 0);
      return {
        hourStart: new Date(tile.start).toISOString(),
        activeSeconds: unionSeconds(working, tile),
        agentSeconds: summedSeconds(agents, tile),
        inputTokens: indices.length === 0 ? null : indexSum,
        outputTokens: indices.length === 0 ? null : indices.length,
        cacheCreationInputTokens: indices.length === 0 ? null : 0,
        cacheReadInputTokens: indices.length === 0 ? null : indexSum * 10,
      };
    });

    // Act
    const series = timeSeries(working, agents, usage, { start: rangeStart, end: rangeEnd }, bucketMs);

    // Assert
    expect(series).toEqual(expected);
  });
});

describe("me/stats", () => {
  it("scopes per-project totals to the caller with inclusive calendar bounds", async () => {
    const reports = new Reports();
    reports.projectTotals = [
      { project: { id: ids.project, name: "Timer" }, durationSeconds: 7_200, attributedSeconds: 5_400, sessionCount: 2 },
      { project: { id: ids.otherProject, name: "Side" }, durationSeconds: "600", attributedSeconds: "600", sessionCount: 1 },
    ];
    reports.appTotals = [
      { processName: "Code.exe", durationSeconds: "4200" },
      { processName: "chrome.exe", durationSeconds: 1_800 },
    ];
    reports.siteTotals = [
      { mapping: { id: "01c7e513-b094-4d4c-ae55-21790ae019a4", pattern: "github.com/acme/*", projectId: ids.project }, durationSeconds: "900" },
    ];
    const service = createReportService({ reports, agents });

    const result = await service.meStats(subject, { from: "2026-08-01", to: "2026-08-06" });

    expect(result).toEqual({
      filters: { from: "2026-08-01", to: "2026-08-06" },
      totalDurationSeconds: 7_800,
      attributedSeconds: 6_000,
      unattributedSeconds: 1_800,
      ...noMeasurement,
      hourly: [],
      projects: [
        { project: { id: ids.project, name: "Timer" }, durationSeconds: 7_200, attributedSeconds: 5_400, unattributedSeconds: 1_800, sessionCount: 2 },
        { project: { id: ids.otherProject, name: "Side" }, durationSeconds: 600, attributedSeconds: 600, unattributedSeconds: 0, sessionCount: 1 },
      ],
      apps: [
        { processName: "Code.exe", durationSeconds: 4_200 },
        { processName: "chrome.exe", durationSeconds: 1_800 },
      ],
      sites: [
        { mapping: { id: "01c7e513-b094-4d4c-ae55-21790ae019a4", pattern: "github.com/acme/*", projectId: ids.project }, durationSeconds: 900 },
      ],
      agents: [],
    });
    // Without a userId filter, the repository read is pinned to the caller.
    expect(reports.lastProjectTotalsQuery).toEqual({
      from: new Date("2026-08-01T00:00:00.000Z"),
      toExclusive: new Date("2026-08-07T00:00:00.000Z"),
      userId: ids.user,
    });
    expect(reports.lastAppTotalsQuery).toEqual(reports.lastProjectTotalsQuery);
    expect(reports.lastSiteTotalsQuery).toEqual(reports.lastProjectTotalsQuery);
  });

  it("returns an empty stats response when the caller recorded nothing", async () => {
    const result = await createReportService({ reports: new Reports(), agents }).meStats(subject, {});

    expect(result).toEqual({ filters: {}, totalDurationSeconds: 0, attributedSeconds: 0, unattributedSeconds: 0, ...noMeasurement, hourly: [], projects: [], apps: [], sites: [], agents: [] });
  });

  it("buckets active and agent time by the caller's local hours, collapsing overlap but summing parallelism", async () => {
    const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
    const reports = new Reports();
    // Two overlapping presence intervals still count as one hour of presence
    // per wall-clock hour - the union, never the sum.
    reports.presenceIntervals = [
      { user: { id: ids.user, name: "Alex" }, startedAt: hour(9), endedAt: hour(11) },
      { user: { id: ids.user, name: "Alex" }, startedAt: new Date(Date.UTC(2026, 7, 5, 9, 30)), endedAt: new Date(Date.UTC(2026, 7, 5, 10, 30)) },
    ];
    // Two agents running in parallel count twice inside that hour.
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: null, agentRepoRoot: null, agentRepoKey: null, startedAt: hour(9), endedAt: hour(10) },
      { user: { id: ids.user, name: "Alex" }, source: "codex", model: null, cwd: null, projectId: ids.project, agentId: null, agentRepoRoot: null, agentRepoKey: null, startedAt: hour(9), endedAt: hour(10) },
    ];
    const service = createReportService({ reports, agents });

    const result = await service.meStats(subject, {
      fromAt: "2026-08-05T00:00:00.000Z",
      toExclusiveAt: "2026-08-06T00:00:00.000Z",
    });

    // The series tiles midnight-to-midnight on the caller's calendar, so the
    // empty early hours are present and the two busy hours read exactly. No
    // usage repository is wired, so every hour's token fields stay null.
    expect(result.hourly).toHaveLength(24);
    const byHour = new Map(result.hourly.map((bucket) => [new Date(bucket.hourStart).getUTCHours(), bucket]));
    expect(byHour.get(9)).toEqual({ hourStart: "2026-08-05T09:00:00.000Z", activeSeconds: 3_600, agentSeconds: 7_200, ...nullTokens });
    expect(byHour.get(10)).toEqual({ hourStart: "2026-08-05T10:00:00.000Z", activeSeconds: 3_600, agentSeconds: 0, ...nullTokens });
    for (let h = 0; h < 24; h++) {
      if (h === 9 || h === 10) continue;
      expect(byHour.get(h)).toEqual({ hourStart: `2026-08-05T${String(h).padStart(2, "0")}:00:00.000Z`, activeSeconds: 0, agentSeconds: 0, ...nullTokens });
    }
  });

  it("fills hourly token fields from the usage buckets and keeps unreported hours null", async () => {
    const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
    const reports = new Reports();
    reports.presenceIntervals = [
      { user: { id: ids.user, name: "Alex" }, startedAt: hour(9), endedAt: hour(11) },
    ];
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: hour(9), endedAt: hour(10) },
    ];
    const usage = new Usage([
      // Two buckets in the 09:00 hour sum together; the 10:00 hour reported nothing.
      usageSeed({ bucketStartAt: hour(9), inputTokens: 1_000, outputTokens: 100, cacheCreationInputTokens: 50, cacheReadInputTokens: 9_000 }),
      usageSeed({ bucketStartAt: hour(9), inputTokens: 500, outputTokens: 40, cacheReadInputTokens: 1_000 }),
      // A teammate's bucket never surfaces on the caller's series.
      usageSeed({ userId: ids.otherUser, bucketStartAt: hour(9), inputTokens: 9_999 }),
    ]);
    const service = createReportService({ reports, agents, agentUsage: usage });

    const result = await service.meStats(subject, {
      fromAt: "2026-08-05T00:00:00.000Z",
      toExclusiveAt: "2026-08-06T00:00:00.000Z",
    });

    expect(result.hourly).toHaveLength(24);
    const byHour = new Map(result.hourly.map((bucket) => [new Date(bucket.hourStart).getUTCHours(), bucket]));
    expect(byHour.get(9)).toEqual({
      hourStart: "2026-08-05T09:00:00.000Z",
      activeSeconds: 3_600,
      agentSeconds: 3_600,
      inputTokens: 1_500,
      outputTokens: 140,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 10_000,
    });
    expect(byHour.get(10)).toEqual({ hourStart: "2026-08-05T10:00:00.000Z", activeSeconds: 3_600, agentSeconds: 0, ...nullTokens });
    expect(usage.lastBucketQuery).toEqual({
      from: new Date("2026-08-05T00:00:00.000Z"),
      toExclusive: new Date("2026-08-06T00:00:00.000Z"),
      userId: ids.user,
    });
  });

  it("leaves the unbounded all-time range without an hourly graph", async () => {
    const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
    const reports = new Reports();
    reports.presenceIntervals = [
      { user: { id: ids.user, name: "Alex" }, startedAt: hour(9), endedAt: hour(11) },
    ];
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: null, agentRepoRoot: null, agentRepoKey: null, startedAt: hour(9), endedAt: hour(10) },
    ];
    const service = createReportService({ reports, agents });

    const result = await service.meStats(subject, {});

    expect(result.hourly).toEqual([]);
    expect(result.activeSeconds).toBe(7_200);
  });

  it("reads a named teammate's stats instead of the caller's when asked", async () => {
    const reports = new Reports([], new Set([ids.user, ids.otherUser]));
    const service = createReportService({ reports, agents });

    await service.meStats(subject, { userId: ids.otherUser });

    expect(reports.lastProjectTotalsQuery).toEqual({ userId: ids.otherUser });
    expect(reports.lastAppTotalsQuery).toEqual({ userId: ids.otherUser });
  });

  it("refuses a stats userId from outside the workspace, like the org report does", async () => {
    const service = createReportService({ reports: new Reports([], new Set()), agents });

    await expect(service.meStats(subject, { userId: ids.otherUser }))
      .rejects.toMatchObject({ code: "not_found", message: "User not found." });
  });

  it("rejects reversed or excessive date ranges like the org reports do", async () => {
    const service = createReportService({ reports: new Reports(), agents });

    await expect(service.meStats(subject, { from: "2026-08-07", to: "2026-08-06" })).rejects.toMatchObject({ code: "validation_error" });
    await expect(service.meStats(subject, { from: "2025-01-01", to: "2026-01-02" })).rejects.toMatchObject({ code: "validation_error" });
  });

  it("reads only the identities its own shifts name, never the whole roster", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    // A roster with an identity this member never ran: reading it would be
    // bytes off the wire on every 60-second refresh, for a row nothing renders.
    const roster = new Agents([agentRecord({ id: ids.session }), agentRecord({ id: ids.otherAgent, source: "codex" })]);
    const service = createReportService({ reports, agents: roster });

    const result = await service.meStats(subject, {});

    expect(roster.lastRequestedIds).toEqual([ids.session]);
    expect(result.agents.map((row) => row.agent.id)).toEqual([ids.session]);
  });

  it("asks for nothing at all when no shift in range names an identity", async () => {
    const roster = new Agents([agentRecord({ id: ids.session })]);
    const service = createReportService({ reports: new Reports(), agents: roster });

    const result = await service.meStats(subject, {});

    expect(roster.lastRequestedIds).toEqual([]);
    expect(result.agents).toEqual([]);
  });

  it("carries the caller's own agent rows, scoped exactly like the org-wide pay-run report", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: "claude-fable-5", cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
      // A teammate's shift under a different roster identity must never surface here.
      { user: { id: ids.otherUser, name: "Sam" }, source: "codex", model: null, cwd: null, projectId: ids.project, agentId: ids.otherAgent, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    const roster = new Agents([agentRecord({ id: ids.session }), agentRecord({ id: ids.otherAgent, source: "codex" })]);
    const authoredAt = new Date("2026-08-06T14:30:00.000Z");
    const shiftCommits = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
    ]);
    const service = createReportService({ reports, agents: roster, shiftCommits });

    const result = await service.meStats(subject, {});

    expect(result.agents).toEqual([{
      agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
      agentSeconds: 3_600,
      shiftCount: 1,
      commitsRecorded: 2,
      commitsPending: 0,
      commitsMerged: 2,
      commitsReverted: 0,
      commitsOrphaned: 0,
      heldRate: 1,
      models: ["claude-fable-5"],
      repos: [],
      ...noTokens,
    }]);
  });

  it("scopes a shared agent's commit and token tallies to the caller in meStats while the org report shows every member", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
      { user: { id: ids.otherUser, name: "Sam" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    const roster = new Agents([agentRecord({ id: ids.session })]);
    const authoredAt = new Date("2026-08-06T14:30:00.000Z");
    const shiftCommits = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
      { userId: ids.otherUser, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
    ]);
    const usage = new Usage([
      usageSeed({ userId: ids.user, inputTokens: 600, outputTokens: 60 }),
      usageSeed({ userId: ids.otherUser, inputTokens: 300, outputTokens: 30 }),
    ]);
    const service = createReportService({ reports, agents: roster, shiftCommits, agentUsage: usage });

    const own = await service.meStats(subject, {});

    expect(own.agents).toEqual([{
      agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
      agentSeconds: 3_600,
      shiftCount: 1,
      commitsRecorded: 1,
      commitsPending: 0,
      commitsMerged: 1,
      commitsReverted: 0,
      commitsOrphaned: 0,
      heldRate: 1,
      models: [],
      repos: [],
      tokens: { inputTokens: 600, outputTokens: 60, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      tokensReported: true,
    }]);
    expect(shiftCommits.lastCountsQuery).toEqual({ userId: ids.user });
    expect(usage.lastAgentQuery).toEqual({ userId: ids.user });

    const org = await service.agentsReport(subject, {});

    expect(org.rows).toEqual([{
      agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", owner: { id: ids.user, name: "Alex" }, project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
      agentSeconds: 7_200,
      shiftCount: 2,
      commitsRecorded: 2,
      commitsPending: 0,
      commitsMerged: 2,
      commitsReverted: 0,
      commitsOrphaned: 0,
      heldRate: 1,
      models: [],
      repos: [],
      tokens: { inputTokens: 900, outputTokens: 90, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      tokensReported: true,
    }]);
  });

  it("marks tokensReported by the existence of rows, never by a nonzero sum", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    const roster = new Agents([agentRecord({ id: ids.session }), agentRecord({ id: ids.otherAgent, source: "codex" })]);
    // A bucket whose counters are all zero is still a report: tokensReported
    // reads true, and the row ranks above agents that reported nothing.
    const usage = new Usage([usageSeed({ userId: ids.user })]);
    const service = createReportService({ reports, agents: roster, agentUsage: usage });

    const result = await service.agentsReport(subject, {});

    expect(result.rows[0]).toMatchObject({
      tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      tokensReported: true,
    });
    expect(result.rows[1]).toMatchObject({ ...noTokens });
  });
});

describe("agents report", () => {
  it("lists every roster agent with hours, shifts, and held share - zero-activity agents included", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: "claude-fable-5", cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    const roster = new Agents([
      agentRecord({ id: ids.session }),
      agentRecord({ id: ids.otherAgent, name: "Codex @ Side", source: "codex", status: "registered" }),
    ]);
    const authoredAt = new Date("2026-08-06T14:30:00.000Z");
    const shiftCommits = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "pending", authoredAt },
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "reverted", authoredAt },
    ]);
    const service = createReportService({ reports, agents: roster, shiftCommits });

    const result = await service.agentsReport(subject, {});

    expect(result.rows).toEqual([
      {
        agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", owner: { id: ids.user, name: "Alex" }, project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
        agentSeconds: 3_600,
        shiftCount: 1,
        commitsRecorded: 3,
        commitsPending: 1,
        commitsMerged: 1,
        commitsReverted: 1,
        commitsOrphaned: 0,
        // merged / decided (merged + reverted + orphaned); "orphaned" decides too.
        heldRate: 0.5,
        models: ["claude-fable-5"],
        repos: [],
        ...noTokens,
      },
      {
        // A registered agent with nothing in range still gets a row: zeros and a null rate, never absence.
        agent: { id: ids.otherAgent, name: "Codex @ Side", source: "codex", status: "registered", owner: { id: ids.user, name: "Alex" }, project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
        agentSeconds: 0,
        shiftCount: 0,
        commitsRecorded: 0,
        commitsPending: 0,
        commitsMerged: 0,
        commitsReverted: 0,
        commitsOrphaned: 0,
        heldRate: null,
        models: [],
        repos: [],
        ...noTokens,
      },
    ]);
    expect(result.headcount).toEqual({ total: 2, active: 2, retired: 0 });
  });

  it("works with no commit repository configured, and rejects a scope outside the workspace", async () => {
    const roster = new Agents([agentRecord()]);
    const service = createReportService({ reports: new Reports(), agents: roster });

    const result = await service.agentsReport(subject, {});
    expect(result.rows).toEqual([{
      agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", owner: { id: ids.user, name: "Alex" }, project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
      agentSeconds: 0,
      shiftCount: 0,
      commitsRecorded: 0,
      commitsPending: 0,
      commitsMerged: 0,
      commitsReverted: 0,
      commitsOrphaned: 0,
      heldRate: null,
      models: [],
      repos: [],
      ...noTokens,
    }]);

    const outsideScopeService = createReportService({ reports: new Reports([], new Set()), agents });
    await expect(outsideScopeService.agentsReport(subject, { scope: ids.otherProject }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("names each agent's codebases from its shifts' working directories, deduped and path-free", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:\\dev\\siqshift", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
      // A deeper directory in the same codebase adds no second label.
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift/", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T15:00:00.000Z"), endedAt: new Date("2026-08-06T16:00:00.000Z") },
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "/home/alex/src/pocket-piggies", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T16:00:00.000Z"), endedAt: new Date("2026-08-06T17:00:00.000Z") },
      // A shift that recorded no directory contributes nothing rather than a blank.
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T17:00:00.000Z"), endedAt: new Date("2026-08-06T18:00:00.000Z") },
    ];
    const service = createReportService({ reports, agents: new Agents([agentRecord({ id: ids.session })]) });

    const result = await service.agentsReport(subject, {});

    expect(result.rows[0]!.repos).toEqual(["siqshift", "pocket-piggies"]);
  });

  // The Overlord's roster was mostly rows reading "0s · 0 shifts · pending"
  // under a RETIRED tag. A retired agent that did nothing in the range is
  // neither on the clock nor evidence of anything; the headcount is what says
  // the retirement happened.
  it("drops a retired agent with no activity in the range, but keeps one that worked", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "codex", model: null, cwd: null, projectId: ids.project, agentId: ids.otherAgent, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    const roster = new Agents([
      agentRecord({ id: ids.session, name: "Pi @ unassigned", source: "pi", status: "retired" }),
      agentRecord({ id: ids.otherAgent, name: "Codex @ Side", source: "codex", status: "retired" }),
    ]);
    const service = createReportService({ reports, agents: roster });

    const result = await service.agentsReport(subject, {});

    expect(result.rows.map((row) => row.agent.id)).toEqual([ids.otherAgent]);
    // Both are still counted: hiding an empty row is not un-retiring anyone.
    expect(result.headcount).toMatchObject({ total: 2, retired: 2 });
  });

  // Commits are counted by their git author date and intervals by session
  // overlap, so a rebased commit lands in a range its shift never touched.
  // A retired agent must not take its evidence off the roster with it.
  it("keeps a retired agent whose commits land in the range even with no shift in it", async () => {
    const reports = new Reports();
    const roster = new Agents([
      agentRecord({ id: ids.session, name: "Pi @ unassigned", source: "pi", status: "retired" }),
      agentRecord({ id: ids.otherAgent, name: "Codex @ Side", source: "codex", status: "retired" }),
    ]);
    const shiftCommits = new ShiftCommits([
      { userId: ids.user, agentId: ids.otherAgent, projectId: ids.project, verification: "merged", authoredAt: new Date("2026-08-06T14:30:00.000Z") },
    ]);
    const service = createReportService({ reports, agents: roster, shiftCommits });

    const result = await service.agentsReport(subject, {});

    // The one with a commit survives with its tally; the all-zero one is gone.
    expect(result.rows.map((row) => row.agent.id)).toEqual([ids.otherAgent]);
    expect(result.rows[0]).toMatchObject({ agentSeconds: 0, shiftCount: 0, commitsRecorded: 1, heldRate: 1 });
  });

  it("labels a shift by its commit's repo root over its working directory, the paystub's rule", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      // Run from a subdirectory: the cwd alone would read "web".
      { sessionId: "shift-1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift/apps/web", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
      // No commit recorded a repo root here, so the cwd still names the codebase.
      { sessionId: "shift-2", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "/home/alex/src/pocket-piggies", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T15:00:00.000Z"), endedAt: new Date("2026-08-06T16:00:00.000Z") },
    ];
    const shiftCommits = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "pending", authoredAt: new Date("2026-08-06T14:30:00.000Z"), agentSessionId: "shift-1", repoRoot: "C:/dev/siqshift" },
    ]);
    const service = createReportService({ reports, agents: new Agents([agentRecord({ id: ids.session })]), shiftCommits });

    const result = await service.agentsReport(subject, {});

    expect(result.rows[0]!.repos).toEqual(["siqshift", "pocket-piggies"]);
  });

  it("narrows commit tallies to the same project scope as the hours", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
      { user: { id: ids.user, name: "Alex" }, source: "codex", model: null, cwd: null, projectId: ids.otherProject, agentId: ids.otherAgent, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    const roster = new Agents([
      agentRecord({ id: ids.session }),
      agentRecord({ id: ids.otherAgent, name: "Codex @ Side", source: "codex", project: { id: ids.otherProject, name: "Side" } }),
    ]);
    const authoredAt = new Date("2026-08-06T14:30:00.000Z");
    const shiftCommits = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
      { userId: ids.user, agentId: ids.otherAgent, projectId: ids.otherProject, verification: "merged", authoredAt },
    ]);
    const service = createReportService({ reports, agents: roster, shiftCommits });

    const result = await service.agentsReport(subject, { scope: ids.project });

    expect(result.rows).toEqual([
      {
        agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", owner: { id: ids.user, name: "Alex" }, project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
        agentSeconds: 3_600,
        shiftCount: 1,
        commitsRecorded: 1,
        commitsPending: 0,
        commitsMerged: 1,
        commitsReverted: 0,
        commitsOrphaned: 0,
        heldRate: 1,
        models: [],
        repos: [],
        ...noTokens,
      },
      {
        agent: { id: ids.otherAgent, name: "Codex @ Side", source: "codex", status: "anonymous", owner: { id: ids.user, name: "Alex" }, project: { id: ids.otherProject, name: "Side" }, createdAt: "2026-08-01T00:00:00.000Z" },
        agentSeconds: 0,
        shiftCount: 0,
        commitsRecorded: 0,
        commitsPending: 0,
        commitsMerged: 0,
        commitsReverted: 0,
        commitsOrphaned: 0,
        heldRate: null,
        models: [],
        repos: [],
        ...noTokens,
      },
    ]);
    expect(shiftCommits.lastCountsQuery).toEqual({ projectId: ids.project });
  });

  it("ranks rows by hours or tokens when the filters ask, non-reporters last, ties in roster order", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    // Roster order is deliberate: codex first, so the sorts have something to move.
    const roster = new Agents([
      agentRecord({ id: ids.otherAgent, name: "Codex @ Side", source: "codex" }),
      agentRecord({ id: ids.session }),
      agentRecord({ id: ids.otherProject, name: "Kimi @ Field", source: "kimi_code" }),
    ]);
    const usage = new Usage([
      // Codex burned the most; kimi never reported a bucket.
      usageSeed({ agentId: ids.otherAgent, inputTokens: 5_000, outputTokens: 500, cacheReadInputTokens: 20_000 }),
      usageSeed({ agentId: ids.session, inputTokens: 1_000, outputTokens: 100 }),
    ]);
    const service = createReportService({ reports, agents: roster, agentUsage: usage });

    // Absent sort keeps the roster's own order.
    const unsorted = await service.agentsReport(subject, {});
    expect(unsorted.rows.map((row) => row.agent.id)).toEqual([ids.otherAgent, ids.session, ids.otherProject]);

    // Hours rank by agentSeconds; everyone else ties at zero and keeps roster order.
    const byHours = await service.agentsReport(subject, { sort: "hours" });
    expect(byHours.filters.sort).toBe("hours");
    expect(byHours.rows.map((row) => [row.agent.id, row.agentSeconds])).toEqual([
      [ids.session, 3_600],
      [ids.otherAgent, 0],
      [ids.otherProject, 0],
    ]);

    // Tokens rank by the sum of the four counters; the agent that reported
    // nothing sorts last even though roster order put it third anyway - swap
    // the roster to prove the ranking, not the seeding, decides.
    const byTokens = await service.agentsReport(subject, { sort: "tokens" });
    expect(byTokens.rows.map((row) => [row.agent.id, row.tokensReported])).toEqual([
      [ids.otherAgent, true],
      [ids.session, true],
      [ids.otherProject, false],
    ]);
    expect(byTokens.rows[0]?.tokens).toEqual({ inputTokens: 5_000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 20_000 });

    const flipped = createReportService({
      reports,
      agents: new Agents([
        agentRecord({ id: ids.otherProject, name: "Kimi @ Field", source: "kimi_code" }),
        agentRecord({ id: ids.session }),
        agentRecord({ id: ids.otherAgent, name: "Codex @ Side", source: "codex" }),
      ]),
      agentUsage: usage,
    });
    const reranked = await flipped.agentsReport(subject, { sort: "tokens" });
    expect(reranked.rows.map((row) => row.agent.id)).toEqual([ids.otherAgent, ids.session, ids.otherProject]);
  });
});

describe("agent shifts", () => {
  const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 7, 6, hour, minute));

  /// The rows behind one group, read the way a drawer reads them: the same
  /// filters the heads were built with, plus the group and the page.
  const rowsOf = async (
    service: ReportService,
    groupKey: string,
    filters: AgentShiftsFilters = {},
  ): Promise<readonly { id: string; commitCount: number }[]> => (
    await service.agentShiftRows(subject, { ...filters, groupKey, pageSize: 50 })
  ).shifts;

  it("groups shifts by codebase, so two worktree clones of one repo read as one group", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      // Two clones of the same codebase in different treehouse worktrees.
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: "claude-opus-5", cwd: "C:/Users/a/.treehouse/siqshift-0cd188/1/siqshift", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
      { sessionId: "s2", user: { id: ids.user, name: "Alex" }, source: "pi", model: "deepseek-v4-pro", cwd: "C:/Users/a/.treehouse/siqshift-8f31a2/1/siqshift", projectId: ids.project, agentId: ids.otherAgent, agentRepoRoot: null, agentRepoKey: null, startedAt: at(12), endedAt: at(12, 30) },
      // A different codebase, and a shift that recorded nothing.
      { sessionId: "s3", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "/home/a/src/quartermaster", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(13), endedAt: at(13, 10) },
      { sessionId: "s4", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(14), endedAt: at(15) },
      // Browser spans are attention, never shifts.
      { sessionId: "s5", user: { id: ids.user, name: "Alex" }, source: "browser", model: null, cwd: null, projectId: ids.project, agentId: null, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(16) },
    ];
    const service = createReportService({ reports });

    const result = await service.agentShifts(subject, {});

    // Heaviest first, the label-less group last despite out-summing quartermaster.
    expect(result.groups.map((group) => [group.repo, group.agentSeconds, group.shiftCount])).toEqual([
      ["siqshift", 5_400, 2],
      ["quartermaster", 600, 1],
      [null, 3_600, 1],
    ]);
    expect(result.totalAgentSeconds).toBe(9_600);
    // The heads carry no rows at all; the shifts are a second read, keyed by
    // the group the first one named. Newest first, each carrying its own facts.
    expect(result.groups[0]).not.toHaveProperty("shifts");
    const siqshift = await service.agentShiftRows(subject, { groupKey: result.groups[0]!.groupKey, pageSize: 50 });
    expect(siqshift.shifts.map((shift) => shift.id)).toEqual(["s2", "s1"]);
    expect(siqshift.shifts[1]).toMatchObject({ source: "claude_code", model: "claude-opus-5", owner: { name: "Alex" }, agentSeconds: 3_600 });
    // The group fits in one page, so there is nowhere further to go.
    expect(siqshift.nextCursor).toBeNull();
  });

  it("pages one group's rows, and answers an empty page for a group the range no longer holds", async () => {
    const reports = new Reports();
    reports.agentIntervals = [10, 12, 14].map((hour) => ({
      sessionId: `s${hour}`,
      user: { id: ids.user, name: "Alex" },
      source: "claude_code",
      model: null,
      cwd: "C:/dev/siqshift",
      projectId: ids.project,
      agentId: ids.session,
      agentRepoRoot: null,
      agentRepoKey: null,
      startedAt: at(hour),
      endedAt: at(hour + 1),
    }));
    const service = createReportService({ reports });

    const first = await service.agentShiftRows(subject, { groupKey: "siqshift", pageSize: 2 });
    const second = await service.agentShiftRows(subject, {
      groupKey: "siqshift",
      pageSize: 2,
      afterStartedAt: first.nextCursor!.startedAt,
      afterId: first.nextCursor!.id,
    });

    // Newest first, split across the pages without repeating or dropping one.
    // The cursor names the last row served rather than a count, and goes null
    // once the group is spent, which is what retires the drawer's control.
    expect(first.shifts.map((shift) => shift.id)).toEqual(["s14", "s12"]);
    expect(first.nextCursor).toEqual({ startedAt: at(12).toISOString(), id: "s12" });
    expect(second.shifts.map((shift) => shift.id)).toEqual(["s10"]);
    expect(second.nextCursor).toBeNull();

    // A drawer opened from an aggregate a minute old can name a group that has
    // since rolled out of a moving range. That is a normal answer, not an error.
    const gone = await service.agentShiftRows(subject, { groupKey: "quartermaster", pageSize: 50 });
    expect(gone.shifts).toEqual([]);
    expect(gone.nextCursor).toBeNull();
  });

  it("keeps a cursor page honest when a newer shift lands between two reads", async () => {
    // The case an offset cannot survive: the group is re-sorted on every read,
    // so a shift arriving at the head moves every row below it down by one and
    // an offset page serves a row the drawer already holds while dropping one
    // it never saw.
    const interval = (hour: number) => ({
      sessionId: `s${hour}`,
      user: { id: ids.user, name: "Alex" },
      source: "claude_code" as const,
      model: null,
      cwd: "C:/dev/siqshift",
      projectId: ids.project,
      agentId: ids.session,
      agentRepoRoot: null,
      agentRepoKey: null,
      startedAt: at(hour),
      endedAt: at(hour, 30),
    });
    const reports = new Reports();
    reports.agentIntervals = [10, 11, 12, 13].map(interval);
    const service = createReportService({ reports });

    const first = await service.agentShiftRows(subject, { groupKey: "siqshift", pageSize: 2 });
    // A newer shift starts while the reader is looking at page one.
    reports.agentIntervals = [...reports.agentIntervals, interval(14)];
    const second = await service.agentShiftRows(subject, {
      groupKey: "siqshift",
      pageSize: 2,
      afterStartedAt: first.nextCursor!.startedAt,
      afterId: first.nextCursor!.id,
    });

    const shown = [...first.shifts, ...second.shifts].map((shift) => shift.id);
    expect(shown).toEqual(["s13", "s12", "s11", "s10"]);
    expect(new Set(shown).size).toBe(shown.length);
    expect(second.nextCursor).toBeNull();
  });

  it("folds the hourly series server-side, and declines it over an unbounded range", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
      // An hour later, so the quiet hour between them has to read as a zero
      // rather than vanish from the axis.
      { sessionId: "s2", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(12, 30), endedAt: at(13) },
    ];
    const service = createReportService({ reports });

    const bounded = await service.agentShifts(subject, {
      fromAt: at(10).toISOString(),
      toExclusiveAt: at(14).toISOString(),
    });

    expect(bounded.hourly.map((bucket) => [bucket.hourStart, bucket.agentSeconds])).toEqual([
      [at(10).toISOString(), 3_600],
      [at(11).toISOString(), 0],
      [at(12).toISOString(), 1_800],
    ]);
    // The series measures agent time alone, so presence and tokens stay empty
    // rather than being invented from a report this endpoint never reads.
    expect(bounded.hourly[0]).toMatchObject({ activeSeconds: 0, inputTokens: null, cacheReadInputTokens: null });
    // It sums back to the total the groups spend, which is the one assertion
    // that catches a bucket counted twice or an hour clipped away.
    expect(bounded.hourly.reduce((sum, bucket) => sum + bucket.agentSeconds, 0)).toBe(bounded.totalAgentSeconds);

    // Per-hour resolution over all of history is meaningless and the series
    // would grow with the workspace, so an unbounded range declines it.
    const unbounded = await service.agentShifts(subject, {});
    expect(unbounded.hourly).toEqual([]);
    expect(unbounded.totalAgentSeconds).toBe(5_400);
  });

  describe("token chart", () => {
    const shift = (sessionId: string, projectId: string | null, projectName: string | null, start: Date, end: Date): AgentIntervalRecord => ({
      sessionId,
      user: { id: ids.user, name: "Alex" },
      source: "claude_code",
      model: null,
      cwd: "C:/dev/ledger",
      projectId,
      projectName,
      agentId: ids.session,
      agentRepoRoot: null,
      agentRepoKey: null,
      externalSessionId: `${sessionId}-runtime-id`,
      startedAt: start,
      endedAt: end,
    });
    const day = { fromAt: at(0).toISOString(), toExclusiveAt: at(24).toISOString() };

    it("bars a day by the hour, with in, out and their sum added on the server", async () => {
      const reports = new Reports();
      reports.agentIntervals = [shift("s1", ids.project, "Timer", at(10), at(12))];
      const usage = new Usage([
        usageSeed({ bucketStartAt: at(10), inputTokens: 100, cacheCreationInputTokens: 20, cacheReadInputTokens: 3_000, outputTokens: 400 }),
        usageSeed({ bucketStartAt: at(11), inputTokens: 1, outputTokens: 2 }),
      ]);
      const service = createReportService({ reports, agentUsage: usage });

      const result = await service.agentShifts(subject, day);

      expect(result.tokenChart?.bucketSeconds).toBe(3_600);
      expect(result.tokenChart?.buckets).toHaveLength(24);
      expect(result.tokenChart?.buckets[10]).toEqual({ start: at(10).toISOString(), tokensIn: 3_120, tokensOut: 400, tokens: 3_520 });
      expect(result.tokenChart?.buckets[11]).toEqual({ start: at(11).toISOString(), tokensIn: 1, tokensOut: 2, tokens: 3 });
      // An hour nothing reported is no data, never an invented zero.
      expect(result.tokenChart?.buckets[12]).toEqual({ start: at(12).toISOString(), tokensIn: null, tokensOut: null, tokens: null });
    });

    it("splits the bars by project, counts usage of shifts that named none under the default project, and lists a project without tokens at zero", async () => {
      const reports = new Reports();
      reports.defaultProject = { id: ids.otherProject, name: "General" };
      reports.agentIntervals = [
        shift("s1", ids.project, "Timer", at(9), at(10)),
        shift("s2", null, null, at(10), at(11)),
        shift("s3", "91c7e513-b094-4d4c-ae55-21790ae019a4", "Quiet", at(11), at(12)),
      ];
      const usage = new Usage([
        usageSeed({ bucketStartAt: at(9), projectId: ids.project, inputTokens: 10, outputTokens: 5 }),
        usageSeed({ bucketStartAt: at(10), projectId: null, inputTokens: 200, outputTokens: 100 }),
        usageSeed({ bucketStartAt: at(10), projectId: ids.otherProject, inputTokens: 1, outputTokens: 1 }),
      ]);
      usage.projectNames.set(ids.otherProject, "General");
      const service = createReportService({ reports, agentUsage: usage });

      const result = await service.agentShifts(subject, day);

      expect(result.tokenChart?.projects.map((entry) => [entry.project.name, entry.tokens])).toEqual([
        ["General", 302],
        ["Timer", 15],
        ["Quiet", 0],
      ]);
      const general = result.tokenChart?.projects[0];
      expect(general?.buckets[10]).toEqual({ start: at(10).toISOString(), tokensIn: 201, tokensOut: 101, tokens: 302 });
      expect(result.tokenChart?.projects[2]?.buckets).toEqual([]);
      // The bars for every project together hold all of it.
      expect(result.tokenChart?.buckets[10]?.tokens).toBe(302);
      expect(result.tokenChart?.buckets[9]?.tokens).toBe(15);
    });

    it("bars a longer range by the day, the spare daylight-saving hour joining the last day", async () => {
      const reports = new Reports();
      reports.agentIntervals = [shift("s1", ids.project, "Timer", at(10), at(11))];
      const usage = new Usage([
        usageSeed({ bucketStartAt: at(10), inputTokens: 7, outputTokens: 3 }),
        // The last hour of a week that runs one hour long.
        usageSeed({ bucketStartAt: new Date(at(0).getTime() + 7 * 24 * 3_600_000), inputTokens: 1, outputTokens: 1 }),
      ]);
      const service = createReportService({ reports, agentUsage: usage });

      const result = await service.agentShifts(subject, {
        fromAt: at(0).toISOString(),
        toExclusiveAt: new Date(at(0).getTime() + (7 * 24 + 1) * 3_600_000).toISOString(),
      });

      expect(result.tokenChart?.bucketSeconds).toBe(86_400);
      expect(result.tokenChart?.buckets.map((bucket) => bucket.tokens)).toEqual([10, null, null, null, null, null, 2]);
    });

    it("reads no bucketed usage and draws no chart over an unbounded range, nor without a usage source", async () => {
      const reports = new Reports();
      reports.agentIntervals = [shift("s1", ids.project, "Timer", at(10), at(11))];
      const usage = new Usage([usageSeed({ bucketStartAt: at(10), inputTokens: 7, outputTokens: 3 })]);

      const unbounded = await createReportService({ reports, agentUsage: usage }).agentShifts(subject, {});
      const unread = await createReportService({ reports }).agentShifts(subject, day);

      expect(unbounded.tokenChart).toBeUndefined();
      expect(usage.projectBucketReads).toBe(0);
      expect(unbounded.totalAgentSeconds).toBe(3_600);
      expect(unread.tokenChart).toBeUndefined();
    });
  });

  describe("tokens by repo and runtime", () => {
    const shift = (sessionId: string, source: string, cwd: string, userId: string, start: Date, end: Date): AgentIntervalRecord => ({
      sessionId,
      user: { id: userId, name: userId === ids.user ? "Alex" : "Riley" },
      source,
      model: null,
      cwd,
      projectId: ids.project,
      projectName: "Timer",
      agentId: ids.session,
      agentRepoRoot: null,
      agentRepoKey: null,
      externalSessionId: `${sessionId}-runtime-id`,
      startedAt: start,
      endedAt: end,
    });
    const board = (): Reports => {
      const reports = new Reports();
      reports.agentIntervals = [
        shift("s1", "claude_code", "C:/dev/siqshift", ids.user, at(10), at(11)),
        shift("s2", "codex", "C:/dev/siqshift", ids.otherUser, at(12), at(12, 30)),
        shift("s3", "claude_code", "/home/a/src/quartermaster", ids.user, at(13), at(13, 10)),
        shift("s4", "pi", "/home/a/src/quartermaster", ids.otherUser, at(14), at(14, 30)),
      ];
      return reports;
    };
    const usage = (): Usage => new Usage([
      usageSeed({ agentSessionId: "s1", bucketStartAt: at(10), inputTokens: 100, cacheCreationInputTokens: 20, cacheReadInputTokens: 3_000, outputTokens: 400 }),
      usageSeed({ agentSessionId: "s2", userId: ids.otherUser, bucketStartAt: at(12), inputTokens: 1, outputTokens: 2 }),
      usageSeed({ agentSessionId: "s4", userId: ids.otherUser, bucketStartAt: at(14), inputTokens: 10, outputTokens: 10 }),
      // A session the board does not hold: its tokens belong to no group.
      usageSeed({ agentSessionId: "s9", bucketStartAt: at(15), inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ]);

    it("totals each group's tokens and rolls its shifts up by runtime, both reconciling with the groups", async () => {
      const service = createReportService({ reports: board(), agentUsage: usage() });

      const result = await service.agentShifts(subject, {});

      expect(result.groups.map((group) => [group.repo, group.agentSeconds, group.shiftCount, group.tokens])).toEqual([
        ["siqshift", 5_400, 2, 3_523],
        ["quartermaster", 2_400, 2, 20],
      ]);
      // Heaviest first, the equal pair ordered by source.
      expect(result.runtimes).toEqual([
        { source: "claude_code", agentSeconds: 4_200, shiftCount: 2, tokens: 3_520 },
        { source: "codex", agentSeconds: 1_800, shiftCount: 1, tokens: 3 },
        { source: "pi", agentSeconds: 1_800, shiftCount: 1, tokens: 20 },
      ]);
      expect(result.tokenTotals).toEqual({ tokensIn: 3_131, tokensOut: 412, tokens: 3_543 });
      const runtimes = result.runtimes ?? [];
      expect(runtimes.reduce((sum, runtime) => sum + runtime.agentSeconds, 0)).toBe(result.totalAgentSeconds);
      expect(runtimes.reduce((sum, runtime) => sum + runtime.shiftCount, 0))
        .toBe(result.groups.reduce((sum, group) => sum + group.shiftCount, 0));
      expect(result.groups.reduce((sum, group) => sum + (group.tokens ?? 0), 0)).toBe(result.tokenTotals?.tokens);
    });

    it("narrows the groups' tokens, the runtimes and the totals to the selected person, and keeps everyone on the board", async () => {
      const service = createReportService({ reports: board(), agentUsage: usage() });

      const result = await service.agentShifts(subject, { userId: ids.user });

      expect(result.groups.map((group) => [group.repo, group.shiftCount, group.tokens])).toEqual([
        ["siqshift", 1, 3_520],
        ["quartermaster", 1, 0],
      ]);
      expect(result.runtimes).toEqual([{ source: "claude_code", agentSeconds: 4_200, shiftCount: 2, tokens: 3_520 }]);
      expect(result.tokenTotals).toEqual({ tokensIn: 3_120, tokensOut: 400, tokens: 3_520 });
      expect(result.people.map((person) => person.owner.id).sort()).toEqual([ids.user, ids.otherUser].sort());
    });

    it.each([
      { label: "an unbounded range", filters: {} },
      { label: "a bounded range", filters: { fromAt: at(0).toISOString(), toExclusiveAt: at(24).toISOString() } },
    ])("states the tokens over $label", async ({ filters }) => {
      const service = createReportService({ reports: board(), agentUsage: usage() });

      const result = await service.agentShifts(subject, filters);

      expect(result.tokenTotals).toEqual({ tokensIn: 3_131, tokensOut: 412, tokens: 3_543 });
      expect(result.groups.map((group) => group.tokens)).toEqual([3_523, 20]);
    });

    // Activity after the server ended a session - `claude --continue` the
    // morning after - opens a continuation shift, `<session id>~<unix start>`,
    // while the desktop keeps filing the session's tokens under its own row.
    it.each([
      { label: "only continuations of it, its own shift having ended the night before", ownStart: at(-4), ownEnd: at(-2, 40), shiftCount: 2, agentSeconds: 7_200 },
      { label: "its own shift beside the continuations", ownStart: at(7), ownEnd: at(8), shiftCount: 3, agentSeconds: 10_800 },
    ])("credits a session's tokens once when the board holds $label", async ({ ownStart, ownEnd, shiftCount, agentSeconds }) => {
      // Arrange
      const reports = new Reports();
      reports.agentIntervals = [
        { ...shift("own", "claude_code", "C:/dev/siqshift", ids.user, ownStart, ownEnd), externalSessionId: "resumed" },
        { ...shift("morning", "claude_code", "C:/dev/siqshift", ids.user, at(9), at(10)), externalSessionId: `resumed~${at(9).getTime() / 1_000}` },
        { ...shift("afternoon", "claude_code", "C:/dev/siqshift", ids.user, at(13), at(14)), externalSessionId: `resumed~${at(13).getTime() / 1_000}` },
      ];
      const usage = new Usage([
        usageSeed({ agentSessionId: "own", externalSessionId: "resumed", bucketStartAt: at(9), inputTokens: 1_200_000, outputTokens: 300_000 }),
        usageSeed({ agentSessionId: "own", externalSessionId: "resumed", bucketStartAt: at(13), inputTokens: 400_000, outputTokens: 100_000 }),
      ]);
      const service = createReportService({ reports, agentUsage: usage });

      // Act
      const result = await service.agentShifts(subject, { fromAt: at(0).toISOString(), toExclusiveAt: at(24).toISOString() });

      // Assert
      expect(result.groups.map((group) => [group.repo, group.shiftCount, group.tokens])).toEqual([["siqshift", shiftCount, 2_000_000]]);
      expect(result.runtimes).toEqual([{ source: "claude_code", agentSeconds, shiftCount, tokens: 2_000_000 }]);
      expect(result.tokenTotals).toEqual({ tokensIn: 1_600_000, tokensOut: 400_000, tokens: 2_000_000 });
      // The token chart on the same page draws exactly the tokens the totals state.
      expect(result.tokenChart?.buckets.reduce((sum, bucket) => sum + (bucket.tokens ?? 0), 0)).toBe(2_000_000);
    });

    it("leaves a session's tokens out when the board holds only another person's continuation of the same id", async () => {
      // Arrange
      const reports = new Reports();
      reports.agentIntervals = [
        { ...shift("theirs", "claude_code", "C:/dev/siqshift", ids.otherUser, at(9), at(10)), externalSessionId: `resumed~${at(9).getTime() / 1_000}` },
      ];
      const usage = new Usage([
        usageSeed({ agentSessionId: "mine", externalSessionId: "resumed", bucketStartAt: at(9), inputTokens: 1_000, outputTokens: 1_000 }),
      ]);
      const service = createReportService({ reports, agentUsage: usage });

      // Act
      const result = await service.agentShifts(subject, { fromAt: at(0).toISOString(), toExclusiveAt: at(24).toISOString() });

      // Assert
      expect(result.groups.map((group) => group.tokens)).toEqual([0]);
      expect(result.tokenTotals).toEqual({ tokensIn: 0, tokensOut: 0, tokens: 0 });
    });

    it("leaves the tokens out without a usage source, and still rolls up the runtimes", async () => {
      const service = createReportService({ reports: board() });

      const result = await service.agentShifts(subject, {});

      expect(result.tokenTotals).toBeUndefined();
      expect(result.groups.every((group) => !("tokens" in group))).toBe(true);
      expect(result.runtimes).toEqual([
        { source: "claude_code", agentSeconds: 4_200, shiftCount: 2 },
        { source: "codex", agentSeconds: 1_800, shiftCount: 1 },
        { source: "pi", agentSeconds: 1_800, shiftCount: 1 },
      ]);
    });
  });

  it("labels a run-directory shift by its roster identity's repository, so gate worktrees land on their codebase", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      // A validation run inside a no-mistakes gate worktree: the path names
      // only the run, but the roster identity this shift minted is keyed on
      // the remote the runtime probed for it.
      {
        sessionId: "s1",
        user: { id: ids.user, name: "Alex" },
        source: "claude_code",
        model: null,
        cwd: "C:/Users/riley/.no-mistakes/worktrees/3946e592fa2c/01M1ZNNGRXGEJ0B31V2MJTY7BX",
        projectId: ids.project,
        agentId: ids.session,
        agentRepoRoot: "C:/Users/riley/.no-mistakes/worktrees/3946e592fa2c/01M1ZNNGRXGEJ0B31V2MJTY7BX",
        agentRepoKey: "github.com/acme/novawebsite-ai",
        startedAt: at(10),
        endedAt: at(11),
      },
    ];
    const service = createReportService({ reports });

    const result = await service.agentShifts(subject, {});

    // The identity's own name wins over the worktree's, and a named group
    // carries no cause.
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ repo: "novawebsite-ai", nullCause: null, shiftCount: 1 });
  });

  it("splits the codebase-less groups by why, so one bucket never hides two answers", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      // Never captured a directory: a tracking gap, whatever its age.
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
      // Worked in a per-run worktree whose repository nothing identified -
      // the operator's unassigned bucket has no repository to fall back to.
      { sessionId: "s2", user: { id: ids.user, name: "Alex" }, source: "codex", model: null, cwd: "C:/Users/riley/.no-mistakes/worktrees/4ddfd9c24f0e/01M1T5ZSHNS0TPA1W0D2YCQ1Y7", projectId: ids.project, agentId: ids.otherAgent, agentRepoRoot: null, agentRepoKey: null, startedAt: at(12), endedAt: at(13) },
    ];
    const service = createReportService({ reports });

    const result = await service.agentShifts(subject, {});

    expect(result.groups.map((group) => [group.repo, group.nullCause])).toEqual([
      [null, "no-working-directory"],
      [null, "unidentified-run-directory"],
    ]);
    // Both stay footnotes after the named groups, ordered by their own weight.
    expect(result.groups.every((group) => group.repo === null)).toBe(true);
    expect(result.totalAgentSeconds).toBe(7_200);
  });

  it("groups worktree shifts under the repository their identity is keyed on, not the worktree's folder", async () => {
    const reports = new Reports();
    const goblin = { user: { id: ids.user, name: "Alex" }, source: "claude_code" as const, model: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: "C:/dev/relay-app", agentRepoKey: "github.com/acme/relay-app" };
    reports.agentIntervals = [
      // A goblin's worktree folder is named for its task, not its codebase,
      // and it is not opaque enough to read as a run directory.
      { ...goblin, sessionId: "s1", cwd: "C:\\dev\\relay-app\\.worktrees\\gb-ra-ci-speed", startedAt: at(10), endedAt: at(11) },
      { ...goblin, sessionId: "s2", cwd: "C:\\dev\\relay-app\\.worktrees\\gb-ra-flakes-3", startedAt: at(11), endedAt: at(12) },
      { ...goblin, sessionId: "s3", cwd: "C:\\dev\\relay-app", startedAt: at(12), endedAt: at(13) },
    ];
    const service = createReportService({ reports });

    const result = await service.agentShifts(subject, {});

    expect(result.groups.map((group) => [group.repo, group.shiftCount])).toEqual([["relay-app", 3]]);
  });

  it("folds one repository's spellings into one group under its identity's name", async () => {
    const reports = new Reports();
    const outreach = { user: { id: ids.user, name: "Alex" }, source: "claude_code" as const, model: null, projectId: ids.project, agentId: ids.session, agentRepoRoot: "C:/Users/alex/coldOutreachNovaWebsite", agentRepoKey: "github.com/acme/coldoutreachnovawebsite" };
    reports.agentIntervals = [
      // The main checkout's folder keeps its capitalisation; a worktree with an
      // opaque name falls back to the remote, which is lowercased. One codebase.
      { ...outreach, sessionId: "s1", cwd: "C:\\Users\\alex\\coldOutreachNovaWebsite", startedAt: at(10), endedAt: at(11) },
      { ...outreach, sessionId: "s2", cwd: "C:\\Users\\alex\\coldOutreachNovaWebsite\\.claude\\worktrees\\consolidate-csvs-google-sheet-0f77f7", startedAt: at(11), endedAt: at(12) },
      // No identity key at all, only a folder spelled another way.
      { sessionId: "s3", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/Users/alex/ColdOutreachNovaWebsite", projectId: ids.project, agentId: ids.otherAgent, agentRepoRoot: null, agentRepoKey: null, startedAt: at(12), endedAt: at(13) },
    ];
    const service = createReportService({ reports });

    const result = await service.agentShifts(subject, {});

    expect(result.groups.map((group) => [group.repo, group.shiftCount])).toEqual([["coldoutreachnovawebsite", 3]]);
    const rows = await service.agentShiftRows(subject, { groupKey: result.groups[0]!.groupKey, pageSize: 50 });
    expect(rows.shifts.map((shift) => shift.id).sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("files home-folder and temp-folder shifts under no codebase, unless a remote names one", async () => {
    const reports = new Reports();
    const alex = { user: { id: ids.user, name: "Alex" }, source: "claude_code" as const, model: null, projectId: ids.project };
    const scratch = "C:/Users/alex/AppData/Local/Temp/claude/run/scratchpad/steer-proof/home/worktrees/project/steer-claude";
    reports.agentIntervals = [
      // A session started in the home folder works on whatever it is asked to.
      { ...alex, sessionId: "s1", cwd: "C:\\Users\\alex", agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
      { ...alex, sessionId: "s2", cwd: "/home/alex", agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(11), endedAt: at(12) },
      // A throwaway repository a test harness made under the temp folder.
      { ...alex, sessionId: "s3", cwd: scratch, agentId: ids.otherAgent, agentRepoRoot: scratch, agentRepoKey: `path:${scratch}`, startedAt: at(12), endedAt: at(13) },
      // A clone of a real repository that happens to sit in temp is still that repository.
      { ...alex, sessionId: "s4", cwd: "/tmp/checkout", agentId: ids.otherAgent, agentRepoRoot: "/tmp/checkout", agentRepoKey: "github.com/acme/app", startedAt: at(13), endedAt: at(14) },
    ];
    const service = createReportService({ reports });

    const result = await service.agentShifts(subject, {});

    expect(result.groups.map((group) => [group.repo, group.nullCause, group.shiftCount])).toEqual([
      ["app", null, 1],
      [null, "home-or-temp-directory", 3],
    ]);
  });

  it("prefers the shift's own commit root over its identity's repository", async () => {
    const shiftCommits = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "pending", authoredAt: at(10, 30), agentSessionId: "s1", repoRoot: "C:/dev/siqshift", subject: "fix: the thing" },
    ]);
    const reports = new Reports();
    reports.agentIntervals = [
      {
        sessionId: "s1",
        user: { id: ids.user, name: "Alex" },
        source: "claude_code",
        model: null,
        // An opaque cwd would read as a run directory on its own; the commit
        // captured for this very shift names the repository, and it wins.
        cwd: "C:/Users/riley/.no-mistakes/worktrees/3946e592fa2c/01M1ZNNGRXGEJ0B31V2MJTY7BX",
        projectId: ids.project,
        agentId: ids.session,
        agentRepoRoot: null,
        agentRepoKey: "github.com/acme/novawebsite-ai",
        startedAt: at(10),
        endedAt: at(11),
      },
    ];
    const service = createReportService({ reports, shiftCommits });

    const result = await service.agentShifts(subject, {});

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ repo: "siqshift", nullCause: null });
  });

  // The board that opens the tab, and the filter it doubles as. Two owners,
  // because a single-owner fixture cannot falsify a per-person roll-up.
  const twoOwners = () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
      { sessionId: "s2", user: { id: ids.otherUser, name: "Sam" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, agentId: ids.otherAgent, agentRepoRoot: null, agentRepoKey: null, startedAt: at(12), endedAt: at(12, 30) },
      { sessionId: "s3", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "/home/a/src/quartermaster", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(13), endedAt: at(13, 10) },
      // Browser spans are attention, never shifts, on the board as in the groups.
      { sessionId: "s4", user: { id: ids.otherUser, name: "Sam" }, source: "browser", model: null, cwd: null, projectId: ids.project, agentId: null, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(16) },
    ];
    return reports;
  };

  it("opens on a board of people, heaviest first, that sums back to the recorded total", async () => {
    const service = createReportService({ reports: twoOwners() });

    const result = await service.agentShifts(subject, {});

    expect(result.people.map((person) => [person.owner.name, person.agentSeconds, person.shiftCount])).toEqual([
      ["Alex", 4_200, 2],
      ["Sam", 1_800, 1],
    ]);
    // The board is a partition of the same seconds the groups spend, so it
    // reconciles exactly. Nothing else in this suite would catch a shift
    // counted into two people, or a second rounded twice.
    expect(result.people.reduce((sum, person) => sum + person.agentSeconds, 0)).toBe(result.totalAgentSeconds);
    // Sam's six-hour browser span is attention, not a shift, so it reaches
    // neither the board nor the total.
    expect(result.people[1]!.agentSeconds).toBe(1_800);
  });

  it("keeps every person on the board while narrowing everything else to one of them", async () => {
    const service = createReportService({ reports: twoOwners() });

    const result = await service.agentShifts(subject, { userId: ids.user });

    // The board is computed before the filter. If it narrowed too, picking a
    // person would empty the control that picked them and there would be no
    // way back to the board.
    expect(result.people.map((person) => person.owner.name)).toEqual(["Alex", "Sam"]);
    expect(result.people[1]!.agentSeconds).toBe(1_800);
    // Everything below the board is Alex alone.
    expect(result.totalAgentSeconds).toBe(4_200);
    expect(result.totalAgentSeconds).toBe(result.people[0]!.agentSeconds);
    const picked = { userId: ids.user };
    const shiftIds = (await Promise.all(
      result.groups.map(async (group) => (await rowsOf(service, group.groupKey, picked)).map((shift) => shift.id)),
    )).flat();
    expect(shiftIds).toEqual(["s1", "s3"]);
    expect(result.filters.userId).toBe(ids.user);
  });

  it("sums one person's parallel agents rather than unioning them, so a row can exceed the clock", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
      { sessionId: "s2", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, agentId: ids.otherAgent, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
    ];
    const service = createReportService({ reports });

    const result = await service.agentShifts(subject, {});

    // One hour of wall clock, two agents, two hours on the row - and the
    // shift count is what says it was several agents and not a long day.
    expect(result.people[0]).toMatchObject({ agentSeconds: 7_200, shiftCount: 2 });
    expect(result.people[0]!.agentSeconds).toBe(result.totalAgentSeconds);
  });

  it("refuses a shifts userId from outside the workspace, like the org report does", async () => {
    const service = createReportService({ reports: new Reports([], new Set()) });

    await expect(service.agentShifts(subject, { userId: ids.otherUser }))
      .rejects.toMatchObject({ code: "not_found", message: "User not found." });
  });

  it("labels a shift by its commit's repo root over its cwd, and holds the rate back until a commit is decided", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      // Run from a subdirectory: the cwd alone would read "web".
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift/apps/web", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
      { sessionId: "s2", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(12), endedAt: at(13) },
    ];
    const pendingOnly = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "pending", authoredAt: at(10, 30), agentSessionId: "s1", repoRoot: "C:/dev/siqshift", subject: "fix: the thing" },
    ]);
    const service = createReportService({ reports, shiftCommits: pendingOnly });

    const result = await service.agentShifts(subject, {});

    expect(result.groups).toHaveLength(1);
    const group = result.groups[0]!;
    expect(group.repo).toBe("siqshift");
    // Nothing decided yet: no rate, rather than a "pending" that reads as a state.
    expect(group.heldRate).toBeNull();
    const shifts = await rowsOf(service, group.groupKey);
    expect(shifts.find((shift) => shift.id === "s1")!.commitCount).toBe(1);
    expect(shifts.find((shift) => shift.id === "s2")!.commitCount).toBe(0);

    const decided = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt: at(10, 30), agentSessionId: "s1", repoRoot: "C:/dev/siqshift" },
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "reverted", authoredAt: at(12, 30), agentSessionId: "s2", repoRoot: "C:/dev/siqshift" },
    ]);
    const decidedService = createReportService({ reports, shiftCommits: decided });
    const decidedResult = await decidedService.agentShifts(subject, {});
    expect(decidedResult.groups[0]!.heldRate).toBe(0.5);
  });

  it("clips shifts to the range and drops the ones outside it", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(9), endedAt: at(11) },
      { sessionId: "s2", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(5), endedAt: at(6) },
    ];
    const service = createReportService({ reports });

    const result = await service.agentShifts(subject, { fromAt: at(10).toISOString(), toExclusiveAt: at(12).toISOString() });

    const bounds = { fromAt: at(10).toISOString(), toExclusiveAt: at(12).toISOString() };
    expect(result.groups).toHaveLength(1);
    // The rows are read under the same bounds the head was totalled with, so
    // the drawer can never list a shift its own head dropped.
    expect((await rowsOf(service, result.groups[0]!.groupKey, bounds)).map((shift) => shift.id)).toEqual(["s1"]);
    expect(result.groups[0]!.agentSeconds).toBe(3_600);
    // The board is clipped by the same bounds the groups are, so the invariant
    // holds on a bounded range too and not only on the unbounded one.
    expect(result.people[0]!.agentSeconds).toBe(3_600);
    expect(result.people.reduce((sum, person) => sum + person.agentSeconds, 0)).toBe(result.totalAgentSeconds);
  });

  // Why the filter has to be server-side at all: a client holding the shifts
  // could recount seconds, but it never receives the verification states a
  // held rate is derived from, so it would keep rendering the unfiltered one.
  it("narrows each codebase's held rate to the selected person, which no client could recompute", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
      { sessionId: "s2", user: { id: ids.otherUser, name: "Sam" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, agentId: ids.otherAgent, agentRepoRoot: null, agentRepoKey: null, startedAt: at(12), endedAt: at(13) },
    ];
    const commits = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt: at(10, 30), agentSessionId: "s1", repoRoot: "C:/dev/siqshift" },
      { userId: ids.otherUser, agentId: ids.otherAgent, projectId: ids.project, verification: "reverted", authoredAt: at(12, 30), agentSessionId: "s2", repoRoot: "C:/dev/siqshift" },
    ]);
    // Both owners are members here, so the selection authorizes and the test
    // reaches the held rate rather than stopping at the tenancy check.
    reports.accessible.add(ids.otherUser);
    const service = createReportService({ reports, shiftCommits: commits });

    // One merged, one reverted, in the same codebase: half of it held.
    expect((await service.agentShifts(subject, {})).groups[0]!.heldRate).toBe(0.5);
    // Alex's alone held completely; Sam's alone held not at all. Only the
    // server can say either, because only the server has the verifications.
    expect((await service.agentShifts(subject, { userId: ids.user })).groups[0]!.heldRate).toBe(1);
    expect((await service.agentShifts(subject, { userId: ids.otherUser })).groups[0]!.heldRate).toBe(0);
  });

  // The predicate used to live in SQL, where a uuid column compares either
  // case. In memory `!==` does not, so an id that authorizes would silently
  // match no shift and answer 200 with nothing in it.
  it("keeps a selected id in the one spelling the database hands back", () => {
    const bounds = { fromAt: at(10).toISOString(), toExclusiveAt: at(12).toISOString() };

    expect(normalizedQuery({ ...bounds, userId: ids.user.toUpperCase() }).userId).toBe(ids.user);
    expect(normalizedQuery({ from: "2026-08-06", to: "2026-08-06", userId: ids.user.toUpperCase() }).userId).toBe(ids.user);
  });

  it("pins a group's project-tied shifts above its untied ones, without hiding the untied", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, projectName: "Timer", agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
      { sessionId: "s2", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: null, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(14), endedAt: at(15) },
      { sessionId: "s3", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, projectName: "Timer", agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(12), endedAt: at(13) },
    ];
    const service = createReportService({ reports });

    const result = await service.agentShiftRows(subject, { groupKey: "siqshift", pageSize: 50 });

    // The tie reads first, newest within each partition; the untied shift
    // stays visible below rather than being filtered away.
    expect(result.shifts.map((shift) => [shift.id, shift.project?.name ?? null])).toEqual([
      ["s3", "Timer"],
      ["s1", "Timer"],
      ["s2", null],
    ]);
  });

  it("pages a drawer across the project-tie boundary, and the cursor carries the tie", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, projectName: "Timer", agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
      { sessionId: "s2", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: null, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(14), endedAt: at(15) },
      { sessionId: "s3", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, projectName: "Timer", agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(12), endedAt: at(13) },
    ];
    const service = createReportService({ reports });

    const first = await service.agentShiftRows(subject, { groupKey: "siqshift", pageSize: 2 });
    expect(first.shifts.map((shift) => shift.id)).toEqual(["s3", "s1"]);
    expect(first.nextCursor).toMatchObject({ id: "s1", projectTied: true });

    const second = await service.agentShiftRows(subject, {
      groupKey: "siqshift",
      pageSize: 2,
      afterStartedAt: first.nextCursor!.startedAt,
      afterId: first.nextCursor!.id,
      projectTied: "true",
    });
    // The unpinned partition opens past a pinned cursor, and the untied shift
    // is still served - sorted below, never hidden. The group is exhausted
    // after it, so the cursor is null and the drawer stops offering pages.
    expect(second.shifts.map((shift) => shift.id)).toEqual(["s2"]);
    expect(second.nextCursor).toBeNull();
  });

  it("answers a cursor without the tie without repeating a row, the way a client from before the tie sends it", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { sessionId: "s1", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: ids.project, projectName: "Timer", agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(10), endedAt: at(11) },
      { sessionId: "s2", user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, cwd: "C:/dev/siqshift", projectId: null, agentId: ids.session, agentRepoRoot: null, agentRepoKey: null, startedAt: at(14), endedAt: at(15) },
    ];
    const service = createReportService({ reports });

    const page = await service.agentShiftRows(subject, {
      groupKey: "siqshift",
      pageSize: 2,
      afterStartedAt: at(11).toISOString(),
      afterId: "s1",
    });
    // A legacy cursor reads as untied. The tied shift sits above it and every
    // untied shift newer than the cursor was already served under the old
    // ordering, so the honest continuation is an empty page - nothing
    // repeated, nothing invented.
    expect(page.shifts).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("live agent sessions", () => {
  const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 7, 6, hour, minute));

  const running = (overrides: Partial<RunningAgentSessionRecord> = {}): RunningAgentSessionRecord => ({
    sessionId: "s1",
    user: { id: ids.user, name: "Alex" },
    source: "claude_code",
    model: null,
    cwd: "C:/dev/siqshift",
    projectId: ids.project,
    projectName: "Timer",
    agentRepoRoot: null,
    agentRepoKey: null,
    startedAt: at(10),
    lastEventAt: at(12),
    ...overrides,
  });

  it("shows who is running an agent right now, and only them", async () => {
    const reports = new Reports();
    reports.runningSessions = [
      running({ source: "codex", model: "gpt-5.6-sol" }),
      running({
        sessionId: "s3",
        source: "codex",
        model: "gpt-5.6-sol",
        cwd: "C:/dev/quartermaster",
        projectId: null,
        projectName: null,
        startedAt: at(11),
      }),
      // A person whose only running span is a browser tab is not running an
      // agent; attention is not a worker, the roster's own rule.
      running({ sessionId: "s2", user: { id: ids.otherUser, name: "Sam" }, source: "browser", cwd: null, projectId: null, projectName: null, startedAt: at(9) }),
      // A finished shift is history, and the live view never shows history.
    ];
    const service = createReportService({ reports, now: () => at(12, 30) });

    const result = await service.liveAgentSessions(subject, {});

    expect(result.people.map((person) => person.owner.name)).toEqual(["Alex"]);
    expect(result.people[0]!.sessions.map((session) => [session.id, session.source])).toEqual([
      ["s1", "codex"],
      ["s3", "codex"],
    ]);
  });

  it("describes a session from captured facts alone, never an invented summary", async () => {
    const reports = new Reports();
    reports.runningSessions = [
      running({ model: "claude-opus-5", startedAt: at(12) }),
      running({ sessionId: "s2", source: "pi", model: "deepseek-v4-pro", cwd: null, projectId: null, projectName: null, agentRepoRoot: "C:/dev/quartermaster", agentRepoKey: "path:C:/dev/quartermaster", startedAt: at(10, 30) }),
    ];
    const service = createReportService({ reports, now: () => at(12, 30) });

    const result = await service.liveAgentSessions(subject, {});

    // Runtime, model, the project the attribution resolved to, and how long
    // it has been up. No clause the data cannot support.
    expect(result.people[0]!.sessions.map((session) => session.description)).toEqual([
      "Claude Code on claude-opus-5 in Timer, running 30m",
      "Pi on deepseek-v4-pro in quartermaster, running 2h 0m",
    ]);
    // The codebase label rides beside the description, a name and never a path.
    expect(result.people[0]!.sessions.map((session) => session.repo)).toEqual(["siqshift", "quartermaster"]);
  });

  it("orders project-tied sessions above untied ones, then newest, and people by their running time", async () => {
    const reports = new Reports();
    reports.runningSessions = [
      // Sam's single, shorter session.
      running({ sessionId: "s4", user: { id: ids.otherUser, name: "Sam" }, startedAt: at(12) }),
      // Alex: untied but newest, tied newer, tied older - in that arrival order.
      running({ sessionId: "s1", projectId: null, projectName: null, startedAt: at(12, 10) }),
      running({ sessionId: "s2", startedAt: at(12, 5) }),
      running({ sessionId: "s3", startedAt: at(11) }),
    ];
    const service = createReportService({ reports, now: () => at(12, 30) });

    const result = await service.liveAgentSessions(subject, {});

    expect(result.people.map((person) => person.owner.name)).toEqual(["Alex", "Sam"]);
    expect(result.people[0]!.sessions.map((session) => [session.id, session.project?.name ?? null])).toEqual([
      ["s2", "Timer"],
      ["s3", "Timer"],
      ["s1", null],
    ]);
  });

  it("answers an honest empty roster when nothing is running, and narrows by scope", async () => {
    const empty = createReportService({ reports: new Reports(), now: () => at(12, 30) });
    await expect(empty.liveAgentSessions(subject, {})).resolves.toEqual({ people: [] });

    const reports = new Reports();
    reports.runningSessions = [
      running(),
      running({ sessionId: "s2", cwd: "C:/dev/siqshift", projectId: null, projectName: null, agentRepoRoot: null, agentRepoKey: null, startedAt: at(11) }),
    ];
    const scoped = createReportService({ reports, now: () => at(12, 30) });
    const narrowed = await scoped.liveAgentSessions(subject, { scope: ids.project });
    expect(narrowed.people[0]!.sessions.map((session) => session.id)).toEqual(["s1"]);

    const unassigned = await scoped.liveAgentSessions(subject, { scope: "unassigned" });
    expect(unassigned.people[0]!.sessions.map((session) => session.id)).toEqual(["s2"]);
  });

  it("refuses a scope from outside the workspace, like every report read", async () => {
    const service = createReportService({ reports: new Reports([], new Set()) });

    await expect(service.liveAgentSessions(subject, { scope: ids.project }))
      .rejects.toMatchObject({ code: "not_found", message: "Project not found." });
  });

  it("leaves a shift silent for longer than the staleness window off the live view", async () => {
    const reports = new Reports();
    reports.runningSessions = [
      running({ sessionId: "s1", lastEventAt: at(12) }),
      running({ sessionId: "s2", lastEventAt: at(11, 59) }),
    ];
    const service = createReportService({ reports, now: () => at(12, 30) });

    const result = await service.liveAgentSessions(subject, {});

    expect(result.people.flatMap((person) => person.sessions.map((session) => session.id))).toEqual(["s1"]);
  });
});
