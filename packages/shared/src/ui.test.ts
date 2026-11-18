import { describe, expect, it } from "vitest";

import { buildAppRows, buildMeterRows } from "./ui.js";

// Issue 122: the Windows recorder names Chrome "chrome.exe" and the Mac recorder
// "Google Chrome", so a person recording on both machines saw two "Google
// Chrome" rows, each holding part of the app's time.
const CROSS_PLATFORM_APPS = [
  { processName: "chrome.exe", durationSeconds: 1_800 },
  { processName: "Code.exe", durationSeconds: 900 },
  { processName: "Google Chrome", durationSeconds: 1_200 },
  { processName: "claude.exe", durationSeconds: 300 },
  { processName: "claude", durationSeconds: 120 },
];

describe("app rows across operating systems", () => {
  it("joins one app's names from Windows and macOS into one All-stats row", () => {
    const rows = buildAppRows(CROSS_PLATFORM_APPS, 5_000);

    expect(rows).toEqual([
      { key: "chrome.exe", label: "Google Chrome", durationSeconds: 3_000, agent: false },
      { key: "Code.exe", label: "VS Code", durationSeconds: 900, agent: false },
      { key: "agent-clis", label: "Claude Code", durationSeconds: 420, agent: true },
      { key: "quiet-time", label: "Quiet time", durationSeconds: 680, agent: false },
    ]);
    expect(rows.reduce((sum, row) => sum + row.durationSeconds, 0)).toBe(5_000);
  });

  it("joins one app's names from Windows and macOS into one Today row", () => {
    const rows = buildMeterRows(CROSS_PLATFORM_APPS);

    expect(rows.map((row) => [row.label, row.processName, row.durationSeconds, row.share])).toEqual([
      ["Google Chrome", "chrome.exe", 3_000, 100],
      ["VS Code", "Code.exe", 900, 30],
      ["Claude Code", "claude.exe", 420, 14],
    ]);
  });

  it("ranks an app by its whole time before the tail folds into Everything else", () => {
    // Split across two names, Chrome's halves each fall below the eighth app;
    // joined, it outranks every one of them.
    const apps = [
      ...Array.from({ length: 8 }, (_, index) => ({ processName: `app-${index}.exe`, durationSeconds: 1_000 - index })),
      { processName: "chrome.exe", durationSeconds: 600 },
      { processName: "Google Chrome", durationSeconds: 600 },
    ];

    expect(buildAppRows(apps)[0]).toMatchObject({ label: "Google Chrome", durationSeconds: 1_200 });
    expect(buildMeterRows(apps)[0]).toMatchObject({ label: "Google Chrome", durationSeconds: 1_200 });
  });
});
