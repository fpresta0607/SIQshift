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

// Regression for the production leaderboard 500: readAgentIntervals bound the
// `from` range bound as a bare Date on the right of a raw sql`` fragment, which
// strips drizzle's Date mapping and makes postgres-js refuse the query. The fix
// serializes the bound as an ISO string, like every other report range bound.
// This runs the real leaderboard endpoint against a real PostgreSQL server so
// the driver-level serialization is actually exercised.
//
// It guards the class, not the one line: every raw-fragment range bound the
// board touches has to survive the same request. `readMedianSessionSeconds`
// clips its lengths with `greatest`/`least` over the same two bounds and made
// the same mistake, and a unit test cannot see it because a faked repository
// never reaches a driver.
integration("leaderboard agent-interval range binding", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  const authUserId = randomUUID();
  let app: ReturnType<typeof createApp>;
  let headers: Record<string, string>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "agent_interval_regression");
    database = disposable.database;
    const config = parseEnv({
      DATABASE_URL: disposable.databaseUrl,
      AUTH_BASE_URL: "https://auth.siqshift.test/neondb/auth",
      NODE_ENV: "test",
    });
    await runMigrations(database);

    const auth = await createTestAuth(config, new Date());
    headers = {
      authorization: await auth.bearer(authUserId, { email: "regression@siqshift.test", name: "Regression User" }),
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
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  it("returns the leaderboard with a from bound instead of 500ing", async () => {
    const me = await app.request("/me", { headers });
    expect(me.status).toBe(200);
    const { user } = await me.json();

    const endedAt = new Date(Date.now() - 30_000);
    const startedAt = new Date(endedAt.getTime() - 3_600_000);
    // A stopped session inside the range, so the board's median is measured
    // rather than null - the median clips with its own raw-fragment bounds.
    const projectId = randomUUID();
    await database.client`
      insert into projects (id, organization_id, name)
      values (${projectId}, ${user.organizationId}, 'Median Test')
    `;
    await database.client`
      insert into project_memberships (organization_id, project_id, user_id)
      values (${user.organizationId}, ${projectId}, ${user.id})
    `;
    const sessionStoppedAt = new Date(Date.now() - 60_000);
    const sessionStartedAt = new Date(sessionStoppedAt.getTime() - 1_800_000);
    await database.client`
      insert into time_sessions (
        id, organization_id, user_id, project_id, client_id, status,
        started_at, stopped_at, idle_seconds, duration_seconds, attribution
      ) values (
        ${randomUUID()}, ${user.organizationId}, ${user.id}, ${projectId}, ${randomUUID()}, 'stopped',
        ${sessionStartedAt.toISOString()}, ${sessionStoppedAt.toISOString()}, 0, 1800, 'manual'
      )
    `;
    await database.client`
      insert into agent_sessions (
        id, organization_id, user_id, source, external_session_id, model,
        project_id, cwd, rule_id, status, started_at, ended_at, last_event_at,
        linked_session_id, received_at
      ) values (
        ${randomUUID()}, ${user.organizationId}, ${user.id}, 'claude_code', ${randomUUID()}, null,
        null, null, null, 'ended', ${startedAt.toISOString()}, ${endedAt.toISOString()}, ${endedAt.toISOString()},
        null, ${endedAt.toISOString()}
      )
    `;

    const fromAt = new Date(Date.now() - 7_200_000).toISOString();
    const toExclusiveAt = new Date(Date.now() + 3_600_000).toISOString();
    const response = await app.request(
      `/reports/leaderboard?fromAt=${encodeURIComponent(fromAt)}&toExclusiveAt=${encodeURIComponent(toExclusiveAt)}`,
      { headers },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toContainEqual(expect.objectContaining({
      user: { id: user.id, name: user.name },
      agentSeconds: 3_600,
    }));
    // The whole half-hour sits inside the range, so clipping leaves it whole.
    expect(body.medianSessionSeconds).toBe(1_800);
  }, 60_000);
});
