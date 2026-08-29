import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { agentRuntimeForBinary, agentRuntimeLabel } from "./agent-runtimes.js";
import { friendlyAppName } from "./app-names.js";
import { formatHumanDuration } from "./time.js";
import { AgentRuntimeIcon } from "./agent-marks.js";

export { AgentRuntimeIcon } from "./agent-marks.js";

/**
 * The surfaces both frontends draw a measurement in.
 *
 * These shipped as hand-synced copies in `apps/desktop/src/App.tsx` and
 * `apps/web/src/App.tsx` - the chart's own comment said the two were
 * "byte-identical" - which is the arrangement that lost a background fix twice
 * before `webgl-shader` became one file. React is this entry's only optional
 * peer, reached through `@siqshift/shared/ui` alone, so the API - which imports
 * the contracts entry and nothing else - never pulls it.
 *
 * Every class here is styled by `styles/brand.css` plus each app's own sheet;
 * nothing below hardcodes a color.
 */

/** The part of a concurrency split the breakdown reads. */
export type ConcurrencySplit = {
  t0Seconds: number;
  t1Seconds: number;
  t2Seconds: number;
  t3PlusSeconds: number;
};

/// A person's active time laid out as labeled rows: the hours up top, then
/// how many agents were running through them. What those agents added up to
/// belongs to the agent, not the person, so it lives on the Agents tab's
/// shifts-by-codebase map.
export const MemberBreakdown = ({
  activeSeconds,
  concurrency,
  self,
}: {
  activeSeconds: number;
  concurrency: ConcurrencySplit;
  self: boolean;
}) => (
  <div className="breakdown" data-testid="breakdown">
    <p className="group-label">{self ? "Your active time — the hours you were at this computer" : "Active time — the hours they were at this computer"}</p>
    <div className="metric-row is-headline">
      <span className="metric-name">Active time</span>
      <span className="metric-value">{formatHumanDuration(activeSeconds)}</span>
    </div>
    <div className="metric-row">
      <span className="metric-swatch swatch-human" aria-hidden="true" />
      <span className="metric-name">Human work <span className="metric-hint">(no agent running)</span></span>
      <span className="metric-value">{formatHumanDuration(concurrency.t0Seconds)}</span>
    </div>
    {concurrency.t1Seconds > 0 && (
      <div className="metric-row">
        <span className="metric-swatch swatch-agent1" aria-hidden="true" />
        <span className="metric-name">With 1 agent</span>
        <span className="metric-value">{formatHumanDuration(concurrency.t1Seconds)}</span>
      </div>
    )}
    {concurrency.t2Seconds > 0 && (
      <div className="metric-row">
        <span className="metric-swatch swatch-agent2" aria-hidden="true" />
        <span className="metric-name">With 2 agents</span>
        <span className="metric-value">{formatHumanDuration(concurrency.t2Seconds)}</span>
      </div>
    )}
    {concurrency.t3PlusSeconds > 0 && (
      <div className="metric-row">
        <span className="metric-swatch swatch-agent3" aria-hidden="true" />
        <span className="metric-name">With 3+ agents</span>
        <span className="metric-value">{formatHumanDuration(concurrency.t3PlusSeconds)}</span>
      </div>
    )}
  </div>
);

/// A compact count for token axes and readouts: 950, 12k, 3.4M. Token counts
/// dwarf durations, so the charts format them on their own scale.
const formatTokenCount = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
};

/// The structural slice of an hourly bucket the charts read. Each app's own
/// bucket type satisfies it.
export type ChartHourlyBucket = {
  hourStart: string;
  activeSeconds: number;
  agentSeconds: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
};

type ChartSeries = {
  /// The data-series hook tests pin to; one per plotted measure, never a path count.
  id: string;
  label: string;
  /// The brand.css chart token the stroke, points, and gradient read.
  color: string;
  values: readonly (number | null)[];
};

/// The tooltip both charts share: the hovered or keyboard-focused moment, and
/// each series' value there. Positioned as a percentage of the plot width so
/// the SVG's viewBox scaling never desyncs it.
const ChartTooltip = ({
  left,
  title,
  rows,
}: {
  left: number;
  title: string;
  rows: readonly { color: string; label: string; value: string }[];
}) => (
  <div className="graph-tooltip" style={{ left: `${left}%` }}>
    <p className="graph-tooltip-title">{title}</p>
    {rows.map((row) => (
      <p key={row.label} className="graph-tooltip-row">
        <span className="legend-line" style={{ background: row.color }} aria-hidden="true" />
        {row.label} {row.value}
      </p>
    ))}
  </div>
);

