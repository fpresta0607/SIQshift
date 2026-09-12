import { describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  ActivitySegmentRepository,
  PresenceIntervalRecord,
  RollupCoverage,
  UserDailyRollupRepository,
} from "../repositories.js";
import {
  BACKFILL_DAYS_PER_PASS,
  RETENTION_DAYS,
  createRetentionService,
  retentionCutoff,
  type RetentionPass,
} from "./retention.js";
import { foldDay, type BackfillOutcome, type RollupService } from "./rollups.js";
import { DAY_MS, utcDayStart } from "./utc-days.js";

const organization = "0e59dfd6-3d1f-4795-9420-3ab65f0df843";
const other = "1e59dfd6-3d1f-4795-9420-3ab65f0df843";
/** 2026-09-12, the day the sweep stands on in every case below. */
const now = new Date(Date.UTC(2026, 8, 12, 3, 0));
const today = utcDayStart(now).getTime();
const day = (offsetFromToday: number): Date => new Date(today + offsetFromToday * DAY_MS);

/** A segment store that remembers what it was asked to delete. */
class Segments implements Partial<ActivitySegmentRepository> {
  public oldest = new Map<string, Date>();
  public organizations: string[] = [];
  public readonly deletes: { organizationId: string; from: Date; toExclusive: Date }[] = [];
  public rowsPerDelete = 7;
  /** Set to make this organization's delete throw, the way a timeout would. */
  public failFor: string | null = null;

  public async organizationsWithSegmentsBefore(_toExclusive: Date, _limit: number): Promise<string[]> {
    return this.organizations;
  }
  public async earliestDay(organizationId: string): Promise<Date | null> {
    return this.oldest.get(organizationId) ?? null;
  }
  public async deleteSpansWithin(organizationId: string, from: Date, toExclusive: Date): Promise<number> {
    if (organizationId === this.failFor) throw new Error("delete timed out");
    this.deletes.push({ organizationId, from, toExclusive });
    return this.rowsPerDelete;
  }
}

/** A fold whose coverage the test drives directly. */
class Rollups implements Partial<UserDailyRollupRepository> {
  public covered = new Map<string, RollupCoverage>();
  /** Days inside coverage with no stored row, as an interrupted fold leaves them. */
  public holes = new Map<string, Date[]>();
  public readonly proofReads: { from: Date; toExclusive: Date }[] = [];

  public async coverage(subject: AuthenticatedSubject): Promise<RollupCoverage | null> {
    return this.covered.get(subject.organizationId) ?? null;
  }
  public async firstUnfoldedDay(subject: AuthenticatedSubject, from: Date, toExclusive: Date): Promise<Date | null> {
    this.proofReads.push({ from, toExclusive });
    const inside = (this.holes.get(subject.organizationId) ?? [])
      .filter((hole) => hole >= from && hole < toExclusive)
      .sort((a, b) => a.getTime() - b.getTime());
    return inside[0] ?? null;
  }
}

class Fold implements RollupService {
  public readonly calls: { organizationId: string; downTo: Date; maxDays: number }[] = [];
  public constructor(private readonly rollups: Rollups, private readonly foldsPerCall = 0) {}
  public async refresh(): Promise<void> {
    throw new Error("the sweep never uploads");
  }
  public async backfill(subject: AuthenticatedSubject, downTo: Date, maxDays: number): Promise<BackfillOutcome> {
    this.calls.push({ organizationId: subject.organizationId, downTo, maxDays });
    const current = this.rollups.covered.get(subject.organizationId);
    if (current === undefined) return { folded: [] };
    // Walks coverage down by however many days this fake was told to manage,
    // never below the floor, the way the real backfill does.
    const target = Math.max(downTo.getTime(), current.earliest.getTime() - this.foldsPerCall * DAY_MS);
    const folded: Date[] = [];
    for (let at = current.earliest.getTime() - DAY_MS; at >= target; at -= DAY_MS) folded.push(new Date(at));
    if (folded.length > 0) {
      this.rollups.covered.set(subject.organizationId, { earliest: new Date(target), latest: current.latest });
    }
    return { folded: folded.reverse() };
  }
}

const sweepWith = async (segments: Segments, rollups: Rollups, fold: Fold): Promise<RetentionPass[]> =>
  createRetentionService({
    segments: segments as unknown as ActivitySegmentRepository,
    rollups: rollups as unknown as UserDailyRollupRepository,
    fold,
    now: () => now,
  }).sweep();

describe("the retention window", () => {
  it("expires a day only once it is wholly older than the window", () => {
    expect(retentionCutoff(now).toISOString()).toBe(day(-RETENTION_DAYS).toISOString());
    // Midnight UTC, like every other boundary the fold uses.
    expect(retentionCutoff(now).getTime() % DAY_MS).toBe(0);
  });

  it("keeps every day the longest charted range can ask for", () => {
    // The dashboards offer today, 7d, 30d and 90d; anything longer is All time,
    // which draws no chart. So the window must not cut inside 90 days.
    expect(RETENTION_DAYS).toBeGreaterThanOrEqual(90);
  });
});

