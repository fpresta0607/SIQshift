import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@siqshift/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "./auth.js";
import { DrizzleAgentRepository, DrizzleAgentUsageRepository, DrizzleReportRepository } from "./drizzle-repositories.js";
import type { AgentUsageSessionTotalsRecord } from "./repositories.js";
import { createReportService } from "./services/reports.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

/** A row's sums as numbers, whatever type the driver hands a sum back in. */
const asNumbers = (row: AgentUsageSessionTotalsRecord) => ({
  agentSessionId: row.agentSessionId,
  userId: row.userId,
  source: row.source,
  externalSessionId: row.externalSessionId,
  inputTokens: Number(row.inputTokens),
  outputTokens: Number(row.outputTokens),
  cacheCreationInputTokens: Number(row.cacheCreationInputTokens),
  cacheReadInputTokens: Number(row.cacheReadInputTokens),
});

// The Agents tab totals each repo and runtime from per-session sums. Only a
// real PostgreSQL proves the grouping, the scopes read through the shift and
// the range read on the bucket start, and that a continuation shift the board
// holds finds the usage the desktop filed under the session it continues.
integration("token usage summed per agent session", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  let usage: DrizzleAgentUsageRepository;

  async function workspace(label: string): Promise<{ subject: AuthenticatedSubject; agentId: string }> {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const agentId = randomUUID();
    await database.client`
      insert into organizations (id, name, invite_code)
      values (${organizationId}, ${label}, ${randomUUID().slice(0, 11)})
    `;
    await database.client`
      insert into users (id, organization_id, email, name, role)
      values (${userId}, ${organizationId}, ${`${userId}@siqshift.test`}, 'Usage User', 'member')
    `;
    await database.client`
      insert into agents (id, organization_id, owner_user_id, project_id, source, name, status)
      values (${agentId}, ${organizationId}, ${userId}, null, 'claude_code', 'Claude Code', 'anonymous')
    `;
    return { subject: { organizationId, userId, role: "member" }, agentId };
  }

  async function shift(
    owner: { subject: AuthenticatedSubject; agentId: string },
    externalSessionId: string,
    projectId: string | null,
    startedAt: string,
    endedAt: string,
  ): Promise<string> {
    const id = randomUUID();
    await database.client`
      insert into agent_sessions (
        id, organization_id, user_id, source, external_session_id, model, project_id, cwd, rule_id, agent_id,
        status, started_at, ended_at, last_event_at
      )
      values (
        ${id}, ${owner.subject.organizationId}, ${owner.subject.userId}, 'claude_code', ${externalSessionId}, null, ${projectId},
        'C:/dev/siqshift', null, ${owner.agentId}, 'ended', ${startedAt}, ${endedAt}, ${endedAt}
      )
    `;
    return id;
  }

  async function bucket(
    owner: { subject: AuthenticatedSubject; agentId: string },
    sessionId: string,
    bucketStartAt: string,
    tokens: { input: number; output: number; cacheCreation: number; cacheRead: number },
  ): Promise<void> {
    await database.client`
      insert into agent_usage (
        id, organization_id, user_id, agent_id, agent_session_id, client_id, bucket_start_at, model, sidechain,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
      )
      values (
        ${randomUUID()}, ${owner.subject.organizationId}, ${owner.subject.userId}, ${owner.agentId}, ${sessionId}, ${randomUUID()},
        ${bucketStartAt}, 'claude-opus-5', false, ${tokens.input}, ${tokens.output}, ${tokens.cacheCreation}, ${tokens.cacheRead}
      )
    `;
  }

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "agent_usage_sessions");
    database = disposable.database;
    await runMigrations(database);
    usage = new DrizzleAgentUsageRepository(database.db);
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  it("sums each session's buckets inside the range, scoped through the shift's project", async () => {
    // Arrange
    const owner = await workspace("Usage Sums Test");
    const projectId = randomUUID();
    await database.client`
      insert into projects (id, organization_id, name) values (${projectId}, ${owner.subject.organizationId}, 'Usage Project')
    `;
    const tied = await shift(owner, "tied-session", projectId, "2026-08-05T22:00:00.000Z", "2026-08-06T11:00:00.000Z");
    const unassigned = await shift(owner, "unassigned-session", null, "2026-08-06T11:00:00.000Z", "2026-08-06T12:00:00.000Z");
    await bucket(owner, tied, "2026-08-05T23:00:00.000Z", { input: 5_000, output: 500, cacheCreation: 50, cacheRead: 50_000 });
    await bucket(owner, tied, "2026-08-06T09:00:00.000Z", { input: 100, output: 10, cacheCreation: 1, cacheRead: 1_000 });
    await bucket(owner, tied, "2026-08-06T10:00:00.000Z", { input: 200, output: 20, cacheCreation: 2, cacheRead: 2_000 });
    await bucket(owner, unassigned, "2026-08-06T11:00:00.000Z", { input: 7, output: 3, cacheCreation: 0, cacheRead: 0 });
    const range = { from: new Date("2026-08-06T00:00:00.000Z"), toExclusive: new Date("2026-08-07T00:00:00.000Z") };
    const tiedKey = { agentSessionId: tied, userId: owner.subject.userId, source: "claude_code", externalSessionId: "tied-session" };
    const unassignedKey = { agentSessionId: unassigned, userId: owner.subject.userId, source: "claude_code", externalSessionId: "unassigned-session" };

    // Act
    const [everything, inProject, withNoProject, allTime] = await Promise.all([
      usage.sumBySession(owner.subject, range),
      usage.sumBySession(owner.subject, { ...range, projectId }),
      usage.sumBySession(owner.subject, { ...range, unassignedOnly: true }),
      usage.sumBySession(owner.subject, {}),
    ]);

    // Assert: the 23:00 bucket the night before starts outside the range, so
    // only an unbounded read counts it.
    const tiedInRange = { ...tiedKey, inputTokens: 300, outputTokens: 30, cacheCreationInputTokens: 3, cacheReadInputTokens: 3_000 };
    const unassignedInRange = { ...unassignedKey, inputTokens: 7, outputTokens: 3, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    expect(everything.map(asNumbers)).toEqual(expect.arrayContaining([tiedInRange, unassignedInRange]));
    expect(everything).toHaveLength(2);
    expect(inProject.map(asNumbers)).toEqual([tiedInRange]);
    expect(withNoProject.map(asNumbers)).toEqual([unassignedInRange]);
    expect(allTime.map(asNumbers)).toEqual(expect.arrayContaining([
      { ...tiedKey, inputTokens: 5_300, outputTokens: 530, cacheCreationInputTokens: 53, cacheReadInputTokens: 53_000 },
      unassignedInRange,
    ]));
  });

  it("credits a session's tokens to the continuation shift a day's board holds when its own shift ended the night before", async () => {
    // Arrange: the session ends at 22:40 and `claude --continue` resumes it
    // the next morning, which the desktop records as `<session id>~<unix start>`
    // while it keeps filing the session's tokens under the session's own row.
    const owner = await workspace("Continuation Test");
    const resumedAt = "2026-08-06T09:00:00.000Z";
    const own = await shift(owner, "resumed-session", null, "2026-08-05T20:00:00.000Z", "2026-08-05T22:40:00.000Z");
    await shift(owner, `resumed-session~${Date.parse(resumedAt) / 1_000}`, null, resumedAt, "2026-08-06T11:00:00.000Z");
    await bucket(owner, own, resumedAt, { input: 1_200_000, output: 500_000, cacheCreation: 100_000, cacheRead: 200_000 });
    const service = createReportService({
      reports: new DrizzleReportRepository(database.db),
      agents: new DrizzleAgentRepository(database.db),
      agentUsage: usage,
    });

    // Act
    const result = await service.agentShifts(owner.subject, {
      fromAt: "2026-08-06T00:00:00.000Z",
      toExclusiveAt: "2026-08-07T00:00:00.000Z",
    });

    // Assert
    expect(result.groups.map((group) => [group.repo, group.shiftCount, group.tokens])).toEqual([["siqshift", 1, 2_000_000]]);
    expect(result.runtimes).toEqual([{ source: "claude_code", agentSeconds: 7_200, shiftCount: 1, tokens: 2_000_000 }]);
    expect(result.tokenTotals).toEqual({ tokensIn: 1_500_000, tokensOut: 500_000, tokens: 2_000_000 });
  });
});
