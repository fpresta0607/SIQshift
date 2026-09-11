import { describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentIntervalRecord,
  AgentRepository,
  AppTotalRecord,
  LeaderboardRowRecord,
  PresenceIntervalRecord,
  ProjectTotalRecord,
  ReportLookupRecord,
  ReportQuery,
  ReportRepository,
  SessionIntervalRecord,
  SiteTotalRecord,
  UserDailyRollupRecord,
  UserDailyRollupRepository,
} from "../repositories.js";
import { createReportService } from "./reports.js";
import { isSpentDay, planRollupRange, rollupWindow } from "./rollup-ranges.js";
import { DAY_MS, createRollupService, foldDay, foldableDays, utcDayStart } from "./rollups.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const subject: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user, role: "member" };

/** 2026-08-05 is a Wednesday; every fixture below is anchored to it. */
const at = (dayOffset: number, hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 7, 5 + dayOffset, hour, minute));
const day = (dayOffset: number): Date => new Date(Date.UTC(2026, 7, 5 + dayOffset));

const presence = (userId: string, name: string, start: Date, end: Date): PresenceIntervalRecord =>
  ({ user: { id: userId, name }, startedAt: start, endedAt: end });

const agentInterval = (
  userId: string,
  name: string,
  start: Date,
  end: Date,
  overrides: Partial<AgentIntervalRecord> = {},
): AgentIntervalRecord => ({
  sessionId: `s-${userId}-${start.toISOString()}`,
  user: { id: userId, name },
  source: "claude_code",
  model: null,
  cwd: null,
  projectId: ids.project,
  agentId: null,
  agentRepoRoot: null,
  agentRepoKey: null,
  startedAt: start,
  endedAt: end,
  ...overrides,
} as AgentIntervalRecord);

/** Reads bounded the way the real repository bounds them: overlap, not containment. */
class Reports implements Partial<ReportRepository> {
  public presenceIntervals: PresenceIntervalRecord[] = [];
  public agentIntervals: AgentIntervalRecord[] = [];
  public sessionIntervals: SessionIntervalRecord[] = [];
  public leaderboardRows: LeaderboardRowRecord[] = [];
  public roster: ReportLookupRecord[] = [];
  public presenceReads: ReportQuery[] = [];
  public agentReads: ReportQuery[] = [];

  public async readPresenceIntervals(_subject: AuthenticatedSubject, query: ReportQuery): Promise<PresenceIntervalRecord[]> {
    this.presenceReads.push(query);
    return this.presenceIntervals.filter((row) => overlaps(row.startedAt, row.endedAt, query));
  }
  public async readAgentIntervals(_subject: AuthenticatedSubject, query: ReportQuery): Promise<AgentIntervalRecord[]> {
    this.agentReads.push(query);
    return this.agentIntervals.filter((row) => overlaps(row.startedAt, row.endedAt, query));
  }
  public async readSessionIntervals(_subject: AuthenticatedSubject, query: ReportQuery): Promise<SessionIntervalRecord[]> {
    return this.sessionIntervals.filter((row) => overlaps(row.startedAt, row.stoppedAt, query));
  }
  public async readLeaderboardForOrganization(): Promise<LeaderboardRowRecord[]> {
    return this.leaderboardRows;
  }
  public async readMembersForOrganization(): Promise<ReportLookupRecord[]> {
    return this.roster;
  }
  public async readMedianSessionSeconds(): Promise<number | null> {
    return null;
  }
  public async findProjectForOrganization(_subject: AuthenticatedSubject, projectId: string): Promise<ReportLookupRecord | null> {
    return projectId === ids.project ? { id: ids.project, name: "Ledger" } : null;
  }
  public async findUserForOrganization(): Promise<null> {
    return null;
  }
  public async readProjectTotalsForMember(): Promise<ProjectTotalRecord[]> {
    return [];
  }
  public async readAppTotalsForMember(): Promise<AppTotalRecord[]> {
    return [];
  }
  public async readSiteTotalsForMember(): Promise<SiteTotalRecord[]> {
    return [];
  }
}

function overlaps(start: Date, end: Date, query: ReportQuery): boolean {
  if (query.from !== undefined && end.getTime() <= query.from.getTime()) return false;
  if (query.toExclusive !== undefined && start.getTime() >= query.toExclusive.getTime()) return false;
  return true;
}

class Rollups implements UserDailyRollupRepository {
  public rows: UserDailyRollupRecord[] = [];
  public readonly calls: string[] = [];
  public failWrite = false;