describe("deleting only what is folded", () => {
  it("deletes from where coverage starts, not from where the evidence starts", async () => {
    const segments = new Segments();
    segments.organizations = [organization];
    segments.oldest.set(organization, day(-400));
    const rollups = new Rollups();
    // The fold has reached back 200 days and no further.
    rollups.covered.set(organization, { earliest: day(-200), latest: day(-1) });
    const fold = new Fold(rollups);

    const [pass] = await sweepWith(segments, rollups, fold);

    // Days 400 to 201 back still hold their rows: nothing has folded them, and
    // deleting them would turn a live read into a silent zero.
    expect(segments.deletes).toEqual([{
      organizationId: organization,
      from: day(-200),
      toExclusive: day(-RETENTION_DAYS),
    }]);
    expect(pass?.deleted).toBe(7);
  });

  it("deletes nothing at all when nothing is folded", async () => {
    const segments = new Segments();
    segments.organizations = [organization];
    segments.oldest.set(organization, day(-400));
    const rollups = new Rollups();
    const fold = new Fold(rollups);

    const [pass] = await sweepWith(segments, rollups, fold);

    expect(segments.deletes).toEqual([]);
    expect(pass?.held).toBe("nothing folded");
  });

  it("deletes nothing when the fold has not yet reached past the cutoff", async () => {
    const segments = new Segments();
    segments.organizations = [organization];
    segments.oldest.set(organization, day(-400));
    const rollups = new Rollups();
    // Coverage sits entirely inside the window, so no expired day is folded.
    rollups.covered.set(organization, { earliest: day(-30), latest: day(-1) });
    const fold = new Fold(rollups);

    const [pass] = await sweepWith(segments, rollups, fold);

    expect(segments.deletes).toEqual([]);
    expect(pass?.held).toBe("no expired day is folded yet");
  });

  it("never deletes inside the window, however far back coverage reaches", async () => {
    const segments = new Segments();
    segments.organizations = [organization];
    segments.oldest.set(organization, day(-400));
    const rollups = new Rollups();
    rollups.covered.set(organization, { earliest: day(-400), latest: day(-1) });
    const fold = new Fold(rollups);

    await sweepWith(segments, rollups, fold);

    // The upper bound is the cutoff, never coverage's own top edge.
    expect(segments.deletes[0]?.toExclusive).toEqual(day(-RETENTION_DAYS));
  });

  it("holds off entirely for an organization with no segments left", async () => {
    const segments = new Segments();
    segments.organizations = [organization];
    const rollups = new Rollups();
    rollups.covered.set(organization, { earliest: day(-400), latest: day(-1) });

    const [pass] = await sweepWith(segments, rollups, new Fold(rollups));

    expect(segments.deletes).toEqual([]);
    expect(pass?.held).toBe("no segments");
  });
});

describe("folding before deleting", () => {
  it("asks the fold to reach the oldest evidence, bounded per pass", async () => {
    const segments = new Segments();
    segments.organizations = [organization];
    segments.oldest.set(organization, day(-400));
    const rollups = new Rollups();
    rollups.covered.set(organization, { earliest: day(-200), latest: day(-1) });
    const fold = new Fold(rollups, 120);

    await sweepWith(segments, rollups, fold);

    expect(fold.calls).toEqual([{ organizationId: organization, downTo: day(-400), maxDays: BACKFILL_DAYS_PER_PASS }]);
  });

  it("converges over successive passes rather than folding a year at once", async () => {
    const segments = new Segments();
    segments.organizations = [organization];
    segments.oldest.set(organization, day(-400));
    const rollups = new Rollups();
    rollups.covered.set(organization, { earliest: day(-200), latest: day(-1) });
    const fold = new Fold(rollups, BACKFILL_DAYS_PER_PASS);

    const first = await sweepWith(segments, rollups, fold);
    const second = await sweepWith(segments, rollups, fold);
    const third = await sweepWith(segments, rollups, fold);

    // Each pass walks coverage further down and the delete window opens with
    // it; the third arrives at the oldest evidence and stops there.
    expect(first[0]?.coverageFrom).toEqual(day(-320));
    expect(second[0]?.coverageFrom).toEqual(day(-400));
    expect(third[0]?.coverageFrom).toEqual(day(-400));
    expect(segments.deletes.map((entry) => entry.from)).toEqual([day(-320), day(-400), day(-400)]);
  });

  it("sweeps each organization on its own coverage", async () => {
    const segments = new Segments();
    segments.organizations = [organization, other];
    segments.oldest.set(organization, day(-400));
    segments.oldest.set(other, day(-120));
    const rollups = new Rollups();
    rollups.covered.set(organization, { earliest: day(-300), latest: day(-1) });
    rollups.covered.set(other, { earliest: day(-120), latest: day(-1) });

    await sweepWith(segments, rollups, new Fold(rollups));

    expect(segments.deletes).toEqual([
      { organizationId: organization, from: day(-300), toExclusive: day(-RETENTION_DAYS) },
      { organizationId: other, from: day(-120), toExclusive: day(-RETENTION_DAYS) },
    ]);
  });
});

