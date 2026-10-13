import { useEffect, useState } from "react";
import { formatHumanDuration } from "@siqshift/shared";
import { AgentRuntimeIcon, HourlyGraph, MeterRowItem, type ChartHourlyBucket, type MeterRow } from "@siqshift/shared/ui";
import { WebGLShader } from "@siqshift/shared/webgl-shader";
import "./landing.css";

export type AuthMode = "sign-in" | "sign-up";

// Illustrative data only. The preview never reads a workspace or records time.
const hours = [
  [0, 0], [1800, 2400], [3300, 5400], [3000, 6600], [900, 3600],
  [2700, 7200], [3300, 6300], [2400, 4500], [600, 1800], [0, 600],
] as const;
const members = [
  { id: "alex", name: "Alex Morgan", initials: "AM", color: "mint", project: "Atlas Portal", projects: [14400, 7200, 0], agents: [28800, 21600] },
  { id: "jordan", name: "Jordan Lee", initials: "JL", color: "blue", project: "Relay App", projects: [7200, 3600, 7200], agents: [14400, 21600] },
  { id: "taylor", name: "Taylor Chen", initials: "TC", color: "purple", project: "Nova Website", projects: [0, 7200, 7200], agents: [14400, 14400] },
];
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const projectIcon = (color: string, drawing: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="${color}"/><g fill="none" stroke="#071016" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${drawing}</g></svg>`)}`;
// Original marks for fictional projects; runtime marks below are the app's real icons.
const exampleProjects = [
  { key: "atlas", name: "Atlas Portal", icon: projectIcon("#62e4ba", '<path d="m8 24 8-16 8 16M11 19h10"/>') },
  { key: "nova", name: "Nova Website", icon: projectIcon("#85c6ff", '<path d="m16 6 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z"/>') },
  { key: "relay", name: "Relay App", icon: projectIcon("#c6a1f4", '<rect x="8" y="7" width="10" height="12" rx="3"/><rect x="14" y="13" width="10" height="12" rx="3"/>') },
];

function LandingBackground() {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return <div className="landing-scene" aria-hidden="true">{!reducedMotion && <WebGLShader />}<div className="landing-shade" /></div>;
}

function ProductPreview() {
  const [view, setView] = useState<"projects" | "agents">("projects");
  const [memberId, setMemberId] = useState<string | null>(null);
  const selectedMember = members.find(member => member.id === memberId);
  const visibleMembers = selectedMember ? [selectedMember] : members;
  const activeSeconds = sum(visibleMembers.map(member => sum(member.projects)));
  const agentSeconds = sum(visibleMembers.map(member => sum(member.agents)));
  const exampleDay: ChartHourlyBucket[] = hours.map(([active, agent], index) => ({
    hourStart: new Date(2026, 9, 12, index + 8).toISOString(),
    activeSeconds: active * activeSeconds / 18000,
    agentSeconds: agent * agentSeconds / 38400,
    inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null,
  }));
  const projects = exampleProjects.map((project, index) => ({
    ...project, seconds: sum(visibleMembers.map(member => member.projects[index] ?? 0)),
  })).filter(project => project.seconds > 0).sort((a, b) => b.seconds - a.seconds);
  const projectRows: MeterRow[] = projects.map(project => ({
    key: project.key, label: project.name, durationSeconds: project.seconds,
    share: project.seconds / (projects[0]?.seconds || 1) * 100,
    source: undefined, processName: undefined,
  }));
  const agentRows: MeterRow[] = ["claude_code", "codex"].map((source, index) => ({
    key: source, source, processName: undefined,
    label: index === 0 ? "Claude Code" : "Codex",
    durationSeconds: sum(visibleMembers.map(member => member.agents[index] ?? 0)), share: 0,
  }));
  const longestAgent = Math.max(...agentRows.map(row => row.durationSeconds));
  for (const row of agentRows) row.share = row.durationSeconds / longestAgent * 100;
  return (
    <figure className="landing-preview" aria-labelledby="preview-caption">
      <div className="landing-app card">
        <div className="landing-app-bar">
          <span className="landing-app-brand"><img src="/favicon.png" alt="" width="28" height="28" />Atlas Studio<span className="landing-workspace-label">Workspace</span></span>
          <span className="landing-example">Example data</span>
        </div>
        <div className="landing-app-body">
          <div className="landing-preview-heading"><h3>{selectedMember?.name ?? "Your team’s work, together."}</h3><span>Today</span></div>
          <div className="landing-scope"><span>{selectedMember ? selectedMember.project : "3 people across 3 projects"}</span>{selectedMember && <button type="button" onClick={() => setMemberId(null)}>All members ×</button>}</div>
          <dl className="landing-metrics">
            <div><dt>{selectedMember ? "Active work hours" : "Team active hours"}</dt><dd>{formatHumanDuration(activeSeconds)}</dd></div>
            <div><dt>Agent runtime</dt><dd>{formatHumanDuration(agentSeconds)}</dd></div>
          </dl>
          <HourlyGraph buckets={exampleDay} personLabel={selectedMember ? selectedMember.name : "Team"} />
          <div className="landing-workspace-grid">
            <section className="landing-leaderboard" aria-labelledby="example-leaderboard-title">
              <div className="landing-panel-heading"><h4 id="example-leaderboard-title">Team leaderboard</h4><span>By active hours</span></div>
              <table aria-label="Example team leaderboard">
                <thead><tr><th scope="col">Member / project</th><th scope="col">Active</th><th scope="col">Agents</th></tr></thead>
                <tbody>{members.map((member, index) => (
                  <tr key={member.id} className={member.id === memberId ? "is-selected" : undefined}>
                    <th scope="row"><button type="button" aria-label={`Show ${member.name}'s work`} aria-pressed={member.id === memberId} onClick={() => setMemberId(member.id === memberId ? null : member.id)}>
                      <span className="landing-rank">{index + 1}</span><span className={`landing-avatar ${member.color}`} aria-hidden="true">{member.initials}</span><span className="landing-person">{member.name}<small>{member.project}</small></span>
                    </button></th>
                    <td>{formatHumanDuration(sum(member.projects))}</td><td>{formatHumanDuration(sum(member.agents))}</td>
                  </tr>
                ))}</tbody>
              </table>
              <p className="landing-table-hint">Select a teammate to explore their work.</p>
            </section>
            <section className="landing-project-panel" aria-label="Workspace breakdown">
              <div className="landing-preview-tabs" role="group" aria-label="Preview breakdown">
                <button type="button" aria-pressed={view === "projects"} onClick={() => setView("projects")}>Projects</button>
                <button type="button" aria-pressed={view === "agents"} onClick={() => setView("agents")}>Agents</button>
              </div>
              <div className="landing-breakdown" aria-live="polite">
                <p>{view === "projects" ? "Active time by project" : "Runtime by agent"}</p>
                <ul className="landing-meter-list">{(view === "projects" ? projectRows : agentRows).map(row => <MeterRowItem key={row.key} row={row} iconUrl={exampleProjects.find(project => project.key === row.key)?.icon} />)}</ul>
              </div>
            </section>
          </div>
          <div className="landing-tools"><span>Local agents, shared visibility</span><span><AgentRuntimeIcon source="claude_code" />Claude Code</span><span><AgentRuntimeIcon source="codex" />Codex</span></div>
        </div>
      </div>
      <figcaption id="preview-caption">An example team workspace. Active hours and agent runtime are measured separately, including agents running in parallel.</figcaption>
    </figure>
  );
}

export function LandingPage({ onAuth }: { onAuth: (mode: AuthMode) => void }) {
  return (
    <div className="landing">
      <LandingBackground />
      <a className="landing-skip" href="#landing-main">Skip to content</a>
      <header className="landing-header">
        <div className="landing-brand-lockup"><a className="landing-product-brand" href="#landing-main" aria-label="SIQshift home"><img src="/favicon.png" alt="" width="56" height="56" /><span>SIQ<strong>shift</strong></span></a><a className="landing-maker" href="https://www.siqstack.com" aria-label="SIQstack home"><span>by</span><img className="landing-siq-logo" src="/siqstack-logo.svg" alt="SIQstack" width="88" height="19" /></a></div>
        <nav aria-label="SIQshift navigation"><a href="#how-it-works">How it works</a><button type="button" onClick={() => onAuth("sign-in")}>Log in</button><button type="button" className="landing-primary landing-header-cta" onClick={() => onAuth("sign-up")}>Create account ↗</button></nav>
      </header>
      <main id="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-wordmark">Team hours. Local AI agents.</div>
          <h1 id="landing-title">Measure the work.<br /><span>Across your team.</span></h1>
          <p>Track active work hours and local AI agent runtime across your team. See who worked on what, in one shared workspace.</p>
          <div className="landing-actions">
            <button type="button" className="landing-primary" onClick={() => onAuth("sign-up")}>Create account <span aria-hidden="true">↗</span></button>
            <button type="button" className="landing-secondary" onClick={() => onAuth("sign-in")}>Log in</button>
          </div>
          <a className="landing-scroll" href="#how-it-works">See how it works <span aria-hidden="true">↓</span></a>
        </section>
        <section id="how-it-works" className="landing-content" aria-labelledby="landing-workflow-title">
          <div className="landing-section-heading"><p className="eyebrow">A clearer picture of work</p><h2 id="landing-workflow-title">Your whole team.<br /><span>One shared view.</span></h2></div>
          <ProductPreview />
          <div className="landing-features">
            <article><span className="landing-feature-number">01</span><h3>Just work.</h3><p>The desktop app records activity automatically. Step away and your active time pauses.</p></article>
            <article><span className="landing-feature-number">02</span><h3>See both sides.</h3><p>Measure human effort and agent runtime across your team, even when several agents work in parallel.</p></article>
            <article><span className="landing-feature-number">03</span><h3>Keep it together.</h3><p>See your team’s leaderboard and the projects behind their hours. One workspace for everyone’s work.</p></article>
          </div>
        </section>
        <section className="landing-closing" aria-labelledby="landing-closing-title">
          <h2 id="landing-closing-title">Make every shift <span>visible.</span></h2>
          <p>Create an account. Install the desktop app. Get back to work.</p>
          <button type="button" className="landing-primary" onClick={() => onAuth("sign-up")}>Create account <span aria-hidden="true">↗</span></button>
        </section>
      </main>
      <footer className="landing-footer"><p>SIQshift <span>by <a href="https://www.siqstack.com">SIQstack</a></span></p><div><a href="https://goblins.siqstack.com">Code Goblins</a><a href="https://www.siqstack.com/work">More of our work</a></div></footer>
    </div>
  );
}
