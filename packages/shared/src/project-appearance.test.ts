import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROJECT_APPEARANCE,
  PROJECT_COLOR_NAMES,
  PROJECT_COLORS,
  projectAppearance,
} from "./project-appearance.js";

const PROJECT_ID = "5b0e8f0e-52a4-4c3e-9d0f-3f2f8f1f7a01";

/**
 * The pair PROJECT_ID is assigned, worked out from the FNV-1a spec rather than
 * from the code: 32-bit FNV-1a over the id's ASCII bytes (offset basis
 * 0x811c9dc5, prime 0x01000193) is 0x69224709. Mod 23, the icons without the
 * default's grid, that is 5: book. Shifted right by 8 and mod 7, the colors
 * without the default's slate, it is 4: coral.
 */
const PROJECT_ID_PAIR = { icon: "book", color: "#ff9d8a" } as const;

describe("a project's icon and color", () => {
  it("shows the pair a member chose", () => {
    const appearance = projectAppearance({ id: PROJECT_ID, isDefault: false, icon: "rocket", color: "#85c6ff" });

    expect(appearance).toEqual({ icon: "rocket", color: "#85c6ff" });
  });

  it("gives the default project its own pair", () => {
    const appearance = projectAppearance({ id: PROJECT_ID, isDefault: true, icon: null, color: null });

    expect(appearance).toEqual(DEFAULT_PROJECT_APPEARANCE);
  });

  // A changed hash or a reordered list re-skins every project nobody picked a
  // pair for, and splits the pair a client falls back to from the one the
  // server answers with.
  it.each([
    { label: "stored as null", stored: { icon: null, color: null } },
    { label: "absent from an older server", stored: { icon: undefined, color: undefined } },
  ])("assigns an unchosen project the pair its id hashes to, with its pair $label", ({ stored }) => {
    const appearance = projectAppearance({ id: PROJECT_ID, isDefault: false, ...stored });

    expect(appearance).toEqual(PROJECT_ID_PAIR);
  });

  it("never assigns the default project's pair to another project", () => {
    const ids = Array.from({ length: 200 }, (_, index) => `project-${index}`);

    const assigned = ids.map((id) => projectAppearance({ id, isDefault: false, icon: null, color: null }));

    expect(assigned.some((appearance) => appearance.icon === DEFAULT_PROJECT_APPEARANCE.icon)).toBe(false);
    expect(assigned.some((appearance) => appearance.color === DEFAULT_PROJECT_APPEARANCE.color)).toBe(false);
  });

  it.each([
    { stored: { icon: "unicorn", color: "#85c6ff" }, kept: "color" as const },
    { stored: { icon: "rocket", color: "#000000" }, kept: "icon" as const },
  ])("replaces a stored value the lists no longer hold and keeps the $kept", ({ stored, kept }) => {
    const appearance = projectAppearance({ id: PROJECT_ID, isDefault: false, ...stored });

    expect(appearance).toEqual(kept === "color"
      ? { icon: PROJECT_ID_PAIR.icon, color: stored.color }
      : { icon: stored.icon, color: PROJECT_ID_PAIR.color });
  });

  it("names every color for the picker", () => {
    expect(Object.keys(PROJECT_COLOR_NAMES).sort()).toEqual([...PROJECT_COLORS].sort());
  });
});
