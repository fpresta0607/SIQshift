import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Sql } from "postgres";

/**
 * Reading the migration journal, so a build can say whether the database in
 * front of it is the one it was written against.
 *
 * "Migrate first, then deploy" is a rule DEPLOY.md states and nothing checks.
 * A build that ships ahead of its schema keeps answering `200` on every route
 * that happens not to touch the new table, so the deploy looks healthy and the
 * partial outage is found by whoever notices their numbers are gone. That is
 * how `0022_user_daily_rollups` went out on 2026-09-17 and left weekly and
 * all-time answering `500` for a day: the leaderboard and a member's card read
 * the rollup for any range covering a finished UTC day, today's range covers
 * none, and so today alone kept working.
 *
 * The comparison is drizzle's own: every bundled migration whose journal
 * timestamp is newer than the newest one the database records is one that has
 * not run. It names no table, so it does not need editing when the next
 * migration adds one.
 */

const journalUrl = new URL("../migrations/meta/_journal.json", import.meta.url);

interface JournalEntry {
  tag: string;
  when: number;
}

/** The migrations this build carries, oldest first. */
export function bundledMigrations(): JournalEntry[] {
  const journal = JSON.parse(readFileSync(fileURLToPath(journalUrl), "utf8")) as { entries: JournalEntry[] };
  return [...journal.entries].sort((left, right) => left.when - right.when);
}

/**
 * The bundled migrations this database has not applied, oldest first.
 *
 * Rejects rather than guessing when the database cannot be read: an
 * unreachable database is not evidence of drift, and the caller is the one
 * that knows what to do with the difference.
 *
 * The journal table is looked up before it is selected from, because a
 * database that has never been migrated does not have one and PostgreSQL
 * resolves a missing relation at parse time - no `CASE` or `WHERE` guard in a
 * single statement can avoid the `42P01`.
 */
export async function pendingMigrations(client: Sql): Promise<string[]> {
  const entries = bundledMigrations();
  const [journal] = await client<{ present: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
  if (journal?.present !== true) return entries.map((entry) => entry.tag);

  // `created_at` is the journal's own `folderMillis`, which overflows a JS
  // number only past year 275760; it comes back as text because drizzle
  // declares the column `bigint`.
  const [latest] = await client<{ applied: string | null }[]>`
    select max(created_at)::text as applied from drizzle.__drizzle_migrations`;
  const applied = latest?.applied == null ? null : Number(latest.applied);
  if (applied === null) return entries.map((entry) => entry.tag);
  return entries.filter((entry) => entry.when > applied).map((entry) => entry.tag);
}
