import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { load as parseYaml } from "js-yaml";

// A stalled Ubuntu mirror never makes apt exit, so the retry loops around the
// two mirror steps never retried and the `rust` job's apt step ran 45 minutes
// until cancelled. No job set a timeout, so GitHub's 360-minute default applied
// (issue #167). Every mirror command now runs under `timeout`, and every job
// ends well inside GitHub's default. A total limit cannot tell a slow mirror
// from a stalled one, so apt's own idle timeout ends a stalled try first and
// the outer `timeout` stays as a backstop for one that only trickles.
const workflow = parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

// GitHub's default is 360 minutes; every job here normally ends in well under 10.
const MAX_JOB_TIMEOUT_MINUTES = 60;

// The command word, so a line that only mentions apt in a string (the apt.conf
// `printf`, the `::error` message) is not an invocation. Playwright's
// `install-deps` runs apt-get as root however its CLI is reached.
const MIRROR_COMMAND = /(?:^|[\s;&|(])apt-get\s|\sinstall-deps(?:\s|$)/;
// `timeout` can only signal processes of its own user, so a command that reaches
// root apt needs `sudo timeout N`: `timeout N sudo ...` and `timeout N` around a
// command that elevates itself both leave the stalled root apt-get running. Only
// `apt-get update` into the step's own lists runs as the runner user.
const TIMED_MIRROR_COMMAND =
  /(?:^|[\s;&|(])(?<elevation>sudo\s+)?timeout\s+(?<seconds>\d+)\s+(?:apt-get\s+(?<subcommand>\S+)|[^;&|]*\sinstall-deps(?:\s|$))/;

const mirrorSteps = [];
for (const [jobName, job] of Object.entries(workflow.jobs)) {
  for (const step of job.steps) {
    if (typeof step.run !== "string") continue;
    const invocations = step.run.split("\n").filter((line) => MIRROR_COMMAND.test(line) && !/^\s*(?:echo|printf)\s/.test(line));
    if (invocations.length > 0) mirrorSteps.push({ jobName, job, script: step.run, invocations });
  }
}

describe("job timeouts", () => {
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    test(`${jobName} sets a timeout of at most ${MAX_JOB_TIMEOUT_MINUTES} minutes`, () => {
      assert.ok(Number.isInteger(job["timeout-minutes"]), `${jobName} has no integer timeout-minutes`);
      assert.ok(job["timeout-minutes"] > 0, `${jobName} timeout-minutes is not positive`);
      assert.ok(job["timeout-minutes"] <= MAX_JOB_TIMEOUT_MINUTES, `${jobName} timeout-minutes is above ${MAX_JOB_TIMEOUT_MINUTES}`);
    });
  }
});

describe("mirror steps", () => {
  test("the workflow has mirror steps to check", () => {
    assert.ok(mirrorSteps.length > 0, "no run step calls apt-get or playwright install-deps");
  });

  for (const { jobName, job, script, invocations } of mirrorSteps) {
    test(`${jobName} runs every mirror command under a timeout that can end it`, () => {
      for (const line of invocations) {
        const timed = line.match(TIMED_MIRROR_COMMAND);
        assert.ok(timed, `not run directly under timeout: ${line.trim()}`);
        if (timed.groups.subcommand !== "update") {
          assert.ok(timed.groups.elevation, `reaches root apt under a timeout that cannot signal it: ${line.trim()}`);
        }
      }
    });

    test(`${jobName} ends a stalled try with apt's idle timeout before the outer timeout`, () => {
      const smallestOuterTimeoutSeconds = Math.min(...invocations.map((line) => Number(line.match(TIMED_MIRROR_COMMAND).groups.seconds)));
      for (const protocol of ["http", "https"]) {
        // The apt.conf form `Acquire::http::Timeout "60";` or the option form `Acquire::http::Timeout=60`.
        const idleTimeout = script.match(new RegExp(`Acquire::${protocol}::Timeout(?:\\s+"|=)(\\d+)`));
        assert.ok(idleTimeout, `${jobName} does not set Acquire::${protocol}::Timeout`);
        const idleTimeoutSeconds = Number(idleTimeout[1]);
        assert.ok(idleTimeoutSeconds > 0, `${jobName} sets Acquire::${protocol}::Timeout to ${idleTimeoutSeconds}, which apt reads as no timeout`);
        assert.ok(
          idleTimeoutSeconds < smallestOuterTimeoutSeconds,
          `${jobName} Acquire::${protocol}::Timeout of ${idleTimeoutSeconds} s is not below its ${smallestOuterTimeoutSeconds} s outer timeout, so a stall would reach the backstop`,
        );
      }
    });

    test(`${jobName} retries inside its job timeout`, () => {
      const attempts = script.match(/for attempt in ((?:\d+\s?)+); do/)[1].trim().split(/\s+/).length;
      const retryPauseSeconds = Number(script.match(/sleep (\d+)/)[1]);
      const tryTotalSeconds = invocations.reduce((total, line) => total + Number(line.match(TIMED_MIRROR_COMMAND)?.groups.seconds ?? Infinity), 0);
      const worstCaseSeconds = attempts * tryTotalSeconds + (attempts - 1) * retryPauseSeconds;
      assert.ok(
        worstCaseSeconds < job["timeout-minutes"] * 60,
        `${jobName} worst case of ${worstCaseSeconds} s does not fit its ${job["timeout-minutes"]} minute timeout, so GitHub would kill it before the error prints`,
      );
    });
  }
});
