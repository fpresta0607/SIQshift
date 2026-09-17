// A backlog uploaded days late, through the real route, SQL and connection
// pool. The staleness rule now lives in three CASE expressions and the project
// lane in a join on the roster, and a mocked repository can fail neither; the
// batch also writes its shifts side by side, which only a real pool exercises.
import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@siqshift/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import {
  DrizzleAccountStore,
  DrizzleAgentRepository,
  DrizzleAgentSessionRepository,
  DrizzlePathMappingRepository,
  DrizzleProjectRepository,
  DrizzleReportRepository,
  DrizzleSessionRepository,
} from "./drizzle-repositories.js";
import { parseEnv } from "./env.js";
import { createTestAuth } from "./test-tokens.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

const minutes = (count: number): number => count * 60_000;

integration("a late agent backlog over a real database", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  let app: ReturnType<typeof createApp>;
  let headers: Record<string, string>;
  let projectId: string;
  // Two days ago, well inside the retention window and far outside the reaper's.
  const origin = Date.now() - minutes(2 * 24 * 60);
  const at = (offsetMinutes: number): string => new Date(origin + minutes(offsetMinutes)).toISOString();

  // The disposable client hands timestamps back as text; read them as the ISO
  // instants the events carried so a comparison is exact.
  const iso = (column: string) => database.client.unsafe(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  const upload = async (events: Record<string, unknown>[]): Promise<void> => {
    const response = await app.request("/agent-sessions", { method: "POST", headers, body: JSON.stringify({ events }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { results: { accepted: boolean }[] };
    expect(body.results.every((result) => result.accepted)).toBe(true);
  };
  const shift = async (externalSessionId: string) => {
    const rows = await database.client<{ status: string; started_at: string; ended_at: string | null; last_event_at: string; project_id: string | null; model: string | null }[]>`
      select status, ${iso("started_at")} started_at, ${iso("ended_at")} ended_at, ${iso("last_event_at")} last_event_at, project_id, model
      from agent_sessions where external_session_id = ${externalSessionId}
    `;
    return rows[0];
  };

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "agent_backlog");
    database = disposable.database;
    const config = parseEnv({
      DATABASE_URL: disposable.databaseUrl,
      AUTH_BASE_URL: "https://auth.siqshift.test/neondb/auth",
      NODE_ENV: "test",
    });
    await runMigrations(database);
    const auth = await createTestAuth(config, new Date());
    headers = {
      authorization: await auth.bearer(randomUUID(), { email: "backlog@siqshift.test", name: "Backlog Operator" }),
      "content-type": "application/json",
    };
    app = createApp({
      config,
      keys: auth.keys,
      accounts: new DrizzleAccountStore(database.db),
      projectRepository: new DrizzleProjectRepository(database.db),
      sessionRepository: new DrizzleSessionRepository(database.db),
      reportRepository: new DrizzleReportRepository(database.db),
      agentRepository: new DrizzleAgentRepository(database.db),
      agentSessionRepository: new DrizzleAgentSessionRepository(database.db),
      pathMappingRepository: new DrizzlePathMappingRepository(database.db),
    });
    await app.request("/me", { headers });
    const projects = (await (await app.request("/projects", { headers })).json()).projects as { id: string }[];
    projectId = projects[0]!.id;
    const mapping = await app.request("/path-mappings", { method: "POST", headers, body: JSON.stringify({ pathPrefix: "C:/dev", projectId }) });
    expect(mapping.status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  it("ends each shift at its last event before a gap past the staleness window, whatever arrives in the same batch", async () => {
    const cwd = "C:/dev/app/.worktrees/goblin";
    await upload([
      // Start, one model heartbeat, then silence until an end a day and a half later.
      { source: "claude_code", externalSessionId: "gate", event: "started", occurredAt: at(0), cwd },
      { source: "claude_code", externalSessionId: "gate", event: "heartbeat", occurredAt: at(1), cwd, model: "claude-opus-5" },
      { source: "claude_code", externalSessionId: "gate", event: "ended", occurredAt: at(36 * 60), cwd },
      // A session resumed hours later under the same id.
      { source: "claude_code", externalSessionId: "resumed", event: "started", occurredAt: at(0), cwd },
      { source: "claude_code", externalSessionId: "resumed", event: "heartbeat", occurredAt: at(20), cwd },
      { source: "claude_code", externalSessionId: "resumed", event: "started", occurredAt: at(15 * 60), cwd },
      // Beats every 25 minutes: one shift throughout.
      { source: "claude_code", externalSessionId: "steady", event: "started", occurredAt: at(0), cwd },
      { source: "claude_code", externalSessionId: "steady", event: "heartbeat", occurredAt: at(25), cwd },
      { source: "claude_code", externalSessionId: "steady", event: "heartbeat", occurredAt: at(50), cwd },
      { source: "claude_code", externalSessionId: "steady", event: "ended", occurredAt: at(75), cwd },
    ]);

    expect(await shift("gate")).toMatchObject({ status: "ended", ended_at: at(1), last_event_at: at(1), model: "claude-opus-5" });
    expect(await shift("resumed")).toMatchObject({ status: "ended", ended_at: at(20), last_event_at: at(20) });
    expect(await shift("steady")).toMatchObject({ status: "ended", ended_at: at(75), project_id: projectId });
  }, 120_000);

  it("still fills a model on a closed shift from a heartbeat that arrives after its end", async () => {
    const cwd = "C:/dev/app";
    await upload([
      { source: "claude_code", externalSessionId: "short", event: "started", occurredAt: at(0), cwd },
      { source: "claude_code", externalSessionId: "short", event: "ended", occurredAt: at(5), cwd },
    ]);
    await upload([{ source: "claude_code", externalSessionId: "short", event: "heartbeat", occurredAt: at(6), cwd, model: "claude-fable-5-1" }]);

    expect(await shift("short")).toMatchObject({ status: "ended", ended_at: at(5), model: "claude-fable-5-1" });
  }, 120_000);

  it("places a gate worktree shift through the operator's own shifts of the same repository", async () => {
    const gate = "C:/Users/op/.no-mistakes/worktrees/3946e592fa2c/01M244TFYBDE1JF7DNGW0H8Y1P";
    await upload([
      { source: "claude_code", externalSessionId: "checkout", event: "started", occurredAt: at(0), cwd: "C:/dev/precisiondocs", repoRoot: "C:/dev/precisiondocs", repoRemote: "https://github.com/acme/PrecisionDocs-AI.git" },
    ]);
    await upload([
      { source: "codex", externalSessionId: "reviewer", event: "started", occurredAt: at(2), cwd: gate, repoRoot: gate, repoRemote: "git@github.com:acme/precisiondocs-ai.git" },
      { source: "claude_code", externalSessionId: "unplaced", event: "started", occurredAt: at(2), cwd: gate, repoRoot: gate, repoRemote: "https://github.com/acme/elsewhere" },
    ]);

    expect(await shift("reviewer")).toMatchObject({ project_id: projectId });
    expect(await shift("unplaced")).toMatchObject({ project_id: null });
  }, 120_000);

  it("writes a full 500-event batch of interleaved shifts to the same rows it would write one at a time", async () => {
    const cwd = "C:/dev/fleet";
    const events = [0, 10, 20, 30].flatMap((offset, step) => Array.from({ length: 125 }, (_, index) => ({
      source: "claude_code",
      externalSessionId: `fleet-${index}`,
      event: step === 0 ? "started" : step === 3 ? "ended" : "heartbeat",
      occurredAt: at(offset + index),
      cwd,
    })));

    await upload(events);

    const rows = await database.client<{ external_session_id: string; status: string; started_at: string; ended_at: string }[]>`
      select external_session_id, status, ${iso("started_at")} started_at, ${iso("ended_at")} ended_at
      from agent_sessions where external_session_id like 'fleet-%'
    `;
    expect(rows).toHaveLength(125);
    for (const row of rows) {
      const index = Number(row.external_session_id.slice("fleet-".length));
      expect(row).toMatchObject({ status: "ended", started_at: at(index), ended_at: at(30 + index) });
    }
  }, 120_000);
});
