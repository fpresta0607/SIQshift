import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDisposableTestDatabase, type DisposableTestDatabase } from "./disposable-test-database.js";
import { runMigrations } from "./migrate.js";
import { bundledMigrations, pendingMigrations } from "./migration-status.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

/**
 * The deploy gate's two statements, against a real PostgreSQL. The fake-client
 * unit tests cover the branch logic and would keep passing if drizzle renamed
 * the journal schema, the table, or `created_at`; only this file notices.
 */
integration(
  databaseUrl
    ? "pendingMigrations against PostgreSQL"
    : "pendingMigrations against PostgreSQL (skipped: TEST_DATABASE_URL is not set)",
  () => {
    let disposable: DisposableTestDatabase | undefined;

    beforeAll(async () => {
      if (!databaseUrl) return;
      disposable = await createDisposableTestDatabase(databaseUrl, "migration_status");
    }, 60_000);

    afterAll(async () => {
      if (disposable !== undefined) await disposable.cleanup();
    });

    it("names every bundled migration before the chain runs, and none after it", async () => {
      if (disposable === undefined) return;
      const { client } = disposable.database;

      await expect(pendingMigrations(client)).resolves.toEqual(bundledMigrations().map((entry) => entry.tag));

      await runMigrations(disposable.database);

      await expect(pendingMigrations(client)).resolves.toEqual([]);
    }, 60_000);
  },
);