/// The smallest 1/2/2.5/5 multiple of a power of ten at or above `raw`.
const niceStep = (raw: number): number => {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const multiplier of [1, 2, 2.5, 5, 10]) {
    if (multiplier * magnitude >= raw) return multiplier * magnitude;
  }
  return 10 * magnitude;
};

/// SVG line chart - agents in the brand green, the person in gray, tokens in
/// blue and purple. No chart library: a fixed viewBox, one path per series,
/// and a gradient area under each. The server buckets to the caller's local
/// hours, so the x-axis reads midnight-to-midnight on the viewer's clock.
/// Token fields are null when nothing in the hour reported; the path breaks
/// there rather than dropping to a zero that never happened.
export const HourlyGraph = ({
  buckets,
  personLabel,
  tokenBlind = [],
}: {
  buckets: readonly ChartHourlyBucket[];
  /// Names the presence line. Absent, no person series draws at all - the
  /// Agents tab plots runtime alone, where a flat "You" at zero would only
  /// claim somebody was measured and absent.
  personLabel?: string;
  /// Runtimes that ran in range but reported no tokens, named beneath the plot.
  tokenBlind?: readonly string[];
}) => {
  const [measure, setMeasure] = useState<"time" | "tokens">("time");
  const [readout, setReadout] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  if (buckets.length === 0) return null;

  const hasTokens = buckets.some((bucket) => bucket.inputTokens !== null || bucket.outputTokens !== null);
  // "In" is everything the model consumed: fresh input plus both cache sides.
  const tokensIn = (bucket: ChartHourlyBucket): number | null =>
    bucket.inputTokens === null
      ? null
      : bucket.inputTokens + (bucket.cacheCreationInputTokens ?? 0) + (bucket.cacheReadInputTokens ?? 0);
  const series: readonly ChartSeries[] = measure === "tokens"
    ? [
        { id: "tokens-in", label: "Tokens in", color: "var(--chart-token-in)", values: buckets.map(tokensIn) },
        { id: "tokens-out", label: "Tokens out", color: "var(--chart-token-out)", values: buckets.map((bucket) => bucket.outputTokens) },
      ]
    : [
        { id: "agent", label: "Agents", color: "var(--chart-agent)", values: buckets.map((bucket) => bucket.agentSeconds) },
        ...(personLabel === undefined
          ? []
          : [{ id: "human", label: personLabel, color: "var(--chart-human)", values: buckets.map((bucket) => bucket.activeSeconds) }]),
      ];
  const formatValue = measure === "tokens" ? formatTokenCount : formatHumanDuration;

  const width = 640;
  const height = 190;
  const margin = { left: 44, right: 12, top: 14, bottom: 24 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const rawMax = Math.max(
    measure === "tokens" ? 3 : 60,
    ...series.flatMap((entry) => entry.values.filter((value): value is number => value !== null)),
  );
  // Gridlines land on thirds of yMax, so the quantum stays divisible by three
  // and every labeled line reads a round number.
  const yMax = measure === "tokens"
    ? 3 * niceStep(Math.ceil(rawMax / 3))
    : Math.max(900, Math.ceil(rawMax / 900) * 900);
  const x = (index: number): number =>
    buckets.length === 1 ? margin.left + plotW / 2 : margin.left + (index / (buckets.length - 1)) * plotW;
  const y = (value: number): number => margin.top + plotH - (value / yMax) * plotH;

  /// One path per series; a null lifts the pen, so a gap reads as a gap
  /// instead of a plunge to the baseline.
  const linePath = (values: readonly (number | null)[]): string => {
    let d = "";
    let pen = false;
    values.forEach((value, index) => {
      if (value === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  type Run = { start: number; end: number };
  /// The contiguous non-null spans of a series; the gradient area fills one
  /// run at a time so it too breaks over gaps.
  const runs = (values: readonly (number | null)[]): Run[] => {
    const spans: Run[] = [];
    let start: number | null = null;
    values.forEach((value, index) => {
      if (value === null) {
        if (start !== null) spans.push({ start, end: index - 1 });
        start = null;
      } else if (start === null) {
        start = index;
      }
    });
    if (start !== null) spans.push({ start, end: values.length - 1 });
    return spans;
  };
  const areaPath = (values: readonly (number | null)[], run: Run): string => {
    let d = `M${x(run.start).toFixed(1)},${y(0).toFixed(1)}`;
    for (let index = run.start; index <= run.end; index += 1) {
      d += `L${x(index).toFixed(1)},${y(values[index] ?? 0).toFixed(1)}`;
    }
    return `${d}L${x(run.end).toFixed(1)},${y(0).toFixed(1)}Z`;
  };

  // Day ranges show every point; longer ranges thin to each series' local
  // extrema, plus wherever the read-out sits.
  const showEveryPoint = buckets.length <= 48;
  const isExtremum = (values: readonly (number | null)[], index: number): boolean => {
    const value = values[index];
    if (value === null || value === undefined) return false;
    const previous = values[index - 1];
    const next = values[index + 1];
    if (previous === null || previous === undefined || next === null || next === undefined) return true;
    return (value > previous && value > next) || (value < previous && value < next);
  };

  const tickCount = Math.min(7, buckets.length);
  const xTicks = Array.from({ length: tickCount }, (_, tick) => {
    const index = tickCount === 1 ? 0 : Math.round((tick / (tickCount - 1)) * (buckets.length - 1));
    const date = new Date(buckets[index]!.hourStart);
    const label = buckets.length <= 48
      ? String(date.getHours()).padStart(2, "0")
      : date.toLocaleDateString([], { month: "short", day: "numeric" });
    return { index, label };
  });

  const indexFromPointer = (clientX: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return null;
    const viewX = ((clientX - rect.left) / rect.width) * width;
    if (viewX < margin.left || viewX > width - margin.right) return null;
    if (buckets.length === 1) return 0;
    return Math.max(0, Math.min(buckets.length - 1, Math.round(((viewX - margin.left) / plotW) * (buckets.length - 1))));
  };

  /// Arrow keys walk the read-out point; Home/End jump to the edges. Returns
  /// false for keys the chart does not consume.
  const moveReadout = (key: string): boolean => {
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return false;
    setReadout((current) => {
      if (key === "Home") return 0;
      if (key === "End") return buckets.length - 1;
      const base = current ?? (key === "ArrowLeft" ? buckets.length : -1);
      return Math.max(0, Math.min(buckets.length - 1, base + (key === "ArrowRight" ? 1 : -1)));
    });
    return true;
  };

  const active = readout !== null && readout < buckets.length ? readout : null;
  const hourLabel = (index: number): string =>
    new Date(buckets[index]!.hourStart).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const summary = (index: number): string =>
    `${hourLabel(index)}: ${series
      .map((entry) => {
        const value = entry.values[index];
        return `${entry.label} ${value === null || value === undefined ? "no data" : formatValue(value)}`;
      })
      .join(", ")}`;

  return (
    <div className="graph" data-testid="hourly-graph">
      {hasTokens && (
        <div className="range-toggle graph-mode" role="group" aria-label="Chart measure">
          {(["time", "tokens"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={measure === value ? "is-active" : undefined}
              onClick={() => setMeasure(value)}
            >
              {value === "time" ? "Time" : "Tokens"}
            </button>
          ))}
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={measure === "tokens" ? "Hourly token usage" : "Hourly active and agent time"}
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
        <defs>
          {series.map((entry) => (
            <linearGradient key={entry.id} id={`hourly-graph-fill-${entry.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={entry.color} stopOpacity="0.16" />
              <stop offset="1" stopColor={entry.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
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
                {formatValue(value)}
              </text>
            </g>
          );
        })}
        {xTicks.map(({ index, label }) => (
          <text key={index} x={x(index)} y={height - 6} fill="var(--chart-axis)" fontSize="9" textAnchor="middle">{label}</text>
        ))}
        {series.map((entry) =>
          runs(entry.values)
            .filter((run) => run.end > run.start)
            .map((run) => (
              <path key={`${entry.id}-${run.start}`} d={areaPath(entry.values, run)} fill={`url(#hourly-graph-fill-${entry.id})`} stroke="none" />
            )),
        )}
        {active !== null && (
          <line x1={x(active)} y1={margin.top} x2={x(active)} y2={margin.top + plotH} stroke="var(--chart-grid)" />
        )}
        {series.map((entry) => (
          <path
            key={entry.id}
            data-series={entry.id}
            d={linePath(entry.values)}
            fill="none"
            stroke={entry.color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {series.map((entry) =>
          entry.values.map((value, index) => {
            if (value === null) return null;
            if (!showEveryPoint && !isExtremum(entry.values, index) && index !== active) return null;
            return (
              <circle
                key={`${entry.id}-${index}`}
                data-point={entry.id}
                cx={x(index)}
                cy={y(value)}
                r={index === active ? 3.5 : 2}
                fill="var(--chart-point)"
                stroke={entry.color}
                strokeWidth="1.5"
              />
            );
          }),
        )}
      </svg>
      {active !== null && (
        <ChartTooltip
          left={(x(active) / width) * 100}
          title={hourLabel(active)}
          rows={series.map((entry) => {
            const value = entry.values[active];
            return { color: entry.color, label: entry.label, value: value === null || value === undefined ? "-" : formatValue(value) };
          })}
        />
      )}
      <p className="visually-hidden" role="status">{active === null ? "" : summary(active)}</p>
      <ul className="legend">
        {series.map((entry) => (
          <li key={entry.id}><span className="legend-line" style={{ background: entry.color }} aria-hidden="true" />{entry.label}</li>
        ))}
      </ul>
      {/* Named only while the token series is on screen: ambient, the note
          repeated under every graph on the page and read as a standing
          warning about nothing the viewer was looking at. */}
      {measure === "tokens" && tokenBlind.length > 0 && (
        <p className="graph-note">No token data from {tokenBlind.join(", ")}.</p>
      )}
    </div>
  );
};

/** One foreground process' total, the shape both stats responses report. */
export type AppDuration = { processName: string; durationSeconds: number };

/** The instant bounds a range resolves to; absent means "everything". */
export type RangeBounds = { fromAt: string; toExclusiveAt: string };

const TOP_APP_ROWS = 8;

/** One row of the All-stats app list. */
export type AppRow = {
  key: string;
  label: string;
  durationSeconds: number;
  agent: boolean;
};

/// Heaviest-first app rows for the All-stats breakdown: agent CLIs fold into
/// one row that never folds further into "Everything else" (so the agent
/// runtimes stay visible), and everything else past the top rows folds into
/// "Everything else". Which executables count as an agent comes from the
/// shared runtime roster, so a newly declared CLI folds in without a second
/// list to remember.
export const buildAppRows = (apps: readonly AppDuration[]): AppRow[] => {
  let agentSeconds = 0;
  const agentSources = new Set<string>();
  const rows: AppRow[] = [];
  for (const app of apps) {
    const agentSource = agentRuntimeForBinary(app.processName);
    if (agentSource !== undefined) {
      agentSeconds += app.durationSeconds;
      agentSources.add(agentSource);
      continue;
    }
    rows.push({ key: app.processName, label: friendlyAppName(app.processName), durationSeconds: app.durationSeconds, agent: false });
  }
  if (agentSeconds > 0) {
    const sources = [...agentSources];
    rows.push({
      key: "agent-clis",
      label: sources.length === 1 ? agentRuntimeLabel(sources[0] ?? "") : "Agent CLIs",
      durationSeconds: agentSeconds,
      agent: true,
    });
  }
  rows.sort((a, b) => b.durationSeconds - a.durationSeconds || a.label.localeCompare(b.label));
  if (rows.length <= TOP_APP_ROWS) return rows;
  // The agent row never folds into the tail: the fold would hide the agent
  // runtimes inside "Everything else".
  const kept = [...rows.slice(0, TOP_APP_ROWS), ...rows.slice(TOP_APP_ROWS).filter((row) => row.agent)];
  const rest = rows.slice(TOP_APP_ROWS).filter((row) => !row.agent)
    .reduce((sum, row) => sum + row.durationSeconds, 0);
  if (rest === 0) return kept;
  return [...kept, { key: "everything-else", label: "Everything else", durationSeconds: rest, agent: false }];
};

/// One app's share of the day, as the Today surface renders it.
export type MeterRow = {
  key: string;
  label: string;
  /// The agent runtime this executable belongs to, when it is one. Drives the
  /// runtime mark, and is how a CLI gets called "Claude Code" rather than
  /// "Claude.exe".
  source: string | undefined;
  /// The executable behind the row, for the OS icon lookup. Absent on the
  /// folded "Everything else" row.
  processName: string | undefined;
  /// Extra words beside the name - the folder an agent session is working in.
  detail?: string | undefined;
  durationSeconds: number;
  /// Percentage of the longest row, for the bar in the row.
  share: number;
};

/// Turns per-app seconds into meter rows. Agent CLIs keep their own row rather
/// than folding into one: which tool the time went to is the whole question
/// this surface answers. Everything past the top rows folds into one.
export const buildMeterRows = (apps: readonly AppDuration[]): MeterRow[] => {
  const longest = apps.reduce((most, app) => Math.max(most, app.durationSeconds), 0);
  const share = (durationSeconds: number): number =>
    longest === 0 ? 0 : Math.round((durationSeconds / longest) * 100);
  const rows = apps
    .filter((app) => app.durationSeconds > 0)
    .map((app) => {
      const source = agentRuntimeForBinary(app.processName);
      return {
        key: app.processName,
        label: source === undefined ? friendlyAppName(app.processName) : agentRuntimeLabel(source),
        source,
        processName: app.processName,
        durationSeconds: app.durationSeconds,
        share: share(app.durationSeconds),
      };
    })
    .sort((a, b) => b.durationSeconds - a.durationSeconds || a.label.localeCompare(b.label));
  if (rows.length <= TOP_APP_ROWS) return rows;
  const rest = rows.slice(TOP_APP_ROWS).reduce((sum, row) => sum + row.durationSeconds, 0);
  return [...rows.slice(0, TOP_APP_ROWS), {
    key: "everything-else",
    label: "Everything else",
    source: undefined,
    processName: undefined,
    durationSeconds: rest,
    share: share(rest),
  }];
};

/**
 * One `.meter-row`: the four-cell scan line the Today card reads a breakdown
 * in - a mark, the name with its optional `·` subtitle, a measure, and the
 * duration.
 *
 * `measure` replaces the share bar in the third cell. The desktop hands it the
 * plan dial for a runtime that bills against one, because "how much of my plan
 * is left" is a different question than "what share of the day was this"; the
 * web has no plan reading to put there and keeps the bar.
 */
export const MeterRowItem = ({
  row,
  measure,
  iconUrl,
}: {
  row: MeterRow;
  measure?: ReactNode;
  /// A data URL for the OS icon of `row.processName`, when the host could read
  /// one. The browser has no such lookup, so the web always draws the placeholder.
  iconUrl?: string | null | undefined;
}) => (
  <li className="meter-row">
    {row.source !== undefined
      ? <AgentRuntimeIcon source={row.source} />
      : iconUrl != null
        ? <img className="app-mark" src={iconUrl} alt="" />
        : <span className="app-mark is-plain" aria-hidden="true" />}
    <span className="meter-name">
      {row.label}
      {row.detail !== undefined && <span className="meter-detail"> · {row.detail}</span>}
    </span>
    {measure ?? (
      <span
        className="meter-bar"
        aria-hidden="true"
        style={{ "--share": `${row.share}%` } as CSSProperties}
      />
    )}
    <span className="meter-duration">
      {/* "connected", not "working": a zero-second agent row exists because
          the tool registered a session, which is not the same as it having
          done anything yet. */}
      {row.durationSeconds === 0 && row.source !== undefined
        ? <span className="app-active">connected</span>
        : formatHumanDuration(row.durationSeconds)}
    </span>
  </li>
);

/** A shift as both Agents tabs render it. */
export type ShiftRow = {
  id: string;
  source: string;
  owner: { name: string };
  model: string | null;
  startedAt: string;
  endedAt: string;
  agentSeconds: number;
  commitCount: number;
};

/** One codebase's shifts, as both Agents tabs render them. */
export type ShiftGroup = {
  repo: string | null;
  agentSeconds: number;
  shiftCount: number;
  heldRate: number | null;
  shifts: readonly ShiftRow[];
};

/// A shift's start, short enough for a row: a same-day shift shows only its
/// time, anything older leads with its date.
export const shiftClock = (startedAt: string): string => {
  const at = new Date(startedAt);
  const now = new Date();
  const sameDay = at.getFullYear() === now.getFullYear()
    && at.getMonth() === now.getMonth()
    && at.getDate() === now.getDate();
  return sameDay
    ? at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/**
 * The Agents tab's map: one collapsible group per codebase, its shifts inside.
 *
 * The head reads in the shared meter row - mark, name, a bar of this
 * codebase's share of the recorded agent time, duration - so a column of
 * codebases scans the way a column of apps does. The held share appears only
 * once a commit is decided: a rate with no decided commits is not a fact, so
 * the head says nothing instead. A drawer, because a busy week runs to
 * hundreds of shifts; the head stays exactly four cells, since a disclosure
 * glyph added as a fifth child of the four-track grid would wrap onto an
 * implicit second row and double its height. Open state is left to the DOM:
 * the keys are stable, so a viewer's open drawers survive a refetch.
 */
export const ShiftGroups = ({
  groups,
  totalAgentSeconds,
}: {
  groups: readonly ShiftGroup[];
  totalAgentSeconds: number;
}) => (
  <>
    {groups.map((group) => (
      <details className="shift-group" key={group.repo ?? ""} data-testid="shift-group">
        <summary className="meter-row shift-group-head">
          <span className="project-dot" aria-hidden="true" />
          <span className="meter-name">
            {group.repo ?? "No codebase recorded"}
            {group.heldRate !== null && <span className="meter-detail held-tag"> · {Math.round(group.heldRate * 100)}% held</span>}
            <span className="meter-detail"> · {group.shiftCount} shift{group.shiftCount === 1 ? "" : "s"}</span>
          </span>
          <span
            className="meter-bar"
            aria-hidden="true"
            style={{ "--share": `${totalAgentSeconds === 0 ? 0 : Math.round((group.agentSeconds / totalAgentSeconds) * 100)}%` } as CSSProperties}
          />
          <span className="meter-duration">{formatHumanDuration(group.agentSeconds)}</span>
        </summary>
        <ul className="shift-list">
          {group.shifts.map((shift) => (
            <li key={shift.id} className="shift-row">
              <span className="shift-when">{shiftClock(shift.startedAt)}</span>
              <span className="shift-facts">
                {agentRuntimeLabel(shift.source)}
                {` · ${shift.owner.name}`}
                {shift.model !== null && ` · ${shift.model}`}
                {shift.commitCount > 0 && ` · ${shift.commitCount} commit${shift.commitCount === 1 ? "" : "s"}`}
              </span>
              <span className="shift-duration">{formatHumanDuration(shift.agentSeconds)}</span>
            </li>
          ))}
        </ul>
      </details>
    ))}
  </>
);

/// The Agents tab's hourly series, folded client-side from the very shifts on
/// screen so the line and the list can never disagree. Per-hour resolution
/// over an unbounded range is meaningless and the fold would grow with the
/// workspace's whole history, so an unbounded range - the Humans tab's
/// server-computed series declines the same way - yields no graph at all.
/// Token counters read null because this series measures time alone.
export const hourlyFromShifts = (
  groups: readonly ShiftGroup[],
  bounds: RangeBounds | undefined,
): readonly ChartHourlyBucket[] => {
  if (bounds === undefined) return [];
  const seconds = new Map<number, number>();
  for (const group of groups) {
    for (const shift of group.shifts) {
      const start = Date.parse(shift.startedAt);
      const end = Date.parse(shift.endedAt);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      for (let hour = Math.floor(start / 3_600_000) * 3_600_000; hour < end; hour += 3_600_000) {
        const overlap = Math.min(end, hour + 3_600_000) - Math.max(start, hour);
        if (overlap > 0) seconds.set(hour, (seconds.get(hour) ?? 0) + Math.round(overlap / 1_000));
      }
    }
  }
  if (seconds.size === 0) return [];
  // A contiguous axis from the range's start onward, zeros included, so quiet
  // hours read as quiet rather than vanishing.
  const first = Math.floor(Date.parse(bounds.fromAt) / 3_600_000) * 3_600_000;
  const last = Math.max(...seconds.keys());
  const buckets: ChartHourlyBucket[] = [];
  for (let hour = first; hour <= last; hour += 3_600_000) {
    buckets.push({
      hourStart: new Date(hour).toISOString(),
      activeSeconds: 0,
      agentSeconds: seconds.get(hour) ?? 0,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
  }
  return buckets;
};
