import { useId, type CSSProperties } from "react";

import { AgentRuntimeIcon } from "./agent-marks.js";
import { agentRuntimeLabel } from "./agent-runtimes.js";
import { formatCount, formatTokens } from "./format.js";
import { TeamTotals } from "./team-totals.js";
import { formatHumanDuration } from "./time.js";
import {
  HourlyGraph,
  LiveSessions,
  ShiftGroups,
  TokenBarChart,
  type ChartHourlyBucket,
  type ChartTokens,
  type LivePersonGroup,
  type ShiftCursor,
  type ShiftGroup,
  type ShiftPage,
} from "./ui.js";

/** One agent runtime's share of the range, as the Agents page lists it. */
export type AgentsViewRuntime = {
  source: string;
  agentSeconds: number;
  shiftCount: number;
  /** Absent from an API that sends no tokens. */
  tokens?: number | undefined;
};

export type AgentsViewProps = {
  totalAgentSeconds: number;
  /** Absent from an API that sends no tokens. */
  tokenTotals: { tokensIn: number; tokensOut: number; tokens: number } | undefined;
  hourly: readonly ChartHourlyBucket[];
  tokenChart: ChartTokens | undefined;
  groups: readonly ShiftGroup[];
  /** Absent from an API older than the list, which draws no Agents card rather than an empty one. */
  runtimes: readonly AgentsViewRuntime[] | undefined;
  loadShifts: (groupKey: string, after: ShiftCursor | null) => Promise<ShiftPage>;
  /** Who is running an agent now; undefined until the first read lands. */
  livePeople: readonly LivePersonGroup[] | undefined;
  isLiveFailed: boolean;
};

const DAY_SECONDS = 86_400;

const byTokens = <Row extends { tokens?: number | undefined; agentSeconds: number }>(a: Row, b: Row): number =>
  (b.tokens ?? 0) - (a.tokens ?? 0) || b.agentSeconds - a.agentSeconds;

/**
 * The team view's Agents page, on the Humans page's layout: the totals, the
 * chart, then the repos ranked on the left and the agents used on the right,
 * with who is running one now under them.
 *
 * The server sends aggregates only. The repos rank by tokens when the server
 * sent them, the label-less group staying last as it is on the server, and in
 * the server's order of agent time otherwise; a drawer reads its shifts a page
 * at a time when it is opened. Like the Humans page, it draws the numbers it
 * is handed under a head the caller draws.
 */
