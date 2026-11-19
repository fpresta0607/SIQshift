import { agentRuntimeLabel } from "./agent-runtimes.js";
import { LiveSessionTile, type LiveSessionRow } from "./live-session-tile.js";

/** One runtime's running sessions, headed by its name and how many there are. */
export const LiveRuntimeGroup = ({
  source,
  sessions,
  now,
}: {
  source: string;
  sessions: readonly LiveSessionRow[];
  now: number;
}) => (
  <section className="live-runtime" data-testid={`live-runtime-${source}`}>
    <h5 className="live-runtime-head">
      {agentRuntimeLabel(source)}{" "}
      <span className="live-runtime-count">{sessions.length}</span>
    </h5>
    <ul className="live-tile-list">
      {sessions.map((session) => <LiveSessionTile key={session.id} session={session} now={now} />)}
    </ul>
  </section>
);
