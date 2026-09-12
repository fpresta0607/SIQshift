import {
  addTimeMeasurementsMs,
  clipInterval,
  intersectIntervals,
  isAttributed,
  measureTime,
  measureTimeMs,
  roundTimeMeasurement,
  summedSeconds,
  unionSeconds,
  type AgentShiftRow,
  type AgentShiftRowsFilters,
  type AgentShiftRowsResponse,
  type AgentShiftsFilters,
  type AgentShiftsResponse,
  type AgentSplit,
  type AgentsReportFilters,
  type AgentsReportResponse,
  type Concurrency,
  type HourlyBucket,
  type Interval,
  type LeaderboardFilters,
  type LeaderboardResponse,
  type MeStatsAgent,
  type MeStatsFilters,
  type MeStatsResponse,
  type ReportFilters,
  type ReportResponse,
  type ReportRow,
  type TimeMeasurementMs,
  type TokenTotals,
} from "@siqshift/shared";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type {
  AgentIntervalRecord,
  AgentRecord,
  AgentRepository,
  AgentUsageBucketTotalRecord,
  AgentUsageRepository,
  AgentUsageTotalsRecord,
  AppTotalRecord,
  LeaderboardRowRecord,
  PresenceIntervalRecord,
  ProjectTotalRecord,
  ReportQuery,
  ReportRepository,
  ReportRowRecord,
  ReportSummaryRecord,
  SessionIntervalRecord,
  ShiftCommitCountsRecord,
  ShiftCommitRecord,
  ShiftCommitRepository,
  ShiftRepoRootRecord,
  SiteTotalRecord,
  UserDailyRollupRepository,
} from "../repositories.js";
import { asAgentView } from "./agents.js";
import { isSpentDay, planRollupRange, rollupWindow, type LiveSpan } from "./rollup-ranges.js";
import { agentCodebaseLabel, repoLabel } from "./attribution.js";
import { rosterEligibleSource, type AgentSessionReaper } from "./agent-sessions.js";