describe("a rollup row the sweep leaves behind", () => {
  it("carries the whole of what an expired day reports, so the fold is record enough", () => {
    // The contract this file defends: once the raw rows are gone, a stored row
    // is all a report has, so the concurrency split it carries must still
    // partition the active time it carries. Asserted over a row the fold
    // actually produced - a literal would only restate itself.
    const member = { id: "e1c7e513-b094-4d4c-ae55-21790ae019a4" };
    const on = day(-200);
    const presence: PresenceIntervalRecord[] = [{
      user: { id: member.id, name: "Alex" },
      startedAt: new Date(on.getTime() + 9 * 60 * 60 * 1_000),
      endedAt: new Date(on.getTime() + 13 * 60 * 60 * 1_000),
    }];
    const agents = [{
      sessionId: "s-1",
      user: { id: member.id, name: "Alex" },
      source: "claude_code",
      model: null,
      cwd: null,
      projectId: null,
      agentId: null,
      agentRepoRoot: null,
      agentRepoKey: null,
      startedAt: new Date(on.getTime() + 10 * 60 * 60 * 1_000),
      endedAt: new Date(on.getTime() + 11 * 60 * 60 * 1_000),
    }];

    const [row] = foldDay(
      [member],
      presence,
      agents as unknown as Parameters<typeof foldDay>[2],
      on,
      now,
    );

    expect(row?.activeMs).toBe(4 * 60 * 60 * 1_000);
    expect(row?.concurrency1Ms).toBe(60 * 60 * 1_000);
    expect(row?.activeMs)
      .toBe(row!.concurrency0Ms + row!.concurrency1Ms + row!.concurrency2Ms + row!.concurrency3PlusMs);
  });
});

describe("proving the days between coverage's endpoints", () => {
  it("stops the delete at the first day inside coverage with no stored row", async () => {
    const segments = new Segments();
    segments.organizations = [organization];
    segments.oldest.set(organization, day(-400));
    const rollups = new Rollups();
    rollups.covered.set(organization, { earliest: day(-300), latest: day(-1) });
    // A chunked write that failed part-way, or a fold that gave out after its
    // clear: coverage's endpoints are intact and the days between are not.
    rollups.holes.set(organization, [day(-150)]);

    const [pass] = await sweepWith(segments, rollups, new Fold(rollups));

    // Below the hole every day is proven folded row by row, so the delete still
    // makes progress; at and above it nothing goes until the hole is filled.
    expect(segments.deletes).toEqual([{
      organizationId: organization,
      from: day(-300),
      toExclusive: day(-150),
    }]);
    expect(pass?.held).toBe("coverage has no row for " + day(-150).toISOString().slice(0, 10));
    // And the proof read only ever looks inside the window the sweep bounded.
    expect(rollups.proofReads).toEqual([{ from: day(-300), toExclusive: day(-RETENTION_DAYS) }]);
  });

  it("deletes to the cutoff when every day between the endpoints has a row", async () => {
    const segments = new Segments();
    segments.organizations = [organization];
    segments.oldest.set(organization, day(-400));
    const rollups = new Rollups();
    rollups.covered.set(organization, { earliest: day(-300), latest: day(-1) });

    const [pass] = await sweepWith(segments, rollups, new Fold(rollups));

    expect(segments.deletes[0]?.toExclusive).toEqual(day(-RETENTION_DAYS));
    expect(pass?.held).toBeUndefined();
  });

  it("ignores a hole outside the window it was going to delete anyway", async () => {
    const segments = new Segments();
    segments.organizations = [organization];
    segments.oldest.set(organization, day(-400));
    const rollups = new Rollups();
    rollups.covered.set(organization, { earliest: day(-300), latest: day(-1) });
    // Inside the retention window, which the delete never reaches.
    rollups.holes.set(organization, [day(-40)]);

    const [pass] = await sweepWith(segments, rollups, new Fold(rollups));

    expect(segments.deletes[0]?.toExclusive).toEqual(day(-RETENTION_DAYS));
    expect(pass?.held).toBeUndefined();
  });
});

describe("one organization's failure", () => {
  it("does not cost the organizations behind it their turn", async () => {
    const segments = new Segments();
    segments.organizations = [organization, other];
    segments.oldest.set(organization, day(-400));
    segments.oldest.set(other, day(-300));
    const rollups = new Rollups();
    rollups.covered.set(organization, { earliest: day(-400), latest: day(-1) });
    rollups.covered.set(other, { earliest: day(-300), latest: day(-1) });
    // The ordering is oldest evidence first, so the failing organization is
    // deterministically at the head of every pass.
    segments.failFor = organization;

    const passes = await sweepWith(segments, rollups, new Fold(rollups));

    expect(passes[0]).toMatchObject({ organizationId: organization, failed: "delete timed out", deleted: 0 });
    expect(segments.deletes).toEqual([{
      organizationId: other,
      from: day(-300),
      toExclusive: day(-RETENTION_DAYS),
    }]);
  });
});
