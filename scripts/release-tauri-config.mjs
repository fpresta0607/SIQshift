import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Tauri configuration a release is compiled and bundled with, merged over
 * `apps/desktop/src-tauri/tauri.conf.json`.
 *
 * - `createUpdaterArtifacts` has the bundler sign every installer for the
 *   updater. `build.rs` allows it only in a release build holding the updater
 *   key, and requires the platform signing below.
 * - The updater polls the newest release's manifest. tauri.conf.json names the
 *   `unsigned-latest` test channel, and a release install must never update
 *   itself to a debug test build.
 * - On Windows the bundler signs the app, both helpers, the uninstaller and
 *   the setup through Azure Artifact Signing: signtool with Microsoft's dlib
 *   and the signing account's metadata file.
 */
export function buildReleaseConfig({ target, updaterEndpoint, signtool, signingDlib, signingMetadata }) {
  if (!updaterEndpoint?.startsWith("https://")) {
    throw new Error(`A release's updater endpoint must be an https URL, not "${updaterEndpoint ?? ""}".`);
  }
  const bundle = { createUpdaterArtifacts: true };
  if (target === "windows") {
    const signing = { signtool, signingDlib, signingMetadata };
    const missing = Object.keys(signing).filter((name) => !signing[name]?.trim());
    if (missing.length > 0) {
      throw new Error(`A Windows release signs through Azure Artifact Signing and needs ${missing.join(", ")}.`);
    }
    bundle.windows = {
      signCommand: {
        cmd: signtool,
        args: [
          "sign", "/v", "/fd", "SHA256",
          "/tr", "http://timestamp.acs.microsoft.com", "/td", "SHA256",
          "/d", "SIQshift", "/du", "https://siqshift.siqstack.com",
          "/dlib", signingDlib,
          "/dmdf", signingMetadata,
          "%1",
        ],
      },
    };
  }
  return { bundle, plugins: { updater: { endpoints: [updaterEndpoint] } } };
}

/**
 * The helpers compile before they are staged under `binaries/`, so their
 * build cannot list them as sidecars. Everything else stays, because
 * `build.rs` checks the same signing configuration for them.
 */
export function helperBuildConfig(config) {
  return { ...config, bundle: { ...config.bundle, externalBin: [] } };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = buildReleaseConfig({
    target: process.env.SIQSHIFT_RELEASE_TARGET,
    updaterEndpoint: process.env.SIQSHIFT_UPDATER_ENDPOINT,
    signtool: process.env.SIQSHIFT_SIGNTOOL,
    signingDlib: process.env.SIQSHIFT_SIGNING_DLIB,
    signingMetadata: process.env.SIQSHIFT_SIGNING_METADATA,
  });
  const configPath = process.env.SIQSHIFT_CONFIG_PATH;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `config=${configPath}\nhelper_config=${JSON.stringify(helperBuildConfig(config))}\n`);
}
