import { appendFileSync } from "node:fs";

/**
 * Decides which installers a release run builds, from whether each signing
 * credential is set. The workflow passes only `true` or `false` for each one,
 * never a value.
 *
 * A release is published signed and updatable, or not at all:
 *
 * - Windows signs through Azure Artifact Signing and is always built, so every
 *   Azure credential, signing variable and the updater key has to be set. One
 *   missing stops the run before anything is built.
 * - The Mac is built only once every Apple signing secret is set. With none
 *   set the release carries Windows alone and says so. With some set the setup
 *   is half built, and the run stops rather than quietly dropping the Mac.
 */
export const WINDOWS_CREDENTIALS = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "SIGNING_ENDPOINT",
  "SIGNING_ACCOUNT",
  "SIGNING_PROFILE",
  "SIGNING_PUBLISHER",
  "TAURI_SIGNING_PRIVATE_KEY",
];

export const APPLE_CREDENTIALS = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_PRIVATE_KEY",
];

const LEGS = {
  windows: {
    os: "windows-latest",
    target: "windows",
    // NSIS only: the test builds install through NSIS, and an MSI of the same
    // app would install beside them rather than over them.
    bundle_args: "--bundles nsis",
    rust_targets: "",
    cargo_targets: "",
    tauri_target: "",
    target_dir: "apps/desktop/src-tauri/target/release",
  },
  // One universal app for Apple silicon and Intel: each architecture compiles
  // on its own and lipo joins them.
  macos: {
    os: "macos-latest",
    target: "macos",
    bundle_args: "",
    rust_targets: "aarch64-apple-darwin,x86_64-apple-darwin",
    cargo_targets: "--target aarch64-apple-darwin --target x86_64-apple-darwin",
    tauri_target: "--target universal-apple-darwin",
    target_dir: "apps/desktop/src-tauri/target/universal-apple-darwin/release",
  },
};

/** `isSet(name)` says whether that credential is set. */
export function resolveReleasePlan(isSet) {
  const missingWindows = WINDOWS_CREDENTIALS.filter((name) => !isSet(name));
  if (missingWindows.length > 0) {
    return {
      error: `The release environment is missing ${missingWindows.join(", ")}, so the Windows installer cannot be signed and updated. Nothing is built.`,
    };
  }
  const missingApple = APPLE_CREDENTIALS.filter((name) => !isSet(name));
  if (missingApple.length === APPLE_CREDENTIALS.length) {
    return {
      legs: [LEGS.windows],
      notice: "The release environment holds no Apple signing secrets yet, so this release carries no Mac installer. The Mac installer is published only signed by SIQstack LLC and notarized by Apple.",
    };
  }
  if (missingApple.length > 0) {
    return {
      error: `Apple signing is partly configured: the release environment is missing ${missingApple.join(", ")}. Nothing is built until every Apple signing secret is set, or none is.`,
    };
  }
  return { legs: [LEGS.windows, LEGS.macos] };
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("release-signing-state.mjs")) {
  const plan = resolveReleasePlan((name) => process.env[name] === "true");
  if (plan.error !== undefined) {
    console.log(`::error title=The release cannot be signed::${plan.error}`);
    process.exit(1);
  }
  if (plan.notice !== undefined) {
    console.log(`::notice title=No Mac installer in this release::${plan.notice}`);
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: plan.legs })}\n`);
}
