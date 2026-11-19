import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const brandCss = readFileSync(fileURLToPath(new URL("../styles/brand.css", import.meta.url)), "utf8");

const liveTileRules = brandCss
  .split("\n")
  .filter((line) => line.startsWith(".live-") && !line.startsWith(".live-pulse") && !line.startsWith(".live-dot"));

describe("the Live now card's styles", () => {
  it("styles the tiles, which means the rules were found", () => {
    expect(liveTileRules.some((rule) => rule.startsWith(".live-tile {"))).toBe(true);
  });

  it.each(["text-overflow", "white-space: nowrap", "overflow: hidden"])("never cuts a tile's text short with %s", (declaration) => {
    expect(liveTileRules.filter((rule) => rule.includes(declaration))).toEqual([]);
  });
});
