import { useId, useState, type ReactNode } from "react";

import { AgentRuntimeIcon } from "./agent-marks.js";
import { agentRuntimeLabel } from "./agent-runtimes.js";
import { formatHumanDuration } from "./time.js";
import { HourlyGraph, MeterRowItem, type ChartHourlyBucket, type MeterRow } from "./ui.js";

/**
 * The workspace view: the home page's example team workspace, and the team
 * view both apps open from All stats. One component draws all three, so the
 * product looks like what the home page promises and the copies cannot drift.
 *
 * It draws the numbers it is handed and adds nothing up: the apps pass the
 * server's workspace report, the home page its illustrative data. The
 * `.workspace` rules in `styles/brand.css` lay it out by its own width, since
 * it sits in a wide landing section, a full-window dialog and a 520px window.
 *
 * Its own entry rather than part of `./ui`, which it imports: re-exported from
 * there, the two modules would import each other.
 */

/** One leaderboard row. */
export type WorkspaceViewMember = {
  id: string;
  rank: number;
  name: string;
  /** The project this member spent most time on, or null when none had any. */
  project: string | null;
  activeSeconds: number;
  agentSeconds: number;
  isSelf: boolean;
};

/** One member the whole view is narrowed to, as the home page's example does on a click. */
export type WorkspaceFocus = {
  name: string;
  project: string | null;
  onClear: () => void;
};

export type WorkspaceViewProps = {
  workspaceName: string;
  logoUrl?: string;
  /** Words on the right of the app bar, such as "Example data". */
  badge?: string;
  periodLabel: string;
  focus?: WorkspaceFocus | undefined;
  activeSeconds: number;
  agentSeconds: number;
  hourly: readonly ChartHourlyBucket[];
  members: readonly WorkspaceViewMember[];
  /** The control beside the board's title: how it is ordered. */
  boardTool: ReactNode;
  selectedMemberId: string | undefined;
  onSelectMember: (member: WorkspaceViewMember) => void;
  /** Lines under the board. */
  boardNotes: readonly string[];
  projectRows: readonly MeterRow[];
  /** Agent rows; each `source` is also named in the footer. */
  agentRows: readonly MeterRow[];
  /** Image URLs for project rows, by row key. */
  projectIcons?: Readonly<Record<string, string>>;
};

const AVATAR_TONES = ["mint", "blue", "purple"] as const;

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");

const countOf = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** Breakdown rows, each bar a share of its own list's longest row. */
const shareRows = (rows: readonly Omit<MeterRow, "share">[]): MeterRow[] => {
  const longest = rows.reduce((most, row) => Math.max(most, row.durationSeconds), 0);
  return rows.map((row) => ({ ...row, share: longest === 0 ? 0 : Math.round((row.durationSeconds / longest) * 100) }));
};

/** A workspace report's two breakdowns as meter rows, in the order the report gives them. */
export const workspaceBreakdownRows = (report: {
  projects: readonly { project: { id: string; name: string }; durationSeconds: number }[];
  agents: readonly { source: string; durationSeconds: number }[];
}): { projectRows: MeterRow[]; agentRows: MeterRow[] } => ({
  projectRows: shareRows(report.projects.map((entry) => ({
    key: entry.project.id,
    label: entry.project.name,
    source: undefined,
    processName: undefined,
    durationSeconds: entry.durationSeconds,
  }))),
  agentRows: shareRows(report.agents.map((entry) => ({
    key: entry.source,
    label: agentRuntimeLabel(entry.source),
    source: entry.source,
    processName: undefined,
    durationSeconds: entry.durationSeconds,
  }))),
});

