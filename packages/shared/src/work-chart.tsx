import { useRef, useState } from "react";

import { ChartTooltip } from "./chart-tooltip.js";
import { formatTokens } from "./format.js";
import { formatHumanDuration } from "./time.js";
import type { ChartHourlyBucket } from "./ui.js";

/// One token bucket as the server sends it. `tokens` is the server's own total
/// of input and output: the chart draws it as given and never adds the two
/// halves up. All three are null when nothing in the bucket reported tokens.
export type ChartTokenBucket = {
  start: string;
  tokensIn: number | null;
  tokensOut: number | null;
  tokens: number | null;
};

/// The token series as the server computes it: the whole period's buckets.
/// Each app's decoded type satisfies it.
export type ChartTokens = {
  bucketSeconds: number;
  buckets: readonly ChartTokenBucket[];
};

/// The three things the chart can draw; the legend is the filter that picks them.
export type WorkSeries = "active" | "agent" | "tokens";

const HOUR_MS = 3_600_000;
const DAY_SECONDS = 86_400;

const SERIES_LABELS: Readonly<Record<WorkSeries, string>> = {
  active: "Active time",
  agent: "Agent time",
  tokens: "Tokens",
};

/// The smallest 1/2/2.5/5 multiple of a power of ten at or above `raw`.
const niceStep = (raw: number): number => {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const multiplier of [1, 2, 2.5, 5, 10]) {
    if (multiplier * magnitude >= raw) return multiplier * magnitude;
  }
  return 10 * magnitude;
};

/**
 * The dashboard's one chart: time as lines and tokens as bars, on one time
 * axis, so an hour of agent time and the tokens it burned stand over the same
 * stretch of the axis. Active time is the gray line and agent time the green
 * one, read on the left scale; each token bar spans its own bucket (an hour,
 * or a day over a longer range) and is split into tokens in, at its foot, and
 * tokens out above, read on the right scale. A bar's height is the server's
 * own total, so the chart never adds the halves up.
 *
 * The legend is the chart's filter: each entry is a toggle, and the last one
 * on stays on. A series the range has nothing to draw for is not offered.
 */
