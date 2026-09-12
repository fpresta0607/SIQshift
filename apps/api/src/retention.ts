import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createDatabase, type DatabaseConnection } from "@siqshift/database";

import {
  DrizzleActivitySegmentRepository,
  DrizzleReportRepository,
  DrizzleUserDailyRollupRepository,
} from "./drizzle-repositories.js";
import { parseEnv } from "./env.js";
import { createRetentionService, RETENTION_DAYS } from "./services/retention.js";
import { createRollupService } from "./services/rollups.js";

/**
 * The retention sweep, as a command rather than a route.
 *
 * A scheduler runs this; nothing in the API calls it. That is deliberate: the
 * alternative is an HTTP endpoint that deletes data, which then needs a shared
 * secret, needs that secret kept out of logs and out of the repo, and is one
 * misconfiguration away from being reachable by anyone. A command has no
 * listener to secure - whoever can run it could already read the database.
 *
 * DEPLOY.md has the Railway wiring. The sweep itself is an ordinary exported
 * function, so if a route is ever wanted instead this file is the only thing
 * that has to change.
 */
/**
 * The advisory lock two sweeps serialize on.
 *
 * An arbitrary but fixed key; PostgreSQL advisory locks share one namespace per
 * database, so it only has to differ from whatever else takes one here.
 */
const SWEEP_LOCK_KEY = 8_150_923_041_772_113;

/**
 * Runs `work` holding the sweep lock, or returns null when another sweep holds
 * it.
 *
 * Two sweeps overlapping is an ordinary operational event - cron fires while a
 * slow first run is still converging, or an operator runs one by hand during the
 * window - and interleaving them is not safe. One run's `backfill` can clear the
 * days the other has just proved folded and is about to delete behind, which
 * leaves those days with neither segments nor a correct row. Nothing recovers
 * that: uploads fill coverage only upward and `backfill` extends it only below
 * where coverage starts.
 *
 * The lock is taken on a connection reserved out of the pool, so it is held for
 * the whole run rather than for one statement, and it is a session lock rather
 * than a transaction one because the sweep is many statements. It dies with its
 * connection, so a killed run leaves nothing stuck.
 */
async function withSweepLock<T>(
  { client }: Pick<DatabaseConnection, "client">,
  work: () => Promise<T>,
): Promise<T | null> {
  const reserved = await client.reserve();
  try {
    const [row] = await reserved<{ locked: boolean }[]>`select pg_try_advisory_lock(${SWEEP_LOCK_KEY}) as locked`;
    if (row?.locked !== true) return null;
    try {
      return await work();
    } finally {
      await reserved`select pg_advisory_unlock(${SWEEP_LOCK_KEY})`;
    }
  } finally {
    reserved.release();
  }
}

async function main(): Promise<void> {
  const config = parseEnv(process.env);
  const { client, db } = createDatabase(config.databaseUrl);
  try {
    const passes = await withSweepLock({ client }, () => createRetentionService({
      segments: new DrizzleActivitySegmentRepository(db),
      rollups: new DrizzleUserDailyRollupRepository(db),
      fold: createRollupService({
        reports: new DrizzleReportRepository(db),
        rollups: new DrizzleUserDailyRollupRepository(db),
      }),
    }).sweep());

    if (passes === null) {
      console.info("siqshift-retention: another sweep holds the lock; standing down.");
      return;
    }
    if (passes.length === 0) {
      console.info(`siqshift-retention: nothing older than ${RETENTION_DAYS} days.`);
      return;
    }
    for (const pass of passes) {
      // A failed pass is one organization's, not the sweep's: the rest of the
      // night's budget was spent on the organizations behind it, and this line
      // is the only place the failure surfaces.
      if (pass.failed !== undefined) {
        // A scheduler reads the exit code, not the log. With per-organization
        // isolation a night where every pass failed would otherwise report green.
        process.exitCode = 1;
        console.error(`siqshift-retention: org=${pass.organizationId} failed=${pass.failed}`);
        continue;
      }
      const held = pass.held === undefined ? "" : ` held=${pass.held}`;
      console.info(
        `siqshift-retention: org=${pass.organizationId} backfilled=${pass.backfilled} `
        + `coverageFrom=${pass.coverageFrom?.toISOString().slice(0, 10) ?? "none"} `
        + `deleted=${pass.deleted} before=${pass.deletedBefore?.toISOString().slice(0, 10) ?? "none"}${held}`,
      );
    }
  } finally {
    await client.end();
  }
}

// Runs only when this file is the entrypoint, never when it is imported, the
// same guard `packages/database/src/migrate.ts` uses and its cli test pins.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error("siqshift-retention: sweep failed", error);
    process.exitCode = 1;
  });
}

export { main, withSweepLock, SWEEP_LOCK_KEY };