export interface ReportService {
  list(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportResponse>;
  export(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportExport>;
  leaderboard(subject: AuthenticatedSubject, filters: LeaderboardFilters): Promise<LeaderboardResponse>;
  meStats(subject: AuthenticatedSubject, filters: MeStatsFilters): Promise<MeStatsResponse>;
  agentsReport(subject: AuthenticatedSubject, filters: AgentsReportFilters): Promise<AgentsReportResponse>;
  agentShifts(subject: AuthenticatedSubject, filters: AgentShiftsFilters): Promise<AgentShiftsResponse>;
  agentShiftRows(subject: AuthenticatedSubject, filters: AgentShiftRowsFilters): Promise<AgentShiftRowsResponse>;
}

export interface ReportExport {
  totalDurationSeconds: number;
  rows: ReportRow[];
}

export interface ReportServiceDependencies {
  reports: ReportRepository;
  /** Stale running agent sessions close at lastEventAt before report aggregation. */
  reaper: AgentSessionReaper;
  /** The roster behind the pay-run report and /me/stats's own-agent rows. */
  agents: AgentRepository;
  /** Without it, every agent row's commit counts stay at zero and heldRate null. */
  shiftCommits?: ShiftCommitRepository;
  /** Without it, token totals stay at zero under tokensReported false, and hourly token fields stay null. */
  agentUsage?: AgentUsageRepository;
  /**
   * Folded finished days. Without it the leaderboard reads every interval row
   * in the range, which is what it did before this table existed and is still
   * what a project-scoped range does.
   */
  rollups?: UserDailyRollupRepository;
  /** Injected so a test can stand at a fixed instant; production passes nothing. */
  now?: () => Date;
}

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
export const reportExportRowCap = 10_000;

function validatePagination(filters: ReportFilters): void {
  if (!Number.isSafeInteger(filters.page) || !Number.isSafeInteger(filters.pageSize)
    || filters.page < 1 || filters.page > 10_000 || filters.pageSize < 1 || filters.pageSize > 200) {
    throw new AppError("validation_error", "Invalid report pagination.");
  }
}

function utcStart(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

type ReportRangeFilters = Pick<ReportFilters, "from" | "to" | "fromAt" | "toExclusiveAt">;

/**
 * A uuid the way PostgreSQL stores and returns one. `idSchema` accepts either
 * case, and a `uuid` column compares either case, so an id only ever differs
 * from the rows it selects once a predicate moves out of SQL and into
 * JavaScript - where `!==` is a plain string compare. Canonicalizing here, at
 * the single point every `ReportQuery.userId` is built, keeps the two kinds of
 * consumer agreeing instead of patching whichever one moved.
 */
function canonicalId(id: string): string {
  return id.toLowerCase();
}

/** Shared range normalization; the agents paystub and pay-run reuse the exact reporting rules. */
export function normalizedQuery(filters: ReportRangeFilters & Partial<Pick<ReportFilters, "projectId" | "userId">>): ReportQuery {
  const hasInstantBoundary = filters.fromAt !== undefined || filters.toExclusiveAt !== undefined;
  if (hasInstantBoundary) {
    if (filters.from !== undefined || filters.to !== undefined || filters.fromAt === undefined || filters.toExclusiveAt === undefined) {
      throw new AppError("validation_error", "Report instant bounds must be supplied together without calendar dates.");
    }
    const from = new Date(filters.fromAt);
    const toExclusive = new Date(filters.toExclusiveAt);
    const durationMs = toExclusive.getTime() - from.getTime();
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 367 * millisecondsPerDay) {
      throw new AppError("validation_error", "The report time range must be between zero and 367 days.");
    }
    return {
      from,
      toExclusive,
      ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
      ...(filters.userId === undefined ? {} : { userId: canonicalId(filters.userId) }),
    };
  }
  const from = filters.from === undefined ? undefined : utcStart(filters.from);
  const inclusiveTo = filters.to === undefined ? undefined : utcStart(filters.to);
  if (from !== undefined && inclusiveTo !== undefined) {
    const rangeDays = (inclusiveTo.getTime() - from.getTime()) / millisecondsPerDay;
    if (rangeDays < 0 || rangeDays > 365) {
      throw new AppError("validation_error", "The report date range must be between zero and 366 days.");
    }
  }
  return {
    ...(from === undefined ? {} : { from }),
    ...(inclusiveTo === undefined ? {} : { toExclusive: new Date(inclusiveTo.getTime() + millisecondsPerDay) }),
    ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
    ...(filters.userId === undefined ? {} : { userId: canonicalId(filters.userId) }),
  };
}

function normalizedMeStatsQuery(filters: MeStatsFilters): ReportQuery {
  return { ...normalizedQuery(filters), ...scopeQuery(filters.scope) };
}

/** Maps the dashboard scope onto query predicates. 'all' and absent are the same thing. */
function scopeQuery(scope: LeaderboardFilters["scope"]): Pick<ReportQuery, "projectId" | "unassignedOnly"> {
  if (scope === undefined || scope === "all") return {};
  if (scope === "unassigned") return { unassignedOnly: true };
  return { projectId: scope };
}

/** Everything the time model needs about one member, gathered across the three interval reads. */
type MemberIntervals = {
  user: { id: string; name: string };
  presence: Interval[];
  sessions: Interval[];
  agents: { source: string; model: string | null; interval: Interval }[];
};

const asInterval = (start: Date, end: Date): Interval => ({ start: start.getTime(), end: end.getTime() });

function collectMembers(
  presence: PresenceIntervalRecord[],
  sessions: SessionIntervalRecord[],
  agents: AgentIntervalRecord[],
): Map<string, MemberIntervals> {
  const members = new Map<string, MemberIntervals>();
  const memberFor = (user: { id: string; name: string }): MemberIntervals => {
    const existing = members.get(user.id);
    if (existing !== undefined) return existing;
    const created: MemberIntervals = { user, presence: [], sessions: [], agents: [] };
    members.set(user.id, created);
    return created;
  };
  for (const row of presence) memberFor(row.user).presence.push(asInterval(row.startedAt, row.endedAt));
  for (const row of sessions) memberFor(row.user).sessions.push(asInterval(row.startedAt, row.stoppedAt));
  for (const row of agents) {
    // Browser spans are attention, not agent runtime - the roster's own rule.
    // One left in here would reclassify the person's own presence as
    // agent-assisted in the concurrency split.
    if (!rosterEligibleSource(row.source)) continue;
    memberFor(row.user).agents.push({ source: row.source, model: row.model, interval: asInterval(row.startedAt, row.endedAt) });
  }
  return members;
}

type MemberMeasurement = {
  activeSeconds: number;
  agentSeconds: number;
  concurrency: Concurrency;
  byAgent: AgentSplit[];
};

/** The range as epoch-millisecond bounds, matching what `measureTime` clips by. */
function queryRange(query: ReportQuery): Partial<Interval> {
  return {
    ...(query.from === undefined ? {} : { start: query.from.getTime() }),
    ...(query.toExclusive === undefined ? {} : { end: query.toExclusive.getTime() }),
  };
}

/**
 * The person's working intervals under the current scope. Presence carries no
 * project, so a project or unassigned scope narrows it to the slices where that
 * scope's sessions were open; the all-projects scope is presence itself.
 */
function workingIntervals(member: MemberIntervals, query: ReportQuery): Interval[] {
  const scoped = query.projectId !== undefined || query.unassignedOnly === true;
  return scoped ? intersectIntervals(member.presence, member.sessions) : member.presence;
}

/** Intervals clipped to the range, zero-length ones dropped. */
function clippedIntervals(intervals: readonly Interval[], range: Partial<Interval>): Interval[] {
  return intervals
    .map((interval) => clipInterval(interval, range))
    .filter((interval): interval is Interval => interval !== null);
}

/** Peak number of the given intervals overlapping at once, via a sweep line. */
export function maxConcurrentCount(intervals: readonly Interval[]): number {
  const starts = intervals.map((interval) => interval.start).sort((a, b) => a - b);
  const ends = intervals.map((interval) => interval.end).sort((a, b) => a - b);
  let startIndex = 0;
  let endIndex = 0;
  let running = 0;
  let peak = 0;
  while (startIndex < starts.length) {
    if (starts[startIndex]! < ends[endIndex]!) {
      running += 1;
      peak = Math.max(peak, running);
      startIndex += 1;
    } else {
      running -= 1;
      endIndex += 1;
    }
  }
  return peak;
}

/** Median in-range session length in seconds; 0 with no sessions. */
export function medianDurationSeconds(intervals: readonly Interval[]): number {
  const lengths = intervals
    .map((interval) => interval.end - interval.start)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  if (lengths.length === 0) return 0;
  const middle = Math.floor(lengths.length / 2);
  const medianMs = lengths.length % 2 === 1 ? lengths[middle]! : (lengths[middle - 1]! + lengths[middle]!) / 2;
  return Math.round(medianMs / 1_000);
}

/**
 * One hour of the caller's local calendar at a time. Bounded ranges tile from
 * their start instant - which the dashboards send as the viewer's local
 * midnight - so bucket `k` is local hour `k`. The unbounded "all time" range
 * returns no buckets; its full history lives in the CSV export instead.
 *
 * Usage buckets join the tile their start falls inside, and tokens are a
 * plain sum over them. An hour nothing reported tokens for keeps nulls, never
 * an invented zero.
 */
export function hourlySeries(
  working: readonly Interval[],
  agents: readonly Interval[],
  usage: readonly AgentUsageBucketTotalRecord[],
  range: Partial<Interval>,
): HourlyBucket[] {
  if (range.start === undefined || range.end === undefined) return [];
  const evidence = [...working, ...agents];
  if (evidence.length === 0) return [];
  const start = range.start;
  const end = range.end;
  if (start >= end) return [];
  const buckets: HourlyBucket[] = [];
  for (let cursor = start; cursor < end; cursor += 60 * 60 * 1_000) {
    const hour = { start: cursor, end: Math.min(cursor + 60 * 60 * 1_000, end) };
    const tokens = usageTokensInHour(usage, hour);
    buckets.push({
      hourStart: new Date(cursor).toISOString(),
      activeSeconds: unionSeconds(working, hour),
      agentSeconds: summedSeconds(agents, hour),
      inputTokens: tokens?.inputTokens ?? null,
      outputTokens: tokens?.outputTokens ?? null,
      cacheCreationInputTokens: tokens?.cacheCreationInputTokens ?? null,
      cacheReadInputTokens: tokens?.cacheReadInputTokens ?? null,
    });
  }
  return buckets;
}

/** The token counters summed over the usage buckets whose start falls inside the hour; null when none do. */
function usageTokensInHour(usage: readonly AgentUsageBucketTotalRecord[], hour: Interval): TokenTotals | null {
  let totals: TokenTotals | null = null;
  for (const bucket of usage) {
    const bucketStart = bucket.bucketStartAt.getTime();
    if (bucketStart < hour.start || bucketStart >= hour.end) continue;
    totals ??= { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    totals.inputTokens += safeInteger(bucket.inputTokens, "hourly input tokens");
    totals.outputTokens += safeInteger(bucket.outputTokens, "hourly output tokens");
    totals.cacheCreationInputTokens += safeInteger(bucket.cacheCreationInputTokens, "hourly cache creation tokens");
    totals.cacheReadInputTokens += safeInteger(bucket.cacheReadInputTokens, "hourly cache read tokens");
  }
  return totals;
}

const ZERO_TOKENS: TokenTotals = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/**
 * One agent's token totals for a report row: the counters summed over the
 * range, and tokensReported counting rows - never whether the sum is nonzero.
 */
function agentTokenTotals(record: AgentUsageTotalsRecord | undefined): { tokens: TokenTotals; tokensReported: boolean } {
  if (record === undefined) return { tokens: ZERO_TOKENS, tokensReported: false };
  return {
    tokens: {
      inputTokens: safeInteger(record.inputTokens, "agent input tokens"),
      outputTokens: safeInteger(record.outputTokens, "agent output tokens"),
      cacheCreationInputTokens: safeInteger(record.cacheCreationInputTokens, "agent cache creation tokens"),
      cacheReadInputTokens: safeInteger(record.cacheReadInputTokens, "agent cache read tokens"),
    },
    tokensReported: safeInteger(record.rowCount, "agent usage row count") > 0,
  };
}

/** Total tokens burned: the sum of the four counters, for the tokens ranking. */
function totalTokens(tokens: TokenTotals): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationInputTokens + tokens.cacheReadInputTokens;
}

/**
 * The tokens ranking key: reporters rank by their total tokens, and agents
 * that reported none sit below every reporter - even one whose rows sum to
 * zero, because a reported zero and no report are different facts.
 */
function rankTokens(row: { tokens: TokenTotals; tokensReported: boolean }): number {
  return row.tokensReported ? totalTokens(row.tokens) + 1 : 0;
}


/** One member's measured time, with the name the live reads saw when they saw one. */
type MeasuredMember = { name?: string; measurement: TimeMeasurementMs };

/**
 * Every member's active and agent time over the range, spending whole finished
 * UTC days out of the rollup table and reading only what it cannot cover.
 *
 * The rollup holds no project, so it answers the all-projects scope alone: a
 * project or unassigned scope narrows active time to the slices where that
 * scope's sessions were open, which a table with one row per person per day
 * cannot state. Those ranges read live, exactly as they did before.
 *
 * Returning milliseconds is the point. Seconds round once per group, and a
 * range assembled from pre-rounded days would drift a second a day away from
 * the answer the live path gives for the same range.
 */
async function measureMembersMs(
  dependencies: ReportServiceDependencies,
  subject: AuthenticatedSubject,
  query: ReportQuery,
  now: Date,
): Promise<Map<string, MeasuredMember>> {
  const range = queryRange(query);
  const scoped = query.projectId !== undefined || query.unassignedOnly === true;
  // A stored day carries the whole workspace and names no project, so any
  // narrowing it cannot restate reads live instead: the project and unassigned
  // scopes, and equally a scope narrowed to one person - stored rows would
  // contribute everyone's time while the live spans contributed one person's,
  // putting other people's hours on their row.
  const canSpendStoredDays = !scoped && query.userId === undefined;
  const openRange = { start: range.start ?? null, end: range.end ?? null };

  const liveSpans: LiveSpan[] = [{ from: query.from ?? null, toExclusive: query.toExclusive ?? null }];
  const totals = new Map<string, TimeMeasurementMs[]>();
  // A stored day names only a user id. The live reads join `users`, so they do
  // carry a name, and it is kept here for the one case the roster read cannot
  // answer: someone the roster no longer lists whose measured work still counts.
  const names = new Map<string, string>();
  const add = (userId: string, measurement: TimeMeasurementMs): void => {
    const pieces = totals.get(userId) ?? [];
    pieces.push(measurement);
    totals.set(userId, pieces);
  };

  const rollups = dependencies.rollups;
  if (rollups !== undefined && canSpendStoredDays) {
    const window = rollupWindow(openRange, (await rollups.earliestDay(subject))?.getTime() ?? null, now);
    const stored = window.from.getTime() >= window.toExclusive.getTime()
      ? []
      : await rollups.readForRange(subject, window.from, window.toExclusive);
    const plan = planRollupRange(openRange, window, new Set(stored.map((row) => row.day.getTime())));
    for (const row of stored) {
      if (!isSpentDay(row.day.getTime(), plan)) continue;
      add(row.userId, {
        activeMs: row.activeMs,
        agentMs: row.agentMs,
        concurrency: {
          t0Ms: row.concurrency0Ms,
          t1Ms: row.concurrency1Ms,
          t2Ms: row.concurrency2Ms,
          t3PlusMs: row.concurrency3PlusMs,
          awayMs: row.awayMs,
        },
      });
    }
    liveSpans.length = 0;
    liveSpans.push(...plan.live);
  }

  // Each span is read on its own and measured against its own bounds. They do
  // not overlap - not each other, and not the days spent above - so adding the
  // pieces is the same union the live path computes in one pass.
  //
  // The spans are walked one at a time, for the reason the fold walks its runs
  // one at a time: there is no bound on how many there are. A day is folded
  // only when an upload's instants land in it, so a day nobody worked stays
  // live for good, and a workspace that rests at weekends accumulates one live
  // span a week. Filling those gaps is fold coverage, and belongs with the
  // scheduled job in the retention change rather than here; until then the
  // stored history is not contiguous and this must not fan out with it.
  const reads: { span: LiveSpan; members: Map<string, MemberIntervals> }[] = [];
  for (const span of liveSpans) {
    // The bounds are replaced rather than narrowed: an open side of a span is
    // an absent bound, which is what the repository reads already mean by it.
    const { from: _rangeFrom, toExclusive: _rangeToExclusive, ...scopeOnly } = query;
    const spanQuery: ReportQuery = {
      ...scopeOnly,
      ...(span.from === null ? {} : { from: span.from }),
      ...(span.toExclusive === null ? {} : { toExclusive: span.toExclusive }),
    };
    const [presence, sessions, agents] = await Promise.all([
      dependencies.reports.readPresenceIntervals(subject, spanQuery),
      scoped ? dependencies.reports.readSessionIntervals(subject, spanQuery) : Promise.resolve([] as SessionIntervalRecord[]),
      dependencies.reports.readAgentIntervals(subject, spanQuery),
    ]);
    reads.push({ span, members: collectMembers(presence, sessions, agents) });
  }

  for (const read of reads) {
    const spanRange: Partial<Interval> = {
      ...(read.span.from === null ? {} : { start: read.span.from.getTime() }),
      ...(read.span.toExclusive === null ? {} : { end: read.span.toExclusive.getTime() }),
    };
    for (const member of read.members.values()) {
      names.set(member.user.id, member.user.name);
      add(member.user.id, measureTimeMs(
        workingIntervals(member, query),
        member.agents.map((agent) => agent.interval),
        spanRange,
      ));
    }
  }

  return new Map([...totals].map(([userId, pieces]) => [userId, {
    ...(names.has(userId) ? { name: names.get(userId)! } : {}),
    measurement: addTimeMeasurementsMs(pieces),
  }]));
}

/**
 * One member's numbers under the current scope. Presence carries no project,
 * so a project or unassigned scope narrows it to the slices where that scope's
 * sessions were open; the all-projects scope is presence itself.
 */
function measureMember(member: MemberIntervals, query: ReportQuery): MemberMeasurement {
  const working = workingIntervals(member, query);
  const range = queryRange(query);
  const measurement = measureTime(working, member.agents.map((agent) => agent.interval), range);
  // Grouped before summing, so each split rounds once. Rounding every
  // interval on its own drifts the splits away from the agentSeconds total
  // they are contracted to reconstruct.
  const grouped = new Map<string, { source: string; model: string | null; intervals: Interval[] }>();
  for (const agent of member.agents) {
    const key = `${agent.source}|${agent.model ?? ""}`;
    const existing = grouped.get(key) ?? { source: agent.source, model: agent.model, intervals: [] };
    existing.intervals.push(agent.interval);
    grouped.set(key, existing);
  }
  const splits = new Map<string, AgentSplit>();
  for (const [key, group] of grouped) {
    const clipped = clippedIntervals(group.intervals, range);
    splits.set(key, {
      source: group.source,
      model: group.model,
      durationSeconds: Math.round(clipped.reduce((sum, interval) => sum + (interval.end - interval.start), 0) / 1_000),
      sessionCount: clipped.length,
      maxConcurrent: maxConcurrentCount(clipped),
      medianSeconds: medianDurationSeconds(clipped),
    });
  }
  return {
    activeSeconds: measurement.activeSeconds,
    agentSeconds: measurement.agentSeconds,
    concurrency: measurement.concurrency,
    byAgent: [...splits.values()]
      .filter((split) => split.durationSeconds > 0)
      .sort((a, b) => b.durationSeconds - a.durationSeconds || a.source.localeCompare(b.source)),
  };
}

const EMPTY_MEASUREMENT: MemberMeasurement = {
  activeSeconds: 0,
  agentSeconds: 0,
  concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
  byAgent: [],
};

function asReportRow(record: ReportRowRecord): ReportRow {
  const durationSeconds = record.durationSeconds;
  return {
    id: record.id,
    user: record.user,
    project: record.project,
    description: record.description,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    stoppedAt: record.stoppedAt.toISOString(),
    idleSeconds: record.idleSeconds,
    durationSeconds,
    attribution: record.attribution,
    // A session is attributed whole or not at all: its project came from a
    // naming signal, or it fell back to the default project.
    attributedSeconds: isAttributed(record.attribution) ? durationSeconds : 0,
    unattributedSeconds: isAttributed(record.attribution) ? 0 : durationSeconds,
  };
}

/** The legacy per-member row, before the time model measures it. */
function asLeaderboardEntry(record: LeaderboardRowRecord): {
  rank: number;
  user: { id: string; name: string };
  durationSeconds: number;
  sessionCount: number;
  attributedSeconds: number;
  unattributedSeconds: number;
} {
  const durationSeconds = safeInteger(record.durationSeconds, "leaderboard duration");
  const attributedSeconds = Math.min(
    durationSeconds,
    safeInteger(record.attributedSeconds, "leaderboard attributed seconds"),
  );
  // Rank is assigned once, after the board sorts by active time.
  return {
    rank: 0,
    user: record.user,
    durationSeconds,
    sessionCount: safeInteger(record.sessionCount, "leaderboard session count"),
    attributedSeconds,
    unattributedSeconds: Math.max(0, durationSeconds - attributedSeconds),
  };
}

/** Reads a postgres sum/count - number, string, or bigint - as a safe nonnegative integer; null reads as 0. */
export function safeInteger(value: number | string | bigint | null, field: string): number {
  if (value === null) return 0;
  const bigint = typeof value === "bigint"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? BigInt(value)
      : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? BigInt(value)
        : null;
  if (bigint === null || bigint > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Report ${field} exceeds the safe integer range.`);
  }
  return Number(bigint);
}

function summaryValues(summary: ReportSummaryRecord): { totalRows: number; totalDurationSeconds: number } {
  return {
    totalRows: safeInteger(summary.totalRows, "row count"),
    totalDurationSeconds: safeInteger(summary.totalDurationSeconds, "duration total"),
  };
}

async function authorizeFilters(repository: ReportRepository, subject: AuthenticatedSubject, query: ReportQuery): Promise<void> {
  if (query.projectId !== undefined && await repository.findProjectForOrganization(subject, query.projectId) === null) {
    throw new AppError("not_found", "Project not found.");
  }
  if (query.userId !== undefined && await repository.findUserForOrganization(subject, query.userId) === null) {
    throw new AppError("not_found", "User not found.");
  }
}

function asProjectTotal(record: ProjectTotalRecord): MeStatsResponse["projects"][number] {
  const durationSeconds = safeInteger(record.durationSeconds, "project duration");
  const attributedSeconds = Math.min(
    durationSeconds,
    safeInteger(record.attributedSeconds, "project attributed seconds"),
  );
  return {
    project: record.project,
    durationSeconds,
    attributedSeconds,
    unattributedSeconds: Math.max(0, durationSeconds - attributedSeconds),
    sessionCount: safeInteger(record.sessionCount, "project session count"),
  };
}

function asAppTotal(record: AppTotalRecord): MeStatsResponse["apps"][number] {
  return {
    processName: record.processName,
    durationSeconds: safeInteger(record.durationSeconds, "app duration"),
  };
}

function asSiteTotal(record: SiteTotalRecord): MeStatsResponse["sites"][number] {
  return {
    mapping: record.mapping,
    durationSeconds: safeInteger(record.durationSeconds, "site duration"),
  };
}

/**
 * The pay-run report is org-wide, so the working-directory disclosure is
 * decided row by row: the folder name for everyone, the path only for the
 * agent's own owner and for workspace admins.
 */
function asAgentReportView(record: AgentRecord, subject: AuthenticatedSubject): AgentsReportResponse["rows"][number]["agent"] {
  return asAgentView(record, subject);
}

/** The same row scoped to one caller, who is by construction its owner; `owner` is redundant there. */
function asMeStatsAgentView(record: AgentRecord, subject: AuthenticatedSubject): MeStatsAgent["agent"] {
  const { owner: _owner, ...view } = asAgentView(record, subject);
  return view;
}

/** Hours and shift count from an agent's intervals overlapping the range (reports rounding rule: group, then round once). */
function agentHours(intervals: readonly Interval[], range: Partial<Interval>): { agentSeconds: number; shiftCount: number } {
  const clipped = clippedIntervals(intervals, range);
  return {
    agentSeconds: Math.round(clipped.reduce((sum, interval) => sum + (interval.end - interval.start), 0) / 1_000),
    shiftCount: clipped.length,
  };
}

/** merged / (merged + reverted + orphaned) - the decided commits; null while nothing has been decided. */
function agentCommitCounts(counts: ShiftCommitCountsRecord | undefined): {
  commitsRecorded: number;
  commitsPending: number;
  commitsMerged: number;
  commitsReverted: number;
  commitsOrphaned: number;
  heldRate: number | null;
} {
  const recorded = counts === undefined ? 0 : safeInteger(counts.recorded, "agent commit recorded count");
  const pending = counts === undefined ? 0 : safeInteger(counts.pending, "agent commit pending count");
  const merged = counts === undefined ? 0 : safeInteger(counts.merged, "agent commit merged count");
  const reverted = counts === undefined ? 0 : safeInteger(counts.reverted, "agent commit reverted count");
  const orphaned = counts === undefined ? 0 : safeInteger(counts.orphaned, "agent commit orphaned count");
  const decided = merged + reverted + orphaned;
  return {
    commitsRecorded: recorded,
    commitsPending: pending,
    commitsMerged: merged,
    commitsReverted: reverted,
    commitsOrphaned: orphaned,
    heldRate: decided === 0 ? null : merged / decided,
  };
}

/**
 * One roster agent's intervals plus the distinct models its shifts named and
 * the distinct codebases they worked, both capped like the contract's rows.
 */
interface AgentIntervals {
  intervals: Interval[];
  models: string[];
  repos: string[];
}

const agentLabelCap = 20;

/** Appends a label once, up to the contract's cap. */
function collectLabel(labels: string[], label: string | null): void {
  if (label === null || labels.includes(label) || labels.length >= agentLabelCap) return;
  labels.push(label);
}

/**
 * Roster agents' intervals grouped by agentId; legacy sessions with no roster
 * identity carry no row to group into. A shift's codebase follows the
 * paystub's shiftRepoLabel rule: its commit's repo root when it recorded one,
 * its working directory otherwise.
 */
function intervalsByAgentId(
  intervals: readonly AgentIntervalRecord[],
  repoRoots: readonly ShiftRepoRootRecord[],
): Map<string, AgentIntervals> {
  const rootBySession = new Map(repoRoots.map((row) => [row.agentSessionId, row.repoRoot]));
  const grouped = new Map<string, AgentIntervals>();
  for (const row of intervals) {
    if (row.agentId === null) continue;
    const existing = grouped.get(row.agentId) ?? { intervals: [], models: [], repos: [] };
    existing.intervals.push(asInterval(row.startedAt, row.endedAt));
    collectLabel(existing.models, row.model);
    const root = rootBySession.get(row.sessionId) ?? row.cwd;
    collectLabel(existing.repos, root === null ? null : repoLabel(root));
    grouped.set(row.agentId, existing);
  }
  return grouped;
}

export function createReportService(dependencies: ReportServiceDependencies): ReportService {
  const now = dependencies.now ?? ((): Date => new Date());
  return {
    async list(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportResponse> {
      validatePagination(filters);
      const query: ReportQuery = { ...normalizedQuery(filters), ...scopeQuery(filters.scope) };
      await authorizeFilters(dependencies.reports, subject, query);
      await dependencies.reaper.reapStale(subject);
      const offset = (filters.page - 1) * filters.pageSize;
      if (!Number.isSafeInteger(offset)) throw new AppError("validation_error", "Invalid report pagination.");
      const page = await dependencies.reports.readPageForOrganization(subject, query, { limit: filters.pageSize, offset });
      const summary = summaryValues(page.summary);
      return {
        filters,
        totalDurationSeconds: summary.totalDurationSeconds,
        pagination: {
          page: filters.page,
          pageSize: filters.pageSize,
          totalRows: summary.totalRows,
          totalPages: Math.ceil(summary.totalRows / filters.pageSize),
        },
        rows: page.rows.map(asReportRow),
      };
    },

    async export(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportExport> {
      validatePagination(filters);
      const query: ReportQuery = { ...normalizedQuery(filters), ...scopeQuery(filters.scope) };
      await authorizeFilters(dependencies.reports, subject, query);
      await dependencies.reaper.reapStale(subject);
      const exportRead = await dependencies.reports.readExportForOrganization(subject, query, reportExportRowCap);
      const summary = summaryValues(exportRead.summary);
      if (summary.totalRows > reportExportRowCap) {
        throw new AppError("validation_error", "Report export is limited to 10,000 rows. Narrow the filters and try again.");
      }
      const rows = exportRead.rows ?? [];
      if (rows.length > reportExportRowCap) throw new RangeError("Report export row count exceeded its limit.");
      return {
        totalDurationSeconds: summary.totalDurationSeconds,
        rows: rows.map(asReportRow),
      };
    },

    async leaderboard(subject: AuthenticatedSubject, filters: LeaderboardFilters): Promise<LeaderboardResponse> {
      const query: ReportQuery = { ...normalizedQuery(filters), ...scopeQuery(filters.scope) };
      await authorizeFilters(dependencies.reports, subject, query);
      await dependencies.reaper.reapStale(subject);
      const [rows, roster, measurements, median] = await Promise.all([
        dependencies.reports.readLeaderboardForOrganization(subject, query),
        dependencies.reports.readMembersForOrganization(subject),
        measureMembersMs(dependencies, subject, query, now()),
        dependencies.reports.readMedianSessionSeconds(subject, query),
      ]);
      const legacy = rows.map(asLeaderboardEntry);
      const legacyById = new Map(legacy.map((entry) => [entry.user.id, entry]));
      // Every member of the workspace is on the board, zeros included: a
      // teammate with no recorded time today reads as "0s", never as missing.
      for (const user of roster) {
        if (legacyById.has(user.id)) continue;
        const empty = { rank: 0, user, durationSeconds: 0, sessionCount: 0, attributedSeconds: 0, unattributedSeconds: 0 };
        legacy.push(empty);
        legacyById.set(user.id, empty);
      }
      // Measured evidence can name someone the roster no longer does (a member
      // deleted mid-range); their work still counts, and the name comes from
      // the roster read when it still has one.
      const rosterById = new Map(roster.map((user) => [user.id, user]));
      for (const [userId, member] of measurements) {
        if (legacyById.has(userId)) continue;
        // The roster names everyone in the workspace, so it answers first; the
        // name a live read carried is the fallback for evidence the roster no
        // longer lists, which is the case this loop exists for.
        const name = rosterById.get(userId)?.name ?? member.name;
        if (name === undefined) continue;
        const empty = { rank: 0, user: { id: userId, name }, durationSeconds: 0, sessionCount: 0, attributedSeconds: 0, unattributedSeconds: 0 };
        legacy.push(empty);
        legacyById.set(userId, empty);
      }
      const measured = legacy.map((entry) => {
        const member = measurements.get(entry.user.id);
        const rounded = member === undefined
          ? { activeSeconds: 0, agentSeconds: 0 }
          : roundTimeMeasurement(member.measurement);
        return { ...entry, activeSeconds: rounded.activeSeconds, agentSeconds: rounded.agentSeconds };
      });
      // The board ranks by active time - the human-hours number - with the
      // legacy duration as a stable tiebreak. A rank is shared only when the
      // whole ranking key ties, so equal work reads as equal and nothing else does.
      measured.sort((a, b) => b.activeSeconds - a.activeSeconds
        || b.durationSeconds - a.durationSeconds
        || a.user.id.localeCompare(b.user.id));
      const tied = (a: typeof measured[number], b: typeof measured[number]): boolean =>
        a.activeSeconds === b.activeSeconds && a.durationSeconds === b.durationSeconds;
      const entries = measured.map((entry, index) => ({ ...entry, rank: index + 1 }));
      for (let i = 1; i < entries.length; i++) {
        if (tied(measured[i]!, measured[i - 1]!)) entries[i]!.rank = entries[i - 1]!.rank;
      }
      return {
        filters,
        totalDurationSeconds: entries.reduce((total, entry) => total + entry.durationSeconds, 0),
        medianSessionSeconds: median,
        entries,
      };
    },

    async meStats(subject: AuthenticatedSubject, filters: MeStatsFilters): Promise<MeStatsResponse> {
      // A named teammate, or the caller. The same membership check the org
      // report runs: an id outside this workspace is a stable not_found.
      const query: ReportQuery = { ...normalizedMeStatsQuery(filters), userId: filters.userId ?? subject.userId };
      await authorizeFilters(dependencies.reports, subject, {
        ...(filters.userId === undefined ? {} : { userId: filters.userId }),
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      });
      await dependencies.reaper.reapStale(subject);
      const [projects, apps, sites, presence, sessionIntervals, agentIntervals, usageBuckets, usageByAgent] = await Promise.all([
        dependencies.reports.readProjectTotalsForMember(subject, query).then((rows) => rows.map(asProjectTotal)),
        dependencies.reports.readAppTotalsForMember(subject, query).then((rows) => rows.map(asAppTotal)),
        dependencies.reports.readSiteTotalsForMember(subject, query).then((rows) => rows.map(asSiteTotal)),
        dependencies.reports.readPresenceIntervals(subject, query),
        dependencies.reports.readSessionIntervals(subject, query),
        dependencies.reports.readAgentIntervals(subject, query),
        dependencies.agentUsage === undefined ? Promise.resolve([]) : dependencies.agentUsage.sumByBucket(subject, query),
        dependencies.agentUsage === undefined ? Promise.resolve([]) : dependencies.agentUsage.sumByAgent(subject, query),
      ]);
      const member = collectMembers(presence, sessionIntervals, agentIntervals).get(query.userId ?? subject.userId);
      const measurement = member === undefined ? EMPTY_MEASUREMENT : measureMember(member, query);
      const hourly = member === undefined
        ? []
        : hourlySeries(workingIntervals(member, query), member.agents.map((agent) => agent.interval), usageBuckets, queryRange(query));

      const range = queryRange(query);
      const [commitCounts, repoRoots] = dependencies.shiftCommits === undefined
        ? [[], []]
        : await Promise.all([
          dependencies.shiftCommits.countsByAgent(subject, query),
          dependencies.shiftCommits.repoRootsByAgent(subject, query),
        ]);
      const grouped = intervalsByAgentId(agentIntervals, repoRoots);
      // Only the identities this member's own shifts ran under. The whole
      // roster was read here and then discarded down to exactly these ids,
      // which on a 60-second refresh was the largest fixed read on the path.
      const roster = await dependencies.agents.listByIds(subject, [...grouped.keys()]);
      const rosterById = new Map(roster.map((agent) => [agent.id, agent]));
      const countsById = new Map(commitCounts.map((row) => [row.agentId, row]));
      const usageById = new Map(usageByAgent.map((row) => [row.agentId, row]));
      // Own agent rows are exactly the roster identities this member's shifts
      // ran under in range - the same boundary the interval read already scoped to.
      const agents: MeStatsAgent[] = [...grouped.keys()]
        .map((agentId) => rosterById.get(agentId))
        .filter((agent): agent is AgentRecord => agent !== undefined)
        .map((agent) => ({
          agent: asMeStatsAgentView(agent, subject),
          ...agentHours(grouped.get(agent.id)?.intervals ?? [], range),
          ...agentCommitCounts(countsById.get(agent.id)),
          models: grouped.get(agent.id)?.models ?? [],
          repos: grouped.get(agent.id)?.repos ?? [],
          ...agentTokenTotals(usageById.get(agent.id)),
        }));

      return {
        filters,
        totalDurationSeconds: projects.reduce((total, project) => total + project.durationSeconds, 0),
        attributedSeconds: projects.reduce((total, project) => total + project.attributedSeconds, 0),
        unattributedSeconds: projects.reduce((total, project) => total + project.unattributedSeconds, 0),
        ...measurement,
        hourly,
        projects,
        apps,
        sites,
        agents,
      };
    },

    async agentsReport(subject: AuthenticatedSubject, filters: AgentsReportFilters): Promise<AgentsReportResponse> {
      const query: ReportQuery = { ...normalizedQuery(filters), ...scopeQuery(filters.scope) };
      await authorizeFilters(dependencies.reports, subject, query);
      await dependencies.reaper.reapStale(subject);
      const [roster, agentIntervals, commitCounts, repoRoots, usageByAgent] = await Promise.all([
        dependencies.agents.listForOrganization(subject),
        dependencies.reports.readAgentIntervals(subject, query),
        dependencies.shiftCommits === undefined ? Promise.resolve([]) : dependencies.shiftCommits.countsByAgent(subject, query),
        dependencies.shiftCommits === undefined ? Promise.resolve([]) : dependencies.shiftCommits.repoRootsByAgent(subject, query),
        dependencies.agentUsage === undefined ? Promise.resolve([]) : dependencies.agentUsage.sumByAgent(subject, query),
      ]);
      const range = queryRange(query);
      const grouped = intervalsByAgentId(agentIntervals, repoRoots);
      const countsById = new Map(commitCounts.map((row) => [row.agentId, row]));
      const usageById = new Map(usageByAgent.map((row) => [row.agentId, row]));
      // Every roster agent gets a row, activity or not: the roster - not the
      // interval data - decides which agents exist. The one exception is a
      // retired agent with nothing to show in this range: it is neither on the
      // clock nor evidence of anything, so a row reading "0s · 0 shifts ·
      // pending" is pure clutter between the agents the reader came for. It
      // still counts in the headcount, which is what says the retirement
      // happened at all.
      //
      // "Nothing to show" has to mean every column, because these reads do not
      // share a clock: commits are counted by their git author date while
      // intervals are counted by session overlap, so a rebased commit can land
      // in a range the shift that recorded it never touched. A row with a
      // commit tally or a token total is evidence, whatever its hours say.
      const rows = roster
        .map((agent) => ({
          agent: asAgentReportView(agent, subject),
          ...agentHours(grouped.get(agent.id)?.intervals ?? [], range),
          ...agentCommitCounts(countsById.get(agent.id)),
          models: grouped.get(agent.id)?.models ?? [],
          repos: grouped.get(agent.id)?.repos ?? [],
          ...agentTokenTotals(usageById.get(agent.id)),
        }))
        .filter((row) => row.agent.status !== "retired"
          || row.agentSeconds > 0
          || row.shiftCount > 0
          || row.commitsRecorded > 0
          || row.tokensReported);
      // A sort ranks heaviest first; ties and non-reporters keep roster order
      // (the sort is stable). Tokens rank agents that reported none last.
      if (filters.sort === "hours") {
        rows.sort((a, b) => b.agentSeconds - a.agentSeconds);
      } else if (filters.sort === "tokens") {
        rows.sort((a, b) => rankTokens(b) - rankTokens(a));
      }
      return {
        filters,
        headcount: {
          total: roster.length,
          // Active is everyone still on the clock: anonymous and registered alike.
          active: roster.filter((agent) => agent.status !== "retired").length,
          retired: roster.filter((agent) => agent.status === "retired").length,
        },
        rows,
      };
    },

    async agentShifts(subject: AuthenticatedSubject, filters: AgentShiftsFilters): Promise<AgentShiftsResponse> {
      const board = await readShiftBoard(dependencies, subject, filters);
      return {
        filters,
        totalAgentSeconds: board.groups.reduce((sum, group) => sum + group.agentSeconds, 0),
        // Heaviest first, with the id breaking ties so an equal pair keeps
        // one order between two reads of the same range.
        people: [...board.people.values()]
          .sort((a, b) => b.agentSeconds - a.agentSeconds || a.owner.id.localeCompare(b.owner.id)),
        hourly: shiftHourlySeries(board.groups, board.range),
        // The heads alone. The shifts behind them are a paged read against
        // `groupKey`, made when a reader opens a drawer: a busy month runs to
        // thousands of rows, and shipping them all to draw four numbers per
        // group was almost the whole of this response.
        groups: board.groups.map((group) => ({
          groupKey: group.key,
          repo: group.repo,
          nullCause: group.nullCause,
          agentSeconds: group.agentSeconds,
          shiftCount: group.shifts.length,
          heldRate: heldRateOf(group.commits),
        })),
      };
    },

    async agentShiftRows(subject: AuthenticatedSubject, filters: AgentShiftRowsFilters): Promise<AgentShiftRowsResponse> {
      const { groupKey, pageSize, afterStartedAt, afterId, ...boardFilters } = filters;
      const board = await readShiftBoard(dependencies, subject, boardFilters);
      // A key the range no longer holds is an empty page, not an error: the
      // aggregate a drawer was opened from can be a minute old, and a group
      // that has since rolled out of a moving range is a normal answer.
      const shifts = board.groups.find((group) => group.key === groupKey)?.shifts ?? [];
      // Sliced from the first shift strictly after the cursor in the group's
      // own ordering, never from an index: a shift that started since the last
      // page moves every index below it and an offset would serve a row the
      // drawer already holds. No cursor asks for the head of the list.
      const start = afterStartedAt === undefined || afterId === undefined
        ? 0
        : shifts.findIndex((shift) => isAfterShiftCursor(shift, afterStartedAt, afterId));
      const page = start === -1 ? [] : shifts.slice(start, start + pageSize);
      const last = page.at(-1);
      return {
        filters,
        shifts: page,
        // The last row's own ordering pair while rows remain behind it. Null
        // says the group is exhausted, which is the whole of what a drawer
        // needs to decide whether to offer another page.
        nextCursor: last === undefined || start + page.length >= shifts.length
          ? null
          : { startedAt: last.startedAt, id: last.id },
      };
    },
  };
}

/**
 * Whether a shift falls strictly after a cursor in the board's own ordering -
 * `startedAt` descending, `id` ascending to break an equal instant. The cursor
 * instant is re-rendered through `Date` first, because it arrives off a query
 * string where `...:00Z` and `...:00.000Z` name the same moment but do not
 * compare as the same string.
 */
function isAfterShiftCursor(shift: AgentShiftRow, afterStartedAt: string, afterId: string): boolean {
  const cursorStartedAt = new Date(afterStartedAt).toISOString();
  if (shift.startedAt !== cursorStartedAt) return shift.startedAt < cursorStartedAt;
  return shift.id > afterId;
}

/** One codebase's group mid-assembly: its shifts, and the commits its held rate is decided from. */
type ShiftBoardGroup = {
  key: string;
  repo: string | null;
  nullCause: NonNullable<AgentShiftsResponse["groups"][number]["nullCause"]> | null;
  agentSeconds: number;
  commits: ShiftCommitRecord[];
  shifts: AgentShiftRow[];
};

/**
 * The Agents tab's one read, shared by the aggregate and by the paged rows
 * behind it, so a drawer can never list shifts its own head did not count.
 * The cost of sharing it: opening a drawer reads the whole range again, since
 * a shift's codebase label is computed here rather than in SQL and so cannot
 * narrow the query to one group.
 *
 * One group per codebase label, assembled straight from the shifts: no roster
 * join, so two worktree clones of the same repo read as one codebase, which
 * is what the tab is for. Each shift labels itself the paystub's way - its
 * first commit's repo root, else its working directory - and a shift whose
 * own paths name only a run (a no-mistakes gate worktree, a CI checkout)
 * falls back to its roster identity's repository: the remote the runtime
 * probed for exactly this shift, the same evidence that keyed the identity. A
 * shift that can name nothing at all groups under null, split by why - no
 * directory ever captured, or a run directory whose repository no runtime
 * identified - so the reader can tell a capture gap from work that
 * legitimately has no repo.
 */
async function readShiftBoard(
  dependencies: ReportServiceDependencies,
  subject: AuthenticatedSubject,
  filters: AgentShiftsFilters,
): Promise<{
  groups: ShiftBoardGroup[];
  people: Map<string, AgentShiftsResponse["people"][number]>;
  range: Partial<Interval>;
}> {
  const query: ReportQuery = { ...normalizedQuery(filters), ...scopeQuery(filters.scope) };
  await authorizeFilters(dependencies.reports, subject, query);
  await dependencies.reaper.reapStale(subject);
  // Authorize the selection, then read without it. `normalizedQuery`
  // forwards `userId` into the query and `readAgentIntervals` turns it
  // into a predicate, so reading with it would narrow the rows `people`
  // is rolled up from - the board would collapse to the one person who
  // was picked, leaving no control to clear the selection with. The
  // filter is applied in memory below instead, after the roll-up.
  const { userId: selectedUserId, ...boardQuery } = query;
  const [intervals, commits] = await Promise.all([
    dependencies.reports.readAgentIntervals(subject, boardQuery),
    dependencies.shiftCommits === undefined
      ? Promise.resolve([] as ShiftCommitRecord[])
      : dependencies.shiftCommits.listForOrganization(subject, boardQuery),
  ]);
  const range = queryRange(query);
  const commitsBySession = new Map<string, ShiftCommitRecord[]>();
  for (const commit of commits) {
    const list = commitsBySession.get(commit.agentSessionId);
    if (list === undefined) commitsBySession.set(commit.agentSessionId, [commit]);
    else list.push(commit);
  }

  type NullCause = ShiftBoardGroup["nullCause"];
  const groups = new Map<string, ShiftBoardGroup>();
  const people = new Map<string, AgentShiftsResponse["people"][number]>();
  for (const interval of intervals) {
    // Browser spans are attention, not shifts, the roster's own rule.
    if (!rosterEligibleSource(interval.source)) continue;
    const clipped = clipInterval({ start: interval.startedAt.getTime(), end: interval.endedAt.getTime() }, range);
    if (clipped === null) continue;
    // Rounded once, then spent on the person, the group and the shift, so
    // the three totals reconcile exactly rather than drifting a second
    // per shift across the hundreds of rows this tab exists to hold.
    const shiftSeconds = Math.round((clipped.end - clipped.start) / 1_000);
    // Every shift has exactly one owner, so the board is a partition of
    // the same seconds the groups spend: summing it back reaches the
    // total. This runs before the selection so the board keeps every
    // person on it whoever is picked.
    const person = people.get(interval.user.id)
      ?? { owner: { id: interval.user.id, name: interval.user.name }, agentSeconds: 0, shiftCount: 0 };
    person.agentSeconds += shiftSeconds;
    person.shiftCount += 1;
    people.set(interval.user.id, person);
    if (selectedUserId !== undefined && interval.user.id !== selectedUserId) continue;
    const shiftCommitList = commitsBySession.get(interval.sessionId) ?? [];
    const root = shiftCommitList[0]?.repoRoot ?? interval.cwd;
    const repo = (root === null || root === undefined ? null : repoLabel(root))
      ?? agentCodebaseLabel(interval.agentRepoRoot, interval.agentRepoKey);
    const nullCause: NullCause = repo === null
      ? (root === null || root === undefined ? "no-working-directory" : "unidentified-run-directory")
      : null;
    const key = repo ?? `null:${nullCause}`;
    const group = groups.get(key)
      ?? { key, repo, nullCause, agentSeconds: 0, commits: [], shifts: [] };
    group.agentSeconds += shiftSeconds;
    group.commits.push(...shiftCommitList);
    group.shifts.push({
      id: interval.sessionId,
      source: interval.source,
      owner: { id: interval.user.id, name: interval.user.name },
      model: interval.model,
      startedAt: interval.startedAt.toISOString(),
      endedAt: interval.endedAt.toISOString(),
      agentSeconds: shiftSeconds,
      commitCount: shiftCommitList.length,
    });
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    // Newest first, the id breaking ties: a page boundary falling between two
    // shifts that share a start instant would otherwise be free to repeat one
    // of them and drop the other across two page reads.
    group.shifts.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
  }
  return {
    groups: [...groups.values()]
      // Heaviest first; the label-less group reads last whatever its hours,
      // because "no codebase recorded" is a footnote, not a codebase.
      .sort((a, b) => Number(a.repo === null) - Number(b.repo === null) || b.agentSeconds - a.agentSeconds),
    people,
    range,
  };
}

/**
 * The Agents tab's hourly series, over the shifts the tab is showing. Folded
 * from the shifts' own instants rather than from their clipped seconds, so
 * the line traces when the work happened.
 *
 * Per-hour resolution over an unbounded range is meaningless and the series
 * would grow with the workspace's whole history, so an unbounded range - the
 * Humans tab's series declines the same way - yields no buckets at all. The
 * axis is contiguous from the range's start, zeros included, so quiet hours
 * read as quiet rather than vanishing. Token counters read null because this
 * series measures time alone.
 */
function shiftHourlySeries(groups: readonly ShiftBoardGroup[], range: Partial<Interval>): HourlyBucket[] {
  if (range.start === undefined || range.end === undefined) return [];
  const hourMs = 60 * 60 * 1_000;
  const seconds = new Map<number, number>();
  for (const group of groups) {
    for (const shift of group.shifts) {
      const start = Date.parse(shift.startedAt);
      const end = Date.parse(shift.endedAt);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      for (let hour = Math.floor(start / hourMs) * hourMs; hour < end; hour += hourMs) {
        const overlap = Math.min(end, hour + hourMs) - Math.max(start, hour);
        if (overlap > 0) seconds.set(hour, (seconds.get(hour) ?? 0) + Math.round(overlap / 1_000));
      }
    }
  }
  if (seconds.size === 0) return [];
  const first = Math.floor(range.start / hourMs) * hourMs;
  const last = Math.max(...seconds.keys());
  const buckets: HourlyBucket[] = [];
  for (let hour = first; hour <= last; hour += hourMs) {
    buckets.push({
      hourStart: new Date(hour).toISOString(),
      activeSeconds: 0,
      agentSeconds: seconds.get(hour) ?? 0,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
  }
  return buckets;
}

/** merged / decided; null while nothing has been decided - never a fake zero. */
function heldRateOf(commits: readonly ShiftCommitRecord[]): number | null {
  const decided = commits.filter((commit) => commit.verification !== "pending");
  if (decided.length === 0) return null;
  return decided.filter((commit) => commit.verification === "merged").length / decided.length;
}
