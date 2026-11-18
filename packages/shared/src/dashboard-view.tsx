import { useId, type CSSProperties, type ReactNode } from "react";

import { AgentRuntimeIcon } from "./agent-marks.js";
import { agentRuntimeLabel } from "./agent-runtimes.js";
import { formatCount, formatTokens } from "./format.js";
import { MemberAvatar } from "./member-avatar.js";
import { projectAppearance, type ProjectAppearance } from "./project-appearance.js";
import { ProjectIconTile } from "./project-icon-tile.js";
import { TeamTotals } from "./team-totals.js";
import { formatHumanDuration } from "./time.js";
import {
  LiveSessions,
  MeterRowItem,
  ShiftGroups,
  type AppRow,
  type ChartHourlyBucket,
  type ConcurrencySplit,
  type LivePersonGroup,
  type MeterRow,
  type ShiftCursor,
  type ShiftGroup,
  type ShiftPage,
} from "./ui.js";
import { WorkChart, type ChartTokens } from "./work-chart.js";

export { TeamTotals, type TeamTotal } from "./team-totals.js";
export { TeamViewHead } from "./team-view-head.js";
export { WorkChart, type ChartTokenBucket, type ChartTokens } from "./work-chart.js";
export { DashboardFilter, dayBounds, localDay, type DashboardDays, type DashboardFilterProject } from "./dashboard-filter.js";

/**
 * The dashboard: one page, no tabs, where every stat is drawn once. Both apps
 * open it from All stats and the home page draws it as its example workspace,
 * so the product looks like what the home page promises and the copies cannot
 * drift.
 *
 * The page answers for one subject at a time - the whole team, or the one
 * person picked on the People board - and every card follows it: the four
 * totals (tokens, active time, agent time, recorded time), the one chart, the
 * projects, the agents, the repos and who is running one now. The board is the
 * picker, so it stays the whole team's and is drawn only when there are two or
 * more people to pick between; in a workspace of one the person is the team.
 * A person also gets the two cards only a person has: their active time split
 * by agents running, and the apps it was spent in.
 *
 * It draws the numbers it is handed and adds nothing up: the apps pass the
 * server's reports, the home page its illustrative data. Its parts are the
 * children of a `.tv` box the caller draws, under the `TeamViewHead` the caller
 * also draws, so the head and its controls stay put while a read lands. The
 * `.tv` rules in `styles/brand.css` lay it out by its own width.
 *
 * Its own entry rather than part of `./ui`, which it imports: re-exported from
 * there, the two modules would import each other.
 */

/** One board row. */
export type DashboardPerson = {
  id: string;
  rank: number;
  name: string;
  /** The member's picture as a data URL; their initials stand in without one. */
  picture?: string | undefined;
  /** The project this member spent most time on, or null when none had any. */
  project: { name: string; appearance: ProjectAppearance } | null;
  activeSeconds: number;
  agentSeconds: number;
  isSelf: boolean;
};

/** Tokens over the range, as the server totals them. */
export type DashboardTokens = { tokensIn: number; tokensOut: number; tokens: number };

/** One agent runtime's share of the range. */
export type DashboardRuntime = {
  source: string;
  agentSeconds: number;
  shiftCount: number;
  /** Absent from an API that sends no tokens. */
  tokens?: number | undefined;
};

/** What the agents' own read says about the subject; the apps pass it once it lands. */
export type DashboardAgents = {
  /** Absent from an API that reads no token usage. */
  tokenTotals: DashboardTokens | undefined;
  tokenChart: ChartTokens | undefined;
  /** Absent from an API older than the list, which draws no Agents card rather than an empty one. */
  runtimes: readonly DashboardRuntime[] | undefined;
  /** The codebases the subject's agents worked; absent where nothing can open a drawer, as on the home page. */
  repos?: {
    groups: readonly ShiftGroup[];
    loadShifts: (groupKey: string, after: ShiftCursor | null) => Promise<ShiftPage>;
  } | undefined;
};

/** The person the page answers for, with the two numbers only a person's own read carries. */
export type DashboardSubject = {
  id: string;
  name: string;
  picture?: string | undefined;
  isSelf: boolean;
};

