import { measureTimeMs, type Interval } from "@siqshift/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentIntervalRecord,
  PresenceIntervalRecord,
  ReportRepository,
  UserDailyRollupRecord,
  UserDailyRollupRepository,
} from "../repositories.js";
import { rosterEligibleSource } from "./agent-sessions.js";
import { DAY_MS, utcDayStart } from "./utc-days.js";

/**
 * The distinct UTC days these instants fall in, oldest first, keeping only days
 * that are already over.
 *
 * Today is never folded: it is still being written, and a row for it would go
 * stale the moment the next segment lands. A day that is over cannot change
 * except by a late upload, and a late upload is exactly what calls this.
 */
export function foldableDays(instants: readonly Date[], now: Date): Date[] {
  const today = utcDayStart(now).getTime();
  const days = new Set<number>();
  for (const instant of instants) {
    const day = utcDayStart(instant).getTime();
    if (day < today) days.add(day);
  }
  return [...days].sort((a, b) => a - b).map((day) => new Date(day));
}

/** Splits days already sorted ascending into runs of adjacent UTC days. */
function contiguousRuns(days: readonly Date[]): Date[][] {
  const runs: Date[][] = [];
  for (const day of days) {
    const current = runs[runs.length - 1];
    if (current !== undefined && current[current.length - 1]!.getTime() + DAY_MS === day.getTime()) {
      current.push(day);
      continue;
    }
    runs.push([day]);
  }
  return runs;
}

export interface RollupServiceDependencies {
  reports: ReportRepository;
  rollups: UserDailyRollupRepository;
  /** Injected so a test can stand at a fixed instant; production passes nothing. */
  now?: () => Date;
}

export interface RollupService {
  /**
   * Folds every finished UTC day these instants touch, for the whole
   * workspace, and replaces whatever was stored for those days.
   */
  refresh(subject: AuthenticatedSubject, instants: readonly Date[]): Promise<void>;
}

const asInterval = (start: Date, end: Date): Interval => ({ start: start.getTime(), end: end.getTime() });

/**
 * Maintains the folded-day cache the leaderboard spends.
 *
 * Three rules make this safe to run from an upload handler:
 *
 * It folds whole finished UTC days only, and a finished day is not therefore
 * final. An agent session that is still running is read as ending at its last
 * event, so a day it is still reaching into keeps owing more of it until that
 * end moves past the day's midnight. That is the whole of it: a finished day's
 * numbers can move only when a session's known end crosses it, which is why
 * the upload path hands this the days between where each touched session's end
 * was and where the event put it. What cannot move on its own is a day nothing
 * open still reaches into: the freshness guard the presence read applies
 * compares two stored instants, so it never changes its mind about a row, and
 * the only thing left that can change such a day is data arriving for it late
 * - which is what calls this.
 *
 * It replaces rather than increments. The batch endpoints are idempotent on a
 * client id and will happily be re-sent the same day, and an increment would
 * count it twice.
 *
 * It writes a row for every member of the workspace, zeros included. The read
 * path treats any row for a day as proof that the whole day is folded, so a
 * quiet member left out would read as a measured zero rather than as a day the
 * report still has to read live.
 */
export function createRollupService(dependencies: RollupServiceDependencies): RollupService {
  const now = dependencies.now ?? ((): Date => new Date());
  return {
    async refresh(subject: AuthenticatedSubject, instants: readonly Date[]): Promise<void> {
      const days = foldableDays(instants, now());
      if (days.length === 0) return;
      // Clear before folding, never after. A day with no row is always correct
      // because the report path reads it live, so everything below this line
      // can fail and the worst outcome is a day that has to be read the slow
      // way. Writing the fold first and clearing after would leave the old
      // numbers standing over rows that no longer match them.
      await dependencies.rollups.clearDays(subject, days);
      const membersRead = dependencies.reports.readMembersForOrganization(subject);
      // One read per contiguous run rather than one read spanning them all: a
      // backlog carrying one instant from ninety days ago and one from
      // yesterday folds two days, and reading the ninety between them would be
      // interval rows fetched only to be discarded. The runs are walked one at
      // a time because the upload is waiting on this: a catch-up batch landing
      // on thirty scattered days must not open sixty connections at once.
      const rows: UserDailyRollupRecord[] = [];
      const reads: { run: Date[]; presence: PresenceIntervalRecord[]; agents: AgentIntervalRecord[]; computedAt: Date }[] = [];
      for (const run of contiguousRuns(days)) {
        const from = run[0]!;
        const toExclusive = new Date(run[run.length - 1]!.getTime() + DAY_MS);
        const computedAt = now();
        const [presence, agents] = await Promise.all([
          dependencies.reports.readPresenceIntervals(subject, { from, toExclusive }),
          dependencies.reports.readAgentIntervals(subject, { from, toExclusive }),
        ]);
        reads.push({ run, presence, agents, computedAt });
      }
      const members = await membersRead;
      for (const read of reads) {
        for (const day of read.run) {
          rows.push(...foldDay(members, read.presence, read.agents, day, read.computedAt));
        }
      }
      await dependencies.rollups.writeDays(subject, rows);
    },
  };
}

