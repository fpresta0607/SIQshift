import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// The repository is public, so a fixture that borrows a real workspace's
// project name publishes it. Fixtures use made-up names such as the home
// page's Atlas Portal. A name that once leaked is listed here by the SHA-256
// of its words joined in lower case, so this file never holds it either.
const REAL_WORKSPACE_NAME_DIGESTS = new Set([
  "aadd249742dcacc51039cfefd531f81b7b245a439056069966402016ba2e9e58",
  "53c79d50bdfa1739f952192353648062e05d85deaf753c3f68a5eefea32cd2dd",
]);

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function gitListedFiles(...options) {
  return execFileSync("git", ["ls-files", "-z", ...options], { cwd: repositoryRoot, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "");
}

// Each word, and each pair of neighbouring words joined, in lower case, so a
// two-word name is found however it is written: atlasPortal, Atlas Portal,
// atlas-portal, atlasportal or atlasPortal1h with a duration run into it.
function nameCandidates(line) {
  const words = line
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z]+|[0-9]+/g) ?? [];
  return words.flatMap((word, index) => (index === 0 ? [word] : [word, words[index - 1] + word]));
}

describe("name candidates", () => {
  const cases = [
    ["C:/dev/atlasPortal", ["c", "dev", "cdev", "atlas", "devatlas", "portal", "atlasportal"]],
    ["Atlas Portal", ["atlas", "portal", "atlasportal"]],
    ["atlas-portal_app", ["atlas", "portal", "atlasportal", "app", "portalapp"]],
    ["atlasportal-4b3191", ["atlasportal", "4", "atlasportal4", "b", "4b", "3191", "b3191"]],
    ["atlasPortal1h 34m", ["atlas", "portal", "atlasportal", "1", "portal1", "h", "1h", "34", "h34", "m", "34m"]],
    ["", []],
  ];

  for (const [line, candidates] of cases) {
    test(`reads ${JSON.stringify(candidates)} from ${JSON.stringify(line)}`, () => {
      assert.deepEqual(nameCandidates(line), candidates);
    });
  }
});

test("no tracked file names a real workspace's project", () => {
  // Arrange
  const deletedFiles = new Set(gitListedFiles("--deleted"));
  const trackedFiles = gitListedFiles().filter((file) => !deletedFiles.has(file));

  // Act
  const isRealByCandidate = new Map();
  const isReal = (candidate) => {
    if (!isRealByCandidate.has(candidate)) {
      isRealByCandidate.set(candidate, REAL_WORKSPACE_NAME_DIGESTS.has(createHash("sha256").update(candidate).digest("hex")));
    }
    return isRealByCandidate.get(candidate);
  };
  const leaks = [];
  for (const file of trackedFiles) {
    const content = readFileSync(join(repositoryRoot, file));
    if (content.includes(0)) continue;
    content.toString("utf8").split(/\r?\n/).forEach((line, index) => {
      if (nameCandidates(line).some(isReal)) leaks.push(`${file}:${index + 1}`);
    });
  }

  // Assert
  assert.deepEqual(leaks, [], "these lines name a real workspace's project; use a made-up name such as Atlas Portal");
});
