import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

const repoFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

/**
 * A stylesheet's leading `@import` block, removed.
 *
 * Both stylesheets keep every `@import` at the top, one statement per line, so
 * the block ends at the first line that is not one. Cutting to the next `;`
 * instead would end inside the Google Fonts URL, whose `wght@300;400;...` axis
 * list is semicolons: the tail would survive as a rule prelude and CSS error
 * recovery would swallow the first real rule after it.
 */
const withoutImports = (css: string): string => {
  const lines = css.split("\n");
  let first = 0;
  while (lines[first]?.trimStart().startsWith("@import")) first++;
  return lines.slice(first).join("\n");
};

/**
 * An app's real stylesheet, with its `@import`s resolved by hand.
 *
 * The pages below are served through `setContent`, which has no module
 * resolver and no network: the bare `@siqshift/shared/brand.css` import would
 * not resolve and the Google Fonts one would reach out of the test run. Both
 * are replaced here - brand.css by its own text, the font by nothing - so the
 * rules under test are the ones the app actually ships.
 */
const stylesheet = (app: "desktop" | "web"): string =>
  [repoFile("packages/shared/styles/brand.css"), withoutImports(repoFile(`apps/${app}/src/styles.css`))].join("\n");

/**
 * Inject an app's stylesheet, and prove the containers it lays the rows out in
 * are the ones the app renders.
 *
 * A sheet mangled on its way in still parses: CSS error recovery reads the
 * wreckage as a prelude and drops the rule after it. Every assertion below is
 * relative - an ordering, a width that grew - so a container left at its
 * default layout passes them all quietly. Each of these containers is laid out
 * by its own rule, the app's or the shared team view's, so `display: grid` is
 * that rule arriving.
 */
async function applyStylesheet(page: Page, app: "desktop" | "web", ...containers: readonly string[]): Promise<void> {
  await page.addStyleTag({ content: stylesheet(app) });
  for (const container of containers) {
    const display = await page.locator(container).evaluate((element) => getComputedStyle(element).display);
    if (display !== "grid") {
      throw new Error(`${container} is not laid out by the ${app} stylesheet: display is "${display}", not "grid"`);
    }
  }
}

/**
 * The third cell of a `.meter-row`: a share bar, or - on an agent's row - the
 * plan dial that answers a different question in the same column.
 */
const meterCell = (share: number | "quota"): string =>
  share === "quota"
    ? `<div class="quota">
         <button type="button" class="quota-trigger" aria-expanded="false">
           <svg class="quota-face" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
             <circle class="quota-track" cx="14" cy="14" r="11" fill="none" stroke-width="3"></circle>
             <text class="quota-figure" x="14" y="14" text-anchor="middle" dominant-baseline="central">62%</text>
           </svg>
           <span class="quota-meta">
             <span class="quota-plan">Max</span>
             <span class="quota-window">til 21:00</span>
           </span>
         </button>
       </div>`
    : `<span class="meter-bar" aria-hidden="true" style="--share: ${share}%"></span>`;

/** One `.meter-row`, in the markup the Today card and the Agents tab emit. */
const meterRow = (name: string, detail: string, share: number | "quota", duration: string): string => `
  <li class="meter-row">
    <span class="app-mark is-plain" aria-hidden="true"></span>
    <span class="meter-name">${name}${detail === "" ? "" : `<span class="meter-detail"> · ${detail}</span>`}</span>
    ${meterCell(share)}
    <span class="meter-duration">${duration}</span>
  </li>`;

/// Heaviest first, the order the Today card sorts them in. The agent row
/// carries a quota dial where the others carry a bar, because two of those
/// side by side is what a second column has to survive.
const TODAY_ROWS: readonly (readonly [string, string, number | "quota", string])[] = [
  ["Visual Studio Code", "", 100, "4h 12m"],
  ["Claude Code", "siqshift", "quota", "3h 06m"],
  ["Google Chrome", "", 51, "2h 09m"],
  ["Windows Terminal", "", 33, "1h 24m"],
  ["Slack", "", 18, "46m"],
  ["Everything else", "", 9, "23m"],
];

/**
 * The Today card, in either app's markup for it.
 *
 * Both lay it out in a `.screen` column of the same width ladder, so the card
 * is the same card - the shells around that column differ, and the desktop
 * alone can put a plan dial in a row's third cell, because a plan reading
 * never leaves the machine that read it.
 */
