import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@siqshift/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "./auth.js";
import { DrizzleUserDailyRollupRepository } from "./drizzle-repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

// A refresh clears the days it is about to fold, reads, then writes - and two
// refreshes of one day interleave routinely, because the desktop posts activity
// and agent events concurrently and teammates upload on their own. When they
// do, the second write meets rows the first already inserted under
// user_daily_rollups_organization_user_day_unique. A plain insert raises there,
// and the caller swallows the error, leaving the day standing on the older
// fold's numbers with nothing scheduled to correct it - exactly the stale-cache
// outcome the clear-before-fold ordering exists to rule out. Only a real
// PostgreSQL server can show which of those two happens, so this writes the
// same day twice against one.
integration("daily rollup writes", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const subject: AuthenticatedSubject = { organizationId, userId, role: "member" };
  const day = new Date("2026-08-05T00:00:00.000Z");
  let repository: DrizzleUserDailyRollupRepository;

  const fold = (activeMs: number, agentMs: number) => ({
    userId,
    day,
    activeMs,
    agentMs,
    concurrency0Ms: activeMs,
    concurrency1Ms: 0,
    concurrency2Ms: 0,
    concurrency3PlusMs: 0,
    awayMs: agentMs,
  });

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "rollup_write");
    database = disposable.database;
    await runMigrations(database);
    await database.client`
      insert into organizations (id, name, invite_code)
      values (${organizationId}, 'Rollup Test', ${randomUUID().slice(0, 11)})
    `;
    await database.client`
      insert into users (id, organization_id, email, name, role)
      values (${userId}, ${organizationId}, 'rollup@siqshift.test', 'Rollup User', 'member')
    `;
    repository = new DrizzleUserDailyRollupRepository(database.db);
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  it("lets the later fold of a day overwrite the earlier one rather than failing on it", async () => {
    await repository.writeDays(subject, [fold(3_600_000, 600_000)]);

    // The interleaved refresh: it never saw a row to clear, and folds the same
    // day from data the first one was too early to read.
    await expect(repository.writeDays(subject, [fold(7_200_000, 900_000)])).resolves.toBeUndefined();

    const stored = await repository.readForRange(subject, day, new Date(day.getTime() + 24 * 60 * 60 * 1_000));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ activeMs: 7_200_000, agentMs: 900_000, concurrency0Ms: 7_200_000, awayMs: 900_000 });
  });
});