export type DashboardViewProps = {
  /** Who the page answers for: undefined is the whole team. */
  subject: DashboardSubject | undefined;
  /** The subject's measured time: undefined while its read is on the way, a sentence when it failed. */
  time: {
    activeSeconds: number;
    agentSeconds: number;
    recordedSeconds: number;
    hourly: readonly ChartHourlyBucket[];
    projectRows: readonly MeterRow[];
    /** A person's active time split by agents running; the team has none. */
    split?: ConcurrencySplit | undefined;
    /** What recorded is made of beyond active time, from `recordedBasis`. */
    recordedNote?: string | null | undefined;
    /** A person's apps; the team has none. */
    appRows?: readonly AppRow[] | undefined;
  } | string | undefined;
  /** The agents' read for the same subject and range: undefined while it loads, a sentence when it failed. */
  agents: DashboardAgents | string | undefined;
  /** The whole team's board, which is also how a person is picked. */
  people: readonly DashboardPerson[];
  /** Beside the board's title: how it is ordered, or the control that orders it. */
  boardTool: ReactNode;
  onSelectPerson: (person: DashboardPerson | undefined) => void;
  /** Lines under the board. */
  boardNotes: readonly string[];
  /** Who is running an agent now, already narrowed to the subject; absent where nothing reads it. */
  live?: { people: readonly LivePersonGroup[] | undefined; isFailed: boolean } | undefined;
};

/** Why a project can hold more time than the Active time total above it. */
export const RECORDED_TIME_NOTE = "Recorded time counts whole sessions, quiet minutes included. Active time counts only minutes at the computer, so a project can show more than the Active time total.";

const LOADING = "…";

/** Breakdown rows, each bar a share of its own list's longest row. */
const shareRows = (rows: readonly Omit<MeterRow, "share">[]): MeterRow[] => {
  const longest = rows.reduce((most, row) => Math.max(most, row.durationSeconds), 0);
  return rows.map((row) => ({ ...row, share: longest === 0 ? 0 : Math.round((row.durationSeconds / longest) * 100) }));
};

/** A project as a report names it, with the icon and color a server that predates them leaves out. */
type ReportedProject = { id: string; name: string; icon?: string | null | undefined; color?: string | null | undefined };

/** A project from the caller's own project list, which knows whether it is the workspace's default. */
type ListedProject = { id: string; isDefault: boolean; icon?: string | null | undefined; color?: string | null | undefined };

/**
 * The icon and color a project wears on the dashboard: the pair the workspace
 * report gives it, else the pair the caller's own project list gives it, else
 * the pair its id assigns. The report is read with the view, so where it lists
 * the project the whole view agrees on one pair. The caller's list covers what
 * it does not list yet - the open stretch's project before it uploads, or any
 * project while the report loads - and says which project is the default, so
 * the default still wears its own pair and a picked pair is never swapped for
 * one the id would assign.
 */
export const reportedAppearance = (
  projects: readonly { project: ReportedProject }[],
  listed: readonly ListedProject[],
  projectId: string,
): ProjectAppearance => {
  const own = listed.find((project) => project.id === projectId);
  const resolved = projects.find((entry) => entry.project.id === projectId)?.project ?? own;
  return projectAppearance({ id: projectId, isDefault: own?.isDefault ?? false, icon: resolved?.icon, color: resolved?.color });
};

/** Recorded time per project as meter rows, in the order given, each wearing the appearance `appearanceOf` names. */
export const projectMeterRows = (
  projects: readonly { project: { id: string; name: string }; durationSeconds: number }[],
  appearanceOf: (projectId: string) => ProjectAppearance,
): MeterRow[] => shareRows(projects.map((entry) => ({
  key: entry.project.id,
  label: entry.project.name,
  source: undefined,
  processNames: [],
  appearance: appearanceOf(entry.project.id),
  durationSeconds: entry.durationSeconds,
})));

const SPLIT_ROWS = [
  { key: "t0Seconds", label: "No agent running", level: 0 },
  { key: "t1Seconds", label: "With 1 agent", level: 1 },
  { key: "t2Seconds", label: "With 2 agents", level: 2 },
  { key: "t3PlusSeconds", label: "With 3+ agents", level: 3 },
] as const;

