import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROJECT_APPEARANCE,
  PROJECT_COLOR_NAMES,
  PROJECT_COLORS,
  PROJECT_ICONS,
  projectAppearance,
} from "./project-appearance.js";

const PROJECT_ID = "5b0e8f0e-52a4-4c3e-9d0f-3f2f8f1f7a01";

describe("a project's icon and color", () => {
  it("shows the pair a member chose", () => {
    const appearance = projectAppearance({ id: PROJECT_ID, isDefault: false, icon: "rocket", color: "#85c6ff" });

    expect(appearance).toEqual({ icon: "rocket", color: "#85c6ff" });
  });

  it("gives the default project its own pair", () => {
    const appearance = projectAppearance({ id: PROJECT_ID, isDefault: true, icon: null, color: null });

    expect(appearance).toEqual(DEFAULT_PROJECT_APPEARANCE);
  });

  it("assigns an unchosen project the same pair on every read", () => {
    const first = projectAppearance({ id: PROJECT_ID, isDefault: false, icon: null, color: null });
    const second = projectAppearance({ id: PROJECT_ID, isDefault: false, icon: undefined, color: undefined });

    expect(second).toEqual(first);
    expect(PROJECT_ICONS).toContain(first.icon);
    expect(PROJECT_COLORS).toContain(first.color);
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
    const assigned = projectAppearance({ id: PROJECT_ID, isDefault: false, icon: null, color: null });

    const appearance = projectAppearance({ id: PROJECT_ID, isDefault: false, ...stored });

    expect(appearance).toEqual(kept === "color"
      ? { icon: assigned.icon, color: stored.color }
      : { icon: stored.icon, color: assigned.color });
  });

  it("names every color for the picker", () => {
    expect(Object.keys(PROJECT_COLOR_NAMES).sort()).toEqual([...PROJECT_COLORS].sort());
  });
});
