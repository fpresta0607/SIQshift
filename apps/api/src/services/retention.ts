import type { AuthenticatedSubject } from "../auth.js";
import type { ActivitySegmentRepository, UserDailyRollupRepository } from "../repositories.js";
import type { RollupService } from "./rollups.js";
import { DAY_MS, retentionCutoff, utcDayStart } from "./utc-days.js";

// The window itself lives beside the day arithmetic, because the ingest paths
// bound on it too: evidence for a day this sweep will not keep is refused at
// the door rather than stored, swept, and folded to zero in between.
export { RETENTION_DAYS, retentionCutoff } from "./utc-days.js";

/**
 * Days of history one pass will fold per organization.
 *
 * The sweep runs on a schedule, so it may converge over several nights rather
 * than fold a year in one sitting. A bound here is what keeps a first run
 * against a long-lived workspace from holding a connection open for an hour.
 */
export const BACKFILL_DAYS_PER_PASS = 120;

/** Organizations one pass will touch, for the same reason. */
export const ORGANIZATIONS_PER_PASS = 25;

/**
 * Days the sweep holds back below the retention cutoff before deleting.
 *
 * This is slack for clock and midnight drift between two processes, not an
 * off-by-one to be tightened away later. The fold and the sweep each evaluate
 * `retentionCutoff` against their own `now`, and nothing serializes a sweep
 * against an upload - the advisory lock covers sweep against sweep only. A
 * refresh that computed its cutoff just before UTC midnight still admits day D
 * as a named day while a sweep that computed its cutoff just after would treat
 * day D as expired; the refold then reads evidence the delete has removed and
 * writes zeros over a correct row, with a fresher `computedAt` that wins the
 * upsert. That is the unrecoverable outcome this file exists to prevent.
 *
 * One day of slack rules it out with no coordination at all, because the newest
 * day the sweep will delete is a whole day older than the oldest day the fold
 * will touch, and the two cutoffs can disagree by at most a day. The fold's own
 * floor stays at the cutoff: widening it instead would reopen the band where
 * evidence is accepted, stored and then never folded.
 */
export const SWEEP_SLACK_DAYS = 1;

/** The first day the sweep will not delete at or above; a day below the cutoff. */
export function sweepCutoff(now: Date): Date {
  return new Date(retentionCutoff(now).getTime() - SWEEP_SLACK_DAYS * DAY_MS);
}

/**
 * Where in the candidate ordering tonight's pass starts.
 *
 * The candidates are ordered oldest evidence first and cut at
 * `ORGANIZATIONS_PER_PASS`, and on its own that cut is permanent rather than
 * merely a budget: an organization the sweep cannot advance keeps the same
 * oldest evidence, so it keeps the same place at the head of that ordering and
 * is chosen again every night. Both ways of being stuck are real and already
 * documented - a hole in coverage the sweep will not delete across, and a pass
 * that throws - so twenty-five of them would hide every other organization in
 * the deployment indefinitely, while the command still exits 0.
 *
 * Advancing the window by one pass width per UTC day means every candidate is
 * reached within `ceil(candidates / ORGANIZATIONS_PER_PASS)` nights however
 * stuck the ones ahead of it are, and the furthest behind still comes first
 * inside the night's own window. The UTC day number needs no stored state:
 * every process that knows what day it is already agrees on it, which is the
 * same reason the cutoff is derived from it.
 */
export function passRotation(now: Date): number {
  return Math.floor(utcDayStart(now).getTime() / DAY_MS) * ORGANIZATIONS_PER_PASS;
}

export interface RetentionServiceDependencies {
  segments: ActivitySegmentRepository;
  rollups: UserDailyRollupRepository;
  fold: RollupService;
  /** Injected so a test can stand at a fixed instant; production passes nothing. */
  now?: () => Date;
}

