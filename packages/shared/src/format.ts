const shortForm = (value: number, unit: number, suffix: string): string =>
  `${(value / unit).toFixed(1).replace(/\.0$/, "")}${suffix}`;

/**
 * A token count in short form for every surface: 950, 1.2k, 391k, 48.2M, 2.1B.
 * Token counts dwarf durations, so they read on their own scale; a surface that
 * shows one also puts the exact count in a title beside it. Each step starts
 * where the one below would round up to a thousand, so 999,999 reads 1M, never
 * 1000k.
 */
export const formatTokens = (value: number): string => {
  if (value >= 999_950_000) return shortForm(value, 1_000_000_000, "B");
  if (value >= 999_500) return shortForm(value, 1_000_000, "M");
  if (value >= 9_999.5) return `${Math.round(value / 1_000)}k`;
  if (value >= 999.95) return shortForm(value, 1_000, "k");
  return String(Math.round(value));
};

const COUNT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** A whole count with thousands separators, for the totals that count things: 1,284 shifts. */
export const formatCount = (value: number): string => COUNT_FORMAT.format(value);

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/**
 * The days a bounded range covers, for the line under the team view's title:
 * "Nov 9 to Nov 15", or "Nov 13" for a single day. The end is exclusive, as
 * every report range is, so the last day shown is the one before it.
 */
export const formatRangeDays = (fromAt: string, toExclusiveAt: string): string => {
  const first = DAY_FORMAT.format(new Date(fromAt));
  const last = DAY_FORMAT.format(new Date(new Date(toExclusiveAt).getTime() - 1));
  return first === last ? first : `${first} to ${last}`;
};
