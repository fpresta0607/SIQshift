import { randomUUID } from "node:crypto";

import {
  activitySegments,
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@siqshift/database";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "./auth.js";
import { DrizzleActivitySegmentRepository, DrizzleUserDailyRollupRepository } from "./drizzle-repositories.js";
import type { ActivitySegmentInsert } from "./repositories.js";
import { DAY_MS } from "./services/utc-days.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

// The irreversible half of the retention change is three statements, and every
// service-level test around them drives a fake that re-implements the contract
// in TypeScript. That proves the sweep's use of the contract and never that the
// SQL honours it - which is the wrong way round, because a wrong predicate here
// deletes evidence that does not come back. So the delete window, the hole walk
// that gates it, and the affected-row count an operator reads before trusting a
// first run all run against a real PostgreSQL server.
integration("the retention sweep's SQL", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  let segments: DrizzleActivitySegmentRepository;
  let rollups: DrizzleUserDailyRollupRepository;

  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const subject: AuthenticatedSubject = { organizationId, userId, role: "admin" };

  /** 2026-06-01, the day every window below is measured from. */
  const origin = new Date("2026-06-01T00:00:00.000Z").getTime();
  const day = (offset: number): Date => new Date(origin + offset * DAY_MS);
  /** An instant inside a day, so a span can be placed either side of midnight. */
  const at = (offset: number, hour: number): Date => new Date(origin + offset * DAY_MS + hour * 60 * 60 * 1_000);

  const segment = (
    organization: string,
    user: string,
    startedAt: Date,
    endedAt: Date,
  ): ActivitySegmentInsert => ({
    organizationId: organization,
    userId: user,
    clientId: randomUUID(),
    deviceId: randomUUID(),
    kind: "active",
    processName: "code.exe",
    startedAt,
    endedAt,
    receivedAt: new Date("2026-06-20T00:00:00.000Z"),
  });

  interface Fold { organization: string; user: string; on: Date }
  const fold = (organization: string, user: string, on: Date): Fold => ({ organization, user, on });

  const storedSpans = async (organization: string): Promise<[string, string][]> => {
    const rows = await database.db
      .select({ startedAt: activitySegments.startedAt, endedAt: activitySegments.endedAt })
      .from(activitySegments)
      .where(eq(activitySegments.organizationId, organization))
      .orderBy(asc(activitySegments.startedAt));
    return rows.map((row) => [row.startedAt.toISOString(), row.endedAt.toISOString()]);
  };

  // Bound as an ISO string rather than a Date: postgres-js cannot serialize a
  // bare Date, the same reason the repository casts its own raw bounds.
  const writeFolds = async (rows: readonly Fold[]): Promise<void> => {
    for (const row of rows) {
      await database.client`
        insert into user_daily_rollups (
          organization_id, user_id, day, active_ms, agent_ms,
          concurrency_0_ms, concurrency_1_ms, concurrency_2_ms, concurrency_3_plus_ms, away_ms
        ) values (
          ${row.organization}, ${row.user}, ${row.on.toISOString()}, 60000, 0, 60000, 0, 0, 0, 0
        )
      `;
    }
  };

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "retention_sweep");
    database = disposable.database;
    await runMigrations(database);
    for (const [organization, user, name] of [
      [organizationId, userId, "Sweep Test"],
      [otherOrganizationId, otherUserId, "Other Workspace"],
    ] as const) {
      await database.client`
        insert into organizations (id, name, invite_code)
        values (${organization}, ${name}, ${randomUUID().slice(0, 11)})
      `;
      await database.client`
        insert into users (id, organization_id, email, name, role)
        values (${user}, ${organization}, ${`${user}@siqshift.test`}, 'Member', 'member')
      `;
    }
    segments = new DrizzleActivitySegmentRepository(database.db);
    rollups = new DrizzleUserDailyRollupRepository(database.db);
  }, 60_000);

  afterAll(async () => {
    await disposable?.cleanup();
  });

  beforeEach(async () => {
    if (disposable === undefined) return;
    await database.client`delete from activity_segments`;
    await database.client`delete from user_daily_rollups`;
  });

  describe("deleteSpansWithin", () => {
    it("takes the spans wholly inside the window and spares the ones that reach out of it", async () => {
      const inside = segment(organizationId, userId, at(3, 9), at(3, 17));
      // Ends inside the window but begins below it, in unfolded history the
      // sweep has not proved and a later pass still needs the rows for.
      const startsBelow = segment(organizationId, userId, at(0, 22), at(1, 2));
      // The case the method matches on endedAt for: it begins on the last day
      // the window covers and runs past the bound, so it belongs to a day the
      // reports can still be asked about and reads live.
      const crossesOut = segment(organizationId, userId, at(4, 23), at(5, 1));
      // Inside the window by time, but another workspace's.
      const elsewhere = segment(otherOrganizationId, otherUserId, at(3, 9), at(3, 17));
      await segments.insertBatch([inside, startsBelow, crossesOut, elsewhere]);

      const deleted = await segments.deleteSpansWithin(organizationId, day(1), day(5));

      // The affected-row count DEPLOY.md tells an operator to gate a first run
      // on, so it has to be the rows that actually went.
      expect(deleted).toBe(1);
      expect(await storedSpans(organizationId)).toEqual([
        [startsBelow.startedAt.toISOString(), startsBelow.endedAt.toISOString()],
        [crossesOut.startedAt.toISOString(), crossesOut.endedAt.toISOString()],
      ]);
      expect(await storedSpans(otherOrganizationId)).toHaveLength(1);
    });

    it("takes a span ending exactly on the bound, which is the last day's own evidence", async () => {
      // Half-open on whole UTC days: a span that ends at midnight belongs to
      // the day below the bound, and that day is inside the proven window.
      await segments.insertBatch([segment(organizationId, userId, at(4, 23), day(5))]);

      expect(await segments.deleteSpansWithin(organizationId, day(1), day(5))).toBe(1);
      expect(await storedSpans(organizationId)).toEqual([]);
    });

    it("reports zero rather than deleting when the window holds nothing", async () => {
      await segments.insertBatch([segment(organizationId, userId, at(9, 9), at(9, 17))]);

      expect(await segments.deleteSpansWithin(organizationId, day(1), day(5))).toBe(0);
      expect(await storedSpans(organizationId)).toHaveLength(1);
    });
  });

  describe("firstUnfoldedDay", () => {
    it("names the first day inside the window with no row", async () => {
      await writeFolds([
        fold(organizationId, userId, day(1)),
        fold(organizationId, userId, day(2)),
        // day(3) missing: an interrupted fold, or a chunked write that failed
        // part-way, leaving a stretch with no row strictly inside coverage.
        fold(organizationId, userId, day(4)),
      ]);

      await expect(rollups.firstUnfoldedDay(subject, day(1), day(5))).resolves.toEqual(day(3));
    });

    it("returns null when every day in the window has a row", async () => {
      await writeFolds([1, 2, 3, 4].map((offset) => fold(organizationId, userId, day(offset))));

      await expect(rollups.firstUnfoldedDay(subject, day(1), day(5))).resolves.toBeNull();
    });

    it("names the window's own first day when nothing in it is folded at all", async () => {
      await writeFolds([fold(organizationId, userId, day(9))]);

      await expect(rollups.firstUnfoldedDay(subject, day(1), day(5))).resolves.toEqual(day(1));
    });

    it("ignores a hole outside the window it was asked about", async () => {
      await writeFolds([
        fold(organizationId, userId, day(1)),
        fold(organizationId, userId, day(2)),
        // The hole is at day(3), above the window this call bounds.
        fold(organizationId, userId, day(4)),
      ]);

      await expect(rollups.firstUnfoldedDay(subject, day(1), day(3))).resolves.toBeNull();
    });

    it("counts a day folded when any member has a row for it, not every member", async () => {
      const second = randomUUID();
      await database.client`
        insert into users (id, organization_id, email, name, role)
        values (${second}, ${organizationId}, ${`${second}@siqshift.test`}, 'Second', 'member')
      `;
      // One member worked day 1 and the other day 2, which is ordinary: the
      // fold writes a row per member who has presence, so a day is proven by
      // the day appearing, not by every member appearing on it.
      await writeFolds([fold(organizationId, userId, day(1)), fold(organizationId, second, day(2))]);

      await expect(rollups.firstUnfoldedDay(subject, day(1), day(3))).resolves.toBeNull();
    });

    it("does not count another workspace's rows as this one's coverage", async () => {
      await writeFolds([
        fold(organizationId, userId, day(1)),
        fold(otherOrganizationId, otherUserId, day(2)),
      ]);

      await expect(rollups.firstUnfoldedDay(subject, day(1), day(3))).resolves.toEqual(day(2));
    });
  });

  describe("organizationsWithSegmentsBefore", () => {
    it("returns folded organizations with expired evidence, oldest first, bounded by the limit", async () => {
      await writeFolds([
        fold(organizationId, userId, day(1)),
        fold(otherOrganizationId, otherUserId, day(1)),
      ]);
      await segments.insertBatch([
        segment(organizationId, userId, at(2, 9), at(2, 10)),
        // The other workspace's oldest evidence is older, so it goes first.
        segment(otherOrganizationId, otherUserId, at(1, 9), at(1, 10)),
      ]);

      await expect(segments.organizationsWithSegmentsBefore(day(5), 10))
        .resolves.toEqual([otherOrganizationId, organizationId]);
      // The limit bounds the discovery, not only the sweeping: the organization
      // furthest behind is the one a capped pass spends its budget on.
      await expect(segments.organizationsWithSegmentsBefore(day(5), 1))
        .resolves.toEqual([otherOrganizationId]);
    });

    it("leaves out an organization the upload path has never folded", async () => {
      // No rollup row at all: the backfill refuses to anchor coverage itself,
      // so this workspace could only spend a slot of a capped pass without
      // using it. It rejoins the moment an upload gives it a fold.
      await segments.insertBatch([segment(organizationId, userId, at(1, 9), at(1, 10))]);

      await expect(segments.organizationsWithSegmentsBefore(day(5), 10)).resolves.toEqual([]);
    });

    it("leaves out a folded organization whose evidence has not expired yet", async () => {
      await writeFolds([fold(organizationId, userId, day(1))]);
      await segments.insertBatch([segment(organizationId, userId, at(6, 9), at(6, 10))]);

      await expect(segments.organizationsWithSegmentsBefore(day(5), 10)).resolves.toEqual([]);
    });

    it("leaves out a folded organization whose segments are all gone", async () => {
      await writeFolds([fold(organizationId, userId, day(1))]);

      await expect(segments.organizationsWithSegmentsBefore(day(5), 10)).resolves.toEqual([]);
    });
  });
});
