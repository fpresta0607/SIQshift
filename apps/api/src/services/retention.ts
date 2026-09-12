import type { AuthenticatedSubject } from "../auth.js";
import type { ActivitySegmentRepository, UserDailyRollupRepository } from "../repositories.js";
import type { RollupService } from "./rollups.js";
import { DAY_MS, utcDayStart } from "./utc-days.js";

/**
 * How much raw evidence is kept.
 *
 * Ninety days is the longest bounded range either dashboard offers, so every
 * range that draws an hourly chart still has the segments behind it. Only the
 * unbounded All-time view reaches past this line, and what it reads there is
 * the fold rather than the rows.
 */
export const RETENTION_DAYS = 90;

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

/** The first day whose raw rows may go: everything before it has expired. */
export function retentionCutoff(now: Date): Date {
  return new Date(utcDayStart(now).getTime() - RETENTION_DAYS * DAY_MS);
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
  /** Set when the pass deliberately deleted nothing, naming which rule stopped it. */
  held?: string;
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
 * the fold got there. A pass that folds nothing deletes nothing.
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
      const cutoff = retentionCutoff(now());
      const organizations = await dependencies.segments.organizationsWithSegmentsBefore(cutoff, ORGANIZATIONS_PER_PASS);
      const passes: RetentionPass[] = [];
      for (const organizationId of organizations) {
        passes.push(await sweepOrganization(dependencies, organizationId, cutoff));
      }
      return passes;
    },
  };
}

async function sweepOrganization(
  dependencies: RetentionServiceDependencies,
  organizationId: string,
  cutoff: Date,
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

  // Fold downward toward the oldest evidence and no further. The cutoff is not
  // a floor here: the days that must be folded before anything can be deleted
  // are precisely the ones older than it, and coverage has to stay one
  // contiguous stretch, so the days between are folded on the way past.
  const backfill = await dependencies.fold.backfill(subject, oldestRaw, BACKFILL_DAYS_PER_PASS);

  // Coverage as it stands after the fold. This is the proof the delete needs:
  // coverage is one contiguous stretch, so every day from here to the cutoff
  // is folded, and nothing outside it is.
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
  const toExclusive = new Date(Math.min(cutoff.getTime(), coverage.latest.getTime() + DAY_MS));
  if (toExclusive.getTime() <= from.getTime()) {
    return {
      organizationId,
      backfilled: backfill.folded.length,
      coverageFrom: coverage.earliest,
      deleted: 0,
      deletedBefore: null,
      held: "no expired day is folded yet",
    };
  }

  const deleted = await dependencies.segments.deleteSpansWithin(organizationId, from, toExclusive);
  return {
    organizationId,
    backfilled: backfill.folded.length,
    coverageFrom: coverage.earliest,
    deleted,
    deletedBefore: toExclusive,
  };
}
