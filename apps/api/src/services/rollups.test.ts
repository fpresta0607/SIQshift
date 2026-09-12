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
import { FOLD_MAX_DAYS, createRollupService, foldDay, foldableDays } from "./rollups.js";
import { DAY_MS, utcDayStart, utcDaysBetween } from "./utc-days.js";

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
  public failMembers = false;

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
    if (this.failMembers) throw new Error("roster read failed");
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
  public failLatestDay = false;

  public async readForRange(_subject: AuthenticatedSubject, from: Date, toExclusive: Date): Promise<UserDailyRollupRecord[]> {
    this.calls.push("read");
    return this.rows.filter((row) => row.day >= from && row.day < toExclusive);
  }
  public async earliestDay(): Promise<Date | null> {
    const days = this.rows.map((row) => row.day.getTime()).sort((a, b) => a - b);
    return days[0] === undefined ? null : new Date(days[0]);
  }
  public async latestDay(): Promise<Date | null> {
    if (this.failLatestDay) throw new Error("latest day read failed");
    const days = this.rows.map((row) => row.day.getTime()).sort((a, b) => b - a);
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
    // Mirrors the conditional upsert: a stored row only yields to a fold that
    // read later than it did.
    for (const row of rows) {
      const index = this.rows.findIndex((stored) => stored.userId === row.userId && stored.day.getTime() === row.day.getTime());
      if (index === -1) {
        this.rows.push(row);
        continue;
      }
      if (this.rows[index]!.computedAt.getTime() < row.computedAt.getTime()) this.rows[index] = row;
    }
  }
}

/** Any read instant; the folds below never contend, so only the shape matters. */
const readAt = new Date(Date.UTC(2026, 7, 9));

/** A day already in the table, as an earlier fold would have left it. */
const storedDay = (on: Date, activeMs = 0): UserDailyRollupRecord => ({
  userId: ids.user,
  day: on,
  activeMs,
  agentMs: 0,
  concurrency0Ms: activeMs,
  concurrency1Ms: 0,
  concurrency2Ms: 0,
  concurrency3PlusMs: 0,
  awayMs: 0,
  computedAt: readAt,
});

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

  it("names every day a moved instant crossed, whichever way it moved", () => {
    const names = (from: Date, to: Date): string[] => utcDaysBetween(from, to).map((entry) => entry.toISOString());

    // A move inside one day names that day and no other.
    expect(names(at(0, 1), at(0, 23))).toEqual([day(0).toISOString()]);
    // A move across a midnight names the day it left as well as the one it reached.
    expect(names(at(0, 23, 50), at(1, 0, 5))).toEqual([day(0).toISOString(), day(1).toISOString()]);
    // Every day in between, and the direction of the move does not matter.
    expect(names(at(2, 8), at(0, 9))).toEqual([day(0), day(1), day(2)].map((entry) => entry.toISOString()));
  });
});

