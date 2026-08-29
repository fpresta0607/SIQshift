import { useCallback, useEffect, useRef, useState } from "react";

import {
  agentRuntimeLabel,
  formatDuration,
  formatHumanDuration,
  leverage,
  type AgentShiftsResponse,
  type LeaderboardEntry,
  type MeStatsAgent,
  type MeStatsResponse,
  type Organization,
  type ProjectListItem,
  type ProjectScope,
  type ProjectUsageResponse,
  type ReportRow,
  type ViewPreferences,
} from "@siqshift/shared";
import {
  HourlyGraph,
  MemberBreakdown,
  MeterRowItem,
  ShiftGroups,
  buildAppRows,
  buildMeterRows,
  hourlyFromShifts,
} from "@siqshift/shared/ui";

import { ClientError, type Client } from "./client.js";
import { DownloadInstaller } from "./DownloadInstaller.js";
import { HelpModal } from "./HelpModal.js";
import { WebGLShader } from "@siqshift/shared/webgl-shader";

type AppProps = { client: Client };

/// The same ranges the desktop offers, measured on the viewer's own clock.
type Range = ViewPreferences["range"];

const rangeLabels: Record<Range, string> = {
  today: "Today",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  all: "All time",
};

const rangeSentence: Record<Range, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

const rangeDays: Record<Range, number | null> = { today: 1, "7d": 7, "30d": 30, "90d": 90, all: null };

/**
 * Instant bounds on the viewer's local calendar, ending at the next local
 * midnight. Calendar-date params would be read as UTC days, which roll over
 * mid-afternoon west of Greenwich. "All time" carries no bounds.
 */
const rangeBounds = (range: Range, now = new Date()): { fromAt: string; toExclusiveAt: string } | undefined => {
  const days = rangeDays[range];
  if (days === null) return undefined;
  const toExclusive = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const from = new Date(toExclusive);
  from.setDate(from.getDate() - days);
  return { fromAt: from.toISOString(), toExclusiveAt: toExclusive.toISOString() };
};

/// The range as a query string; "All time" sends no bounds at all, which is
/// how the server reads "everything".
export function rangeQuery(range: Range, now = new Date()): string {
  const bounds = rangeBounds(range, now);
  if (bounds === undefined) return "";
  return `?fromAt=${encodeURIComponent(bounds.fromAt)}&toExclusiveAt=${encodeURIComponent(bounds.toExclusiveAt)}`;
}

/** Appends extra query parameters onto a possibly-empty range query. */
const withParams = (base: string, params: Record<string, string>): string => {
  const query = new URLSearchParams(base.replace(/^\?/, ""));
  for (const [key, value] of Object.entries(params)) query.set(key, value);
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
};

type BoardSort = "active" | "agent" | "leverage";

const boardSorters: Record<BoardSort, (a: LeaderboardEntry, b: LeaderboardEntry) => number> = {
  active: (a, b) => b.activeSeconds - a.activeSeconds,
  agent: (a, b) => b.agentSeconds - a.agentSeconds,
  leverage: (a, b) => (leverage(b) ?? 0) - (leverage(a) ?? 0),
};

const messageFor = (error: unknown): string =>
  error instanceof ClientError ? error.message : "Something went wrong. Try again.";

/// Runtimes that ran shifts in range but reported no tokens - the honest gap
/// the tokens view names beneath the plot rather than zeroing over.
const tokenBlindRuntimes = (agents: readonly MeStatsAgent[] | undefined): string[] => [
  ...new Set(
    (agents ?? [])
      .filter((row) => row.shiftCount > 0 && !row.tokensReported)
      .map((row) => agentRuntimeLabel(row.agent.source)),
  ),
];

/**
 * What the Today panel says when it has nothing to add up. The desktop can
 * name this machine's recording state; a browser records nothing at all, so it
 * names the one thing that would change the answer.
 */
const TODAY_EMPTY = "Nothing has been added up yet. Your hours appear here as the SIQshift app on your computers sends them in.";

/// Keeps the Today panel close to live, the way the desktop's own slow tick does.
const TODAY_REFRESH_MS = 60_000;

