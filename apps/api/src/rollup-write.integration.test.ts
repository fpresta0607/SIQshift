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

// A refresh clears the days it is about to fold, reads, then writes - three
// separate steps - and two refreshes of one day interleave routinely, because
// the desktop posts activity and agent events concurrently and teammates upload
// on their own. So the second write meets rows the first already inserted under
// user_daily_rollups_organization_user_day_unique, and which of them arrives
// last says nothing about which of them saw more.
//
// Both halves of that are SQL: the conflict resolution and the `computed_at`
// comparison that decides it. A plain insert raised instead, and the caller
// swallows the error, leaving the day on the older fold's numbers with nothing
// scheduled to correct it - the stale-cache outcome the clear-before-fold
// ordering exists to rule out. So this runs the real writes against a real
// PostgreSQL server, in both arrival orders.
integration("daily rollup writes", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const subject: AuthenticatedSubject = { organizationId, userId, role: "member" };
  const day = new Date("2026-08-05T00:00:00.000Z");
  let repository: DrizzleUserDailyRollupRepository;

  /** One member's day, as a refresh that read its intervals at `computedAt` folded it. */
  const fold = (activeMs: number, computedAt: string) => ({
    userId,
    day,
    activeMs,
    agentMs: 0,
    concurrency0Ms: activeMs,
    concurrency1Ms: 0,
    concurrency2Ms: 0,
    concurrency3PlusMs: 0,
    awayMs: 0,
    computedAt: new Date(computedAt),
  });

  const storedActiveMs = async (): Promise<number | undefined> => {
    const rows = await repository.readForRange(subject, day, new Date(day.getTime() + 24 * 60 * 60 * 1_000));
    return rows[0]?.activeMs;
  };

  const earlierRead = "2026-08-06T09:00:00.000Z";
  const laterRead = "2026-08-06T09:00:02.000Z";

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

  it("keeps the fold that read last, whichever of the two writes lands last", async () => {
    // Arrival order matching read order: the later read simply wins.
    await repository.writeDays(subject, [fold(3_600_000, earlierRead)]);
    await expect(repository.writeDays(subject, [fold(7_200_000, laterRead)])).resolves.toBeUndefined();
    expect(await storedActiveMs()).toBe(7_200_000);

    // And the interleaving the ordering exists for: A cleared and read, B
    // cleared and read after A did, B wrote, and only now does A's write land.
    // A never saw the rows B did, so it must not stand over them.
    await repository.clearDays(subject, [day]);
    await repository.writeDays(subject, [fold(7_200_000, laterRead)]);
    await expect(repository.writeDays(subject, [fold(3_600_000, earlierRead)])).resolves.toBeUndefined();

    expect(await storedActiveMs()).toBe(7_200_000);
  });

  it("folds a day again when the same refresh re-reads it later", async () => {
    await repository.clearDays(subject, [day]);
    await repository.writeDays(subject, [fold(3_600_000, earlierRead)]);

    // Not contention: the ordinary case of a day being refolded because new
    // evidence arrived for it. A later read always replaces an earlier one.
    await repository.writeDays(subject, [fold(1_800_000, laterRead)]);

    expect(await storedActiveMs()).toBe(1_800_000);
  });

  /**
   * The two check constraints the read path leans on, exercised as constraints:
   * what matters is what the database refuses, and only the database can say.
   */
  describe("the invariants the table holds itself to", () => {
    const insert = (overrides: { day: string; activeMs: number; buckets: [number, number, number, number] }) =>
      database.client`
        insert into user_daily_rollups (
          organization_id, user_id, day, active_ms, agent_ms,
          concurrency_0_ms, concurrency_1_ms, concurrency_2_ms, concurrency_3_plus_ms, away_ms
        ) values (
          ${organizationId}, ${userId}, ${overrides.day}, ${overrides.activeMs}, 0,
          ${overrides.buckets[0]}, ${overrides.buckets[1]}, ${overrides.buckets[2]}, ${overrides.buckets[3]}, 0
        )
      `;

    it("refuses a day that is not midnight UTC, because it would fold against the wrong boundary", async () => {
      await expect(insert({ day: "2026-08-09T12:00:00.000Z", activeMs: 60_000, buckets: [60_000, 0, 0, 0] }))
        .rejects.toThrow(/user_daily_rollups_day_is_utc_midnight/);

      // The same row on the boundary is accepted, so the constraint is refusing
      // the offset rather than the insert.
      await expect(insert({ day: "2026-08-09T00:00:00.000Z", activeMs: 60_000, buckets: [60_000, 0, 0, 0] }))
        .resolves.toBeDefined();
    });

    it("refuses buckets that do not partition the active time they split", async () => {
      await expect(insert({ day: "2026-08-10T00:00:00.000Z", activeMs: 60_000, buckets: [30_000, 0, 0, 0] }))
        .rejects.toThrow(/user_daily_rollups_concurrency_partitions_active/);

      // Over-counting is refused too: the buckets must sum to active time, not
      // merely stay under it.
      await expect(insert({ day: "2026-08-10T00:00:00.000Z", activeMs: 60_000, buckets: [30_000, 30_000, 1, 0] }))
        .rejects.toThrow(/user_daily_rollups_concurrency_partitions_active/);

      await expect(insert({ day: "2026-08-10T00:00:00.000Z", activeMs: 60_000, buckets: [30_000, 20_000, 10_000, 0] }))
        .resolves.toBeDefined();
    });
  });
});
