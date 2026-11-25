import { agentRuntimeLabel } from "./agent-runtimes.js";
import { LiveRuntimeGroup } from "./live-runtime-group.js";
import { type LiveSessionRow } from "./live-session-tile.js";
import { MemberAvatar } from "./member-avatar.js";

export type { LiveSessionRow } from "./live-session-tile.js";

/** One person's running sessions, as both apps' Live now cards render them. */
export type LivePersonGroup = {
  owner: { id: string; name: string };
  sessions: readonly LiveSessionRow[];
};

const earliestFirst = (a: LiveSessionRow, b: LiveSessionRow): number =>
  (a.startedAt ?? "9999").localeCompare(b.startedAt ?? "9999") || a.id.localeCompare(b.id);

/// The busiest runtime first, then by name, so the order never shuffles between reads.
const groupByRuntime = (sessions: readonly LiveSessionRow[]): { source: string; sessions: LiveSessionRow[] }[] => {
  const bySource = new Map<string, LiveSessionRow[]>();
  for (const session of [...sessions].sort(earliestFirst)) {
    bySource.set(session.source, [...(bySource.get(session.source) ?? []), session]);
  }
  return [...bySource]
    .map(([source, grouped]) => ({ source, sessions: grouped }))
    .sort((a, b) => b.sessions.length - a.sessions.length || agentRuntimeLabel(a.source).localeCompare(agentRuntimeLabel(b.source)));
};

/**
 * The dashboard's Live now card: who is running an agent right now, and what
 * each one is doing. The server sends only people with at least
 * one running session, so nobody stale can appear here, and an empty roster
 * is the honest "nothing is running" - not an absence to be papered over.
 *
 * Sessions are grouped by runtime and drawn as tiles. Where the response holds
 * more than one person, each person's runtimes sit under their name, and with
 * one person the name is left out because the page already says whose it is.
 * The apps re-read on their minute tick, which keeps each duration fresh.
 */
export const LiveSessions = ({
  people,
  pictureOf,
}: {
  people: readonly LivePersonGroup[];
  /// A member's picture as a data URL, where the caller has it; initials stand in otherwise.
  pictureOf?: ((id: string) => string | undefined) | undefined;
}) => {
  if (people.length === 0) {
    return (
      <p className="subtle live-sessions-empty" data-testid="live-sessions-empty">
        No agent is running right now.
      </p>
    );
  }
  const now = Date.now();
  const [onlyPerson, ...otherPeople] = people;
  const runtimeGroups = (sessions: readonly LiveSessionRow[]) =>
    groupByRuntime(sessions).map((group) => <LiveRuntimeGroup key={group.source} source={group.source} sessions={group.sessions} now={now} />);
  return (
    <section className="live-sessions" data-testid="live-sessions" aria-label="Agents running now">
      {onlyPerson !== undefined && otherPeople.length === 0
        ? runtimeGroups(onlyPerson.sessions)
        : people.map((person) => (
          <div key={person.owner.id} className="live-person">
            <div className="live-person-head">
              <MemberAvatar id={person.owner.id} name={person.owner.name} picture={pictureOf?.(person.owner.id)} />
              <span className="live-person-name">{person.owner.name}</span>
            </div>
            {runtimeGroups(person.sessions)}
          </div>
        ))}
    </section>
  );
};
