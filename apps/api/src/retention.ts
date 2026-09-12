import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createDatabase } from "@siqshift/database";

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
async function main(): Promise<void> {
  const config = parseEnv(process.env);
  const { client, db } = createDatabase(config.databaseUrl);
  try {
    const passes = await createRetentionService({
      segments: new DrizzleActivitySegmentRepository(db),
      rollups: new DrizzleUserDailyRollupRepository(db),
      fold: createRollupService({
        reports: new DrizzleReportRepository(db),
        rollups: new DrizzleUserDailyRollupRepository(db),
      }),
    }).sweep();

    if (passes.length === 0) {
      console.info(`siqshift-retention: nothing older than ${RETENTION_DAYS} days.`);
      return;
    }
    for (const pass of passes) {
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

export { main };
