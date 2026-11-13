import { useId, type ReactNode } from "react";

import { agentRuntimeLabel } from "./agent-runtimes.js";
import { formatCount } from "./format.js";
import { MemberAvatar } from "./member-avatar.js";
import { projectAppearance, type ProjectAppearance } from "./project-appearance.js";
import { ProjectIconTile } from "./project-icon-tile.js";
import { TeamTotals } from "./team-totals.js";
import { TimeChartCard } from "./time-chart-card.js";
import { formatHumanDuration } from "./time.js";
import { MeterRowItem, type ChartHourlyBucket, type MeterRow } from "./ui.js";

export { AgentsView, type AgentsViewProps } from "./agents-view.js";
export { TeamTotals, type TeamTotal } from "./team-totals.js";
export { TeamViewHead } from "./team-view-head.js";
export { TeamViewTabs, type TeamViewTab } from "./team-view-tabs.js";
export { TimeChartCard } from "./time-chart-card.js";

/**
 * The team view's Humans page: the home page's example team workspace, and
 * the page both apps open from All stats. One component draws all three, so
 * the product looks like what the home page promises and the copies cannot
 * drift. The Agents page, `AgentsView`, is drawn on the same layout.
 *
 * It draws the numbers it is handed and adds nothing up: the apps pass the
 * server's workspace report, the home page its illustrative data. Its parts
 * are the children of a `.tv` box the caller draws, under the `TeamViewHead`
 * the caller also draws, so the head and its controls stay put while a page
 * loads. The `.tv` rules in `styles/brand.css` lay it out by its own width,
 * since it sits in a wide landing section, a full-window dialog and a desktop
 * window.
 *
 * Its own entry rather than part of `./ui`, which it imports: re-exported from
 * there, the two modules would import each other.
 */

/** One board row. */
export type WorkspaceViewMember = {
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

export type WorkspaceViewProps = {
  activeSeconds: number;
  agentSeconds: number;
  hourly: readonly ChartHourlyBucket[];
  members: readonly WorkspaceViewMember[];
  /** Beside the board's title: how it is ordered, or the control that orders it. */
  boardTool: ReactNode;
  selectedMemberId: string | undefined;
  onSelectMember: (member: WorkspaceViewMember) => void;
  /** Lines under the board. */
  boardNotes: readonly string[];
  projectRows: readonly MeterRow[];
  agentRows: readonly MeterRow[];
};

/** Why a project can hold more time than the Active time total above it. */
export const RECORDED_TIME_NOTE = "Recorded time counts whole sessions, quiet minutes included. Active time counts only minutes at the computer, so a project can show more than the Active time total.";

/** Breakdown rows, each bar a share of its own list's longest row. */
const shareRows = (rows: readonly Omit<MeterRow, "share">[]): MeterRow[] => {
  const longest = rows.reduce((most, row) => Math.max(most, row.durationSeconds), 0);
  return rows.map((row) => ({ ...row, share: longest === 0 ? 0 : Math.round((row.durationSeconds / longest) * 100) }));
};

/** A project as a workspace report names it, with the icon and color a server that predates them leaves out. */
type ReportedProject = { id: string; name: string; icon?: string | null | undefined; color?: string | null | undefined };

/**
 * The icon and color a workspace report gives a project, or the pair its id
 * assigns when the report does not list it or predates them.
 */
export const reportedAppearance = (
  projects: readonly { project: ReportedProject }[],
  projectId: string,
): ProjectAppearance => {
  const reported = projects.find((entry) => entry.project.id === projectId)?.project;
  return projectAppearance({ id: projectId, isDefault: false, icon: reported?.icon, color: reported?.color });
};

/** A workspace report's two breakdowns as meter rows, in the order the report gives them. */
export const workspaceBreakdownRows = (report: {
  projects: readonly { project: ReportedProject; durationSeconds: number }[];
  agents: readonly { source: string; durationSeconds: number }[];
}): { projectRows: MeterRow[]; agentRows: MeterRow[] } => ({
  projectRows: shareRows(report.projects.map((entry) => ({
    key: entry.project.id,
    label: entry.project.name,
    source: undefined,
    processName: undefined,
    appearance: projectAppearance({ id: entry.project.id, isDefault: false, icon: entry.project.icon, color: entry.project.color }),
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
}: WorkspaceViewProps) => {
  const boardTitleId = useId();
  const projectsTitleId = useId();
  const agentsTitleId = useId();
  return (
    <>
      <TeamTotals
        label="Totals"
        totals={[
          { label: "Active time", value: formatHumanDuration(activeSeconds), note: "people at the computer" },
          { label: "Agent time", value: formatHumanDuration(agentSeconds), note: "agents running", isAgent: true },
          { label: "People", value: formatCount(members.length), note: "in this workspace" },
          { label: "Projects", value: formatCount(projectRows.length), note: "with recorded time" },
        ]}
      />
      <TimeChartCard buckets={hourly} />
      <div className="tv-grid">
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
              {members.map((member) => (
                <tr key={member.id} className={member.id === selectedMemberId ? "is-selected" : undefined}>
                  <th scope="row">
                    <button
                      type="button"
                      aria-label={`Show ${member.name}'s work`}
                      aria-pressed={member.id === selectedMemberId}
                      onClick={() => onSelectMember(member)}
                    >
                      <span className="tv-rank">{member.rank}</span>
                      <MemberAvatar id={member.id} name={member.name} picture={member.picture} />
                      <span className="tv-name">
                        <span>{member.name}{member.isSelf && <span className="tv-you">You</span>}</span>
                        {member.project !== null && (
                          <span className="tv-sub">
                            <ProjectIconTile appearance={member.project.appearance} />
                            {member.project.name}
                          </span>
                        )}
                      </span>
                    </button>
                  </th>
                  <td>{formatHumanDuration(member.activeSeconds)}</td>
                  <td className="is-agent">{formatHumanDuration(member.agentSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {boardNotes.map((note) => <p key={note} className="tv-card-foot">{note}</p>)}
        </section>
        <div className="tv-stack">
          <section className="tv-card tv-list" aria-labelledby={projectsTitleId}>
            <div className="tv-card-head">
              <h4 id={projectsTitleId}>Projects</h4>
              <span className="tv-card-note">Recorded time</span>
            </div>
            {projectRows.length === 0 ? (
              <p className="subtle">Nothing recorded in this range.</p>
            ) : (
              <>
                <ul className="tv-meter-list">
                  {projectRows.map((row) => <MeterRowItem key={row.key} row={row} />)}
                </ul>
                <p className="tv-card-foot">{RECORDED_TIME_NOTE}</p>
              </>
            )}
          </section>
          <section className="tv-card tv-list" aria-labelledby={agentsTitleId}>
            <div className="tv-card-head">
              <h4 id={agentsTitleId}>Agents</h4>
              <span className="tv-card-note">Agent time</span>
            </div>
            {agentRows.length === 0 ? (
              <p className="subtle">Nothing recorded in this range.</p>
            ) : (
              <ul className="tv-meter-list is-agent">
                {agentRows.map((row) => <MeterRowItem key={row.key} row={row} />)}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
};
