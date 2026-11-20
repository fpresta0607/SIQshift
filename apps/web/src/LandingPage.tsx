import { useEffect, useState } from "react";
import { type ChartHourlyBucket } from "@siqshift/shared/ui";
import { WebGLShader } from "@siqshift/shared/webgl-shader";
import { DashboardView, TeamViewHead, type BoardSort } from "@siqshift/shared/dashboard-view";
import { InstallTabs } from "./InstallTabs.js";
import "./landing.css";

export type AuthMode = "sign-in" | "sign-up";

// Illustrative data only. The preview never reads a workspace or records time.
const hours = [
  [0, 0], [1800, 2400], [3300, 5400], [3000, 6600], [900, 3600],
  [2700, 7200], [3300, 6300], [2400, 4500], [600, 1800], [0, 600],
] as const;
const members = [
  { id: "alex", name: "Alex Morgan", activeSeconds: 21600, agents: [28800, 21600] },
  { id: "jordan", name: "Jordan Lee", activeSeconds: 18000, agents: [14400, 21600] },
  { id: "taylor", name: "Taylor Chen", activeSeconds: 14400, agents: [14400, 14400] },
];
const agentSources = ["claude_code", "codex"];
// About as many tokens an hour of agent runtime burns in the example.
const TOKENS_PER_AGENT_SECOND = 600;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
// A tokens figure split the way the example's bars split it: 6% out.
const exampleTokens = (agentSeconds: number) => {
  const tokens = Math.round(agentSeconds * TOKENS_PER_AGENT_SECOND);
  const tokensOut = Math.round(tokens * 0.06);
  return { tokensIn: tokens - tokensOut, tokensOut, tokens };
};
const boardMembers = members.map((member, index) => ({
  id: member.id, rank: index + 1, name: member.name,
  activeSeconds: member.activeSeconds, agentSeconds: sum(member.agents), tokens: exampleTokens(sum(member.agents)), isSelf: false,
}));

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
  const [memberId, setMemberId] = useState<string | null>(null);
  const [boardSort, setBoardSort] = useState<BoardSort>("active");
  const selectedMember = members.find(member => member.id === memberId);
  const visibleMembers = selectedMember ? [selectedMember] : members;
  const activeSeconds = sum(visibleMembers.map(member => member.activeSeconds));
  const agentSeconds = sum(visibleMembers.map(member => sum(member.agents)));
  const exampleDay: ChartHourlyBucket[] = hours.map(([active, agent], index) => ({
    hourStart: new Date(2026, 9, 12, index + 8).toISOString(),
    activeSeconds: active * activeSeconds / 18000,
    agentSeconds: agent * agentSeconds / 38400,
  }));
  const runtimes = agentSources.map((source, index) => {
    const runtimeSeconds = sum(visibleMembers.map(member => member.agents[index] ?? 0));
    return { source, agentSeconds: runtimeSeconds, shiftCount: Math.round(runtimeSeconds / 5400), tokens: runtimeSeconds * TOKENS_PER_AGENT_SECOND };
  });
  // Each hour burns tokens in step with its agent time, so the bars add up to the Tokens total.
  const tokenBuckets = exampleDay.map(bucket => ({ start: bucket.hourStart, ...exampleTokens(bucket.agentSeconds) }));
  const tokens = sum(tokenBuckets.map(bucket => bucket.tokens));
  const tokensOut = sum(tokenBuckets.map(bucket => bucket.tokensOut));
  return (
    <figure className="landing-preview" aria-labelledby="preview-caption">
      <div className="tv tv-frame">
        <TeamViewHead
          title={selectedMember?.name ?? "Atlas Studio"}
          subtitle="Today"
        >
          <span className="tv-badge">Example data</span>
        </TeamViewHead>
        <DashboardView
          subject={selectedMember === undefined ? undefined : { id: selectedMember.id, name: selectedMember.name, isSelf: false }}
          time={{
            activeSeconds,
            agentSeconds,
            hourly: exampleDay,
          }}
          agents={{ tokenTotals: { tokensIn: tokens - tokensOut, tokensOut, tokens }, tokenChart: { bucketSeconds: 3600, buckets: tokenBuckets }, runtimes }}
          people={boardMembers}
          boardSort={boardSort}
          onBoardSort={setBoardSort}
          onSelectPerson={member => setMemberId(member === undefined || member.id === memberId ? null : member.id)}
          boardNotes={selectedMember === undefined ? ["Select a teammate to explore their work."] : []}
        />
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
        <nav aria-label="SIQshift navigation"><button type="button" className="landing-header-sign-in" onClick={() => onAuth("sign-in")}>Sign in</button><button type="button" className="landing-primary landing-header-cta" onClick={() => onAuth("sign-up")}>Sign up</button></nav>
      </header>
      <main id="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-wordmark">Team hours. Local AI agents.</div>
          <h1 id="landing-title">Measure the work.<br /><span>Across your team.</span></h1>
          <InstallTabs />
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