/** What one organization's pass did, for the log line and for the tests. */
export interface RetentionPass {
  organizationId: string;
  /** Days folded downward this pass; coverage now starts at `coverageFrom`. */
  backfilled: number;
  coverageFrom: Date | null;
  /** Raw segments deleted, and the window they came from. */
  deleted: number;
  deletedBefore: Date | null;
  /**
   * Set when a rule stopped the delete short of the cutoff, naming which one.
   * Usually that means nothing went at all; an unfolded day is the exception,
   * where the pass deletes up to the hole and holds from there.
   */
  held?: string;
  /** Set when the pass threw, so the organizations behind it still get their turn. */
  failed?: string;
}

export interface RetentionService {
  sweep(): Promise<RetentionPass[]>;
}

/**
 * Rolls expired raw segments into the fold and then deletes them.
 *
 * One rule governs everything here, and every bound below exists to keep it:
 *
 *   **A day's raw rows may only be deleted once that day is folded.**
 *
 * The reports treat a day with no stored row as a day to read live, which is
 * what makes the fold safe to be a cache. Delete the rows behind an unfolded
 * day and that same rule turns against them: the live read finds nothing and
 * the day reports as zero, indistinguishable from a day nobody worked. There
 * is no recovering from it, because the evidence is gone.
 *
 * So a pass folds first and deletes second, and it deletes strictly inside
 * what it has proven folded - never up to the cutoff on the assumption that
 * the fold got there, and never across a day inside coverage that has no
 * stored row. A pass that folds nothing deletes nothing. Its upper bound is
 * `sweepCutoff` rather than the retention cutoff itself, which is where the
 * fold's floor stays; see `SWEEP_SLACK_DAYS` for why they are a day apart.
 *
 * What deletion costs, stated plainly because it is not recoverable: beyond
 * the window, `activity_segments` no longer answers. Unscoped active time,
 * agent time and the concurrency split all come from the fold and are
 * unaffected, but a project-scoped range intersects presence with that
 * project's sessions and a member's app breakdown groups those same rows by
 * process, and both read live. Past the window they have nothing to read.
 * That is the trade the retention window is: summary forever, detail for
 * ninety days.
 */