describe("folding a day", () => {
  it("clips at midnight, so a span across it lands in both days and neither twice", () => {
    const overnight = [presence(ids.user, "Alex", at(0, 22), at(1, 2))];
    const first = foldDay([{ id: ids.user }], overnight, [], day(0), readAt);
    const second = foldDay([{ id: ids.user }], overnight, [], day(1), readAt);

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
      readAt,
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
      readAt,
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
      readAt,
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
    // The days the instants named are cleared first, then the fold's own target
    // set - which here is the same single day.
    expect(rollups.calls).toEqual(["clear", "clear", "write"]);
    expect(rollups.rows).toHaveLength(1);

    // A day that now reads differently, with the write failing on the way back.
    reports.presenceIntervals = [presence(ids.user, "Alex", at(0, 9), at(0, 12))];
    rollups.failWrite = true;
    await expect(service.refresh(subject, [at(0, 9)])).rejects.toThrow("write failed");

    // The stale row is gone rather than standing over rows it no longer matches.
    expect(rollups.rows).toEqual([]);
  });

  it("reads one interval span per contiguous run of days, not one across the gaps between them", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }];
    const rollups = new Rollups();
    rollups.rows = [storedDay(day(20))];
    const service = createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => at(30, 9) });

    // The catch-up shape: a desktop back from a long outage uploads two stale
    // instants, well below where coverage has already reached. Those two days
    // are folded where they fall, and the nineteen between them and the
    // frontier are not fetched only to be thrown away.
    await service.refresh(subject, [at(0, 12), at(1, 12)]);

    const spans = (reads: ReportQuery[]): (string | undefined)[][] =>
      reads.map((read) => [read.from?.toISOString(), read.toExclusive?.toISOString()]);
    const expected = [
      [day(0).toISOString(), day(2).toISOString()],
      [day(21).toISOString(), day(30).toISOString()],
    ];
    expect(spans(reports.presenceReads)).toEqual(expected);
    expect(spans(reports.agentReads)).toEqual(expected);
  });

  /**
   * The frontier only ever moves forward, so folding a named day above the
   * window would put `latestDay` past a stretch this refresh could not reach,
   * and no later upload would ever come back for it.
   */
  it("defers a named day above the window rather than stranding the days below it", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }];
    const rollups = new Rollups();
    rollups.rows = [storedDay(day(0))];
    const service = createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => at(100, 9) });

    await service.refresh(subject, [at(55, 12)]);

    const folded = (): number[] => [...new Set(rollups.rows.map((row) => row.day.getTime()))].sort((a, b) => a - b);
    // Day 55 is not folded, and coverage runs unbroken from where it started to
    // the day the window reached.
    expect(folded()).toEqual(
      Array.from({ length: FOLD_MAX_DAYS + 1 }, (_, index) => day(index).getTime()),
    );

    // It is deferred, not dropped: the next refresh carries the frontier over it.
    await service.refresh(subject, []);

    expect(folded()).toContain(day(55).getTime());
    expect(folded()).toEqual(
      Array.from({ length: 2 * FOLD_MAX_DAYS + 1 }, (_, index) => day(index).getTime()),
    );
  });

  it("starts coverage at the oldest finished day a first upload names, not at yesterday alone", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }];
    const rollups = new Rollups();
    const service = createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => at(10, 9) });

    await service.refresh(subject, [at(0, 12), at(1, 12), at(8, 12)]);

    // Days 2 to 7 would be a permanent hole if the bootstrap folded only the
    // days named plus yesterday, because the frontier never comes back down.
    expect([...new Set(rollups.rows.map((row) => row.day.getTime()))].sort((a, b) => a - b))
      .toEqual(Array.from({ length: 10 }, (_, index) => day(index).getTime()));
  });

  /**
   * The review's sequence: a day folded while a session was still running is
   * short by whatever that session went on to claim of it, so the day has to be
   * folded again once the session's end has moved past its midnight.
   */
  it("refolds a day to its whole share once a running session's end moves past that midnight", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }];
    reports.presenceIntervals = [presence(ids.user, "Alex", at(0, 22), at(1, 2))];
    // Still open, so the read ends it at its last event - ten minutes short of midnight.
    reports.agentIntervals = [agentInterval(ids.user, "Alex", at(0, 22), at(0, 23, 50))];
    const rollups = new Rollups();
    let current = at(1, 0, 1);
    const service = createRollupService({
      reports: reports as unknown as ReportRepository,
      rollups,
      now: () => current,
    });
    const storedAgentMs = (): number | undefined =>
      rollups.rows.find((row) => row.day.getTime() === day(0).getTime())?.agentMs;

    await service.refresh(subject, [day(0)]);
    expect(storedAgentMs()).toBe(110 * 60 * 1_000);

    // The session reports again after midnight, so its known end crosses into
    // the next day and day 0 is owed the full two hours it was open for.
    reports.agentIntervals = [agentInterval(ids.user, "Alex", at(0, 22), at(1, 0, 5))];
    current = at(1, 0, 6);
    await service.refresh(subject, [day(0)]);

    expect(storedAgentMs()).toBe(2 * 60 * 60 * 1_000);
  });

  /**
   * The roster read used to be started before the run loop and awaited after
   * it, so for the whole loop it was a promise nothing was watching: a
   * rejection there was an unhandled rejection, which Node answers by killing
   * the process rather than by failing the fold.
   */
  it("reads the roster before any intervals, so its failure is a failed fold rather than a loose rejection", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }];
    reports.failMembers = true;
    const rollups = new Rollups();
    rollups.rows = [storedDay(day(0), 60_000)];
    const service = createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => at(1, 9) });

    await expect(service.refresh(subject, [at(0, 9)])).rejects.toThrow("roster read failed");

    // No interval read was ever issued, so there is nothing for the roster's
    // rejection to race and nothing left in flight when the fold gives up.
    expect(reports.presenceReads).toEqual([]);
    expect(reports.agentReads).toEqual([]);
    // And the clears still went first, so the day is unfolded rather than stale.
    expect(rollups.calls).toEqual(["clear", "clear"]);
    expect(rollups.rows).toEqual([]);
  });

  /**
   * The clear is the whole safety story, so nothing that can fail on its own may
   * run ahead of it. A transient statement failure hits one query and not the
   * next, and the upload it followed has already committed.
   */
  it("clears the days the upload named before asking anything, so a failed lookup leaves them unfolded", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }];
    const rollups = new Rollups();
    rollups.rows = [storedDay(day(0), 60_000)];
    rollups.failLatestDay = true;
    const service = createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => at(1, 9) });

    await expect(service.refresh(subject, [at(0, 9)])).rejects.toThrow("latest day read failed");

    // Day 0 reads live now, rather than standing on numbers measured before the
    // rows this upload just committed existed.
    expect(rollups.calls).toEqual(["clear"]);
    expect(rollups.rows).toEqual([]);
  });

  it("fills forward to yesterday, so a quiet weekend folds as zeros rather than staying live", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }];
    reports.presenceIntervals = [
      presence(ids.user, "Alex", at(0, 9), at(0, 10)),
      presence(ids.user, "Alex", at(3, 9), at(3, 10)),
    ];
    const rollups = new Rollups();
    let current = at(1, 9);
    const service = createRollupService({
      reports: reports as unknown as ReportRepository,
      rollups,
      now: () => current,
    });
    const storedDays = (): string[] => rollups.rows.map((row) => row.day.toISOString()).sort();

    // Friday's upload bootstraps on Friday, which is yesterday as it runs.
    await service.refresh(subject, [at(0, 9)]);
    expect(storedDays()).toEqual([day(0).toISOString()]);

    // Monday's upload names Monday alone, and the quiet weekend between gets
    // its all-zero rows rather than staying a live span for good.
    current = at(4, 9);
    await service.refresh(subject, [at(3, 9)]);
    expect(storedDays()).toEqual([day(0), day(1), day(2), day(3)].map((entry) => entry.toISOString()));
    expect(rollups.rows.find((row) => row.day.getTime() === day(1).getTime()))
      .toMatchObject({ activeMs: 0, agentMs: 0 });
    expect(rollups.rows.find((row) => row.day.getTime() === day(3).getTime())?.activeMs)
      .toBe(60 * 60 * 1_000);
  });

  /**
   * A table left far behind must not hand one upload the whole gap: the read
   * that would close it is exactly the raw-interval read this cache exists to
   * retire, and running it here would only relocate the cost onto ingest.
   */
  it("catches up by at most a month per refresh, reading no wider span than that", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }];
    const rollups = new Rollups();
    rollups.rows = [storedDay(day(0))];
    // A year on from the only day the table holds.
    const service = createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => at(365, 9) });

    await service.refresh(subject, []);

    const folded = rollups.rows.map((row) => row.day.getTime()).sort((a, b) => a - b);
    // The day already held, plus a month of catch-up straight after it: the
    // leading edge moves forward and the gap behind it shrinks each time.
    expect(folded).toHaveLength(FOLD_MAX_DAYS + 1);
    expect(folded[folded.length - 1]).toBe(day(FOLD_MAX_DAYS).getTime());
    // And the read that folded them is bounded by that same month, so no single
    // query drags a year of raw intervals through the upload's request.
    expect(reports.presenceReads).toHaveLength(1);
    expect(reports.presenceReads[0]?.from?.toISOString()).toBe(day(1).toISOString());
    expect(reports.presenceReads[0]?.toExclusive?.toISOString()).toBe(day(1 + FOLD_MAX_DAYS).toISOString());
    const widths = reports.presenceReads.map((read) => (read.toExclusive!.getTime() - read.from!.getTime()) / DAY_MS);
    expect(widths.every((width) => width <= FOLD_MAX_DAYS)).toBe(true);
  });

  it("gives each day of a run only the intervals that day touches, without changing what it measures", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }];
    // One span across the midnight inside the run, and one wholly inside day 1.
    reports.presenceIntervals = [
      presence(ids.user, "Alex", at(0, 22), at(1, 2)),
      presence(ids.user, "Alex", at(1, 9), at(1, 10)),
    ];
    const rollups = new Rollups();
    const service = createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => at(2, 9) });

    await service.refresh(subject, [at(0, 12), at(1, 12)]);

    const activeMs = (offset: number): number | undefined =>
      rollups.rows.find((row) => row.day.getTime() === day(offset).getTime())?.activeMs;
    // Day 0 keeps its two hours of the overnight span and day 1 the other two
    // plus its own hour - exactly what folding from the run's whole arrays
    // gives, because the clipping to [day, day + 1) is unchanged.
    expect(activeMs(0)).toBe(2 * 60 * 60 * 1_000);
    expect(activeMs(1)).toBe(3 * 60 * 60 * 1_000);
  });

  /**
   * The bootstrap. A workspace whose members sit near UTC, work inside one UTC
   * day and upload promptly never hands `refresh` an instant from a finished
   * day, so a fold that only ever wrote the days it was named would leave the
   * table empty for good and the feature would never engage at all.
   */
  it("folds yesterday on an upload that names no finished day, and never today", async () => {
    const reports = new Reports();
    reports.roster = [{ id: ids.user, name: "Alex" }];
    reports.presenceIntervals = [
      presence(ids.user, "Alex", at(-1, 9), at(-1, 10)),
      presence(ids.user, "Alex", at(0, 9), at(0, 11)),
    ];
    const rollups = new Rollups();
    const service = createRollupService({ reports: reports as unknown as ReportRepository, rollups, now: () => at(0, 12) });

    await service.refresh(subject, [at(0, 9)]);

    expect(rollups.rows.map((row) => row.day.toISOString())).toEqual([day(-1).toISOString()]);
    expect(rollups.rows[0]?.activeMs).toBe(60 * 60 * 1_000);

    // The next upload of the same day has nothing left to do, and pays only the
    // one indexed lookup that tells it so.
    rollups.calls.length = 0;
    await service.refresh(subject, [at(0, 11)]);

    expect(rollups.calls).toEqual([]);
    expect(rollups.rows.map((row) => row.day.toISOString())).toEqual([day(-1).toISOString()]);
  });
});

