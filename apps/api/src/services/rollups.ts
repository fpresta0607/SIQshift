import { measureTimeMs, type Interval } from "@siqshift/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentIntervalRecord,
  PresenceIntervalRecord,
  ReportRepository,
  RollupCoverage,
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
 * How far one refresh may fill forward from the latest day stored, and how wide
 * any one interval read it issues may be. The fill is the part that grows on its
 * own while nothing uploads, so it is the part that needs a ceiling; the days an
 * upload names are bounded by what one batch can carry and are all folded.
 */
export const FOLD_MAX_DAYS = 31;

/**
 * The days a refresh folds: a contiguous frontier window, plus the finished
 * days the upload named that fall at or below it. `named` is expected oldest
 * first, as `foldableDays` returns it.
 *
 * Coverage would otherwise be whatever uploads happened to name, which is full
 * of holes - a day nobody uploaded on would never fold, so a workspace that
 * rests at weekends would leave a live span a week and an all-time board would
 * plan a read per gap. The window runs from the day after the latest day stored
 * through yesterday, so stored coverage grows contiguously upward and every
 * refresh moves its leading edge closer to yesterday.
 *
 * That contiguity is the invariant, and both bounds on a named day exist to
 * keep it. A named day ABOVE the window is left out: folding one would push the
 * frontier past a stretch the window could not reach this time, and since the
 * next window starts from the new frontier, those days would never be folded by
 * any later upload. A named day BELOW the stretch already stored is left out
 * for the mirror reason: folding one would drag the earliest stored day
 * backwards and leave a permanent hole behind it, which no later refresh fills
 * either, because the window only ever grows upward. Between those bounds a
 * named day is kept, so a late upload still invalidates the day it landed in.
 *
 * A deferred day is not lost and not stale. Stored coverage is contiguous, so a
 * named day outside those two bounds sits outside coverage and has no stored row
 * to be wrong - it is read live, which is the rule the table already lives
 * under. Every named day that does have a row lies between them and is folded,
 * and `refresh` clears exactly the days this returns, so no day is ever cleared
 * without being rebuilt. There is no cap on how many named days one refresh
 * takes: a named day is one whose stored numbers the upload has just made wrong,
 * so declining it could only leave a stale row or a hole.
 *
 * With nothing stored the window starts at the oldest finished day named, or at
 * yesterday when none was. That second case is the bootstrap, and it is what
 * lets the table start at all: a workspace whose members sit near UTC, work
 * inside one UTC day and upload promptly never names a finished day, so waiting
 * to be handed one would leave the table empty for good.
 *
 * The window is capped at `FOLD_MAX_DAYS`, which is what keeps one upload's
 * work bounded however far behind the table has fallen. History older than the
 * day coverage started is never filled here - backfilling that is the scheduled
 * fold's job in the retention change.
 */
export function foldTargetDays(named: readonly Date[], coverage: RollupCoverage | null, now: Date): Date[] {
  const yesterday = utcDayStart(now).getTime() - DAY_MS;
  const from = coverage === null
    ? named[0]?.getTime() ?? yesterday
    : coverage.latest.getTime() + DAY_MS;
  const toInclusive = Math.min(from + (FOLD_MAX_DAYS - 1) * DAY_MS, yesterday);
  const targets = new Set<number>();
  for (let day = from; day <= toInclusive; day += DAY_MS) targets.add(day);
  // Below this nothing is folded, so coverage can only ever grow upward from
  // where it started. The coverage passed in is the stretch as it stood before
  // this refresh cleared anything, which is what keeps a named day at the
  // bottom edge inside the floor it is measured against. With nothing stored
  // the window itself is the floor.
  const floor = coverage?.earliest.getTime() ?? from;
  for (const day of named) {
    const at = day.getTime();
    if (at < floor || at > toInclusive) continue;
    targets.add(at);
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
 * It grows coverage upward contiguously, filling forward by at most
 * `FOLD_MAX_DAYS` a run, so a long range plans a handful of live spans rather
 * than one per quiet weekend. That
 * contiguity is load bearing: it is what lets the next run resume from the
 * latest stored day and know nothing below it was skipped, which is why a day
 * named above the window waits for the frontier rather than being folded early.
 * A table far behind catches up over successive uploads instead of paying the
 * gap on one request, and history older than the day coverage started is the
 * retention change's scheduled job to backfill.
 */
export function createRollupService(dependencies: RollupServiceDependencies): RollupService {
  const now = dependencies.now ?? ((): Date => new Date());
  return {
    async refresh(subject: AuthenticatedSubject, instants: readonly Date[]): Promise<void> {
      const at = now();
      const named = foldableDays(instants, at);
      // Coverage is read before anything is cleared, so the floor a named day
      // is measured against is the stretch as it stood before this refresh
      // touched it. Clearing first drops a named day at the bottom edge out of
      // coverage and then declines it for sitting below the coverage that very
      // clear moved, which evicts a covered day for good.
      //
      // This read is the only thing that can fail ahead of the clear, and the
      // days the upload named are the ones whose stored numbers it has just
      // made wrong. If the read gives out they are dropped anyway: unfolded is
      // read live, which is correct, where stale is numbers taken before the
      // rows the upload just committed existed.
      let stored: RollupCoverage | null;
      try {
        stored = await dependencies.rollups.coverage(subject);
      } catch (error: unknown) {
        if (named.length > 0) await dependencies.rollups.clearDays(subject, named);
        throw error;
      }
      const days = foldTargetDays(named, stored, at);
      // An upload with nothing to fold costs that one lookup and no more: it is
      // the common case, because coverage already reaching yesterday is what
      // every earlier upload of the day left behind. Named days left out here
      // sit outside coverage and so have no row of their own to be wrong.
      if (days.length === 0) return;
      // One clear, over exactly the days about to be folded, so no day is ever
      // cleared without being rebuilt. Clear before folding, never after: a day
      // with no row is always correct because the report path reads it live, so
      // everything below this line can fail and the worst outcome is a day read
      // the slow way, where writing the fold first and clearing after would
      // leave old numbers standing over rows that no longer match them.
      //
      // That failure is not self-healing, and is not claimed to be. A fold that
      // gives out below this leaves its days cleared inside coverage, and the
      // window only ever fills upward, so nothing re-establishes them. They read
      // live, which is correct; restoring the coverage is the retention change's
      // scheduled fold, not a later upload.
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
      //
      // A pathologically scattered backlog therefore costs a read per
      // non-adjacent day on the upload's own request. That is the deliberate
      // trade against permanent holes, and moving catch-up off the upload
      // request altogether is the retention change's scheduled fold.
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
 * days it is about to fold before it reads anything that could rebuild them, so
 * every failure below that clear leaves those days merely unfolded - which the
 * report path already handles by reading them live. Letting a cache-maintenance error turn a
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
