import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { load as parseYaml } from "js-yaml";

// A stalled Ubuntu mirror never makes apt exit, so the retry loops around the
// two mirror steps never retried and the `rust` job's apt step ran 45 minutes
// until cancelled. No job set a timeout, so GitHub's 360-minute default applied
// (issue #167). Every mirror command now runs under `timeout`, and every job
// ends well inside GitHub's default.
const workflow = parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

// GitHub's default is 360 minutes; every job here normally ends in well under 10.
const MAX_JOB_TIMEOUT_MINUTES = 60;

// The command word, so a line that only mentions apt in a string (the apt.conf
// `printf`, the `::error` message) is not an invocation.
const MIRROR_COMMAND = /(?:^|[\s;&|(])(?:apt-get|playwright install-deps)(?:\s|$)/;
const TIMED_MIRROR_COMMAND = /(?:^|[\s;&|(])(?:sudo\s+)?timeout\s+(\d+)\s+(?:apt-get|pnpm exec playwright install-deps)(?:\s|$)/;

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
    test(`${jobName} runs every mirror command under timeout`, () => {
      for (const line of invocations) {
        assert.match(line, TIMED_MIRROR_COMMAND, `not run under timeout: ${line.trim()}`);
      }
    });

    test(`${jobName} retries inside its job timeout`, () => {
      const attempts = script.match(/for attempt in ((?:\d+\s?)+); do/)[1].trim().split(/\s+/).length;
      const retryPauseSeconds = Number(script.match(/sleep (\d+)/)[1]);
      const tryTotalSeconds = invocations.reduce((total, line) => total + Number(line.match(TIMED_MIRROR_COMMAND)?.[1] ?? Infinity), 0);
      const worstCaseSeconds = attempts * tryTotalSeconds + (attempts - 1) * retryPauseSeconds;
      assert.ok(
        worstCaseSeconds < job["timeout-minutes"] * 60,
        `${jobName} worst case of ${worstCaseSeconds} s does not fit its ${job["timeout-minutes"]} minute timeout, so GitHub would kill it before the error prints`,
      );
    });
  }
});