describe("planning a range against the fold", () => {
  const now = at(3, 9);

  const liveBounds = (plan: { live: { from: Date | null; toExclusive: Date | null }[] }): (string | null)[][] =>
    plan.live.map((span) => [span.from?.toISOString() ?? null, span.toExclusive?.toISOString() ?? null]);

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

    expect(liveBounds(plan)).toEqual([[day(0).toISOString(), day(3).toISOString()]]);
  });

  it("spends nothing for a range that sits inside one unfinished day", () => {
    const range = { start: at(3, 1).getTime(), end: at(3, 8).getTime() };
    const plan = planRollupRange(range, rollupWindow(range, day(0).getTime(), now), new Set());

    expect(plan.window.from.getTime()).toBe(plan.window.toExclusive.getTime());
    expect(liveBounds(plan)).toEqual([[at(3, 1).toISOString(), at(3, 8).toISOString()]]);
  });

  /**
   * A range holding no whole finished day collapses the window onto today's
   * midnight, which can sit outside the range on either side. The spans still
   * have to be the range and nothing more: anything wider is time the caller
   * never asked to measure, counted into the board.
   */
  describe("never names an instant outside the range it was given", () => {
    it("for a client west of UTC asking for its own local Today", () => {
      // The desktop sends local-midnight instants, so a UTC-5 client's Today is
      // 05:00 to 05:00 - a range whose start sits inside the current UTC day.
      const range = { start: at(3, 5).getTime(), end: at(4, 5).getTime() };
      const plan = planRollupRange(range, rollupWindow(range, day(0).getTime(), at(3, 14)), new Set());

      expect(liveBounds(plan)).toEqual([[at(3, 5).toISOString(), at(4, 5).toISOString()]]);
    });

    it("for a sub-day range inside a day that is already over", () => {
      const range = { start: at(1, 8).getTime(), end: at(1, 17).getTime() };
      const plan = planRollupRange(range, rollupWindow(range, day(0).getTime(), now), new Set());

      expect(liveBounds(plan)).toEqual([[at(1, 8).toISOString(), at(1, 17).toISOString()]]);
    });

    it("for an open start that ends before the earliest day the table holds", () => {
      const range = { start: null, end: at(-2, 12).getTime() };
      const plan = planRollupRange(range, rollupWindow(range, day(0).getTime(), now), new Set());

      expect(liveBounds(plan)).toEqual([[null, at(-2, 12).toISOString()]]);
    });
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
      // Early on the unfinished day, before any range below starts: a span that
      // reaches back past a range's own start shows up here as extra minutes.
      presence(ids.user, "Alex", at(3, 0, 30), at(3, 1, 30)),
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
    // The two shapes that hold no whole finished day, so the window collapses
    // onto a midnight outside the range. Both have recorded time just outside
    // the range they ask for, so a span wider than the range is a wrong number
    // on the board rather than only a wrong bound in the planner.
    ["a sub-day range inside a day that is already over", { fromAt: at(1, 8).toISOString(), toExclusiveAt: at(1, 17).toISOString() }],
    ["a range starting mid-day inside the unfinished day", { fromAt: at(3, 2).toISOString(), toExclusiveAt: at(3, 10).toISOString() }],
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