export const WorkChart = ({
  hourly,
  tokens,
}: {
  hourly: readonly ChartHourlyBucket[];
  /// Absent, or with no buckets, when the range reported no tokens.
  tokens: ChartTokens | undefined;
}) => {
  const [hidden, setHidden] = useState<ReadonlySet<WorkSeries>>(new Set());
  const [readoutAt, setReadoutAt] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const tokenBuckets = tokens?.buckets ?? [];
  const tokenMs = (tokens?.bucketSeconds ?? DAY_SECONDS) * 1_000;
  const offered: WorkSeries[] = [
    ...(hourly.length > 0 ? (["active", "agent"] as const) : []),
    ...(tokenBuckets.some((bucket) => (bucket.tokens ?? 0) > 0) ? (["tokens"] as const) : []),
  ];
  if (offered.length === 0) return null;
  const shown = offered.filter((series) => !hidden.has(series));
  const isShown = (series: WorkSeries): boolean => shown.includes(series);
  const toggle = (series: WorkSeries): void => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(series)) next.delete(series);
      else next.add(series);
      return next;
    });
  };

  const starts = [
    ...hourly.map((bucket) => Date.parse(bucket.hourStart)),
    ...(isShown("tokens") ? tokenBuckets.map((bucket) => Date.parse(bucket.start)) : []),
  ];
  const ends = [
    ...hourly.map((bucket) => Date.parse(bucket.hourStart) + HOUR_MS),
    ...(isShown("tokens") ? tokenBuckets.map((bucket) => Date.parse(bucket.start) + tokenMs) : []),
  ];
  const domainStart = Math.min(...starts);
  const domainEnd = Math.max(...ends);
  const span = Math.max(HOUR_MS, domainEnd - domainStart);
  const isLong = span > 2 * DAY_SECONDS * 1_000;

  const width = 640;
  const height = 200;
  const margin = { left: 44, right: isShown("tokens") ? 40 : 12, top: 14, bottom: 24 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const x = (at: number): number => margin.left + ((at - domainStart) / span) * plotW;
  const lineAt = (bucket: ChartHourlyBucket): number => Date.parse(bucket.hourStart) + HOUR_MS / 2;

  const lines = (["agent", "active"] as const).filter(isShown).map((series) => ({
    id: series,
    label: SERIES_LABELS[series],
    color: series === "agent" ? "var(--chart-agent)" : "var(--chart-human)",
    values: hourly.map((bucket) => (series === "agent" ? bucket.agentSeconds : bucket.activeSeconds)),
  }));
  const timeMax = Math.max(900, Math.ceil(Math.max(60, ...lines.flatMap((line) => line.values)) / 900) * 900);
  const tokenMax = 3 * niceStep(Math.ceil(Math.max(3, ...tokenBuckets.map((bucket) => bucket.tokens ?? 0)) / 3));
  const yTime = (value: number): number => margin.top + plotH - (value / timeMax) * plotH;
  const yTokens = (value: number): number => margin.top + plotH - (value / tokenMax) * plotH;

  const linePath = (values: readonly number[]): string =>
    values.map((value, index) => `${index === 0 ? "M" : "L"}${x(lineAt(hourly[index]!)).toFixed(1)},${yTime(value).toFixed(1)}`).join("");
  const areaPath = (values: readonly number[]): string =>
    `M${x(lineAt(hourly[0]!)).toFixed(1)},${yTime(0).toFixed(1)}`
    + values.map((value, index) => `L${x(lineAt(hourly[index]!)).toFixed(1)},${yTime(value).toFixed(1)}`).join("")
    + `L${x(lineAt(hourly[values.length - 1]!)).toFixed(1)},${yTime(0).toFixed(1)}Z`;

  const tickCount = 7;
  const xTicks = Array.from({ length: tickCount }, (_, tick) => {
    const at = domainStart + (tick / (tickCount - 1)) * span;
    const date = new Date(at);
    return {
      at,
      label: isLong
        ? date.toLocaleDateString([], { month: "short", day: "numeric" })
        : String(date.getHours()).padStart(2, "0"),
    };
  });

  const hourIndexAt = (at: number): number | null => {
    if (hourly.length === 0) return null;
    let best = 0;
    for (let index = 1; index < hourly.length; index += 1) {
      if (Math.abs(lineAt(hourly[index]!) - at) < Math.abs(lineAt(hourly[best]!) - at)) best = index;
    }
    return best;
  };
  const tokenIndexAt = (at: number): number | null => {
    const index = tokenBuckets.findIndex((bucket) => {
      const start = Date.parse(bucket.start);
      return at >= start && at < start + tokenMs;
    });
    return index === -1 ? null : index;
  };

  const atFromPointer = (clientX: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return null;
    const viewX = ((clientX - rect.left) / rect.width) * width;
    if (viewX < margin.left || viewX > width - margin.right) return null;
    return domainStart + ((viewX - margin.left) / plotW) * span;
  };

  /// Arrow keys walk the read-out an hour at a time (a bar at a time when only
  /// bars are drawn); Home/End jump to the edges.
  const moveReadout = (key: string): boolean => {
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return false;
    const step = lines.length > 0 ? HOUR_MS : tokenMs;
    const first = domainStart + step / 2;
    const last = domainEnd - step / 2;
    setReadoutAt((current) => {
      if (key === "Home") return first;
      if (key === "End") return last;
      if (current === null) return key === "ArrowRight" ? first : last;
      return Math.max(first, Math.min(last, current + (key === "ArrowRight" ? step : -step)));
    });
    return true;
  };

  const readoutHour = readoutAt === null || lines.length === 0 ? null : hourIndexAt(readoutAt);
  const readoutBar = readoutAt === null || !isShown("tokens") ? null : tokenIndexAt(readoutAt);
  const hasReadout = readoutHour !== null || readoutBar !== null;
  const tokenFigure = (value: number | null): string => (value === null ? "-" : formatTokens(value));
  const readoutBucket = readoutBar === null ? undefined : tokenBuckets[readoutBar];
  const readoutRows = [
    ...lines.map((line) => ({
      color: line.color,
      label: line.label,
      value: readoutHour === null ? "-" : formatHumanDuration(line.values[readoutHour]!),
    })),
    ...(isShown("tokens")
      ? [
        { color: "var(--chart-agent)", label: "Tokens in", value: tokenFigure(readoutBucket?.tokensIn ?? null) },
        { color: "var(--chart-token-out)", label: "Tokens out", value: tokenFigure(readoutBucket?.tokensOut ?? null) },
      ]
      : []),
  ];
  const readoutTitle = readoutAt === null
    ? ""
    : readoutHour !== null
      ? new Date(Date.parse(hourly[readoutHour]!.hourStart)).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : new Date(readoutAt).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const tokenNote = tokenMs >= DAY_SECONDS * 1_000 ? "day" : "hour";

  return (
    <div className="graph work-chart" data-testid="work-chart">
      <div className="work-chart-filter" role="group" aria-label="What the chart shows">
        {offered.map((series) => (
          <button
            key={series}
            type="button"
            className="work-chart-key"
            data-series-key={series}
            aria-pressed={isShown(series)}
            disabled={isShown(series) && shown.length === 1}
            onClick={() => toggle(series)}
          >
            <span className={series === "tokens" ? "work-chart-swatch is-bar" : "work-chart-swatch"} data-series-swatch={series} aria-hidden="true" />
            {SERIES_LABELS[series]}
          </button>
        ))}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${shown.map((series) => SERIES_LABELS[series]).join(", ")} over time`}
        tabIndex={0}
        onMouseMove={(event) => {
          const at = atFromPointer(event.clientX);
          if (at !== null) setReadoutAt(at);
        }}
        onMouseLeave={() => setReadoutAt(null)}
        onKeyDown={(event) => {
          if (moveReadout(event.key)) event.preventDefault();
        }}
      >
        <defs>
          {lines.map((line) => (
            <linearGradient key={line.id} id={`work-chart-fill-${line.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={line.color} stopOpacity="0.16" />
              <stop offset="1" stopColor={line.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {[0, 1, 2, 3].map((third) => (
          <g key={third}>
            <line
              x1={margin.left}
              y1={margin.top + plotH - (third / 3) * plotH}
              x2={width - margin.right}
              y2={margin.top + plotH - (third / 3) * plotH}
              stroke={third === 0 ? "var(--chart-grid)" : "var(--chart-grid-soft)"}
            />
            {lines.length > 0 && (
              <text x={margin.left - 6} y={yTime((timeMax / 3) * third) + 3} fill="var(--chart-axis)" fontSize="9" textAnchor="end">
                {formatHumanDuration((timeMax / 3) * third)}
              </text>
            )}
            {isShown("tokens") && (
              <text x={width - margin.right + 6} y={yTokens((tokenMax / 3) * third) + 3} fill="var(--chart-axis)" fontSize="9" textAnchor="start">
                {formatTokens((tokenMax / 3) * third)}
              </text>
            )}
          </g>
        ))}
        {xTicks.map(({ at, label }, index) => (
          <text
            key={at}
            x={x(at)}
            y={height - 6}
            fill="var(--chart-axis)"
            fontSize="9"
            textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}
          >
            {label}
          </text>
        ))}
        {readoutBar !== null && (
          <rect
            className="token-band"
            x={x(Date.parse(tokenBuckets[readoutBar]!.start))}
            y={margin.top}
            width={x(Date.parse(tokenBuckets[readoutBar]!.start) + tokenMs) - x(Date.parse(tokenBuckets[readoutBar]!.start))}
            height={plotH}
          />
        )}
        {isShown("tokens") && tokenBuckets.map((bucket) => {
          if (bucket.tokens === null || bucket.tokens === 0) return null;
          const start = Date.parse(bucket.start);
          const slot = x(start + tokenMs) - x(start);
          const barWidth = Math.max(1, slot * 0.7);
          const left = x(start) + (slot - barWidth) / 2;
          const inputTop = yTokens(Math.min(bucket.tokensIn ?? 0, bucket.tokens));
          return (
            <g key={bucket.start} data-bar={bucket.start} data-tokens={bucket.tokens}>
              <rect className="token-bar is-out" x={left} y={yTokens(bucket.tokens)} width={barWidth} height={inputTop - yTokens(bucket.tokens)} />
              <rect className="token-bar is-in" x={left} y={inputTop} width={barWidth} height={yTokens(0) - inputTop} />
            </g>
          );
        })}
        {hourly.length > 1 && lines.map((line) => (
          <path key={`${line.id}-area`} d={areaPath(line.values)} fill={`url(#work-chart-fill-${line.id})`} stroke="none" />
        ))}
        {readoutHour !== null && (
          <line
            x1={x(lineAt(hourly[readoutHour]!))}
            y1={margin.top}
            x2={x(lineAt(hourly[readoutHour]!))}
            y2={margin.top + plotH}
            stroke="var(--chart-grid)"
          />
        )}
        {lines.map((line) => (
          <path
            key={line.id}
            data-series={line.id}
            d={linePath(line.values)}
            fill="none"
            stroke={line.color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {readoutHour !== null && lines.map((line) => (
          <circle
            key={`${line.id}-point`}
            cx={x(lineAt(hourly[readoutHour]!))}
            cy={yTime(line.values[readoutHour]!)}
            r={3.5}
            fill="var(--chart-point)"
            stroke={line.color}
            strokeWidth="1.5"
          />
        ))}
      </svg>
      {hasReadout && readoutAt !== null && (
        <ChartTooltip left={(Math.max(x(domainStart), Math.min(x(domainEnd), x(readoutAt))) / width) * 100} title={readoutTitle} rows={readoutRows} />
      )}
      <p className="visually-hidden" role="status">
        {hasReadout ? `${readoutTitle}: ${readoutRows.map((row) => `${row.label} ${row.value}`).join(", ")}` : ""}
      </p>
      <p className="tv-card-foot">
        {lines.length > 0 && "Lines are time, one point per hour, on the left scale."}
        {lines.length > 0 && isShown("tokens") && " "}
        {isShown("tokens") && `Bars are tokens, in at the foot and out on top, one bar per ${tokenNote}, on the right scale.`}
      </p>
    </div>
  );
};
