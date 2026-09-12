import {
  createDatabase,
  createDisposableTestDatabase,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@siqshift/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withSweepLock } from "./retention.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

// Two sweeps overlapping is an ordinary operational event - cron fires while a
// slow first run is still converging, or an operator runs one by hand during the
// window - and interleaving them is not safe: one run's backfill clears the days
// the other has just proved folded and is about to delete behind, leaving days
// with neither segments nor a correct row.
//
// Advisory locks are a PostgreSQL primitive, and the thing worth proving is that
// the second caller is actually turned away while the first is inside its work
// and let in once it is done. That needs a real server and two real connections.
integration("the sweep lock", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "sweep_lock");
    database = disposable.database;
  }, 60_000);

  afterAll(async () => {
    await disposable?.cleanup();
  });

  it("turns a second sweep away while the first is running, and lets it in afterwards", async () => {
    // A genuinely separate connection, which is what a second process running
    // the command has. Borrowing the first one proves nothing and cannot even
    // run: an advisory lock is re-entrant within a session, and the disposable
    // database's pool holds exactly one connection, so reserving a second from
    // it while the first is held waits for itself.
    const second = createDatabase(disposable!.databaseUrl, { max: 1 });
    try {
      let secondWhileFirstRuns: string | null = "not attempted";
      const first = await withSweepLock(database, async () => {
        secondWhileFirstRuns = await withSweepLock(second, async () => "ran");
        return "ran";
      });

      expect(first).toBe("ran");
      // Turned away rather than queued: the command logs and exits 0.
      expect(secondWhileFirstRuns).toBeNull();

      // Released with the work, so the next run is not blocked by it.
      await expect(withSweepLock(second, async () => "ran")).resolves.toBe("ran");
    } finally {
      await second.client.end();
    }
  });

  it("releases the lock when the work throws, so one failed run does not block the next", async () => {
    await expect(withSweepLock(database, async () => {
      throw new Error("sweep failed");
    })).rejects.toThrow("sweep failed");

    await expect(withSweepLock(database, async () => "ran")).resolves.toBe("ran");
  });
});