export async function openTodayCard(page: Page, app: "desktop" | "web" = "desktop"): Promise<void> {
  const rows = app === "desktop"
    ? TODAY_ROWS
    : TODAY_ROWS.map(([name, detail, share, duration]) =>
        [name, detail, share === "quota" ? 74 : share, duration] as const);
  const open = app === "desktop" ? `<main class="app-shell">` : `<main class="shell">`;
  await page.setContent(`
    ${open}
      <div class="screen">
        <section class="session-stats card" aria-labelledby="today-panel-title">
          <div class="panel-head"><h2 id="today-panel-title">Today</h2></div>
          <ul class="meter-list meter-apps" data-testid="session-app-list">
            ${rows.map(([name, detail, share, duration]) => meterRow(name, detail, share, duration)).join("")}
          </ul>
        </section>
      </div>
    </main>`);
  await applyStylesheet(page, app, ".screen");
}

/**
 * The clock card both apps lead with: a quiet date label, then the day's
 * total as the page's largest element.
 */
export async function openClockCard(page: Page, app: "desktop" | "web"): Promise<void> {
  const open = app === "desktop" ? `<main class="app-shell">` : `<main class="shell">`;
  await page.setContent(`
    ${open}
      <div class="screen">
        <section class="hero card recording-card" aria-labelledby="recording-heading">
          <h2 id="recording-heading" class="hero-title">Thursday, August 27</h2>
          <output class="elapsed" data-testid="elapsed-time">04:12:00</output>
          <p class="subtle hero-note">Recorded for you.</p>
        </section>
      </div>
    </main>`);
  await applyStylesheet(page, app, ".screen");
}

/**
 * The desktop's Today rows with a connected agent on top: a row with no
 * minutes of its own, so no duration cell, and its plan dial at the
 * component's real 36px size showing a full plan's "100%". An app row below
 * marks where the duration column starts.
 */
export async function openConnectedAgentRow(page: Page): Promise<void> {
  await page.setContent(`
    <main class="app-shell">
      <div class="screen">
        <section class="session-stats card" aria-labelledby="today-panel-title">
          <div class="panel-head"><h2 id="today-panel-title">Today</h2></div>
          <ul class="meter-list meter-apps" data-testid="session-app-list">
            <li class="meter-row">
              <span class="app-mark is-plain" aria-hidden="true"></span>
              <span class="meter-name">Claude Code<span class="meter-detail"> · siqshift</span></span>
              <div class="quota">
                <button type="button" class="quota-trigger" aria-expanded="false">
                  <svg class="quota-face" viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
                    <circle class="quota-track" cx="18" cy="18" r="16" fill="none" stroke-width="4"></circle>
                    <text class="quota-figure is-wide" x="18" y="18" text-anchor="middle" dominant-baseline="central">100%</text>
                  </svg>
                  <span class="quota-meta">
                    <span class="quota-plan">Max</span>
                    <span class="quota-window">til 12:45 PM</span>
                  </span>
                </button>
              </div>
            </li>
            ${meterRow("Google Chrome", "", 51, "2h 09m")}
          </ul>
        </section>
      </div>
    </main>`);
  await applyStylesheet(page, "desktop", ".screen");
}

/** One repo row on the Agents page, in the markup `ShiftGroups` draws. */
const repoGroup = (rank: number, name: string, sub: string, tokens: string, agentTime: string, shift: string, isOpen: boolean): string => `
  <details class="shift-group" data-testid="shift-group"${isOpen ? " open" : ""}>
    <summary class="tv-row shift-group-head">
      <span class="tv-rank">${rank}</span>
      <span class="repo-mark" aria-hidden="true">${name.charAt(0)}</span>
      <span class="tv-name"><span>${name}</span><span class="tv-sub">${sub}</span></span>
      <span class="tv-num">${tokens}</span>
      <span class="tv-num is-agent">${agentTime}</span>
      <span class="tv-chev" aria-hidden="true"></span>
    </summary>
    <ul class="shift-list">${shift}</ul>
  </details>`;

/** One agent row on the Agents page, in the markup `AgentsView` draws. */
const runtimeRow = (name: string, shifts: string, share: number, tokens: string, agentTime: string): string => `
  <li class="tv-row">
    <span class="agent-mark is-generic" aria-hidden="true">${name.charAt(0)}</span>
    <span class="tv-name"><span>${name}</span><span class="tv-sub">${shifts}</span></span>
    <span class="tv-bar" aria-hidden="true" style="--share: ${share}%"></span>
    <span class="tv-num">${tokens}</span>
    <span class="tv-num is-agent">${agentTime}</span>
  </li>`;

