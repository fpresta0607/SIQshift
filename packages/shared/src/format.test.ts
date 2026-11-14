import { describe, expect, it } from "vitest";

import { formatCount, formatRangeDays, formatTokens } from "./format.js";

describe("a token count in short form", () => {
  it.each([
    { value: 0, text: "0" },
    { value: 950, text: "950" },
    { value: 1_000, text: "1k" },
    { value: 1_234, text: "1.2k" },
    { value: 9_999, text: "10k" },
    { value: 391_400, text: "391k" },
    { value: 999_499, text: "999k" },
    { value: 999_999, text: "1M" },
    { value: 48_214_300, text: "48.2M" },
    { value: 999_949_999, text: "999.9M" },
    { value: 2_140_000_000, text: "2.1B" },
  ])("reads $value as $text", ({ value, text }) => {
    expect(formatTokens(value)).toBe(text);
  });
});

describe("a whole count", () => {
  it.each([
    { value: 0, text: "0" },
    { value: 74, text: "74" },
    { value: 48_214_300, text: "48,214,300" },
  ])("reads $value as $text", ({ value, text }) => {
    expect(formatCount(value)).toBe(text);
  });
});

describe("the days a range covers", () => {
  it("names the first and the last day of a week", () => {
    const fromAt = new Date(2026, 10, 9).toISOString();
    const toExclusiveAt = new Date(2026, 10, 16).toISOString();

    expect(formatRangeDays(fromAt, toExclusiveAt)).toBe("Nov 9 to Nov 15");
  });

  it("names a single day once", () => {
    const fromAt = new Date(2026, 10, 13).toISOString();
    const toExclusiveAt = new Date(2026, 10, 14).toISOString();

    expect(formatRangeDays(fromAt, toExclusiveAt)).toBe("Nov 13");
  });
});
