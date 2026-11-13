import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { HELPERS, stageHelpers } from "./stage-helpers.mjs";

const MAC_TRIPLES = ["aarch64-apple-darwin", "x86_64-apple-darwin"];

/** A stand-in for `lipo -create`: the joined file holds every slice, so a test can tell what went in. */
const joinSlices = (output, slices) => {
  writeFileSync(output, slices.map((slice) => readFileSync(slice, "utf8")).join("+"));
};

/** A scratch `src-tauri` folder, removed when the test ends. */
const scratchTauriDir = (t) => {
  const tauriDir = mkdtempSync(path.join(tmpdir(), "siqshift-stage-helpers-"));
  t.after(() => rmSync(tauriDir, { recursive: true, force: true }));
  return tauriDir;
};

/** Writes what `cargo build --target <triple>` leaves for each helper on a Mac runner. */
const compileMacHelpers = (tauriDir, profile, contentOf = (name, triple) => `${name} for ${triple}`) => {
  for (const triple of MAC_TRIPLES) {
    const outDir = path.join(tauriDir, "target", triple, profile);
    mkdirSync(outDir, { recursive: true });
    for (const name of HELPERS) writeFileSync(path.join(outDir, name), contentOf(name, triple));
  }
};

/** The tables of a Cargo manifest in order, each with its string keys; the keys above the first table sit under "". */
const manifestTables = (manifest) => {
  const tables = [{ name: "", keys: {} }];
  for (const line of manifest.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      tables.push({ name: header[1], keys: {} });
      continue;
    }
    const key = /^\s*([\w-]+)\s*=\s*(["'])(.*?)\2/.exec(line);
    if (key) tables.at(-1).keys[key[1]] = key[3];
  }
  return tables;
};

// Tauri bundles every binary of the crate, each `[[bin]]` table and each
// target in `src/bin`, so a helper the crate builds and this script does not
// stage would break the universal Mac bundle.
test("the staged helpers are every binary the desktop crate builds beside the app", () => {
  // Arrange
  const tauriDir = new URL("../apps/desktop/src-tauri/", import.meta.url);
  const tables = manifestTables(readFileSync(new URL("Cargo.toml", tauriDir), "utf8"));
  const binEntries = readdirSync(new URL("src/bin/", tauriDir), { withFileTypes: true });

  // Act
  const declared = tables.filter((table) => table.name === "bin").map((table) => table.keys.name);
  const discovered = binEntries
    .filter((entry) => entry.isDirectory() || entry.name.endsWith(".rs"))
    .map((entry) => path.parse(entry.name).name);
  const crateHelpers = [...new Set([...declared, ...discovered])];

  // Assert
  assert.deepEqual([...HELPERS].sort(), crateHelpers.sort());
});

for (const profile of ["release", "debug"]) {
  // The bundler copies each of the crate's binaries from the universal output
  // folder, where `tauri build` joins only the app itself. The first universal
  // release failed there: "Failed to copy binary from
  // target/universal-apple-darwin/release/siqshift-hook".
  test(`a Mac ${profile} build leaves each joined helper where the universal bundle copies it from`, (t) => {
    // Arrange
    const tauriDir = scratchTauriDir(t);
    compileMacHelpers(tauriDir, profile);

    // Act
    stageHelpers({ tauriDir, target: "macos", profile, lipo: joinSlices });

    // Assert
    for (const name of HELPERS) {
      const joined = `${name} for aarch64-apple-darwin+${name} for x86_64-apple-darwin`;
      assert.equal(readFileSync(path.join(tauriDir, "target", "universal-apple-darwin", profile, name), "utf8"), joined);
      assert.equal(readFileSync(path.join(tauriDir, "binaries", `${name}-universal-apple-darwin`), "utf8"), joined);
    }
  });
}

test("a Mac build stages each architecture's helper under its own triple", (t) => {
  // Arrange
  const tauriDir = scratchTauriDir(t);
  compileMacHelpers(tauriDir, "release");

  // Act
  stageHelpers({ tauriDir, target: "macos", profile: "release", lipo: joinSlices });

  // Assert
  for (const name of HELPERS) {
    for (const triple of MAC_TRIPLES) {
      assert.equal(readFileSync(path.join(tauriDir, "binaries", `${name}-${triple}`), "utf8"), `${name} for ${triple}`);
    }
  }
});

test("a Windows build stages each helper under the host's triple", (t) => {
  // Arrange
  const tauriDir = scratchTauriDir(t);
  const outDir = path.join(tauriDir, "target", "debug");
  mkdirSync(outDir, { recursive: true });
  for (const name of HELPERS) writeFileSync(path.join(outDir, `${name}.exe`), `${name} for Windows`);

  // Act
  stageHelpers({ tauriDir, target: "windows", profile: "debug", hostTriple: "x86_64-pc-windows-msvc" });

  // Assert
  for (const name of HELPERS) {
    assert.equal(readFileSync(path.join(tauriDir, "binaries", `${name}-x86_64-pc-windows-msvc.exe`), "utf8"), `${name} for Windows`);
  }
});

// A debug build's `build.rs` writes empty stand-ins for the helpers; shipping
// one would install a helper that does nothing.
test("an empty helper is refused rather than staged", (t) => {
  // Arrange
  const tauriDir = scratchTauriDir(t);
  compileMacHelpers(tauriDir, "debug", () => "");

  // Act
  const stage = () => stageHelpers({ tauriDir, target: "macos", profile: "debug", lipo: joinSlices });

  // Assert
  assert.throws(stage, /is empty/);
});

test("a target or profile the workflows never build is refused", (t) => {
  const tauriDir = scratchTauriDir(t);
  for (const [target, profile] of [["linux", "release"], ["macos", "bench"], [undefined, "release"], ["windows", undefined]]) {
    // Act
    const stage = () => stageHelpers({ tauriDir, target, profile, hostTriple: "x86_64-pc-windows-msvc", lipo: joinSlices });

    // Assert
    assert.throws(stage, /windows or macos|release or debug/, `${target} ${profile}`);
  }
});