/**
 * The Agents page's repos and agents, in the markup both apps draw from the
 * shared team view.
 *
 * Both apps open it in the All-stats overlay (`.modal-overlay` >
 * `.today-card.card.modal`), and the rows' width comes from that container -
 * whose padding and border are room the rows do not get, so rendering the page
 * without it would measure the rows at a width they are never shown at. Only
 * the shell around the overlay differs.
 */
export async function openAgentsGroup(page: Page, app: "desktop" | "web"): Promise<void> {
  const shell = app === "desktop" ? `<main class="app-shell">` : `<main class="shell">`;
  await page.setContent(`
    ${shell}<div class="modal-overlay"><section class="today-card card modal"><div class="tv">
      <div class="tv-page" data-testid="agent-shifts">
        <div class="tv-grid">
          <section class="tv-card tv-repos">
            <div class="tv-card-head"><h4>Repos</h4><span class="tv-card-note">Ranked by tokens</span></div>
            <div class="tv-cols" aria-hidden="true">
              <span></span><span></span><span class="is-left">Repo</span><span>Tokens</span><span>Agent time</span><span></span>
            </div>
            ${repoGroup(1, "siqshift", `<span class="held-tag">50% held · </span>1 shift`, "1.3M", "1h 30m", `
              <li class="shift-row">
                <span class="shift-when">15:00</span>
                <span class="shift-facts">Claude Code · Alex · claude-opus-5 · 2 commits</span>
                <span class="shift-duration">1h 00m</span>
              </li>`, false)}
            ${repoGroup(2, "No codebase recorded", "1 shift", "-", "30m", `
              <li class="shift-row">
                <span class="shift-when">09:30</span>
                <span class="shift-facts">Codex · Alex</span>
                <span class="shift-duration">30m</span>
              </li>`, true)}
            <p class="tv-card-foot">Open a repo to see its shifts.</p>
          </section>
          <div class="tv-stack">
            <section class="tv-card tv-runtimes">
              <div class="tv-card-head"><h4>Agents</h4><span class="tv-card-note">Ranked by tokens</span></div>
              <div class="tv-cols" aria-hidden="true">
                <span></span><span class="is-left">Agent</span><span></span><span>Tokens</span><span>Agent time</span>
              </div>
              <ul>
                ${runtimeRow("Claude Code", "1 shift", 100, "1.3M", "1h 30m")}
                ${runtimeRow("Codex", "1 shift", 4, "52k", "30m")}
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div></section></div></main>`);
  await applyStylesheet(page, app, ".modal-overlay", ".tv");
}

/**
 * The All-stats card for one person, in the markup both apps draw: the
 * recorded total with the sentence that says what it is made of, then the
 * project list and the app list that both close on that total.
 *
 * The sentence is the longest line the card draws and it lives in the
 * narrowest container the apps have - the overlay - so a phone is where it
 * runs out of room first. Each app's overlay is its own, so the card is
 * rendered under each app's sheet.
 */
export async function openMemberStats(page: Page, app: "desktop" | "web"): Promise<void> {
  const shell = app === "desktop" ? `<main class="app-shell">` : `<main class="shell">`;
  const appRow = (label: string, duration: string): string =>
    `<li class="app-row"><span class="app-name">${label}</span><span class="app-duration">${duration}</span></li>`;
  await page.setContent(`
    ${shell}<div class="modal-overlay"><section class="today-card card modal"><div class="tv">
      <div class="tv-page">
        <section class="tv-card tv-person" data-testid="member-stats">
          <div class="tv-card-head tv-person-head">
            <h4><span class="member-avatar mint" aria-hidden="true">FP</span>Francesco Presta<span class="tv-you">You</span></h4>
          </div>
          <p class="tv-person-total">
            <strong>1h 56m</strong> recorded
            <span class="metric-hint"> · 1h 19m of it away from the keyboard, 57m of that with an agent running</span>
          </p>
          <div></div>
          <div>
            <p class="group-label">Projects, apps and agents</p>
            <ul class="app-list" data-testid="member-project-list">
              ${appRow("peakCraftsman", "1h 34m")}
              ${appRow("General", "22m")}
            </ul>
            <ul class="app-list" data-testid="member-app-list">
              ${appRow("Windows Terminal", "20m")}
              ${appRow("Google Chrome", "12m")}
              ${appRow("Quiet time", "1h 24m")}
            </ul>
          </div>
        </section>
      </div>
    </div></section></div></main>`);
  await applyStylesheet(page, app, ".modal-overlay", ".tv");
}
