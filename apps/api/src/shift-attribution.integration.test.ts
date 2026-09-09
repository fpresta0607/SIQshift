// A shift worked in a per-run worktree names its codebase from its roster
// identity's repository, and that identity reaches the report only through the
// interval read's `leftJoin(agents)`. A mocked repository cannot fail that
// join, so this exercises it against a real PostgreSQL server: without the
// join the group comes back with no codebase at all, the collapsed
// "No codebase recorded" bucket this attribution fixed.
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
  DrizzleActivitySegmentRepository,
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

integration("shifts map attribution over a real database", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  const authUserId = randomUUID();
  let app: ReturnType<typeof createApp>;
  let headers: Record<string, string>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "shift_attribution");
    database = disposable.database;
    const config = parseEnv({
      DATABASE_URL: disposable.databaseUrl,
      AUTH_BASE_URL: "https://auth.siqshift.test/neondb/auth",
      NODE_ENV: "test",
    });
    await runMigrations(database);
    const auth = await createTestAuth(config, new Date());
    headers = {
      authorization: await auth.bearer(authUserId, { email: "shifts@siqshift.test", name: "Shift Reader" }),
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
      activitySegmentRepository: new DrizzleActivitySegmentRepository(database.db),
    });
  }, 120_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  it("names a gate-worktree shift by its roster identity's repository", async () => {
    const me = await app.request("/me", { headers });
    expect(me.status).toBe(200);
    const { user } = await me.json() as { user: { id: string; name: string; organizationId: string } };

    // A no-mistakes gate worktree: the path names only the run, and the roster
    // identity the runtime minted for this shift is keyed on the remote.
    const runWorktree = "C:/Users/fpres/.no-mistakes/worktrees/3946e592fa2c/01M1ZNNGRXGEJ0B31V2MJTY7BX";
    const agentId = randomUUID();
    await database.client`
      insert into agents (id, organization_id, owner_user_id, project_id, repo_root, repo_key, source, name, status)
      values (
        ${agentId}, ${user.organizationId}, ${user.id}, null, ${runWorktree},
        'github.com/fpresta0607/precisiondocs-ai', 'claude_code', 'Claude Code @ precisiondocs-ai', 'anonymous'
      )
    `;

    const endedAt = new Date(Date.now() - 30_000);
    const startedAt = new Date(endedAt.getTime() - 3_600_000);
    await database.client`
      insert into agent_sessions (
        id, organization_id, user_id, agent_id, source, external_session_id, model,
        project_id, cwd, rule_id, status, started_at, ended_at, last_event_at,
        linked_session_id, received_at
      ) values (
        ${randomUUID()}, ${user.organizationId}, ${user.id}, ${agentId}, 'claude_code', ${randomUUID()}, 'claude-opus-5',
        null, ${runWorktree}, null, 'ended', ${startedAt.toISOString()}, ${endedAt.toISOString()}, ${endedAt.toISOString()},
        null, ${endedAt.toISOString()}
      )
    `;

    const response = await app.request("/reports/agent-shifts", { headers });

    expect(response.status).toBe(200);
    const body = await response.json() as { groups: { repo: string | null; nullCause?: string | null; shiftCount: number }[] };
    expect(body.groups).toContainEqual(expect.objectContaining({ repo: "precisiondocs-ai", nullCause: null, shiftCount: 1 }));
  }, 120_000);
});