/**
 * One finished UTC day, folded for every member.
 *
 * The measurement is the same sweep the live report path runs, over the same
 * intervals, clipped to [day, day + 1). That is what lets a range add stored
 * days to a live partial day and get the answer the live path alone would have
 * given: union and the concurrency buckets both add exactly across pieces of
 * the timeline that do not overlap.
 *
 * Active time here is presence alone, which is what the all-projects scope
 * measures. A project-scoped request intersects presence with that project's
 * sessions and so cannot be answered from a table with no project in it; the
 * report path keeps reading those ranges live.
 */
export function foldDay(
  members: readonly { id: string }[],
  presence: readonly PresenceIntervalRecord[],
  agents: readonly AgentIntervalRecord[],
  day: Date,
  computedAt: Date,
): UserDailyRollupRecord[] {
  const range = { start: day.getTime(), end: day.getTime() + DAY_MS };
  const presenceByUser = new Map<string, Interval[]>();
  for (const row of presence) {
    const list = presenceByUser.get(row.user.id) ?? [];
    list.push(asInterval(row.startedAt, row.endedAt));
    presenceByUser.set(row.user.id, list);
  }
  const agentsByUser = new Map<string, Interval[]>();
  for (const row of agents) {
    // Browser spans are attention, not agent runtime - the roster's own rule.
    // One left in here would reclassify the person's own presence as
    // agent-assisted in the stored concurrency split.
    if (!rosterEligibleSource(row.source)) continue;
    const list = agentsByUser.get(row.user.id) ?? [];
    list.push(asInterval(row.startedAt, row.endedAt));
    agentsByUser.set(row.user.id, list);
  }
  // Every member of the workspace, plus anyone the intervals name that the
  // roster no longer does - a member removed mid-range still worked the hours.
  const userIds = new Set<string>([
    ...members.map((member) => member.id),
    ...presenceByUser.keys(),
    ...agentsByUser.keys(),
  ]);
  return [...userIds].sort().map((userId) => {
    const measurement = measureTimeMs(
      presenceByUser.get(userId) ?? [],
      agentsByUser.get(userId) ?? [],
      range,
    );
    return {
      userId,
      day,
      activeMs: measurement.activeMs,
      agentMs: measurement.agentMs,
      concurrency0Ms: measurement.concurrency.t0Ms,
      concurrency1Ms: measurement.concurrency.t1Ms,
      concurrency2Ms: measurement.concurrency.t2Ms,
      concurrency3PlusMs: measurement.concurrency.t3PlusMs,
      awayMs: measurement.concurrency.awayMs,
      computedAt,
    };
  });
}

/**
 * Folds after an upload, and never fails the upload.
 *
 * The rollup is a cache of rows that are still here, and `refresh` clears the
 * days it is about to fold before it reads anything, so every failure below
 * that clear leaves those days merely unfolded - which the report path already
 * handles by reading them live. Letting a cache-maintenance error turn a
 * successful upload into a 500 would lose the segments the desktop just handed
 * over, which is the one outcome worth avoiding here.
 */
export function foldAfterUpload(rollups: RollupService) {
  return async (subject: AuthenticatedSubject, instants: readonly Date[]): Promise<void> => {
    try {
      await rollups.refresh(subject, instants);
    } catch (error: unknown) {
      console.error("siqshift-api: daily rollup refresh failed; those days will be read live", error);
    }
  };
}
