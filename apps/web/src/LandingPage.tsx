import { useEffect, useState } from "react";
import { formatHumanDuration } from "@siqshift/shared";
import { HourlyGraph, MeterRowItem, type ChartHourlyBucket, type MeterRow } from "@siqshift/shared/ui";
import { WebGLShader } from "@siqshift/shared/webgl-shader";
import "./landing.css";

export type AuthMode = "sign-in" | "sign-up";

// Illustrative data only. The preview never reads a workspace or records time.
const hours = [
  [0, 0], [1800, 2400], [3300, 5400], [3000, 6600], [900, 3600],
  [2700, 7200], [3300, 6300], [2400, 4500], [600, 1800], [0, 600],
] as const;
const exampleDay: ChartHourlyBucket[] = hours.map(([activeSeconds, agentSeconds], index) => ({
  hourStart: new Date(2026, 9, 12, index + 8).toISOString(),
  activeSeconds, agentSeconds, inputTokens: null, outputTokens: null,
  cacheCreationInputTokens: null, cacheReadInputTokens: null,
}));
const activeSeconds = hours.reduce((total, hour) => total + hour[0], 0);
const agentSeconds = hours.reduce((total, hour) => total + hour[1], 0);
const projectRows: MeterRow[] = [
  { key: "website", label: "Website", detail: "Project", durationSeconds: 9000, share: 100, source: undefined, processName: undefined },
  { key: "app", label: "Client app", detail: "Project", durationSeconds: 6300, share: 70, source: undefined, processName: undefined },
  { key: "planning", label: "Planning", detail: "Project", durationSeconds: 2700, share: 30, source: undefined, processName: undefined },
];
const agentRows: MeterRow[] = [
  { key: "claude", label: "Claude Code", detail: "Website", durationSeconds: 21600, share: 100, source: "claude_code", processName: undefined },
  { key: "codex", label: "Codex", detail: "Client app", durationSeconds: 16800, share: 78, source: "codex", processName: undefined },
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
  const [view, setView] = useState<"humans" | "agents">("humans");
  const humans = view === "humans";
  return (
    <figure className="landing-preview" aria-labelledby="preview-caption">
      <div className="landing-app card">
        <div className="landing-app-bar">
          <span className="landing-app-brand"><img src="/favicon.png" alt="" width="24" height="24" />SIQshift</span>
          <span className="landing-example">Example workspace</span>
        </div>
        <div className="landing-app-body">
          <div className="landing-preview-heading"><h3>Your work, at a glance.</h3><span>Today</span></div>
          <dl className="landing-metrics">
            <div><dt>Human active time</dt><dd>{formatHumanDuration(activeSeconds)}</dd></div>
            <div><dt>Agent runtime</dt><dd>{formatHumanDuration(agentSeconds)}</dd></div>
          </dl>
          <HourlyGraph buckets={exampleDay} personLabel="Human" />
          <div className="landing-preview-tabs" role="group" aria-label="Preview breakdown">
            <button type="button" aria-pressed={humans} onClick={() => setView("humans")}>Humans</button>
            <button type="button" aria-pressed={!humans} onClick={() => setView("agents")}>Agents</button>
          </div>
          <div className="landing-breakdown" aria-live="polite">
            <p>{humans ? "Active time by project" : "Runtime by agent"}</p>
            <ul className="landing-meter-list">{(humans ? projectRows : agentRows).map(row => <MeterRowItem key={row.key} row={row} />)}</ul>
          </div>
        </div>
      </div>
      <figcaption id="preview-caption">Explore the app with example data. Agents can work in parallel, so their hours add up separately.</figcaption>
    </figure>
  );
}

export function LandingPage({ onAuth }: { onAuth: (mode: AuthMode) => void }) {
  return (
    <div className="landing">
      <LandingBackground />
      <a className="landing-skip" href="#landing-main">Skip to content</a>
      <header className="landing-header">
        <a href="https://www.siqstack.com" aria-label="SIQstack home"><img className="landing-siq-logo" src="/siqstack-logo.svg" alt="SIQstack" width="150" height="32" /></a>
        <nav aria-label="SIQshift navigation"><a href="#how-it-works">How it works</a><button type="button" onClick={() => onAuth("sign-in")}>Log in</button></nav>
      </header>
      <main id="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-wordmark"><img src="/favicon.png" alt="" width="52" height="52" /><span>SIQshift</span></div>
          <h1 id="landing-title">Your time.<br /><span>Your agents’ time.</span></h1>
          <p>Automatic time tracking for people who work with AI.<br className="landing-desktop-break" /> See where your hours go, together and apart.</p>
          <div className="landing-actions">
            <button type="button" className="landing-primary" onClick={() => onAuth("sign-up")}>Create account <span aria-hidden="true">↗</span></button>
            <button type="button" className="landing-secondary" onClick={() => onAuth("sign-in")}>Log in</button>
          </div>
          <a className="landing-scroll" href="#how-it-works">See how it works <span aria-hidden="true">↓</span></a>
        </section>
        <section id="how-it-works" className="landing-content" aria-labelledby="landing-workflow-title">
          <div className="landing-section-heading"><p className="eyebrow">A clearer picture of work</p><h2 id="landing-workflow-title">One day.<br /><span>The whole picture.</span></h2></div>
          <ProductPreview />
          <div className="landing-features">
            <article><span className="landing-feature-number">01</span><h3>Just work.</h3><p>The desktop app records activity automatically. Step away and your active time pauses.</p></article>
            <article><span className="landing-feature-number">02</span><h3>See both sides.</h3><p>Your focus time and your agents’ runtime, measured separately. Even when agents run together.</p></article>
            <article><span className="landing-feature-number">03</span><h3>Keep it together.</h3><p>Break down time by project, app, and agent. Share a workspace with your team.</p></article>
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
