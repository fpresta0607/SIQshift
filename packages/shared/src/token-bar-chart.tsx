import { useRef, useState } from "react";

import { ChartTooltip } from "./chart-tooltip.js";

/// One bar as the server sends it. `tokens` is the server's own total of input
/// and output: the chart draws it as given and never adds the two halves up.
/// All three are null when nothing in the bucket reported tokens.
export type ChartTokenBucket = {
  start: string;
  tokensIn: number | null;
  tokensOut: number | null;
  tokens: number | null;
};

/// The token chart as the server computes it: the whole period's bars, and
/// each project's own bars over the same buckets with its total for the period.
/// Each app's decoded type satisfies it.
export type ChartTokens = {
  bucketSeconds: number;
  buckets: readonly ChartTokenBucket[];
  projects: readonly {
    project: { id: string; name: string };
    tokens: number;
    buckets: readonly ChartTokenBucket[];
  }[];
};

const DAY_SECONDS = 86_400;

/// A compact count for token axes and readouts: 950, 12k, 3.4M. Token counts
/// dwarf durations, so the chart formats them on their own scale.
const formatTokenCount = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
};

/// The smallest 1/2/2.5/5 multiple of a power of ten at or above `raw`.
const niceStep = (raw: number): number => {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const multiplier of [1, 2, 2.5, 5, 10]) {
    if (multiplier * magnitude >= raw) return multiplier * magnitude;
  }
  return 10 * magnitude;
};

