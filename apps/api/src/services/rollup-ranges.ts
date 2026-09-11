import { DAY_MS, utcDayCeiling, utcDayStart } from "./rollups.js";

/**
 * A span of the range the report path still has to read live. `null` on either
 * side is that side unbounded, which is how an all-time range reaches the
 * repository reads - the same absent bound they already take.
 */
export type LiveSpan = { from: Date | null; toExclusive: Date | null };

/** The range as the report path states it; either bound may be open. */
export type OpenRange = { start: number | null; end: number | null };

/** The whole finished UTC days a range may spend, `[from, toExclusive)`. */
export type RollupWindow = { from: Date; toExclusive: Date };

export type RollupPlan = {
  window: RollupWindow;
  /** The parts of the range no spent day covers. Disjoint, oldest first. */
  live: LiveSpan[];
};

/**
 * The whole finished UTC days this range could spend, before anyone knows
 * which of them are actually stored.
 *
 * Today is never in it: today is still being written, and a row for it would
 * go stale the moment the next segment lands. A range with no lower bound
 * starts at the earliest day the table holds, because there is nothing older
 * to spend; with nothing stored at all the window is empty and the whole range
 * is read live.
 */
export function rollupWindow(range: OpenRange, earliestStored: number | null, now: Date): RollupWindow {
  const today = utcDayStart(now).getTime();
  const lower = range.start ?? earliestStored;
  const from = lower === null ? today : Math.min(utcDayCeiling(lower).getTime(), today);
  const upper = range.end === null ? today : Math.min(utcDayStart(range.end).getTime(), today);
  return { from: new Date(from), toExclusive: new Date(Math.max(from, upper)) };
}

/**
 * Splits the range into the stored days it spends and the spans it still reads
 * live.
 *
 * The split is exact, not an approximation. Every number a rollup holds - a
 * union, a sum, and the concurrency buckets that partition that union - adds
 * across pieces of the timeline that do not overlap, so "stored days plus the
 * partial day at each end" is the answer the live path gives on its own.
 *
 * Nothing here assumes a day is really stored. `coveredDays` is what the table
 * actually holds, and a day inside the window missing from it becomes a live
 * span rather than a silent zero. That is what makes an empty or half-built
 * table merely slower, never wrong.
 */
export function planRollupRange(
  range: OpenRange,
  window: RollupWindow,
  coveredDays: ReadonlySet<number>,
): RollupPlan {
  const windowStart = window.from.getTime();
  const windowEnd = window.toExclusive.getTime();
  const live: LiveSpan[] = [];
  const push = (from: number | null, toExclusive: number | null): void => {
    if (from !== null && toExclusive !== null && from >= toExclusive) return;
    const previous = live[live.length - 1];
    // Touching spans merge, so a missing day beside an edge is one read.
    if (previous !== undefined && previous.toExclusive !== null && from !== null
      && previous.toExclusive.getTime() === from) {
      live[live.length - 1] = {
        from: previous.from,
        toExclusive: toExclusive === null ? null : new Date(toExclusive),
      };
      return;
    }
    live.push({
      from: from === null ? null : new Date(from),
      toExclusive: toExclusive === null ? null : new Date(toExclusive),
    });
  };

  push(range.start, windowStart);
  for (let day = windowStart; day < windowEnd; day += DAY_MS) {
    if (!coveredDays.has(day)) push(day, day + DAY_MS);
  }
  push(windowEnd, range.end);
  return { window, live };
}

/** True when this stored day sits in the window and no live span re-reads it. */
export function isSpentDay(day: number, plan: RollupPlan): boolean {
  if (day < plan.window.from.getTime() || day >= plan.window.toExclusive.getTime()) return false;
  return !plan.live.some((span) => (span.from === null || day >= span.from.getTime())
    && (span.toExclusive === null || day < span.toExclusive.getTime()));
}
