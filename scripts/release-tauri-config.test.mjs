import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildReleaseConfig, helperBuildConfig } from "./release-tauri-config.mjs";

const script = fileURLToPath(new URL("./release-tauri-config.mjs", import.meta.url));
const updaterEndpoint = "https://github.com/fpresta0607/SIQshift/releases/latest/download/latest.json";
const windowsSigning = {
  signtool: "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe",
  signingDlib: "D:\\a\\_temp\\artifact-signing-client\\bin\\x64\\Azure.CodeSigning.Dlib.dll",
  signingMetadata: "D:\\a\\_temp\\artifact-signing-metadata.json",
};

test("a Windows release signs through Azure Artifact Signing and builds updater artifacts", () => {
  const config = buildReleaseConfig({ target: "windows", updaterEndpoint, ...windowsSigning });

  assert.equal(config.bundle.createUpdaterArtifacts, true);
  const { cmd, args } = config.bundle.windows.signCommand;
  assert.equal(cmd, windowsSigning.signtool);
  assert.deepEqual(args.slice(args.indexOf("/dlib"), args.indexOf("/dlib") + 4), ["/dlib", windowsSigning.signingDlib, "/dmdf", windowsSigning.signingMetadata]);
  assert.ok(args.includes("/tr") && args.includes("/td"), "the signature carries a timestamp");
  assert.equal(args.at(-1), "%1");
});

// tauri.conf.json names the test channel; a release install must never update
// to a debug test build from there.
test("a release install polls the newest release, not the test channel", () => {
  for (const target of ["windows", "macos"]) {
    const config = buildReleaseConfig({ target, updaterEndpoint, ...windowsSigning });

    assert.deepEqual(config.plugins.updater.endpoints, [updaterEndpoint]);
  }
});

test("a macOS release carries no Windows signing", () => {
  const config = buildReleaseConfig({ target: "macos", updaterEndpoint });

  assert.equal(config.bundle.windows, undefined);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
});

test("a Windows release without its signing tool, dlib or metadata is refused", () => {
  for (const absent of Object.keys(windowsSigning)) {
    assert.throws(
      () => buildReleaseConfig({ target: "windows", updaterEndpoint, ...windowsSigning, [absent]: " " }),
      /Windows release/,
    );
  }
});

test("an updater endpoint that is not https is refused", () => {
  assert.throws(() => buildReleaseConfig({ target: "macos", updaterEndpoint: "" }), /https/);
  assert.throws(() => buildReleaseConfig({ target: "macos", updaterEndpoint: "http://example.test/latest.json" }), /https/);
});

// The helpers are compiled before they exist under binaries/, so their build
// cannot list them as sidecars; everything that decides signing stays.
test("the helper build keeps the release signing and drops the sidecars", () => {
  const config = buildReleaseConfig({ target: "windows", updaterEndpoint, ...windowsSigning });

  const helperConfig = helperBuildConfig(config);

  assert.deepEqual(helperConfig.bundle.externalBin, []);
  assert.deepEqual(helperConfig.bundle.windows, config.bundle.windows);
  assert.equal(helperConfig.bundle.createUpdaterArtifacts, true);
  assert.equal(config.bundle.externalBin, undefined);
});

test("the script writes the configuration file and both outputs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "siqshift-release-config-"));
  const output = path.join(directory, "github-output");
  const configPath = path.join(directory, "tauri.release.conf.json");
  try {
    execFileSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        SIQSHIFT_RELEASE_TARGET: "windows",
        SIQSHIFT_UPDATER_ENDPOINT: updaterEndpoint,
        SIQSHIFT_SIGNTOOL: windowsSigning.signtool,
        SIQSHIFT_SIGNING_DLIB: windowsSigning.signingDlib,
        SIQSHIFT_SIGNING_METADATA: windowsSigning.signingMetadata,
        SIQSHIFT_CONFIG_PATH: configPath,
      },
      stdio: "pipe",
    });

    const written = JSON.parse(await readFile(configPath, "utf8"));
    const outputs = Object.fromEntries((await readFile(output, "utf8")).trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    assert.equal(written.bundle.windows.signCommand.cmd, windowsSigning.signtool);
    assert.equal(outputs.config, configPath);
    assert.deepEqual(JSON.parse(outputs.helper_config), helperBuildConfig(written));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