const byTokens = <Row extends { tokens?: number | undefined; agentSeconds: number }>(a: Row, b: Row): number =>
  (b.tokens ?? 0) - (a.tokens ?? 0) || b.agentSeconds - a.agentSeconds;

const share = (value: number, largest: number): CSSProperties =>
  ({ "--share": `${largest === 0 ? 0 : Math.round((value / largest) * 100)}%` }) as CSSProperties;

export const DashboardView = ({
  subject,
  time: timeRead,
  agents,
  people,
  boardTool,
  onSelectPerson,
  boardNotes,
  live,
}: DashboardViewProps) => {
  const chartTitleId = useId();
  const boardTitleId = useId();
  const splitTitleId = useId();
  const projectsTitleId = useId();
  const appsTitleId = useId();
  const runtimesTitleId = useId();
  const reposTitleId = useId();
  const liveTitleId = useId();

  const time = typeof timeRead === "object" ? timeRead : undefined;
  const timeFailure = typeof timeRead === "string" ? timeRead : undefined;
  const timeFigure = (seconds: number | undefined): string =>
    seconds !== undefined ? formatHumanDuration(seconds) : timeFailure === undefined ? LOADING : "-";
  const agentRead = typeof agents === "object" ? agents : undefined;
  const agentsFailure = typeof agents === "string" ? agents : undefined;
  const tokenTotals = agentRead?.tokenTotals;
  const hasTokens = tokenTotals !== undefined;
  const tokenChart = agentRead?.tokenChart;
  const hasTokenBars = tokenChart !== undefined && tokenChart.buckets.some((bucket) => (bucket.tokens ?? 0) > 0);
  const hourly = time?.hourly ?? [];
  const hasHourly = hourly.length > 0;
  const runtimes = agentRead?.runtimes === undefined || !hasTokens ? agentRead?.runtimes : [...agentRead.runtimes].sort(byTokens);
  const largestRuntime = (runtimes ?? []).reduce(
    (most, runtime) => Math.max(most, hasTokens ? runtime.tokens ?? 0 : runtime.agentSeconds),
    0,
  );
  const repos = agentRead?.repos;
  const rankedGroups = repos === undefined
    ? []
    : hasTokens
      ? [...repos.groups].sort((a, b) => Number(a.repo === null) - Number(b.repo === null) || byTokens(a, b))
      : repos.groups;
  const runningCount = live?.people?.reduce((sum, person) => sum + person.sessions.length, 0) ?? 0;
  const isBoardShown = people.length > 1;
  const longestActive = people.reduce((most, person) => Math.max(most, person.activeSeconds), 0);
  const longestAgent = people.reduce((most, person) => Math.max(most, person.agentSeconds), 0);
  const appRows = time?.appRows ?? [];
  const longestApp = appRows.reduce((most, row) => Math.max(most, row.durationSeconds), 0);
  const ranked = hasTokens ? "Ranked by tokens" : "Ranked by agent time";
  const agentsPending = agentsFailure ?? "Loading…";

  return (
    <>
      {isBoardShown && subject !== undefined && (
        <div className="tv-subject">
          <MemberAvatar id={subject.id} name={subject.name} picture={subject.picture} />
          <span className="tv-subject-name">{subject.name}{subject.isSelf && <span className="tv-you">You</span>}</span>
          <button type="button" className="ghost" onClick={() => onSelectPerson(undefined)}>Everyone</button>
        </div>
      )}
      <TeamTotals
        label={subject === undefined ? "Totals" : `Totals for ${subject.name}`}
        totals={[
          agentRead === undefined
            ? { label: "Tokens", value: agentsFailure === undefined ? LOADING : "-", note: agentsFailure === undefined ? "loading" : "not loaded", isAgent: true }
            : tokenTotals === undefined
              ? { label: "Tokens", value: "-", note: "not reported", isAgent: true }
              : {
                label: "Tokens",
                value: formatTokens(tokenTotals.tokens),
                note: `${formatTokens(tokenTotals.tokensIn)} in · ${formatTokens(tokenTotals.tokensOut)} out`,
                isAgent: true,
                title: `${formatCount(tokenTotals.tokens)} tokens`,
              },
          { label: "Active time", value: timeFigure(time?.activeSeconds), note: "at the computer" },
          { label: "Agent time", value: timeFigure(time?.agentSeconds), note: "agents running", isAgent: true },
          { label: "Recorded time", value: timeFigure(time?.recordedSeconds), note: "whole sessions" },
        ]}
      />
      {timeFailure !== undefined && <p className="error" role="alert">{timeFailure}</p>}
      {time?.recordedNote != null && <p className="tv-totals-note">Recorded: {time.recordedNote}.</p>}

      {(hasHourly || hasTokenBars) && (
        <section className="tv-card tv-chart" aria-labelledby={chartTitleId}>
          <div className="tv-card-head">
            <h4 id={chartTitleId}>Over time</h4>
          </div>
          <WorkChart hourly={hourly} tokens={hasTokenBars ? tokenChart : undefined} />
        </section>
      )}

      <div className="tv-grid">
        <div className="tv-stack">
          {isBoardShown && (
            <section className="tv-card tv-people" aria-labelledby={boardTitleId}>
              <div className="tv-card-head">
                <h4 id={boardTitleId}>People</h4>
                {boardTool}
              </div>
              <table aria-labelledby={boardTitleId}>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Active time</th>
                    <th scope="col">Agent time</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((person) => {
                    const isPicked = person.id === subject?.id;
                    return (
                      <tr key={person.id} className={isPicked ? "is-selected" : undefined}>
                        <th scope="row">
                          <button
                            type="button"
                            aria-label={`Show ${person.name}'s work`}
                            aria-pressed={isPicked}
                            onClick={() => onSelectPerson(isPicked ? undefined : person)}
                          >
                            <span className="tv-rank">{person.rank}</span>
                            <MemberAvatar id={person.id} name={person.name} picture={person.picture} />
                            <span className="tv-name">
                              <span>{person.name}{person.isSelf && <span className="tv-you">You</span>}</span>
                              {person.project !== null && (
                                <span className="tv-sub">
                                  <ProjectIconTile appearance={person.project.appearance} />
                                  {person.project.name}
                                </span>
                              )}
                            </span>
                          </button>
                        </th>
                        <td>
                          {formatHumanDuration(person.activeSeconds)}
                          <span className="tv-cell-bar" aria-hidden="true" style={share(person.activeSeconds, longestActive)} />
                        </td>
                        <td className="is-agent">
                          {formatHumanDuration(person.agentSeconds)}
                          <span className="tv-cell-bar" aria-hidden="true" style={share(person.agentSeconds, longestAgent)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {boardNotes.map((note) => <p key={note} className="tv-card-foot">{note}</p>)}
            </section>
          )}
          {!isBoardShown && boardNotes.map((note) => <p key={note} className="tv-foot">{note}</p>)}

          {time?.split !== undefined && time.activeSeconds > 0 && (
            <section className="tv-card tv-split" aria-labelledby={splitTitleId}>
              <div className="tv-card-head">
                <h4 id={splitTitleId}>Active time, by agents running</h4>
              </div>
              <ul className="tv-meter-list">
                {SPLIT_ROWS.filter((row) => row.level === 0 || time.split![row.key] > 0).map((row) => (
                  <li key={row.key} className="meter-row">
                    <span className="tv-swatch" data-level={row.level} aria-hidden="true" />
                    <span className="meter-name">{row.label}</span>
                    <span className="meter-bar" aria-hidden="true" style={share(time.split![row.key], time.activeSeconds)} />
                    <span className="meter-duration">{formatHumanDuration(time.split![row.key])}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {repos !== undefined && (
            <section className="tv-card tv-repos" aria-labelledby={reposTitleId}>
              <div className="tv-card-head">
                <h4 id={reposTitleId}>Repos</h4>
                <span className="tv-card-note">{ranked}</span>
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
                  <ShiftGroups groups={rankedGroups} loadShifts={repos.loadShifts} />
                  <p className="tv-card-foot">Open a repo to see its shifts.</p>
                </>
              )}
            </section>
          )}
          {agentRead === undefined && (
            <section className="tv-card tv-repos" aria-labelledby={reposTitleId}>
              <div className="tv-card-head">
                <h4 id={reposTitleId}>Repos</h4>
              </div>
              <p className="subtle" role={agentsFailure === undefined ? "status" : undefined}>{agentsPending}</p>
            </section>
          )}
        </div>

        <div className="tv-stack">
          <section className="tv-card tv-list" aria-labelledby={projectsTitleId}>
            <div className="tv-card-head">
              <h4 id={projectsTitleId}>Projects</h4>
              <span className="tv-card-note">Recorded time</span>
            </div>
            {time === undefined ? (
              <p className="subtle" role={timeFailure === undefined ? "status" : undefined}>{timeFailure === undefined ? "Loading…" : "Not loaded."}</p>
            ) : time.projectRows.length === 0 ? (
              <p className="subtle">Nothing recorded in this range.</p>
            ) : (
              <>
                <ul className="tv-meter-list">
                  {time.projectRows.map((row) => <MeterRowItem key={row.key} row={row} />)}
                </ul>
                <p className="tv-card-foot">{RECORDED_TIME_NOTE}</p>
              </>
            )}
          </section>

          {appRows.length > 0 && (
            <section className="tv-card tv-list tv-apps" aria-labelledby={appsTitleId}>
              <div className="tv-card-head">
                <h4 id={appsTitleId}>Apps</h4>
                <span className="tv-card-note">Time in front</span>
              </div>
              <ul className="tv-meter-list">
                {appRows.map((row) => (
                  <li key={row.key} className={row.agent ? "meter-row is-agent" : "meter-row"}>
                    <span className="meter-name">{row.label}</span>
                    <span className="meter-bar" aria-hidden="true" style={share(row.durationSeconds, longestApp)} />
                    <span className="meter-duration">{formatHumanDuration(row.durationSeconds)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {agentRead === undefined ? (
            <section className="tv-card tv-runtimes" aria-labelledby={runtimesTitleId}>
              <div className="tv-card-head">
                <h4 id={runtimesTitleId}>Agents</h4>
              </div>
              <p className="subtle" role={agentsFailure === undefined ? "status" : "alert"}>{agentsPending}</p>
            </section>
          ) : runtimes !== undefined && (
            <section className="tv-card tv-runtimes" aria-labelledby={runtimesTitleId}>
              <div className="tv-card-head">
                <h4 id={runtimesTitleId}>Agents</h4>
                <span className="tv-card-note">{ranked}</span>
              </div>
              {runtimes.length === 0 ? (
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
                    {runtimes.map((runtime) => (
                      <li key={runtime.source} className="tv-row">
                        <AgentRuntimeIcon source={runtime.source} />
                        <span className="tv-name">
                          <span>{agentRuntimeLabel(runtime.source)}</span>
                          <span className="tv-sub">{formatCount(runtime.shiftCount)} shift{runtime.shiftCount === 1 ? "" : "s"}</span>
                        </span>
                        <span className="tv-bar" aria-hidden="true" style={share(hasTokens ? runtime.tokens ?? 0 : runtime.agentSeconds, largestRuntime)} />
                        <span className="tv-num" title={runtime.tokens === undefined ? undefined : `${formatCount(runtime.tokens)} tokens`}>
                          {runtime.tokens === undefined ? "-" : formatTokens(runtime.tokens)}
                        </span>
                        <span className="tv-num is-agent">{formatHumanDuration(runtime.agentSeconds)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {live !== undefined && (
            <section className="tv-card tv-live" aria-labelledby={liveTitleId}>
              <div className="tv-card-head">
                <h4 id={liveTitleId}><span className="live-pulse" aria-hidden="true" />Live now</h4>
                {runningCount > 0 && <span className="tv-card-note">{formatCount(runningCount)} running</span>}
              </div>
              {live.isFailed ? (
                <p className="subtle">Could not tell who is running an agent right now.</p>
              ) : live.people === undefined ? (
                <p className="subtle" role="status">Checking what is running…</p>
              ) : (
                <LiveSessions people={live.people} />
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
};