/// Bars of tokens burned, input and output together, all green. Picking a
/// project draws its bars solid over the whole period's, which stay behind as
/// ghosts on the same scale, so the project reads as its share of each bucket
/// and every readout narrows to it. Every figure on screen is one the server
/// sent; nothing here is summed.
export const TokenBarChart = ({ chart }: { chart: ChartTokens }) => {
  const [projectId, setProjectId] = useState("");
  const [readout, setReadout] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const selected = chart.projects.find((entry) => entry.project.id === projectId && entry.tokens > 0);
  if (selected === undefined && projectId !== "") setProjectId("");
  const count = chart.buckets.length;
  if (count === 0) return null;

  const shown = selected?.buckets ?? chart.buckets;
  const isDaily = chart.bucketSeconds >= DAY_SECONDS;

  const width = 640;
  const height = 190;
  const margin = { left: 44, right: 12, top: 14, bottom: 24 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  // The scale is the whole period's, so a picked project's bars stay in
  // proportion to the ghosts behind them.
  const rawMax = Math.max(3, ...chart.buckets.map((bucket) => bucket.tokens ?? 0));
  // Gridlines land on thirds of yMax, so the quantum stays divisible by three.
  const yMax = 3 * niceStep(Math.ceil(rawMax / 3));
  const slot = plotW / count;
  const barWidth = Math.max(1, slot * 0.7);
  const slotCenter = (index: number): number => margin.left + index * slot + slot / 2;
  const y = (value: number): number => margin.top + plotH - (value / yMax) * plotH;

  const bucketStart = (index: number): Date => new Date(chart.buckets[index]!.start);
  const bucketMiddle = (index: number): Date => new Date(bucketStart(index).getTime() + chart.bucketSeconds * 500);
  const bucketLabel = (index: number): string =>
    isDaily
      ? bucketMiddle(index).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
      : bucketStart(index).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const tickCount = Math.min(7, count);
  const xTicks = Array.from({ length: tickCount }, (_, tick) => {
    const index = tickCount === 1 ? 0 : Math.round((tick / (tickCount - 1)) * (count - 1));
    const label = isDaily
      ? bucketMiddle(index).toLocaleDateString([], { month: "short", day: "numeric" })
      : String(bucketStart(index).getHours()).padStart(2, "0");
    return { index, label };
  });

  const indexFromPointer = (clientX: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return null;
    const viewX = ((clientX - rect.left) / rect.width) * width;
    if (viewX < margin.left || viewX > width - margin.right) return null;
    return Math.max(0, Math.min(count - 1, Math.floor((viewX - margin.left) / slot)));
  };

  /// Arrow keys walk the read-out bar; Home/End jump to the edges. Returns
  /// false for keys the chart does not consume.
  const moveReadout = (key: string): boolean => {
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return false;
    setReadout((current) => {
      if (key === "Home") return 0;
      if (key === "End") return count - 1;
      const base = current ?? (key === "ArrowLeft" ? count : -1);
      return Math.max(0, Math.min(count - 1, base + (key === "ArrowRight" ? 1 : -1)));
    });
    return true;
  };

  const active = readout !== null && readout < count ? readout : null;
  const figure = (value: number | null | undefined): string =>
    value === null || value === undefined ? "-" : formatTokenCount(value);
  const summary = (index: number): string => {
    const bucket = shown[index];
    return bucket === undefined || bucket.tokens === null
      ? `${bucketLabel(index)}: no tokens`
      : `${bucketLabel(index)}: ${figure(bucket.tokens)} tokens, ${figure(bucket.tokensIn)} in, ${figure(bucket.tokensOut)} out`;
  };

  /// One bar per bucket that burned anything; an empty bucket draws nothing
  /// rather than a zero-height mark.
  const bars = (buckets: readonly ChartTokenBucket[], isGhost: boolean) =>
    buckets.map((bucket, index) => {
      if (bucket.tokens === null || bucket.tokens === 0) return null;
      return (
        <rect
          key={`${isGhost ? "ghost" : "bar"}-${bucket.start}`}
          className={isGhost ? "token-bar is-ghost" : "token-bar"}
          data-bar={isGhost ? undefined : bucket.start}
          data-tokens={isGhost ? undefined : bucket.tokens}
          x={slotCenter(index) - barWidth / 2}
          y={y(bucket.tokens)}
          width={barWidth}
          height={y(0) - y(bucket.tokens)}
          rx={Math.min(2, barWidth / 2)}
        />
      );
    });

  return (
    <div className="graph token-chart" data-testid="token-chart">
      <div className="token-chart-head">
        <p className="token-chart-title">Tokens burned, in and out</p>
        <select
          className="token-chart-picker"
          aria-label="Project"
          value={selected === undefined ? "" : selected.project.id}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">All projects</option>
          {chart.projects.map((entry) => (
            <option key={entry.project.id} value={entry.project.id} disabled={entry.tokens === 0}>
              {entry.project.name} · {entry.tokens === 0 ? "no tokens" : formatTokenCount(entry.tokens)}
            </option>
          ))}
        </select>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Tokens burned per ${isDaily ? "day" : "hour"}${selected === undefined ? "" : `, ${selected.project.name}`}`}
        tabIndex={0}
        onMouseMove={(event) => {
          const index = indexFromPointer(event.clientX);
          if (index !== null) setReadout(index);
        }}
        onMouseLeave={() => setReadout(null)}
        onKeyDown={(event) => {
          if (moveReadout(event.key)) event.preventDefault();
        }}
      >
        {[0, 1, 2, 3].map((third) => {
          const value = (yMax / 3) * third;
          return (
            <g key={third}>
              <line
                x1={margin.left}
                y1={y(value)}
                x2={width - margin.right}
                y2={y(value)}
                stroke={third === 0 ? "var(--chart-grid)" : "var(--chart-grid-soft)"}
              />
              <text x={margin.left - 6} y={y(value) + 3} fill="var(--chart-axis)" fontSize="9" textAnchor="end">
                {formatTokenCount(value)}
              </text>
            </g>
          );
        })}
        {xTicks.map(({ index, label }) => (
          <text key={index} x={slotCenter(index)} y={height - 6} fill="var(--chart-axis)" fontSize="9" textAnchor="middle">{label}</text>
        ))}
        {active !== null && (
          <rect className="token-band" x={margin.left + active * slot} y={margin.top} width={slot} height={plotH} />
        )}
        {selected !== undefined && bars(chart.buckets, true)}
        {bars(shown, false)}
      </svg>
      {active !== null && (
        <ChartTooltip
          left={(slotCenter(active) / width) * 100}
          title={bucketLabel(active)}
          rows={[
            { color: "var(--chart-agent)", label: "Tokens", value: figure(shown[active]?.tokens) },
            { color: "var(--chart-agent)", label: "In", value: figure(shown[active]?.tokensIn) },
            { color: "var(--chart-agent)", label: "Out", value: figure(shown[active]?.tokensOut) },
          ]}
        />
      )}
      <p className="visually-hidden" role="status">{active === null ? "" : summary(active)}</p>
    </div>
  );
};