  public async readForRange(_subject: AuthenticatedSubject, from: Date, toExclusive: Date): Promise<UserDailyRollupRecord[]> {
    this.calls.push("read");
    return this.rows.filter((row) => row.day >= from && row.day < toExclusive);
  }
  public async earliestDay(): Promise<Date | null> {
    const days = this.rows.map((row) => row.day.getTime()).sort((a, b) => a - b);
    return days[0] === undefined ? null : new Date(days[0]);
  }
  public async clearDays(_subject: AuthenticatedSubject, days: readonly Date[]): Promise<void> {
    this.calls.push("clear");
    const dropped = new Set(days.map((entry) => entry.getTime()));
    this.rows = this.rows.filter((row) => !dropped.has(row.day.getTime()));
  }
  public async writeDays(_subject: AuthenticatedSubject, rows: readonly UserDailyRollupRecord[]): Promise<void> {
    this.calls.push("write");
    if (this.failWrite) throw new Error("write failed");
    this.rows.push(...rows);
  }
}

const silentReaper = { reapStale: async (): Promise<number> => 0 };
const agents = { listForOrganization: async () => [], listByIds: async () => [] } as unknown as AgentRepository;

describe("utc days", () => {
  it("keeps only days that are already over, oldest first and each once", () => {
    const now = at(2, 9);
    expect(foldableDays([at(0, 23), at(0, 1), at(1, 12), at(2, 8)], now).map((entry) => entry.toISOString()))
      .toEqual([day(0).toISOString(), day(1).toISOString()]);
    // Today is still being written, so nothing in it is foldable.
    expect(foldableDays([at(2, 0), at(2, 23)], now)).toEqual([]);
  });

  it("floors to midnight UTC rather than to the local day", () => {
    expect(utcDayStart(at(0, 23, 59)).toISOString()).toBe(day(0).toISOString());
    expect(utcDayStart(at(1, 0)).toISOString()).toBe(day(1).toISOString());
  });
});

describe("folding a day", () => {
  it("clips at midnight, so a span across it lands in both days and neither twice", () => {
    const overnight = [presence(ids.user, "Alex", at(0, 22), at(1, 2))];
    const first = foldDay([{ id: ids.user }], overnight, [], day(0));
    const second = foldDay([{ id: ids.user }], overnight, [], day(1));

    expect(first[0]?.activeMs).toBe(2 * 60 * 60 * 1_000);
    expect(second[0]?.activeMs).toBe(2 * 60 * 60 * 1_000);
    // Four hours of presence, split exactly - never rounded into each day.
    expect(first[0]!.activeMs + second[0]!.activeMs).toBe(4 * 60 * 60 * 1_000);
  });

  it("writes a row for every member, so a quiet day is folded rather than absent", () => {
    const rows = foldDay(
      [{ id: ids.user }, { id: ids.otherUser }],
      [presence(ids.user, "Alex", at(0, 9), at(0, 10))],
      [],
      day(0),
    );

    expect(rows.map((entry) => entry.userId).sort()).toEqual([ids.user, ids.otherUser].sort());
    expect(rows.find((entry) => entry.userId === ids.otherUser)).toMatchObject({ activeMs: 0, agentMs: 0 });
  });

  it("keeps browser spans out of the stored split, the roster's own rule", () => {
    const [row] = foldDay(
      [{ id: ids.user }],
      [presence(ids.user, "Alex", at(0, 9), at(0, 11))],
      [agentInterval(ids.user, "Alex", at(0, 9), at(0, 11), { source: "browser" })],
      day(0),
    );

    // A tab is attention, not an agent: the two hours stay unassisted.
    expect(row).toMatchObject({ agentMs: 0, concurrency0Ms: 2 * 60 * 60 * 1_000, concurrency1Ms: 0 });
  });

  it("stores a split that adds back to the active time it partitions", () => {
    const [row] = foldDay(
      [{ id: ids.user }],
      [presence(ids.user, "Alex", at(0, 9), at(0, 12))],
      [
        agentInterval(ids.user, "Alex", at(0, 9), at(0, 10)),
        agentInterval(ids.user, "Alex", at(0, 9), at(0, 11)),
        agentInterval(ids.user, "Alex", at(0, 13), at(0, 14)),
      ],
      day(0),
    );

    // The check constraint the migration carries, asserted where it is produced.
    expect(row!.concurrency0Ms + row!.concurrency1Ms + row!.concurrency2Ms + row!.concurrency3PlusMs)
      .toBe(row!.activeMs);
    // An agent that ran while nobody was at the keyboard is away time, not active.
    expect(row!.awayMs).toBe(60 * 60 * 1_000);
  });
});

