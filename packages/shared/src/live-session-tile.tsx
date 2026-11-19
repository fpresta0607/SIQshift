import { codebaseDisplayName, modelDisplayName } from "./live-session-labels.js";
import { formatHumanDuration } from "./time.js";

/** One running session, as the Live now card draws it. */
export type LiveSessionRow = {
  id: string;
  source: string;
  /** The codebase the session works in, when one is known. */
  repo: string | null;
  /** The project the session's attribution resolved to, when one did. */
  project: { id: string; name: string } | null;
  model: string | null;
  /** Null from a desktop too old to say. */
  startedAt: string | null;
  /** Null when no event has said yet, or from a desktop too old to say. */
  state: "working" | "waiting" | null;
};

const STATE_LABELS = { working: "Working", waiting: "Waiting" } as const;

/**
 * One session as a tile: its codebase, its model, how long it has run and
 * whether it is working or waiting. Nothing is cut short, so a long name wraps.
 */
export const LiveSessionTile = ({ session, now }: { session: LiveSessionRow; now: number }) => {
  const codebase = session.repo ?? session.project?.name ?? null;
  const model = modelDisplayName(session.source, session.model);
  const runningSeconds = session.startedAt === null ? null : (now - Date.parse(session.startedAt)) / 1_000;
  return (
    <li className="live-tile">
      <span className="live-tile-codebase">{codebase === null ? "No codebase" : codebaseDisplayName(codebase)}</span>
      {model !== null && <span className="live-tile-model">{model}</span>}
      <span className="live-tile-facts">
        {runningSeconds !== null && <span className="live-tile-running">Running {formatHumanDuration(runningSeconds)}</span>}
        {session.state !== null && (
          <span className={`live-tile-state is-${session.state}`}>
            <span className={session.state === "working" ? "live-pulse" : "live-dot"} aria-hidden="true" />
            {STATE_LABELS[session.state]}
          </span>
        )}
      </span>
    </li>
  );
};