export const WorkspaceView = ({
  workspaceName,
  logoUrl,
  badge,
  periodLabel,
  focus,
  activeSeconds,
  agentSeconds,
  hourly,
  members,
  boardTool,
  selectedMemberId,
  onSelectMember,
  boardNotes,
  projectRows,
  agentRows,
  projectIcons,
}: WorkspaceViewProps) => {
  const [breakdown, setBreakdown] = useState<"projects" | "agents">("projects");
  const headlineId = useId();
  const boardTitleId = useId();
  const rows = breakdown === "projects" ? projectRows : agentRows;
  const runtimes = agentRows.flatMap((row) => (row.source === undefined ? [] : [row.source]));
  return (
    <section className="workspace card" aria-labelledby={headlineId}>
      <div className="workspace-app-bar">
        <span className="workspace-brand">
          {logoUrl !== undefined && <img src={logoUrl} alt="" width="28" height="28" />}
          <span className="workspace-name">{workspaceName}</span>
          <span className="workspace-label">Workspace</span>
        </span>
        {badge !== undefined && <span className="workspace-badge">{badge}</span>}
      </div>
      <div className="workspace-body">
        <div className="workspace-heading">
          <h3 id={headlineId}>{focus?.name ?? "Your team’s work, together."}</h3>
          <span>{periodLabel}</span>
        </div>
        <div className="workspace-scope">
          {focus === undefined ? (
            <span>{countOf(members.length, "person", "people")} across {countOf(projectRows.length, "project", "projects")}</span>
          ) : (
            <>
              {focus.project !== null && <span>{focus.project}</span>}
              <button type="button" onClick={focus.onClear}>All members ×</button>
            </>
          )}
        </div>
        <dl className="workspace-metrics">
          <div><dt>{focus === undefined ? "Team active hours" : "Active work hours"}</dt><dd>{formatHumanDuration(activeSeconds)}</dd></div>
          <div><dt>Agent runtime</dt><dd>{formatHumanDuration(agentSeconds)}</dd></div>
        </dl>
        <HourlyGraph buckets={hourly} personLabel={focus?.name ?? "Team"} />
        <div className="workspace-grid">
          <section className="workspace-leaderboard" aria-labelledby={boardTitleId}>
            <div className="workspace-panel-heading"><h4 id={boardTitleId}>Team leaderboard</h4>{boardTool}</div>
            <table aria-labelledby={boardTitleId}>
              <thead><tr><th scope="col">Member / project</th><th scope="col">Active</th><th scope="col">Agents</th></tr></thead>
              <tbody>{members.map((member, index) => (
                <tr key={member.id} className={member.id === selectedMemberId ? "is-selected" : undefined}>
                  <th scope="row">
                    <button
                      type="button"
                      aria-label={`Show ${member.name}'s work`}
                      aria-pressed={member.id === selectedMemberId}
                      onClick={() => onSelectMember(member)}
                    >
                      <span className="workspace-rank">{member.rank}</span>
                      <span className={`workspace-avatar ${AVATAR_TONES[index % AVATAR_TONES.length]}`} aria-hidden="true">{initialsOf(member.name)}</span>
                      <span className="workspace-person">
                        <span>{member.name}{member.isSelf && <span className="you-tag"> you</span>}</span>
                        {member.project !== null && <small>{member.project}</small>}
                      </span>
                    </button>
                  </th>
                  <td>{formatHumanDuration(member.activeSeconds)}</td>
                  <td>{formatHumanDuration(member.agentSeconds)}</td>
                </tr>
              ))}</tbody>
            </table>
            {boardNotes.map((note) => <p key={note} className="workspace-hint">{note}</p>)}
          </section>
          <section className="workspace-breakdown-panel" aria-label="Workspace breakdown">
            <div className="workspace-tabs" role="group" aria-label="Projects or agents">
              <button type="button" aria-pressed={breakdown === "projects"} onClick={() => setBreakdown("projects")}>Projects</button>
              <button type="button" aria-pressed={breakdown === "agents"} onClick={() => setBreakdown("agents")}>Agents</button>
            </div>
            <div className="workspace-breakdown" aria-live="polite">
              <p className="workspace-breakdown-title">{breakdown === "projects" ? "Active time by project" : "Runtime by agent"}</p>
              {rows.length === 0 ? (
                <p className="subtle">Nothing recorded in this range.</p>
              ) : (
                <ul className="workspace-meter-list">
                  {rows.map((row) => <MeterRowItem key={row.key} row={row} iconUrl={projectIcons?.[row.key]} />)}
                </ul>
              )}
            </div>
          </section>
        </div>
        {runtimes.length > 0 && (
          <div className="workspace-tools">
            <span>Local agents, shared visibility</span>
            {runtimes.map((source) => <span key={source}><AgentRuntimeIcon source={source} />{agentRuntimeLabel(source)}</span>)}
          </div>
        )}
      </div>
    </section>
  );
};