describe("maintaining the fold", () => {
  it("clears the days before it reads anything, so a failed fold leaves them unfolded rather than wrong", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }];
    reports.presenceIntervals = [presence(ids.user, "Alex", at(0, 9), at(0, 10))];
    const rollups = new Rollups();
    const service = createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => at(1, 9) });

    await service.refresh(subject, [at(0, 9)]);
    expect(rollups.calls).toEqual(["clear", "write"]);
    expect(rollups.rows).toHaveLength(1);

    // A day that now reads differently, with the write failing on the way back.
    reports.presenceIntervals = [presence(ids.user, "Alex", at(0, 9), at(0, 12))];
    rollups.failWrite = true;
    await expect(service.refresh(subject, [at(0, 9)])).rejects.toThrow("write failed");

    // The stale row is gone rather than standing over rows it no longer matches.
    expect(rollups.rows).toEqual([]);
  });

  it("folds nothing for a day that is still being written", async () => {
    const reports = new Reports();
    const rollups = new Rollups();
    const service = createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => at(0, 12) });

    await service.refresh(subject, [at(0, 9)]);

    expect(rollups.calls).toEqual([]);
    expect(rollups.rows).toEqual([]);
  });
});

describe("planning a range against the fold", () => {
  const now = at(3, 9);

  it("never spends today, however the range is bounded", () => {
    const window = rollupWindow({ start: day(0).getTime(), end: at(3, 23).getTime() }, day(0).getTime(), now);
    expect(window.toExclusive.toISOString()).toBe(day(3).toISOString());
  });

  it("reads the partial day at each end live and spends the whole days between", () => {
    const range = { start: at(0, 9).getTime(), end: at(3, 5).getTime() };
    const window = rollupWindow(range, day(0).getTime(), now);
    const covered = new Set([day(1).getTime(), day(2).getTime()]);
    const plan = planRollupRange(range, window, covered);

    expect(plan.live.map((span) => [span.from?.toISOString(), span.toExclusive?.toISOString()])).toEqual([
      [at(0, 9).toISOString(), day(1).toISOString()],
      [day(3).toISOString(), at(3, 5).toISOString()],
    ]);
    expect(isSpentDay(day(1).getTime(), plan)).toBe(true);
    expect(isSpentDay(day(2).getTime(), plan)).toBe(true);
  });

  it("pushes a day the table is missing back into a live span rather than counting it as zero", () => {
    const range = { start: day(0).getTime(), end: day(3).getTime() };
    const window = rollupWindow(range, day(0).getTime(), now);
    const plan = planRollupRange(range, window, new Set([day(0).getTime(), day(2).getTime()]));

    expect(plan.live.map((span) => [span.from?.toISOString(), span.toExclusive?.toISOString()])).toEqual([
      [day(1).toISOString(), day(2).toISOString()],
    ]);
    expect(isSpentDay(day(1).getTime(), plan)).toBe(false);
    expect(isSpentDay(day(0).getTime(), plan)).toBe(true);
  });

  it("reads an all-time range live below the earliest day it holds, and today above it", () => {
    const plan = planRollupRange(
      { start: null, end: null },
      rollupWindow({ start: null, end: null }, day(1).getTime(), now),
      new Set([day(1).getTime(), day(2).getTime()]),
    );

    expect(plan.live.map((span) => [span.from?.toISOString() ?? null, span.toExclusive?.toISOString() ?? null])).toEqual([
      [null, day(1).toISOString()],
      [day(3).toISOString(), null],
    ]);
  });

  it("reads the whole range live when nothing is stored at all", () => {
    const range = { start: day(0).getTime(), end: day(3).getTime() };
    const plan = planRollupRange(range, rollupWindow(range, null, now), new Set());

    expect(plan.live).toHaveLength(1);
    expect(plan.live[0]?.from?.toISOString()).toBe(day(0).toISOString());
    expect(plan.live[0]?.toExclusive?.toISOString()).toBe(day(3).toISOString());
  });

  it("spends nothing for a range that sits inside one unfinished day", () => {
    const range = { start: at(3, 1).getTime(), end: at(3, 8).getTime() };
    const plan = planRollupRange(range, rollupWindow(range, day(0).getTime(), now), new Set());

    expect(plan.window.from.getTime()).toBe(plan.window.toExclusive.getTime());
    expect(plan.live).toHaveLength(1);
  });
});

