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

/**
 * How much catching up one refresh may do, and how wide any one interval read
 * it issues may be. An upload is waiting on this, so the work it can be handed
 * needs a ceiling however far behind the table has fallen.
 */
export const FOLD_MAX_DAYS = 31;

/**
 * The days a refresh folds: the finished days the upload named, plus a fill
 * forward from the day after the latest day already stored through yesterday.
 *
 * Coverage would otherwise be whatever uploads happened to name, which is full
 * of holes - a day nobody uploaded on would never fold, so a workspace that
 * rests at weekends would leave a live span a week and an all-time board would
 * plan a read per gap. Filling forward keeps coverage contiguous from the day
 * it started onwards, and every refresh moves its leading edge toward
 * yesterday, so a gap left by a quiet stretch shrinks rather than persists.
 *
 * With nothing stored the fill is yesterday alone. That is the bootstrap, and
 * it is what lets the table start at all: a workspace whose members sit near
 * UTC, work inside one UTC day and upload promptly never names a finished day,
 * so waiting to be handed one would leave the table empty for good.
 *
 * The fill is capped, so a table months behind catches up over the next several
 * uploads rather than paying the whole gap on one request. A partly filled gap
 * is correct by the rule the table already lives under: what is not stored is
 * read live. History older than the day coverage started is never filled here -
 * backfilling that is the scheduled fold's job in the retention change.
 */
export function foldTargetDays(named: readonly Date[], latestStored: Date | null, now: Date): Date[] {
  const yesterday = utcDayStart(now).getTime() - DAY_MS;
  const targets = new Set(named.map((day) => day.getTime()));
  const firstUnfilled = latestStored === null ? yesterday : latestStored.getTime() + DAY_MS;
  for (let day = firstUnfilled, filled = 0; day <= yesterday && filled < FOLD_MAX_DAYS; day += DAY_MS, filled += 1) {
    targets.add(day);
  }
  return [...targets].sort((a, b) => a - b).map((day) => new Date(day));
}

/**
 * Days already sorted ascending, split into adjacent runs of at most
 * `FOLD_MAX_DAYS`. One interval read covers a run, so the bound is what stops a
 * contiguous catch-up from pulling an unbounded stretch of raw rows into memory
 * on the upload's own request.
 */
function foldRuns(days: readonly Date[]): Date[][] {
  const runs: Date[][] = [];
  for (const day of days) {
    const current = runs[runs.length - 1];
    if (current !== undefined
      && current.length < FOLD_MAX_DAYS
      && current[current.length - 1]!.getTime() + DAY_MS === day.getTime()) {
      current.push(day);
      continue;
    }
    runs.push([day]);
  }
  return runs;
}

/**
 * A run's rows filed under every day of the run their span touches.
 *
 * Built once per run rather than once per day. Folding a day out of the run's
 * whole arrays walks every row again, so a month-long run over a busy workspace
 * would re-walk and re-allocate the same hundred thousand rows thirty times
 * over. The index hands each day exactly the rows the whole-array pass would
 * have, so what a day measures is unchanged - `foldDay` still clips them to
 * `[day, day + 1)`.
 */
function indexByDay<T extends { startedAt: Date; endedAt: Date }>(
  rows: readonly T[],
  run: readonly Date[],
): Map<number, T[]> {
  const first = run[0]!.getTime();
  const last = run[run.length - 1]!.getTime();
  const index = new Map<number, T[]>();
  for (const row of rows) {
    // The last day a span touches is the day its final millisecond falls in, so
    // a span ending exactly on a midnight belongs to the day it ran through
    // rather than to the empty one it stops at.
    const from = Math.max(utcDayStart(row.startedAt).getTime(), first);
    const to = Math.min(utcDayStart(row.endedAt.getTime() - 1).getTime(), last);
    for (let day = from; day <= to; day += DAY_MS) {
      const existing = index.get(day);
      if (existing === undefined) index.set(day, [row]);
      else existing.push(row);
    }
  }
  return index;
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
 *
 * It brings coverage up toward yesterday on every run, by a bounded amount, so
 * coverage is contiguous from the day it started onwards and a long range plans
 * a handful of live spans rather than one per quiet weekend. A table far behind
 * catches up over successive uploads instead of paying the gap on one request.
 * History older than the day coverage started is the retention change's
 * scheduled job to backfill.
 */
export function createRollupService(dependencies: RollupServiceDependencies): RollupService {
  const now = dependencies.now ?? ((): Date => new Date());
  return {
    async refresh(subject: AuthenticatedSubject, instants: readonly Date[]): Promise<void> {
      const at = now();
      // Asked before the clear, which would otherwise drop the very row that
      // names the latest stored day. It is the only read that goes first, and
      // it is one indexed maximum: anything that could stop it answering would
      // stop the clear below from running either, so putting it here cannot
      // leave a stale day standing that the clear would have removed.
      const latestStored = await dependencies.rollups.latestDay(subject);
      const days = foldTargetDays(foldableDays(instants, at), latestStored, at);
      // An upload with nothing to fold costs that one lookup and no more: it is
      // the common case, because coverage already reaching yesterday is what
      // every earlier upload of the day left behind.
      if (days.length === 0) return;
      // Clear before folding, never after. A day with no row is always correct
      // because the report path reads it live, so everything below this line
      // can fail and the worst outcome is a day that has to be read the slow
      // way. Writing the fold first and clearing after would leave the old
      // numbers standing over rows that no longer match them.
      await dependencies.rollups.clearDays(subject, days);
      // Awaited here rather than left running across the loop below. A promise
      // in flight that nothing is watching, rejecting while the loop awaits
      // something else, is an unhandled rejection - and Node's default on one
      // is to kill the process, which is exactly the outcome `foldAfterUpload`
      // exists to keep an upload safe from.
      const members = await dependencies.reports.readMembersForOrganization(subject);
      // One read per run rather than one read spanning them all: a backlog
      // carrying one instant from ninety days ago and one from yesterday folds
      // two days, and reading the ninety between them would be interval rows
      // fetched only to be discarded. The runs are walked one at a time because
      // the upload is waiting on this: a catch-up batch landing on thirty
      // scattered days must not open sixty connections at once.
      const rows: UserDailyRollupRecord[] = [];
      for (const run of foldRuns(days)) {
        const from = run[0]!;
        const toExclusive = new Date(run[run.length - 1]!.getTime() + DAY_MS);
        const computedAt = now();
        const [presence, agents] = await Promise.all([
          dependencies.reports.readPresenceIntervals(subject, { from, toExclusive }),
          dependencies.reports.readAgentIntervals(subject, { from, toExclusive }),
        ]);
        const presenceByDay = indexByDay(presence, run);
        const agentsByDay = indexByDay(agents, run);
        for (const day of run) {
          rows.push(...foldDay(
            members,
            presenceByDay.get(day.getTime()) ?? [],
            agentsByDay.get(day.getTime()) ?? [],
            day,
            computedAt,
          ));
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
