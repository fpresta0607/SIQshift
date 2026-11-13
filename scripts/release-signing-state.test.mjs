import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveReleasePlan } from "./release-signing-state.mjs";

const script = fileURLToPath(new URL("./release-signing-state.mjs", import.meta.url));

// The credentials the release environment holds, as DEPLOY.md and the plan
// job's env block list them.
const WINDOWS_NAMES = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "SIGNING_ENDPOINT",
  "SIGNING_ACCOUNT",
  "SIGNING_PROFILE",
  "SIGNING_PUBLISHER",
  "TAURI_SIGNING_PRIVATE_KEY",
];
const APPLE_NAMES = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_PRIVATE_KEY",
];

const setOnly = (names) => (name) => names.includes(name);
const targetsOf = (plan) => plan.legs.map((leg) => leg.target);

test("Windows signing alone releases Windows and says the Mac is left out", () => {
  // Arrange
  const isSet = setOnly(WINDOWS_NAMES);

  // Act
  const plan = resolveReleasePlan(isSet);

  // Assert
  assert.deepEqual(targetsOf(plan), ["windows"]);
  assert.match(plan.notice, /no Mac installer/i);
  assert.equal(plan.error, undefined);
});

test("every Windows and Apple credential releases both installers", () => {
  const plan = resolveReleasePlan(setOnly([...WINDOWS_NAMES, ...APPLE_NAMES]));

  assert.deepEqual(targetsOf(plan), ["windows", "macos"]);
  assert.equal(plan.notice, undefined);
});

// A release is published signed and updatable or not at all, so no Windows
// credential is optional, the updater key included.
for (const absent of WINDOWS_NAMES) {
  test(`a release without ${absent} stops and names it`, () => {
    const plan = resolveReleasePlan(setOnly([...WINDOWS_NAMES, ...APPLE_NAMES].filter((name) => name !== absent)));

    assert.equal(plan.legs, undefined);
    assert.match(plan.error, new RegExp(`\\b${absent}\\b`));
  });
}

for (const absent of APPLE_NAMES) {
  test(`Apple signing without ${absent} stops and names it`, () => {
    const plan = resolveReleasePlan(setOnly([...WINDOWS_NAMES, ...APPLE_NAMES].filter((name) => name !== absent)));

    assert.equal(plan.legs, undefined);
    assert.match(plan.error, new RegExp(`\\b${absent}\\b`));
  });
}

test("partly configured Apple signing stops instead of quietly dropping the Mac", () => {
  const plan = resolveReleasePlan(setOnly([...WINDOWS_NAMES, "APPLE_CERTIFICATE", "APPLE_API_KEY"]));

  assert.equal(plan.legs, undefined);
  assert.match(plan.error, /APPLE_TEAM_ID/);
  assert.match(plan.error, /APPLE_API_PRIVATE_KEY/);
  assert.doesNotMatch(plan.error, /APPLE_CERTIFICATE,/);
});

test("the Mac leg builds one universal app for Apple silicon and Intel", () => {
  const plan = resolveReleasePlan(setOnly([...WINDOWS_NAMES, ...APPLE_NAMES]));
  const mac = plan.legs.find((leg) => leg.target === "macos");

  assert.equal(mac.tauri_target, "--target universal-apple-darwin");
  assert.equal(mac.rust_targets, "aarch64-apple-darwin,x86_64-apple-darwin");
  assert.match(mac.target_dir, /universal-apple-darwin\/release$/);
});

// The test builds install through NSIS; an MSI of the same app would install
// beside them rather than over them.
test("the Windows leg builds the NSIS installer only, as a release build", () => {
  const plan = resolveReleasePlan(setOnly(WINDOWS_NAMES));

  assert.equal(plan.legs[0].bundle_args, "--bundles nsis");
  assert.match(plan.legs[0].target_dir, /target\/release$/);
});

async function runScript(environment) {
  const directory = await mkdtemp(path.join(tmpdir(), "siqshift-release-plan-"));
  const output = path.join(directory, "github-output");
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env: { PATH: process.env.PATH, ...environment, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    return { stdout, output: await readFile(output, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// The workflow hands the script `true` or `false` per credential, never a value.
test("the script reads the set-or-not flags the workflow passes and writes the matrix", async () => {
  const environment = Object.fromEntries([
    ...WINDOWS_NAMES.map((name) => [name, "true"]),
    ...APPLE_NAMES.map((name) => [name, "false"]),
  ]);

  const { stdout, output } = await runScript(environment);

  assert.match(stdout, /^::notice title=No Mac installer in this release::/m);
  const matrix = JSON.parse(output.replace(/^matrix=/, "").trim());
  assert.deepEqual(matrix.include.map((leg) => leg.target), ["windows"]);
});

test("the script fails the run when a credential is missing", () => {
  const environment = Object.fromEntries(WINDOWS_NAMES.map((name) => [name, name === "AZURE_TENANT_ID" ? "false" : "true"]));

  assert.throws(
    () => execFileSync(process.execPath, [script], {
      env: { PATH: process.env.PATH, ...environment, GITHUB_OUTPUT: path.join(tmpdir(), "siqshift-release-plan-unused") },
      encoding: "utf8",
    }),
    (error) => /::error title=The release cannot be signed::.*AZURE_TENANT_ID/.test(error.stdout),
  );
});
