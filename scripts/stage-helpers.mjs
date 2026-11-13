import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The binaries the desktop crate builds beside the app: its `[[bin]]` targets. */
export const HELPERS = ["siqshift-hook", "siqshift-browser-host"];

const MAC_TRIPLES = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
const UNIVERSAL_TRIPLE = "universal-apple-darwin";

/**
 * Puts the compiled helpers where the app's build and the bundler take them
 * from. Both installer workflows run it between compiling the helpers and
 * compiling the app.
 *
 * `externalBin` resolves `binaries/<name>-<target-triple>`, so each helper is
 * copied there under that name; the bundler signs those copies. A universal
 * Mac build compiles each architecture against its own triple's copy and
 * bundles the `universal-apple-darwin` one, which `lipo` joins from the two.
 *
 * The bundler also copies every `[[bin]]` of the crate from the target's
 * output folder. `tauri build` joins only the app itself into
 * `target/universal-apple-darwin/<profile>`, so each joined helper is put
 * there too; without it the universal bundle fails on the first helper.
 *
 * A debug build's `build.rs` writes empty stand-ins for the helpers, so an
 * empty file here means the helper build left a stand-in, and it is refused.
 */
export function stageHelpers({ tauriDir, target, profile, hostTriple, lipo }) {
  if (target !== "windows" && target !== "macos") {
    throw new Error(`The helpers are staged for windows or macos, not "${target ?? ""}".`);
  }
  if (profile !== "release" && profile !== "debug") {
    throw new Error(`The helpers are staged from a release or debug build, not "${profile ?? ""}".`);
  }
  const binaries = path.join(tauriDir, "binaries");
  mkdirSync(binaries, { recursive: true });
  const stage = (from, to) => {
    copyFileSync(from, to);
    if (statSync(to).size === 0) {
      throw new Error(`${to} is empty: the helper build left a debug stand-in, not ${path.basename(from)}.`);
    }
  };

  for (const name of HELPERS) {
    if (target === "windows") {
      stage(path.join(tauriDir, "target", profile, `${name}.exe`), path.join(binaries, `${name}-${hostTriple}.exe`));
      continue;
    }
    const slices = MAC_TRIPLES.map((triple) => {
      const staged = path.join(binaries, `${name}-${triple}`);
      stage(path.join(tauriDir, "target", triple, profile, name), staged);
      return staged;
    });
    const joined = path.join(binaries, `${name}-${UNIVERSAL_TRIPLE}`);
    lipo(joined, slices);
    const universalOutDir = path.join(tauriDir, "target", UNIVERSAL_TRIPLE, profile);
    mkdirSync(universalOutDir, { recursive: true });
    stage(joined, path.join(universalOutDir, name));
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, profile] = process.argv.slice(2);
  stageHelpers({
    tauriDir: fileURLToPath(new URL("../apps/desktop/src-tauri", import.meta.url)),
    target,
    profile,
    hostTriple: target === "windows" ? /^host: (.+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1].trim() : undefined,
    lipo: (output, slices) => execFileSync("lipo", ["-create", "-output", output, ...slices], { stdio: "inherit" }),
  });
}
