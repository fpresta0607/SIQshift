import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { bundledMigrations, pendingMigrations } from "./migration-status.js";

/** The journal drizzle-kit writes, read as the input contract the reader parses. */
function journalEntries(): Array<{ tag: string; when: number }> {
  const journalPath = fileURLToPath(new URL("../migrations/meta/_journal.json", import.meta.url));
  return (JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string; when: number }> }).entries;
}

/**
 * A `postgres` client stands in for a tagged template, so a fake is a function
 * that answers each call in order with the rows that call would have read.
 */
function fakeClient(answers: readonly unknown[][]): Sql {
  let call = 0;
  return ((): unknown[] => {
    const rows = answers[call] ?? [];
    call += 1;
    return rows;
  }) as unknown as Sql;
}

describe("bundledMigrations", () => {
  it("reads the journal this build ships, in the order it would apply it", () => {
    const raw = journalEntries();
    const oldestFirst = [...raw].sort((left, right) => left.when - right.when);

    const entries = bundledMigrations();

    expect(raw.length).toBeGreaterThan(0);
    expect(entries.map((entry) => ({ tag: entry.tag, when: entry.when })))
      .toEqual(oldestFirst.map((entry) => ({ tag: entry.tag, when: entry.when })));
    expect(entries.at(0)?.tag).toBe("0000_initial");
  });
});

describe("pendingMigrations", () => {
  it("reports nothing pending when the database has applied the newest bundled migration", async () => {
    const newest = bundledMigrations().at(-1);
    const client = fakeClient([[{ present: true }], [{ applied: String(newest?.when) }]]);

    await expect(pendingMigrations(client)).resolves.toEqual([]);
  });

  it("names every migration newer than the newest the database records", async () => {
    const entries = bundledMigrations();
    const thirdFromLast = entries.at(-3);
    const client = fakeClient([[{ present: true }], [{ applied: String(thirdFromLast?.when) }]]);

    await expect(pendingMigrations(client)).resolves.toEqual([entries.at(-2)?.tag, entries.at(-1)?.tag]);
  });

  it("treats a database with no journal table as having applied none of them", async () => {
    const client = fakeClient([[{ present: false }]]);

    await expect(pendingMigrations(client)).resolves.toEqual(bundledMigrations().map((entry) => entry.tag));
  });

  it("treats an empty journal table the same way", async () => {
    const client = fakeClient([[{ present: true }], [{ applied: null }]]);

    await expect(pendingMigrations(client)).resolves.toEqual(bundledMigrations().map((entry) => entry.tag));
  });
});