export const App = ({ client }: AppProps) => {
  const [booting, setBooting] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [justSignedUp, setJustSignedUp] = useState(false);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | undefined>();

  const [scope, setScope] = useState<ProjectScope>("all");
  const [range, setRange] = useState<Range>("30d");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [organization, setOrganization] = useState<Organization | undefined>();
  const [selfId, setSelfId] = useState<string | undefined>();
  const [selfName, setSelfName] = useState<string | undefined>();
  const [projects, setProjects] = useState<readonly ProjectListItem[]>([]);
  const [entries, setEntries] = useState<readonly LeaderboardEntry[]>([]);
  const [boardSort, setBoardSort] = useState<BoardSort>("active");
  /// Humans is the leaderboard; Agents is what ran and where, every shift
  /// grouped by the codebase it worked.
  const [boardTab, setBoardTab] = useState<"humans" | "agents">("humans");
  const [agentShifts, setAgentShifts] = useState<AgentShiftsResponse | undefined>();
  const [agentShiftsFailed, setAgentShiftsFailed] = useState(false);
  /// The Agents tab's own person selection. Undefined means everyone, which
  /// is why it cannot borrow `member`: that one falls back to the signed-in
  /// user, so "nobody picked" would silently open the tab on yourself.
  const [shiftsMember, setShiftsMember] = useState<{ id: string; name: string } | undefined>();
  const [loading, setLoading] = useState(false);
  const [dataError, setDataError] = useState<string | undefined>();
  const [boardFailed, setBoardFailed] = useState(false);
  const [member, setMember] = useState<{ id: string; name: string } | undefined>();
  const [memberStats, setMemberStats] = useState<MeStatsResponse | undefined>();
  const [memberFailed, setMemberFailed] = useState(false);
  /// The home screen's own reading: today, for the signed-in viewer, over
  /// whichever project the filing header is pointed at. It keeps its own copy
  /// so opening a teammate's month in All stats never rewrites the day the
  /// clock above is counting.
  const [todayStats, setTodayStats] = useState<MeStatsResponse | undefined>();
  const [todayFailed, setTodayFailed] = useState(false);
  const [todayTick, setTodayTick] = useState(0);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionRows, setSessionRows] = useState<readonly ReportRow[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [sessionPage, setSessionPage] = useState(1);
  const [allStatsOpen, setAllStatsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [newProjectError, setNewProjectError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | undefined>();
  const [helpOpen, setHelpOpen] = useState(false);

  const expireSession = useCallback(() => {
    setSignedIn(false);
    setAuthError("Your session expired. Sign in again.");
  }, []);

  const scopeParams = useCallback(
    (base: string): string => (scope === "all" ? base : withParams(base, { scope })),
    [scope],
  );

  // On page load, trade a persisted auth cookie for a JWT before choosing
  // between the sign-in form and the dashboard — no form flash for a live session.
  useEffect(() => {
    let cancelled = false;
    void client.restoreSession().then((restored) => {
      if (cancelled) return;
      if (restored) setSignedIn(true);
      setBooting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Workspaces that predate roles have no administrator at all, which locks
  // everyone out of project deletion. The first signed-in member claims the
  // role; every later call is refused by the server and ignored here.
  useEffect(() => {
    if (!signedIn) return;
    void client.claimAdmin().catch(() => undefined);
  }, [client, signedIn]);

  // Who and where: identity, workspace, projects, and the shared view state.
  // Preferences land BEFORE the first board fetch so the page opens where the
  // desktop app last was, with no flicker through the defaults.
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void Promise.allSettled([client.organization(), client.me(), client.projects(), client.preferences()]).then(
      ([organizationResult, meResult, projectsResult, preferencesResult]) => {
        if (cancelled) return;
        const failures = [organizationResult, meResult, projectsResult, preferencesResult]
          .flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
        if (failures.some((reason) => reason instanceof ClientError && reason.kind === "auth")) {
          expireSession();
          return;
        }
        if (organizationResult.status === "fulfilled") setOrganization(organizationResult.value.organization);
        if (meResult.status === "fulfilled") {
          setSelfId(meResult.value.user.id);
          setSelfName(meResult.value.user.name);
        }
        if (projectsResult.status === "fulfilled") setProjects(projectsResult.value.projects);
        if (preferencesResult.status === "fulfilled") {
          // The unassigned scope is retired from the pickers; a stored one
          // reads as everything rather than as a blank select.
          setScope(preferencesResult.value.scope === "unassigned" ? "all" : preferencesResult.value.scope);
          setRange(preferencesResult.value.range);
        }
        setPreferencesReady(true);
        const [firstFailure] = failures;
        if (firstFailure !== undefined) setDataError(messageFor(firstFailure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, expireSession]);

  // The board, refetched whenever scope or range move. It reports its own
  // failure to the page banner and hands the message back, so a caller behind
  // an overlay that covers the banner can repeat it where it can be read.
  const reloadBoard = useCallback(async (): Promise<string | undefined> => {
    setLoading(true);
    setBoardFailed(false);
    try {
      const board = await client.leaderboard(scopeParams(rangeQuery(range)));
      setEntries(board.entries);
      setDataError(undefined);
      return undefined;
    } catch (error: unknown) {
      if (error instanceof ClientError && error.kind === "auth") {
        expireSession();
        return undefined;
      }
      setBoardFailed(true);
      setEntries([]);
      const message = messageFor(error);
      setDataError(message);
      return message;
    } finally {
      setLoading(false);
    }
  }, [client, range, scopeParams, expireSession]);

  useEffect(() => {
    if (!signedIn || !preferencesReady) return;
    void reloadBoard();
  }, [signedIn, preferencesReady, reloadBoard]);

  // The shared view state follows every change, last write wins. The first
  // render after preferences load must not write back what it just read.
  const preferencesDirty = useRef(false);
  useEffect(() => {
    if (!signedIn || !preferencesReady) return;
    if (!preferencesDirty.current) {
      preferencesDirty.current = true;
      return;
    }
    void client.updatePreferences({ scope, range }).catch(() => undefined);
  }, [client, signedIn, preferencesReady, scope, range]);

  // The home screen's day. It follows the filing header's project and nothing
  // else: the All-stats range picker used to move it, which quietly turned the
  // heading's own date into a month's total.
  useEffect(() => {
    if (!signedIn || !preferencesReady) return undefined;
    let cancelled = false;
    client.meStats(scopeParams(rangeQuery("today"))).then(
      (result) => {
        if (cancelled) return;
        setTodayStats(result);
        setTodayFailed(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ClientError && error.kind === "auth") {
          expireSession();
          return;
        }
        setTodayFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, preferencesReady, scopeParams, expireSession, todayTick]);

  useEffect(() => {
    if (!signedIn) return undefined;
    const timer = window.setInterval(() => setTodayTick((tick) => tick + 1), TODAY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [signedIn]);

  // The drill-down: one member's breakdown for the scope and range on screen.
  // Only while All stats is open — nobody is served by fetching a teammate's
  // year in the background.
  const viewedId = member?.id ?? selfId;
  const viewingSelf = member === undefined || member.id === selfId;
  useEffect(() => {
    if (!signedIn || !preferencesReady || !allStatsOpen || viewedId === undefined) return undefined;
    let cancelled = false;
    setMemberStats(undefined);
    setMemberFailed(false);
    client.meStats(scopeParams(withParams(rangeQuery(range), { userId: viewedId }))).then(
      (result) => {
        if (!cancelled) setMemberStats(result);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ClientError && error.kind === "auth") {
          expireSession();
          return;
        }
        setMemberFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, preferencesReady, allStatsOpen, range, viewedId, scopeParams, expireSession]);

  // The Agents tab's shifts, over the range on screen; loads only while the
  // tab is open, since nobody is served by fetching it in the background.
  useEffect(() => {
    if (!signedIn || !preferencesReady || !allStatsOpen || boardTab !== "agents") return undefined;
    let cancelled = false;
    setAgentShiftsFailed(false);
    // Nobody selected sends no parameter at all, so the default tab keeps
    // working against an API deployed before `userId` existed: the filters
    // schema is strict, and an unknown key is a 400 that empties the tab.
    client.agentShifts(scopeParams(
      shiftsMember === undefined ? rangeQuery(range) : withParams(rangeQuery(range), { userId: shiftsMember.id }),
    )).then(
      (result) => {
        if (!cancelled) setAgentShifts(result);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ClientError && error.kind === "auth") {
          expireSession();
          return;
        }
        setAgentShiftsFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, preferencesReady, allStatsOpen, boardTab, range, shiftsMember, scopeParams, expireSession]);

  // Recent sessions load only while their drawer is open, one page at a time.
  useEffect(() => {
    if (!signedIn || !preferencesReady || !sessionsOpen) return undefined;
    let cancelled = false;
    client.report(withParams(scopeParams(rangeQuery(range)), { page: String(sessionPage), pageSize: "25" })).then(
      (result) => {
        if (cancelled) return;
        setSessionRows((current) => (sessionPage === 1 ? result.rows : [...current, ...result.rows]));
        setSessionTotal(result.pagination.totalRows);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, preferencesReady, sessionsOpen, range, sessionPage, scopeParams]);

  // Reset on scope, range, or a fresh open: reopening the drawer with a page
  // counter still at 2 would append page 2's rows on top of themselves.
  useEffect(() => {
    setSessionPage(1);
    setSessionRows([]);
  }, [scope, range, sessionsOpen]);

  // One overlay owns Escape at a time, innermost first, so one press closes
  // one dialog.
  useEffect(() => {
    if (!allStatsOpen && !settingsOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (settingsOpen) setSettingsOpen(false);
      else setAllStatsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [allStatsOpen, settingsOpen]);

  const submitAuth = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(undefined);
    try {
      if (mode === "sign-up") {
        const code = inviteCode.trim();
        const workspace = workspaceName.trim();
        await client.signUp({
          email,
          password,
          name: name.trim(),
          ...(code === "" ? {} : { inviteCode: code }),
          ...(code === "" && workspace !== "" ? { workspaceName: workspace } : {}),
        });
      } else {
        await client.signIn({ email, password });
      }
      setPassword("");
      setName("");
      setInviteCode("");
      setWorkspaceName("");
      setJustSignedUp(mode === "sign-up");
      setSignedIn(true);
    } catch (error: unknown) {
      setAuthError(messageFor(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    await client.signOut();
    setSignedIn(false);
    setJustSignedUp(false);
    setOrganization(undefined);
    setSelfId(undefined);
    setSelfName(undefined);
    setProjects([]);
    setEntries([]);
    setMember(undefined);
    setMemberStats(undefined);
    setMemberFailed(false);
    setBoardFailed(false);
    setTodayStats(undefined);
    setTodayFailed(false);
    // The Agents tab holds another workspace's shifts and another workspace's
    // person id, and the id would go on being sent as a filter. Cleared with
    // the rest of the board, so the next account opens on its own data.
    setBoardTab("humans");
    setShiftsMember(undefined);
    setAgentShifts(undefined);
    setAgentShiftsFailed(false);
    setSessionsOpen(false);
    setSessionRows([]);
    setAllStatsOpen(false);
    setSettingsOpen(false);
    setScopePickerOpen(false);
    setPreferencesReady(false);
    preferencesDirty.current = false;
    setAuthError(undefined);
  };

  const joinWorkspace = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setJoinBusy(true);
    setJoinError(undefined);
    try {
      await client.joinOrganization(joinCode.trim());
      setJoinCode("");
      const refreshed = await client.organization();
      setOrganization(refreshed.organization);
      // The new workspace has its own projects; the filing header, the picker
      // and every scoped request would otherwise still name the old one's.
      const scopeSurvives = await refreshProjects();
      setSettingsError(scopeSurvives ? await reloadBoard() : undefined);
    } catch (error: unknown) {
      setJoinError(messageFor(error));
    } finally {
      setJoinBusy(false);
    }
  };

  const copyInviteCode = async (): Promise<void> => {
    if (organization === undefined) return;
    try {
      await navigator.clipboard.writeText(organization.inviteCode);
      setSettingsError(undefined);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be denied; the code is on screen to copy by hand.
      // The page banner sits under this overlay, so report it in the panel.
      setSettingsError("Could not copy. Select the code and copy it manually.");
    }
  };

  /// Reports whether the scope on screen survived the refresh. A scope naming
  /// a project the list no longer carries falls back to everything, and the
  /// effects that follow `scope` reload the board and the day themselves, so a
  /// caller must not fire its own reload against the scope it just retired.
  const refreshProjects = async (): Promise<boolean> => {
    const listed = await client.projects();
    setProjects(listed.projects);
    const scopeSurvives = scope === "all" || listed.projects.some((project) => project.id === scope);
    if (!scopeSurvives) setScope("all");
    return scopeSurvives;
  };

  /// Creates a project and points the dashboard at it, which is the only
  /// reason to make one from the filing header.
  const createProject = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = newProjectName.trim();
    if (newProjectBusy || trimmed === "") return;
    setNewProjectBusy(true);
    setNewProjectError(undefined);
    try {
      const created = await client.createProject(trimmed);
      await refreshProjects();
      setNewProjectName("");
      setNewProjectOpen(false);
      setScope(created.id);
      setScopePickerOpen(false);
    } catch (error: unknown) {
      setNewProjectError(messageFor(error));
    } finally {
      setNewProjectBusy(false);
    }
  };

  if (booting) {
    return (
      <main className="shell auth-shell">
        <WebGLShader />
      </main>
    );
  }

  if (!signedIn) {
    const isSignUp = mode === "sign-up";
    return (
      <main className="shell auth-shell">
        <WebGLShader />
        <section className="card glass" aria-labelledby="auth-title">
          <p className="eyebrow">SIQshift</p>
          <h1 id="auth-title">{isSignUp ? "Create your account" : "Sign in"}</h1>
          <p className="subtle">
            {isSignUp
              ? "Enter a teammate's invite code to join their workspace, or leave it blank to start your own."
              : "See your team's hours and export them."}
          </p>
          {authError && <p className="error" role="alert">{authError}</p>}
          <form onSubmit={submitAuth}>
            {isSignUp && (
              <label>Name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></label>
            )}
            <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required /></label>
            <label>Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete={isSignUp ? "new-password" : "current-password"}
                minLength={isSignUp ? 8 : undefined}
                required
              />
            </label>
            {isSignUp && (
              <label>Invite code <span className="optional">optional</span>
                <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} autoComplete="off" spellCheck={false} />
              </label>
            )}
            {isSignUp && inviteCode.trim() === "" && (
              <label>Workspace name <span className="optional">optional</span>
                <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} autoComplete="organization" placeholder="You're starting a new workspace" maxLength={80} />
              </label>
            )}
            <button className="primary" type="submit" disabled={authBusy}>
              {authBusy ? "Working…" : isSignUp ? "Create account" : "Sign in"}
            </button>
          </form>
          <button className="link" type="button" onClick={() => { setMode(isSignUp ? "sign-in" : "sign-up"); setAuthError(undefined); setPassword(""); }}>
            {isSignUp ? "Already have an account? Sign in" : "New here? Create an account"}
          </button>
        </section>
      </main>
    );
  }

  if (justSignedUp) {
    return (
      <main className="shell welcome-shell">
        <WebGLShader />
        <section className="welcome" aria-labelledby="welcome-title">
          <p className="eyebrow">You're in</p>
          <h1 id="welcome-title" className="welcome-title">One last thing — the app.</h1>
          <p className="hero-sub">
            SIQshift tracks time from your desktop. Download the app, sign in with this account,
            and your hours show up on the dashboard.
          </p>
          <DownloadInstaller placement="hero" />
          <button className="link" type="button" onClick={() => setJustSignedUp(false)}>
            Skip to your dashboard
          </button>
        </section>
      </main>
    );
  }

  const activeTotal = entries.reduce((total, entry) => total + entry.activeSeconds, 0);
  const boardHasTime = entries.some(
    (entry) => entry.activeSeconds > 0 || entry.agentSeconds > 0 || entry.durationSeconds > 0,
  );
  // Rank follows the column being sorted by; showing the server's active-time
  // rank under an agent-time sort reads as 1, 4, 2, 3.
  const sortedEntries = [...entries]
    .sort(boardSorters[boardSort])
    .map((entry, index) => ({ ...entry, rank: boardSort === "active" ? entry.rank : index + 1 }));
  const memberAppRows = memberStats === undefined ? [] : buildAppRows(memberStats.apps);
  const viewedName = member?.name ?? selfName ?? "You";

  // Where the dashboard is pointed. The desktop's header names the project its
  // recording files under; a browser records nothing, so the same line names
  // the project everything below is read for.
  const scopeProject = scope === "all" ? undefined : projects.find((project) => project.id === scope);
  const scopeName = scope === "all" ? "All projects" : scopeProject?.name ?? "Unknown project";

  const todayTotalSeconds = todayStats?.totalDurationSeconds ?? 0;
  const todayProjectRows = (todayStats?.projects ?? [])
    .filter((entry) => entry.durationSeconds > 0)
    .map((entry) => ({
      key: entry.project.id,
      name: entry.project.name,
      color: projects.find((project) => project.id === entry.project.id)?.color ?? null,
      durationSeconds: entry.durationSeconds,
      share: todayTotalSeconds === 0 ? 0 : Math.round((entry.durationSeconds / todayTotalSeconds) * 100),
    }))
    .sort((a, b) => b.durationSeconds - a.durationSeconds || a.name.localeCompare(b.name));
  const todayMeterRows = buildMeterRows(todayStats?.apps ?? []);
  // The app rows measure time spent in front of something; the day's total is
  // session wall-clock, which also counts the gaps too short to end a stretch.
  // The two were never going to be equal, so the difference gets a row of its
  // own rather than reading as a column that quietly does not add up.
  const foregroundSeconds = todayMeterRows.reduce((sum, row) => sum + row.durationSeconds, 0);
  const quietSeconds = Math.max(0, todayTotalSeconds - foregroundSeconds);

  return (
    <main className="shell">
      <WebGLShader />
      <header className="masthead">
        <div>
          <p className="eyebrow">SIQshift</p>
          <h1>{organization?.name ?? "Your workspace"}</h1>
        </div>
        <div className="masthead-actions">
          <DownloadInstaller />
          <button
            className="ghost help-button"
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => { setSettingsError(undefined); setSettingsOpen(true); }}
          >
            ⚙
          </button>
        </div>
      </header>

      <div className="screen">
        {dataError && <p className="error" role="alert">{dataError}</p>}

        {/* Where the time is read from, named in words rather than hidden
            behind an icon: the workspace, then the project, then a plain link
            to change it. */}
        <div className="filing-header">
          <p className="filing-where" data-testid="filing-where">
            {organization && <span className="filing-org">{organization.name}</span>}
            <span className="filing-project">
              <span
                className="project-dot"
                aria-hidden="true"
                style={scopeProject?.color == null ? undefined : { background: scopeProject.color }}
              />
              {scopeName}
            </span>
          </p>
          <button
            className="filing-change"
            type="button"
            data-testid="filing-change"
            aria-expanded={scopePickerOpen}
            onClick={() => setScopePickerOpen((open) => !open)}
          >
            {scopePickerOpen ? "Done" : "Change"}
          </button>
        </div>

        {/* The clock and nothing else: a label, and the day's total under it. */}
        <section className="hero card recording-card" aria-labelledby="recording-heading">
          <h2 id="recording-heading" className="hero-title">
            {new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          </h2>
          <output className="elapsed" data-testid="elapsed-time" aria-label="Time recorded today">
            {formatDuration(todayTotalSeconds)}
          </output>
          <p className="subtle hero-note">
            Recorded for you by the SIQshift app on your computers. There is nothing to start here.
          </p>
          {scopePickerOpen && (
            <div className="filing-picker">
              {/* One project at a time, so this is a radio group wearing a
                  tick rather than a row of checkboxes that could imply two. */}
              <div className="project-picker" role="radiogroup" aria-label="Show time from" data-testid="project-picker">
                <button
                  type="button"
                  role="radio"
                  aria-checked={scope === "all"}
                  className="project-choice"
                  onClick={() => { setScope("all"); setScopePickerOpen(false); }}
                >
                  <span className="project-tick" aria-hidden="true">{scope === "all" ? "✓" : ""}</span>
                  All projects
                </button>
                {projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="radio"
                    aria-checked={scope === project.id}
                    className="project-choice"
                    onClick={() => { setScope(project.id); setScopePickerOpen(false); }}
                  >
                    <span className="project-tick" aria-hidden="true">{scope === project.id ? "✓" : ""}</span>
                    {project.name}
                  </button>
                ))}
              </div>
              {newProjectOpen ? (
                <form className="new-project-form" onSubmit={createProject}>
                  <label>New project name<input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} maxLength={80} placeholder="e.g. Client work" autoComplete="off" required /></label>
                  {newProjectError && <p className="error" role="alert">{newProjectError}</p>}
                  <div className="new-project-actions">
                    <button className="primary" type="submit" disabled={newProjectBusy || newProjectName.trim() === ""}>{newProjectBusy ? "Creating…" : "Create project"}</button>
                    <button className="ghost" type="button" disabled={newProjectBusy} onClick={() => { setNewProjectOpen(false); setNewProjectName(""); setNewProjectError(undefined); }}>Cancel</button>
                  </div>
                </form>
              ) : (
                <button className="new-project-trigger" type="button" onClick={() => setNewProjectOpen(true)}>New project…</button>
              )}
            </div>
          )}
        </section>

        {/* The main surface below the clock: where today's time went, grouped
            by the projects it was filed under, then by app. Everything
            historical lives behind "All stats" at the bottom. */}
        <section className="session-stats card" aria-labelledby="today-panel-title">
          <div className="panel-head">
            <h2 id="today-panel-title">Today</h2>
          </div>
          {todayFailed && todayMeterRows.length === 0 && todayProjectRows.length === 0 && (
            <p className="error" role="alert">Could not load today's hours.</p>
          )}
          {todayMeterRows.length === 0 && todayProjectRows.length === 0 ? (
            todayStats !== undefined && <p className="subtle" data-testid="today-panel-empty">{TODAY_EMPTY}</p>
          ) : (
            <>
              {todayProjectRows.length > 0 && (
                <ul className="meter-list" data-testid="project-list">
                  {todayProjectRows.map((row) => (
                    <li key={row.key} className="meter-row">
                      <span
                        className="project-dot"
                        aria-hidden="true"
                        style={row.color === null ? undefined : { background: row.color }}
                      />
                      <span className="meter-name">{row.name}</span>
                      <span
                        className="meter-bar"
                        aria-hidden="true"
                        style={{ "--share": `${row.share}%` } as React.CSSProperties}
                      />
                      <span className="meter-duration">{formatHumanDuration(row.durationSeconds)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {todayMeterRows.length > 0 && (
                <ul className="meter-list meter-apps" data-testid="session-app-list">
                  {todayMeterRows.map((row) => <MeterRowItem key={row.key} row={row} />)}
                  {quietSeconds >= 60 && (
                    <li className="meter-row" data-testid="quiet-row">
                      <span className="app-mark is-plain" aria-hidden="true" />
                      <span className="meter-name">Quiet time</span>
                      <span aria-hidden="true" />
                      <span className="meter-duration">{formatHumanDuration(quietSeconds)}</span>
                    </li>
                  )}
                </ul>
              )}
              <HourlyGraph
                buckets={todayStats?.hourly ?? []}
                personLabel="You"
                tokenBlind={tokenBlindRuntimes(todayStats?.agents)}
              />
            </>
          )}
        </section>

        {/* The two ways out of this screen, kept to the foot of it: neither is
            what the page is for. */}
        <div className="screen-foot">
          <button
            className="foot-button"
            type="button"
            onClick={() => setAllStatsOpen(true)}
            data-testid="all-stats-trigger"
          >
            All stats
          </button>
          <button
            className="foot-button is-icon"
            type="button"
            aria-label="How SIQshift works"
            title="How SIQshift works"
            onClick={() => setHelpOpen(true)}
          >
            ⓘ
          </button>
        </div>
      </div>

      {allStatsOpen && (
        <div className="modal-overlay" onClick={() => setAllStatsOpen(false)}>
          <section
            className="today-card card modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="all-stats-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-head">
              <h2 id="all-stats-title" className="visually-hidden">All stats</h2>
              <div className="range-toggle" role="group" aria-label="Humans or agents">
                <button
                  type="button"
                  className={boardTab === "humans" ? "is-active" : undefined}
                  onClick={() => setBoardTab("humans")}
                >
                  Humans
                </button>
                <button
                  type="button"
                  className={boardTab === "agents" ? "is-active" : undefined}
                  onClick={() => setBoardTab("agents")}
                >
                  Agents
                </button>
              </div>
              <div className="range-toggle" role="group" aria-label="Date range">
                {(Object.keys(rangeLabels) as Range[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={range === value ? "is-active" : undefined}
                    onClick={() => setRange(value)}
                  >
                    {rangeLabels[value]}
                  </button>
                ))}
              </div>
              <button className="ghost modal-close" type="button" aria-label="Close all stats" onClick={() => setAllStatsOpen(false)}>✕</button>
            </div>

            {boardTab === "agents" ? (
              <ShiftsTab
                shifts={agentShifts}
                shiftsFailed={agentShiftsFailed}
                range={range}
                rangeLabel={rangeSentence[range]}
                people={agentShifts?.people ?? []}
                selected={shiftsMember}
                onSelect={setShiftsMember}
                selfId={selfId}
              />
            ) : (
              <>
                <div className="board-head">
                  <h3 className="visually-hidden">Leaderboard</h3>
                  <span className="board-tools">
                    <span className="total">{boardFailed ? "Not loaded" : `${formatHumanDuration(activeTotal)} total`}</span>
                    <label className="board-sort">
                      <span className="visually-hidden">Sort by</span>
                      <select value={boardSort} onChange={(event) => setBoardSort(event.target.value as BoardSort)}>
                        <option value="active">By active time</option>
                        <option value="agent">By agent time</option>
                        <option value="leverage">By leverage</option>
                      </select>
                    </label>
                  </span>
                </div>
                {boardFailed ? (
                  <p className="subtle">Could not load hours for this range.</p>
                ) : loading && entries.length === 0 ? (
                  <p className="subtle" role="status">Loading hours…</p>
                ) : (
                  <>
                    {!boardHasTime && (
                      <p className="subtle">
                        {scope === "all"
                          ? "No recorded time in this range yet. Install the desktop app and it records on its own."
                          : "Nothing recorded here in this range. Pick another range, or All projects."}
                      </p>
                    )}
                    {entries.length > 0 && (
                      <ol className="board-list" data-testid="board-list">
                        {sortedEntries.map((entry) => (
                          <li key={entry.user.id} className={entry.user.id === viewedId ? "is-selected" : undefined}>
                            <button
                              type="button"
                              className="board-choice"
                              aria-pressed={entry.user.id === viewedId}
                              onClick={() => setMember({ id: entry.user.id, name: entry.user.name })}
                            >
                              <span className="board-rank">{entry.rank}</span>
                              <span className="board-name">
                                {entry.user.name}
                                {entry.user.id === selfId && <span className="you-tag"> you</span>}
                              </span>
                              <span className="board-times">
                                <span className="board-hours">{formatHumanDuration(entry.activeSeconds)}</span>
                                <span className="board-agent">
                                  Agent {formatHumanDuration(entry.agentSeconds)}
                                  {leverage(entry) !== null && ` · ${leverage(entry)}×`}
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ol>
                    )}
                  </>
                )}

                {viewedId !== undefined && (
                  <section className="member-stats" aria-labelledby="member-stats-title" data-testid="member-stats">
                    <div className="member-stats-head">
                      <h3 id="member-stats-title">{viewedName} · {rangeSentence[range]}</h3>
                      {viewedId !== selfId && (
                        <button type="button" className="member-self" onClick={() => setMember(undefined)}>
                          Show my own
                        </button>
                      )}
                    </div>
                    {memberFailed ? (
                      <p className="subtle">Could not load this member's breakdown.</p>
                    ) : memberStats === undefined ? (
                      <p className="subtle" role="status">Loading…</p>
                    ) : (
                      <>
                        {/* Recorded is whole sessions, so unattended agent
                            stretches sit inside it; the active-time split
                            below is the person's own. */}
                        <p className="member-total">
                          <strong>{formatHumanDuration(memberStats.totalDurationSeconds)}</strong> recorded
                          {memberStats.totalDurationSeconds > memberStats.activeSeconds && (
                            <span className="metric-hint"> · unattended agent time included</span>
                          )}
                        </p>
                        <MemberBreakdown
                          activeSeconds={memberStats.activeSeconds}
                          concurrency={memberStats.concurrency}
                          self={viewingSelf}
                        />
                        <HourlyGraph
                          buckets={memberStats.hourly ?? []}
                          personLabel={viewingSelf ? "You" : viewedName}
                          tokenBlind={tokenBlindRuntimes(memberStats.agents)}
                        />
                        {memberStats.projects.length > 0 && (
                          <ul className="app-list" data-testid="member-project-list">
                            {memberStats.projects.filter((entry) => entry.durationSeconds > 0).map((entry) => (
                              <li key={entry.project.id} className="app-row">
                                <span className="app-name">{entry.project.name}</span>
                                <span className="app-duration">{formatHumanDuration(entry.durationSeconds)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {memberAppRows.length === 0 ? (
                          <p className="subtle" data-testid="today-empty">No recorded time in this range.</p>
                        ) : (
                          <ul className="app-list" data-testid="member-app-list">
                            {memberAppRows.map((row) => (
                              <li key={row.key} className={row.agent ? "app-row is-agent" : "app-row"}>
                                <span className="app-name">{row.label}</span>
                                <span className="app-duration">{formatHumanDuration(row.durationSeconds)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {memberStats.unattributedSeconds > 0 && (
                          <p className="verified-foot" data-testid="unattributed-foot">
                            {formatHumanDuration(memberStats.unattributedSeconds)} of that landed in the default project,
                            because nothing said which project it was for.
                          </p>
                        )}
                      </>
                    )}
                  </section>
                )}
              </>
            )}

            {/* History lives out of the main scroll, one page at a time. */}
            <details
              className="sessions-card"
              open={sessionsOpen}
              onToggle={(event) => setSessionsOpen((event.target as HTMLDetailsElement).open)}
            >
              <summary>Recent sessions{sessionTotal > 0 ? ` (${sessionTotal})` : ""}</summary>
              {sessionRows.length === 0 ? (
                <p className="subtle">Nothing recorded in this range.</p>
              ) : (
                <>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Member</th>
                        <th scope="col">Project</th>
                        <th scope="col">Started</th>
                        <th scope="col" className="numeric">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessionRows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.user.name}</td>
                          <td>{row.project.name}</td>
                          <td>{new Date(row.startedAt).toLocaleString()}</td>
                          <td className="numeric hours">{formatHumanDuration(row.durationSeconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {sessionRows.length < sessionTotal && (
                    <button className="ghost" type="button" onClick={() => setSessionPage((page) => page + 1)}>
                      Show more
                    </button>
                  )}
                </>
              )}
            </details>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            className="card modal settings-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-head">
              <h2 id="settings-title">Settings</h2>
              <button className="ghost modal-close" type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>

            {settingsError && <p className="error" role="alert">{settingsError}</p>}

            {/* Collapsible groups keep the panel scannable; native
                details/summary so there is no tab machinery to maintain. */}
            <details className="settings-group" open>
              <summary>Recording</summary>
              <p className="subtle">
                Recording happens in the SIQshift app on each computer, so its switches — the
                consent toggle, the quiet-minutes limit, and which AI tools are connected — live
                there. This page only reads what those computers sent.
              </p>
              <DownloadInstaller />
              <button
                className="link privacy-open"
                type="button"
                onClick={() => { setSettingsOpen(false); setHelpOpen(true); }}
              >
                See exactly what&apos;s recorded — and what never is
              </button>
            </details>

            <ProjectsGroup client={client} projects={projects} onChanged={() => {
              void refreshProjects()
                .then((scopeSurvives) => (scopeSurvives ? reloadBoard() : undefined))
                .then((failure) => setSettingsError(failure))
                .catch((error: unknown) => setSettingsError(messageFor(error)));
            }} />

            {organization && (
              <details className="settings-group">
                <summary>Team</summary>
                <p className="subtle">
                  You are keeping time with <strong>{organization.name}</strong>. Anyone who enters
                  this code at sign-up joins this workspace.
                </p>
                <div className="team-code-row">
                  <code className="invite-code" data-testid="invite-code">{organization.inviteCode}</code>
                  <button className="ghost" type="button" onClick={() => void copyInviteCode()}>{copied ? "Copied" : "Copy code"}</button>
                </div>
                <form className="join-form" onSubmit={joinWorkspace}>
                  <label className="team-join-label">
                    Their invite code
                    <input
                      value={joinCode}
                      onChange={(event) => setJoinCode(event.target.value)}
                      placeholder="Join another team: ABCDE-FGHJK"
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                  </label>
                  <button className="primary" type="submit" disabled={joinBusy || joinCode.trim() === ""}>
                    {joinBusy ? "Joining…" : "Join this team"}
                  </button>
                </form>
                {joinError && <p className="error" role="alert">{joinError}</p>}
              </details>
            )}

            <button className="link" type="button" onClick={() => void signOut()}>Sign out</button>
          </section>
        </div>
      )}

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </main>
  );
};

type ShiftsTabProps = {
  shifts: AgentShiftsResponse | undefined;
  shiftsFailed: boolean;
  range: Range;
  rangeLabel: string;
  people: AgentShiftsResponse["people"];
  selected: { id: string; name: string } | undefined;
  onSelect: (person: { id: string; name: string } | undefined) => void;
  selfId: string | undefined;
};

/// The Agents tab: who ran agents, and what those agents ran. A board of the
/// people the range recorded opens it, ranked by agent time, and picking one
/// narrows everything below to their shifts. Then the recorded total, and one
/// collapsible group per codebase with its shifts inside.
///
/// A person row is a sum over shifts rather than an agent, so it carries a
/// shift count beside its hours: one row can be several agents running at
/// once rather than one worker's long day. It carries no bar, because the
/// board is deliberately computed before the filter and a pre-filter
/// numerator over the post-filter total would read past 100%.
const ShiftsTab = ({ shifts, shiftsFailed, range, rangeLabel, people, selected, onSelect, selfId }: ShiftsTabProps) => {
  // The heading names whoever the numbers below it are actually about, which
  // is the request that came back rather than the row last clicked: naming the
  // new person over the old person's total is the one way this tab can lie.
  // The board's own highlight is what acknowledges the click immediately.
  const shownId = shifts?.filters.userId;
  const shown = shownId === undefined ? undefined : people.find((person) => person.owner.id === shownId);
  return (
    <section className="member-stats" aria-labelledby="agent-shifts-title" data-testid="agent-shifts">
      {/* The head renders before anything can fail, because "All people" is
          the only way out of a filter and a filtered request that keeps
          failing would otherwise strand the tab with no control to clear it. */}
      <div className="member-stats-head">
        <h3 id="agent-shifts-title">{shown?.owner.name ?? "Agents"} · {rangeLabel}</h3>
        {selected !== undefined && (
          <button type="button" className="member-self" onClick={() => onSelect(undefined)}>
            All people
          </button>
        )}
      </div>
      {shiftsFailed && <p className="subtle">Could not load the shifts for this range.</p>}
      {!shiftsFailed && shifts === undefined && <p className="subtle" role="status">Loading…</p>}
      {!shiftsFailed && shifts !== undefined && (
        <ShiftsTabBody
          shifts={shifts}
          range={range}
          people={people}
          selected={selected}
          onSelect={onSelect}
          selfId={selfId}
        />
      )}
    </section>
  );
};

type ShiftsTabBodyProps = Omit<ShiftsTabProps, "shifts" | "shiftsFailed" | "rangeLabel"> & { shifts: AgentShiftsResponse };

/// Everything under the head: the board, the total, the graph, the drawers.
const ShiftsTabBody = ({ shifts, range, people, selected, onSelect, selfId }: ShiftsTabBodyProps) => (
  <>
    {people.length > 1 && (
      <ol className="board-list" data-testid="agent-people">
        {people.map((person, index) => (
          <li key={person.owner.id} className={person.owner.id === selected?.id ? "is-selected" : undefined}>
            <button
              type="button"
              className="board-choice"
              aria-pressed={person.owner.id === selected?.id}
              onClick={() => onSelect(
                person.owner.id === selected?.id ? undefined : { id: person.owner.id, name: person.owner.name },
              )}
            >
              <span className="board-rank">{index + 1}</span>
              <span className="board-name">
                {person.owner.name}
                {person.owner.id === selfId && <span className="you-tag"> you</span>}
              </span>
              <span className="board-times">
                <span className="board-hours">{formatHumanDuration(person.agentSeconds)}</span>
                <span className="board-agent">
                  {person.shiftCount} shift{person.shiftCount === 1 ? "" : "s"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    )}
    <p className="member-total"><strong>{formatHumanDuration(shifts.totalAgentSeconds)}</strong> recorded</p>
    <HourlyGraph buckets={hourlyFromShifts(shifts.groups, rangeBounds(range))} />
    {shifts.groups.length === 0 ? (
      <p className="subtle">No agent worked in this range.</p>
    ) : (
      <ShiftGroups groups={shifts.groups} totalAgentSeconds={shifts.totalAgentSeconds} />
    )}
  </>
);

type ProjectsGroupProps = {
  client: Client;
  projects: readonly ProjectListItem[];
  onChanged: () => void;
};

/** Rename, create, and the guarded delete: the whole management surface. */
const ProjectsGroup = ({ client, projects, onChanged }: ProjectsGroupProps) => {
  const [error, setError] = useState<string | undefined>();
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | undefined>();
  const [renameDraft, setRenameDraft] = useState("");
  const [deleting, setDeleting] = useState<{ project: ProjectListItem; usage: ProjectUsageResponse } | undefined>();
  const [reassignTo, setReassignTo] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onChanged();
    } catch (actionError: unknown) {
      setError(messageFor(actionError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="settings-group">
      <summary>Projects</summary>
      {error && <p className="error" role="alert">{error}</p>}
      {deleting === undefined ? (
        <>
          <ul className="manage-list" data-testid="project-manage-list">
            {projects.map((project) => (
              <li key={project.id} className="manage-row">
                {renamingId === project.id ? (
                  <form
                    className="manage-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const trimmed = renameDraft.trim();
                      if (trimmed === "") return;
                      void act(async () => {
                        await client.updateProject(project.id, { name: trimmed });
                        setRenamingId(undefined);
                      });
                    }}
                  >
                    <label>
                      <span className="visually-hidden">New name for {project.name}</span>
                      <input value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} maxLength={80} required />
                    </label>
                    <button type="submit" disabled={busy}>Save</button>
                    <button type="button" onClick={() => setRenamingId(undefined)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <span className="manage-name">
                      <span className="project-dot" aria-hidden="true" style={project.color == null ? undefined : { background: project.color }} />
                      {project.name}
                      {project.isDefault && <span className="you-tag"> default</span>}
                    </span>
                    <span className="manage-actions">
                      <button type="button" disabled={busy} onClick={() => { setRenamingId(project.id); setRenameDraft(project.name); }}>Rename</button>
                      {!project.isDefault && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            // A read, not a mutation: opening the dialog must
                            // not refetch the whole board.
                            setBusy(true);
                            setError(undefined);
                            void client.projectUsage(project.id).then(
                              (usage) => {
                                setBusy(false);
                                // An empty project has nothing to guard: it
                                // goes on the click. Only recorded time needs
                                // the ask.
                                if (usage.sessionCount === 0 && usage.agentSessionCount === 0 && usage.agentCount === 0) {
                                  void act(() => client.deleteProject(project.id, { reassignTo: null }));
                                  return;
                                }
                                setDeleting({ project, usage });
                                setReassignTo("");
                              },
                              (usageError: unknown) => {
                                setError(messageFor(usageError));
                                setBusy(false);
                              },
                            );
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <form
            className="manage-create"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await client.createProject(newName.trim());
                setNewName("");
              });
            }}
          >
            <label>
              <span className="visually-hidden">New project name</span>
              <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="New project…" maxLength={80} required />
            </label>
            <button className="ghost" type="submit" disabled={busy}>Create</button>
          </form>
        </>
      ) : (
        <div className="manage-delete" data-testid="project-delete-confirm">
          <p>
            Deleting <strong>{deleting.project.name}</strong> takes with it{" "}
            <strong>{deleting.usage.sessionCount} sessions</strong> ({formatHumanDuration(deleting.usage.durationSeconds)})
            and {deleting.usage.agentSessionCount} agent sessions, unless they move first.
          </p>
          {deleting.usage.agentCount > 0 && (
            <p className="subtle">
              {deleting.usage.agentCount} roster {deleting.usage.agentCount === 1 ? "agent moves" : "agents move"} with it,
              or retires where another agent already works the destination.
            </p>
          )}
          <label>
            What happens to its sessions?
            <select value={reassignTo} onChange={(event) => setReassignTo(event.target.value)}>
              <option value="">Delete them with the project</option>
              {projects.filter((project) => project.id !== deleting.project.id).map((project) => (
                <option key={project.id} value={project.id}>Move to {project.name}</option>
              ))}
            </select>
          </label>
          <div className="manage-actions">
            <button
              className="ghost is-danger"
              type="button"
              disabled={busy}
              onClick={() => void act(async () => {
                await client.deleteProject(deleting.project.id, { reassignTo: reassignTo === "" ? null : reassignTo });
                setDeleting(undefined);
              })}
            >
              Delete {deleting.project.name}
            </button>
            <button className="ghost" type="button" disabled={busy} onClick={() => setDeleting(undefined)}>Cancel</button>
          </div>
        </div>
      )}
    </details>
  );
};
