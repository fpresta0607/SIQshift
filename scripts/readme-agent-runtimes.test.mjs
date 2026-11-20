import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

// The README's "Agent hooks" section is written by hand, while the roster is what the
// desktop actually does. When Codex moved to native capture the roster changed and the
// README kept calling it a merged hook (issue #195), so each runtime's row is read
// against its roster entry here.
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const { runtimes } = JSON.parse(
  readFileSync(new URL("../packages/shared/src/agent-runtimes.json", import.meta.url), "utf8"),
);

const MERGED_REGISTRATIONS = new Set(["claude_json", "cursor_json"]);
const REGISTRATION_CELL = {
  claude_json: /^merged automatically$/,
  cursor_json: /^merged automatically$/,
  codex_native: /^none: captured natively\b/,
  manual: /\bto paste$/,
};

const sectionStart = readme.indexOf("\n## Agent hooks\n");
const sectionEnd = readme.indexOf("\n## ", sectionStart + 1);
const section = readme.slice(sectionStart, sectionEnd);
const tableRows = section
  .split("\n")
  .filter((line) => line.startsWith("| **"))
  .map((line) => line.slice(1, -1).split(" | ").map((cell) => cell.trim()));

function rowFor(runtime) {
  return tableRows.filter(([names]) => names.includes(`**${runtime.label}**`));
}

describe("the README's Agent hooks section", () => {
  test("has a section and a table to check", () => {
    assert.ok(sectionStart >= 0, "README has no Agent hooks section");
    assert.ok(tableRows.length > 0, "the Agent hooks section has no runtime rows");
  });

  test("says which runtimes SIQshift merges hooks for, exactly as the roster registers them", () => {
    const merged = section.match(/whose hook shape it knows how to merge:\s+today ([^.]+)\./);
    assert.ok(merged, "the paragraph naming the merged runtimes is missing");
    const named = merged[1].split(/,\s*(?:and\s+)?|\s+and\s+/).map((name) => name.trim());
    const registered = runtimes.filter((runtime) => MERGED_REGISTRATIONS.has(runtime.registration)).map((runtime) => runtime.label);
    assert.deepEqual(named.toSorted(), registered.toSorted());
  });

  for (const runtime of runtimes) {
    test(`${runtime.id}'s row matches its roster registration and model reporting`, () => {
      const rows = rowFor(runtime);
      assert.equal(rows.length, 1, `expected one row naming **${runtime.label}**`);
      const [, , , reportsModel, registration] = rows[0];
      assert.equal(reportsModel, runtime.reportsModel);
      assert.match(registration, REGISTRATION_CELL[runtime.registration]);
    });
  }
});