export const AgentsView = ({
  totalAgentSeconds,
  tokenTotals,
  hourly,
  tokenChart,
  groups,
  runtimes,
  loadShifts,
  livePeople,
  isLiveFailed,
}: AgentsViewProps) => {
  const chartTitleId = useId();
  const reposTitleId = useId();
  const runtimesTitleId = useId();
  const liveTitleId = useId();
  const hasTokens = tokenTotals !== undefined;
  const rankedGroups = hasTokens
    ? [...groups].sort((a, b) => Number(a.repo === null) - Number(b.repo === null) || byTokens(a, b))
    : groups;
  const rankedRuntimes = runtimes === undefined || !hasTokens ? runtimes ?? [] : [...runtimes].sort(byTokens);
  const largestRuntime = rankedRuntimes.reduce(
    (most, runtime) => Math.max(most, hasTokens ? runtime.tokens ?? 0 : runtime.agentSeconds),
    0,
  );
  const runningCount = livePeople?.reduce((sum, person) => sum + person.sessions.length, 0) ?? 0;
  const hasTokenBars = tokenChart !== undefined && tokenChart.buckets.length > 0;
  return (
    <>
      <TeamTotals
        label="Totals"
        totals={[
          tokenTotals === undefined
            ? { label: "Tokens", value: "-", note: "not reported", isAgent: true }
            : {
              label: "Tokens",
              value: formatTokens(tokenTotals.tokens),
              note: `${formatTokens(tokenTotals.tokensIn)} in · ${formatTokens(tokenTotals.tokensOut)} out`,
              isAgent: true,
              title: `${formatCount(tokenTotals.tokens)} tokens`,
            },
          { label: "Agent time", value: formatHumanDuration(totalAgentSeconds), note: "agents running" },
          { label: "Shifts", value: formatCount(groups.reduce((sum, group) => sum + group.shiftCount, 0)), note: "agent work sessions" },
          { label: "Repos", value: formatCount(groups.filter((group) => group.repo !== null).length), note: "with agent work" },
        ]}
      />
      {(hasTokenBars || hourly.length > 0) && (
        <section className="tv-card tv-chart" aria-labelledby={chartTitleId}>
          <div className="tv-card-head">
            <h4 id={chartTitleId}>Over time</h4>
          </div>
          {hasTokenBars ? (
            <>
              <TokenBarChart chart={tokenChart} />
              <p className="tv-card-foot">Tokens in and out. Each bar is one {tokenChart.bucketSeconds >= DAY_SECONDS ? "day" : "hour"}.</p>
            </>
          ) : (
            <>
              <HourlyGraph buckets={hourly} />
              <p className="tv-card-foot">Each point is one hour.</p>
            </>
          )}
        </section>
      )}
      <div className="tv-grid">
        <section className="tv-card tv-repos" aria-labelledby={reposTitleId}>
          <div className="tv-card-head">
            <h4 id={reposTitleId}>Repos</h4>
            <span className="tv-card-note">{hasTokens ? "Ranked by tokens" : "Ranked by agent time"}</span>
          </div>
          {rankedGroups.length === 0 ? (
            <p className="subtle">No agent worked in this range.</p>
          ) : (
            <>
              <div className="tv-cols" aria-hidden="true">
                <span />
                <span />
                <span className="is-left">Repo</span>
                <span>Tokens</span>
                <span>Agent time</span>
                <span />
              </div>
              <ShiftGroups groups={rankedGroups} loadShifts={loadShifts} />
              <p className="tv-card-foot">Open a repo to see its shifts.</p>
            </>
          )}
        </section>
        <div className="tv-stack">
          {runtimes !== undefined && <section className="tv-card tv-runtimes" aria-labelledby={runtimesTitleId}>
            <div className="tv-card-head">
              <h4 id={runtimesTitleId}>Agents</h4>
              <span className="tv-card-note">{hasTokens ? "Ranked by tokens" : "Ranked by agent time"}</span>
            </div>
            {rankedRuntimes.length === 0 ? (
              <p className="subtle">No agent worked in this range.</p>
            ) : (
              <>
                <div className="tv-cols" aria-hidden="true">
                  <span />
                  <span className="is-left">Agent</span>
                  <span />
                  <span>Tokens</span>
                  <span>Agent time</span>
                </div>
                <ul>
                  {rankedRuntimes.map((runtime) => {
                    const measure = hasTokens ? runtime.tokens ?? 0 : runtime.agentSeconds;
                    const share = largestRuntime === 0 ? 0 : Math.round((measure / largestRuntime) * 100);
                    return (
                      <li key={runtime.source} className="tv-row">
                        <AgentRuntimeIcon source={runtime.source} />
                        <span className="tv-name">
                          <span>{agentRuntimeLabel(runtime.source)}</span>
                          <span className="tv-sub">{formatCount(runtime.shiftCount)} shift{runtime.shiftCount === 1 ? "" : "s"}</span>
                        </span>
                        <span className="tv-bar" aria-hidden="true" style={{ "--share": `${share}%` } as CSSProperties} />
                        <span className="tv-num" title={runtime.tokens === undefined ? undefined : `${formatCount(runtime.tokens)} tokens`}>
                          {runtime.tokens === undefined ? "-" : formatTokens(runtime.tokens)}
                        </span>
                        <span className="tv-num is-agent">{formatHumanDuration(runtime.agentSeconds)}</span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>}
          <section className="tv-card tv-live" aria-labelledby={liveTitleId}>
            <div className="tv-card-head">
              <h4 id={liveTitleId}><span className="live-pulse" aria-hidden="true" />Live now</h4>
              {runningCount > 0 && <span className="tv-card-note">{formatCount(runningCount)} running</span>}
            </div>
            {isLiveFailed ? (
              <p className="subtle">Could not tell who is running an agent right now.</p>
            ) : livePeople === undefined ? (
              <p className="subtle" role="status">Checking what is running…</p>
            ) : (
              <LiveSessions people={livePeople} />
            )}
          </section>
        </div>
      </div>
    </>
  );
};