export function createRetentionService(dependencies: RetentionServiceDependencies): RetentionService {
  const now = dependencies.now ?? ((): Date => new Date());
  return {
    async sweep(): Promise<RetentionPass[]> {
      const at = now();
      const deleteBefore = sweepCutoff(at);
      const organizations = await dependencies.segments.organizationsWithSegmentsBefore(
        deleteBefore,
        ORGANIZATIONS_PER_PASS,
        passRotation(at),
      );
      const passes: RetentionPass[] = [];
      for (const organizationId of organizations) {
        // One organization's failure is its own. Letting a rejection out of this
        // loop would drop every organization behind it from tonight's pass, on a
        // workspace whose backfill happens to time out. Across nights the
        // rotation is what stops a workspace that keeps failing from holding the
        // same slot for good.
        try {
          passes.push(await sweepOrganization(dependencies, organizationId, deleteBefore));
        } catch (error: unknown) {
          passes.push({
            organizationId,
            backfilled: 0,
            coverageFrom: null,
            deleted: 0,
            deletedBefore: null,
            failed: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return passes;
    },
  };
}

async function sweepOrganization(
  dependencies: RetentionServiceDependencies,
  organizationId: string,
  deleteBefore: Date,
): Promise<RetentionPass> {
  // A subject is how every report read is scoped, and a scheduled job has no
  // member to act as. The reads below use the organization alone, so the user
  // id is the organization's own - it names nothing, and it is never used to
  // decide what may be read, only carried.
  const subject: AuthenticatedSubject = { organizationId, userId: organizationId, role: "admin" };
  const oldestRaw = await dependencies.segments.earliestDay(organizationId);
  if (oldestRaw === null) {
    return { organizationId, backfilled: 0, coverageFrom: null, deleted: 0, deletedBefore: null, held: "no segments" };
  }

  // Fold downward toward the oldest evidence and no further. The bound is not
  // a floor here: the days that must be folded before anything can be deleted
  // are precisely the ones older than it, and coverage has to stay one
  // contiguous stretch, so the days between are folded on the way past.
  const backfill = await dependencies.fold.backfill(subject, oldestRaw, BACKFILL_DAYS_PER_PASS);

  // The lock serializes sweeps against sweeps and never against uploads, so a
  // segment for one of the days the backfill just folded can commit between
  // the backfill's reads and its write. The row it wrote comes from a snapshot
  // that predates that evidence, and nothing repairs it afterwards - the
  // backfill has pulled coverage past the day, so a later upload's refresh
  // declines it, and declining is what keeps a hole from opening below
  // coverage. Only a day the ingest can still accept can be raced for, and
  // every such day sits at or above this sweep's own bound, so only those of
  // the backfill's days are rebuilt. An upload committing before the rebuild
  // is seen by it; one committing after folds the day itself, because the day
  // is inside coverage by then.
  const raced = backfill.folded.filter((day) => day.getTime() >= deleteBefore.getTime());
  if (raced.length > 0) await dependencies.fold.refold(subject, raced);

  // A workspace that stops uploading leaves its frontier wherever the last
  // upload put it, and the window below is capped at that frontier: the days
  // between it and the cutoff are expired but folded by nobody, because
  // folding upward is what uploads do and there are none. Fold them here,
  // toward the sweep's own bound and never past it, so the window opens the
  // way every still-uploading organization's does.
  await dependencies.fold.fillForward(subject, deleteBefore, BACKFILL_DAYS_PER_PASS);

  // Coverage as it stands after the fold: the outer bounds of the delete
  // window. It is not the proof on its own - these are two endpoints, and the
  // days between them are checked below.
  const coverage = await dependencies.rollups.coverage(subject);
  if (coverage === null) {
    // Nothing folded at all. The upload path owns the bootstrap and has not run
    // for this organization yet, so there is no proven day to delete behind.
    return {
      organizationId,
      backfilled: backfill.folded.length,
      coverageFrom: null,
      deleted: 0,
      deletedBefore: null,
      held: "nothing folded",
    };
  }

  // The delete window is the overlap of what is folded and what has expired.
  // Its lower bound is where coverage starts rather than where evidence
  // starts, because the days below coverage are the ones the fold has not
  // reached yet - a later pass will, and their rows must still be there for it.
  const from = coverage.earliest;
  const expiring = new Date(Math.min(deleteBefore.getTime(), coverage.latest.getTime() + DAY_MS));
  if (expiring.getTime() <= from.getTime()) {
    return {
      organizationId,
      backfilled: backfill.folded.length,
      coverageFrom: coverage.earliest,
      deleted: 0,
      deletedBefore: null,
      held: "no expired day is folded yet",
    };
  }

  // Coverage's two endpoints are all `coverage()` proves. Contiguity between
  // them is what the fold intends, not what it can promise: `writeDays` chunks
  // its inserts outside any transaction, and a fold that fails after its clear
  // leaves its days cleared on purpose, so either can leave a stretch with no
  // row strictly inside the span. Deleting across one is the unrecoverable
  // case this whole file exists to prevent - the day would have no rollup row
  // and no segments, and would report zero forever - so the window is proven
  // day by day rather than assumed, and stops at the first day that has no row.
  const hole = await dependencies.rollups.firstUnfoldedDay(subject, from, expiring);
  const toExclusive = hole ?? expiring;
  if (toExclusive.getTime() <= from.getTime()) {
    return {
      organizationId,
      backfilled: backfill.folded.length,
      coverageFrom: coverage.earliest,
      deleted: 0,
      deletedBefore: null,
      held: `coverage has no row for ${isoDay(from)}`,
    };
  }

  const deleted = await dependencies.segments.deleteSpansWithin(organizationId, from, toExclusive);
  return {
    organizationId,
    backfilled: backfill.folded.length,
    coverageFrom: coverage.earliest,
    deleted,
    deletedBefore: toExclusive,
    // Said out loud rather than left to look like a stalled sweep. Repairing
    // the hole is a separate and larger decision; naming it is not.
    ...(hole === null ? {} : { held: `coverage has no row for ${isoDay(hole)}` }),
  };
}

/** The day as an operator reads it in a log line. */
function isoDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}
