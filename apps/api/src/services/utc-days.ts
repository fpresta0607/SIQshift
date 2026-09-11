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