describe("the board with and without the fold", () => {
  /** Three days of two people working, agents overlapping and crossing midnight. */
  const seed = (): Reports => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }, { id: ids.otherUser, name: "Sam" }];
    reports.presenceIntervals = [
      presence(ids.user, "Alex", at(0, 9), at(0, 17)),
      presence(ids.user, "Alex", at(1, 22), at(2, 2)),
      presence(ids.user, "Alex", at(3, 8), at(3, 9, 30)),
      presence(ids.otherUser, "Sam", at(0, 13), at(0, 14)),
      presence(ids.otherUser, "Sam", at(2, 9), at(2, 18)),
    ];
    reports.agentIntervals = [
      agentInterval(ids.user, "Alex", at(0, 9), at(0, 12)),
      agentInterval(ids.user, "Alex", at(0, 10), at(0, 11)),
      agentInterval(ids.user, "Alex", at(1, 23), at(2, 4)),
      agentInterval(ids.otherUser, "Sam", at(2, 9), at(2, 12)),
      agentInterval(ids.otherUser, "Sam", at(2, 10), at(2, 20)),
      agentInterval(ids.user, "Alex", at(0, 20), at(0, 22), { source: "browser" }),
    ];
    return reports;
  };

  const now = at(3, 10);

  /**
   * The claim the whole table rests on: spending stored days changes how the
   * answer is assembled and nothing about the answer.
   */
  it.each([
    ["all time", {}],
    ["a bounded range whose ends fall mid-day", { fromAt: at(0, 10).toISOString(), toExclusiveAt: at(3, 9).toISOString() }],
    ["a range on whole day boundaries", { fromAt: day(0).toISOString(), toExclusiveAt: day(3).toISOString() }],
    ["a range inside the unfinished day", { fromAt: at(3, 0).toISOString(), toExclusiveAt: at(3, 10).toISOString() }],
    ["a range that starts before anything recorded", { fromAt: at(-4, 0).toISOString(), toExclusiveAt: at(3, 9).toISOString() }],
  ])("answers %s the same either way", async (_label, filters) => {
    const live = createReportService({
      reports: seed() as unknown as ReportRepository,
      reaper: silentReaper,
      agents,
      now: () => now,
    });
    const reports = seed();
    const rollups = new Rollups();
    await createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => now })
      .refresh(subject, [at(0, 12), at(1, 12), at(2, 12)]);
    const folded = createReportService({
      reports: reports as unknown as ReportRepository,
      reaper: silentReaper,
      agents,
      rollups,
      now: () => now,
    });

    const before = await live.leaderboard(subject, filters);
    const after = await folded.leaderboard(subject, filters);

    expect(after.entries).toEqual(before.entries);
    expect(after.totalDurationSeconds).toBe(before.totalDurationSeconds);
  });

  it("stops reading whole days of intervals once they are folded", async () => {
    const reports = seed();
    const rollups = new Rollups();
    await createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => now })
      .refresh(subject, [at(0, 12), at(1, 12), at(2, 12)]);
    const service = createReportService({
      reports: reports as unknown as ReportRepository,
      reaper: silentReaper,
      agents,
      rollups,
      now: () => now,
    });
    reports.agentReads.length = 0;
    reports.presenceReads.length = 0;

    await service.leaderboard(subject, { fromAt: day(0).toISOString(), toExclusiveAt: day(3).toISOString() });

    // Every day in that range is stored, so the board reads no intervals at
    // all - which is the compute this table exists to take off the report path.
    expect(reports.agentReads).toEqual([]);
    expect(reports.presenceReads).toEqual([]);
  });

  it("falls back to reading live for a project-scoped range, which the fold cannot answer", async () => {
    const reports = seed();
    const rollups = new Rollups();
    await createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => now })
      .refresh(subject, [at(0, 12), at(1, 12), at(2, 12)]);
    const service = createReportService({
      reports: reports as unknown as ReportRepository,
      reaper: silentReaper,
      agents,
      rollups,
      now: () => now,
    });
    reports.presenceReads.length = 0;

    await service.leaderboard(subject, { scope: ids.project, fromAt: day(0).toISOString(), toExclusiveAt: day(3).toISOString() });

    // Active time under a project scope is presence intersected with that
    // project's sessions, which a table holding one row per person per day
    // cannot state - so the whole range is read.
    expect(reports.presenceReads).toHaveLength(1);
    expect(reports.presenceReads[0]?.projectId).toBe(ids.project);
  });
});

describe("the day boundary the fold uses", () => {
  it("is a whole number of days wide", () => {
    expect(DAY_MS).toBe(24 * 60 * 60 * 1_000);
  });
});
