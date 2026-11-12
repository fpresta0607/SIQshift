import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// The repository is public, so a path under a real person's home folder
// publishes their user name. Fixtures that need a home folder use one of these
// made-up users instead; a new one joins this list, never a real name.
const MADE_UP_HOME_FOLDERS = new Set(["a", "alex", "dev", "op", "riley", "sam"]);

// A drive's Users folder with forward slashes, single backslashes or the
// doubled backslashes of a string literal, and the POSIX /home and /Users
// folders when they start a path rather than sit inside one.
const HOME_FOLDER_PATTERNS = [
  /[a-z]:(?:\/|\\{1,2})users(?:\/|\\{1,2})([a-z0-9][\w.-]*)/gi,
  /(?<![\w.-])\/(?:home|users)\/([a-z0-9][\w.-]*)/gi,
];

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function homeFolderNames(text) {
  const names = HOME_FOLDER_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]));
  return [...new Set(names)];
}

describe("home folder names", () => {
  const cases = [
    ["C:/Users/riley/.treehouse/siqshift-4b3191/siqshift", ["riley"]],
    ["C:\\Users\\Sam\\fieldNotes", ["Sam"]],
    ["\"C:\\\\Users\\\\riley\\\\.treehouse\"", ["riley"]],
    ["c:/users/riley/", ["riley"]],
    ["cd /home/riley/src/quartermaster", ["riley"]],
    ["cwd: \"/Users/sam/dev\"", ["sam"]],
    ["C:/Users/alex/AppData/Local/Temp/steer-proof/home/worktrees/project", ["alex"]],
    ["/^(?:[a-z]:\\/users\\/[^/]+|\\/home\\/[^/]+)$/", []],
    ["https://example.com/users/alex", []],
  ];

  for (const [text, names] of cases) {
    test(`finds ${JSON.stringify(names)} in ${text}`, () => {
      assert.deepEqual(homeFolderNames(text), names);
    });
  }
});

test("every home folder a tracked file names belongs to a made-up user", () => {
  // Arrange
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd: repositoryRoot, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "");

  // Act
  const personal = [];
  for (const file of trackedFiles) {
    const content = readFileSync(join(repositoryRoot, file));
    if (content.includes(0)) continue;
    content.toString("utf8").split(/\r?\n/).forEach((line, index) => {
      for (const name of homeFolderNames(line)) {
        if (!MADE_UP_HOME_FOLDERS.has(name.toLowerCase())) personal.push(`${file}:${index + 1} names home folder "${name}"`);
      }
    });
  }

  // Assert
  assert.deepEqual(personal, [], "use a made-up home folder from MADE_UP_HOME_FOLDERS instead");
});
