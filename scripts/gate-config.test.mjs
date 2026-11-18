import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { load as parseYaml } from "js-yaml";

// The gate runs `commands.test` behind the machine's shared test queue and
// each command as `cmd.exe /c <command>`. With no command named, its agent ran
// checks of its own choosing outside that queue and spent its whole budget on
// a cold desktop build before any test ran (issue #88).
const gateConfig = parseYaml(readFileSync(new URL("../.no-mistakes.yaml", import.meta.url), "utf8"));
const rootScripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;

// The pull request's CI run owns these: each needs a database, a browser or a
// full build of every package.
const FULL_SUITE_PNPM_SCRIPTS = new Set(["test", "test:browser", "build"]);

// rustfmt reads sources without compiling. Every other cargo subcommand that
// checks the desktop crate compiles it, from cold in a fresh run worktree.
const QUICK_CARGO_SUBCOMMANDS = new Set(["fmt"]);

// cmd.exe strips neither single quotes nor `$`, and `;` does not separate its
// commands, so a POSIX-shell command string runs as something else there.
const POSIX_ONLY_SYNTAX = ["'", "$", ";", "`"];

function commandSteps(command) {
  return command.split("&&").map((step) => step.trim().split(/\s+/));
}

describe("gate commands", () => {
  for (const name of ["prepare", "test", "lint"]) {
    test(`commands.${name} is named`, () => {
      assert.equal(typeof gateConfig.commands?.[name], "string");
      assert.notEqual(gateConfig.commands[name].trim(), "");
    });
  }

  test("commands.prepare installs from the lockfile", () => {
    const [program, subcommand, ...options] = commandSteps(gateConfig.commands.prepare)[0];
    assert.deepEqual([program, subcommand], ["pnpm", "install"]);
    assert.ok(options.includes("--frozen-lockfile"), "an install that may rewrite the lockfile is not what CI tested");
  });

  for (const name of ["prepare", "test", "lint"]) {
    test(`commands.${name} is written in cmd.exe syntax`, () => {
      for (const token of POSIX_ONLY_SYNTAX) {
        assert.ok(!gateConfig.commands[name].includes(token), `commands.${name} uses ${token}`);
      }
    });
  }

  for (const name of ["test", "lint"]) {
    test(`commands.${name} runs quick checks only`, () => {
      for (const [program, subcommand] of commandSteps(gateConfig.commands[name])) {
        if (program === "pnpm") {
          assert.ok(Object.hasOwn(rootScripts, subcommand),`pnpm ${subcommand} is not a root package.json script`);
          assert.ok(!FULL_SUITE_PNPM_SCRIPTS.has(subcommand), `pnpm ${subcommand} is a full suite that CI owns`);
        } else if (program === "cargo") {
          assert.ok(QUICK_CARGO_SUBCOMMANDS.has(subcommand), `cargo ${subcommand} compiles the desktop crate`);
        } else {
          assert.fail(`commands.${name} runs ${program}, which this test does not know to be quick`);
        }
      }
    });
  }
});
