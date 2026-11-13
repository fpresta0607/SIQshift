import { readFileSync, writeFileSync } from "node:fs";

/**
 * Builds the `latest.json` the installed app polls.
 *
 * The updater only offers a build whose semver is strictly higher than the one
 * running, so `version` is the whole mechanism: get it wrong and either every
 * machine reinstalls in a loop, or none of them ever updates.
 *
 * The Mac is listed only when the build published an app archive. The macOS
 * updater installs from that archive, not from the `.dmg` the unsigned
 * workflow builds, so a `darwin` entry without one would hand the updater
 * something it cannot apply and fail on every Mac. A release builds one
 * universal archive, which serves both Mac architectures.
 */
export function buildUpdaterManifest({ version, baseUrl, signature, installerName, macArchiveName, macSignature, pubDate, notes }) {
  const trimmedVersion = version?.trim();
  if (!trimmedVersion) {
    throw new Error("The update manifest needs the version this build published.");
  }
  // A prerelease suffix is what makes successive test builds comparable, so a
  // bare `0.1.4` from a test run is a mistake worth catching here rather than
  // discovering as a machine that never updates again.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmedVersion)) {
    throw new Error(`The update manifest version is not semver: ${trimmedVersion}`);
  }
  const trimmedSignature = signature?.trim();
  if (!trimmedSignature) {
    throw new Error("The update manifest needs the installer's minisign signature.");
  }
  const trimmedBase = baseUrl?.trim().replace(/\/+$/, "");
  if (!trimmedBase) {
    throw new Error("The update manifest needs the release's download base URL.");
  }
  if (!installerName?.trim()) {
    throw new Error("The update manifest needs the installer's published name.");
  }

  const platforms = {
    "windows-x86_64": {
      signature: trimmedSignature,
      url: `${trimmedBase}/${installerName.trim()}`,
    },
  };
  if (macArchiveName !== undefined) {
    const trimmedMacSignature = macSignature?.trim();
    if (!macArchiveName.trim() || !trimmedMacSignature) {
      throw new Error("The update manifest needs both the Mac app archive's name and its minisign signature.");
    }
    const mac = { signature: trimmedMacSignature, url: `${trimmedBase}/${macArchiveName.trim()}` };
    platforms["darwin-aarch64"] = mac;
    platforms["darwin-x86_64"] = mac;
  }

  return {
    version: trimmedVersion,
    notes: notes ?? "Automatic update of the SIQshift unsigned test build.",
    pub_date: pubDate ?? new Date().toISOString(),
    platforms,
  };
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("updater-manifest.mjs")) {
  const installerName = process.env.INSTALLER_NAME;
  const manifest = buildUpdaterManifest({
    version: process.env.VERSION,
    baseUrl: process.env.BASE_URL,
    signature: readFileSync(process.env.SIGNATURE_PATH, "utf8"),
    installerName,
    ...(process.env.MAC_ARCHIVE_NAME
      ? { macArchiveName: process.env.MAC_ARCHIVE_NAME, macSignature: readFileSync(process.env.MAC_SIGNATURE_PATH, "utf8") }
      : {}),
    ...(process.env.NOTES ? { notes: process.env.NOTES } : {}),
    ...(process.env.PUB_DATE ? { pubDate: process.env.PUB_DATE } : {}),
  });
  writeFileSync(process.env.MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(manifest);
}
