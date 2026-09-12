/**
 * The UTC day arithmetic the fold is built on.
 *
 * It lives on its own because both sides of the fold need it and neither may
 * depend on the other: the rollup service reads agent-session intervals, and
 * the agent-session ingest names the days its writes invalidated. A UTC day is
 * the only day boundary this data model can state - nothing stores a timezone,
 * and two members of one workspace can sit in different ones.
 */

export const DAY_MS = 24 * 60 * 60 * 1_000;

/** Midnight UTC at or before the instant. */
export function utcDayStart(at: Date | number): Date {
  const ms = typeof at === "number" ? at : at.getTime();
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS);
}

/** Midnight UTC at or after the instant. */
export function utcDayCeiling(at: Date | number): Date {
  const ms = typeof at === "number" ? at : at.getTime();
  return new Date(Math.ceil(ms / DAY_MS) * DAY_MS);
}

/**
 * Midnight of every UTC day the closed span between two instants touches, in
 * either order.
 *
 * This is how a moved session end names the days it may have changed: a
 * session measured up to its last event owed each day it reached into a share
 * that was not final while that end could still move, so every day between
 * where the end was and where it now is has to be folded again.
 */
export function utcDaysBetween(from: Date, to: Date): Date[] {
  const first = utcDayStart(Math.min(from.getTime(), to.getTime())).getTime();
  const last = utcDayStart(Math.max(from.getTime(), to.getTime())).getTime();
  const days: Date[] = [];
  for (let day = first; day <= last; day += DAY_MS) days.push(new Date(day));
  return days;
}

/**
 * How long raw evidence is kept, and therefore how far back an uploaded instant
 * may claim to be.
 *
 * One constant, because these are one boundary said twice. Ninety days is the
 * longest bounded range either dashboard offers, so every range that draws an
 * hourly chart still has the segments behind it; only the unbounded All-time
 * view reaches past this line, and what it reads there is the fold rather than
 * the rows. Accepting evidence older than that would store rows the sweep is
 * about to delete, and - worse - would let a late upload name a day whose rows
 * are already gone, which refolds a correct stored row into zeros. So the
 * ingest refuses at the door what retention will not keep.
 *
 * It lives beside the day arithmetic for the same reason that does: both ingest
 * paths, the fold and the sweep all need it and none of them may depend on
 * another, and a window kept in two places is a window that stops agreeing.
 * The future side of an upload was always checked by each path and the past
 * side was not, so any authenticated client could post `0000-01-01T00:00:00Z` -
 * `timestampSchema` accepts any four-digit year. On the agent path that stored
 * a session whose known end sat two thousand years back, and the span between
 * a session's old and new known end is expanded one `Date` per day; on the
 * activity path it named a day two thousand years back for the fold, which
 * anchors a fresh table's coverage there.
 */
export const RETENTION_DAYS = 90;

/** The same window in milliseconds, as the ingest bounds want it. */
export const RETENTION_WINDOW_MS = RETENTION_DAYS * DAY_MS;

/** The first day whose raw rows may go: everything before it has expired. */
export function retentionCutoff(now: Date): Date {
  return new Date(utcDayStart(now).getTime() - RETENTION_WINDOW_MS);
}
