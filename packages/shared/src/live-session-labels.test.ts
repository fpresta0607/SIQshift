import { describe, expect, it } from "vitest";

import { codebaseDisplayName, modelDisplayName, runtimeDisplayName } from "./live-session-labels.js";

describe("a codebase in proper case", () => {
  it.each([
    ["code-goblins", "Code Goblins"],
    ["quartermaster", "Quartermaster"],
    ["my_cool.repo name", "My Cool Repo Name"],
    ["siqshift-stats-time-tokens", "Siqshift Stats Time Tokens"],
    ["app2-v3", "App2 V3"],
    ["2fa-service", "2fa Service"],
    ["SIQshift", "SIQshift"],
    ["Code Goblins", "Code Goblins"],
    ["codeGoblins", "codeGoblins"],
    ["  spaced-out  ", "Spaced Out"],
    ["---", "---"],
    ["", ""],
  ])("reads %j as %j", (label, expected) => {
    expect(codebaseDisplayName(label)).toBe(expected);
  });
});

describe("a model in proper case, its whole name kept", () => {
  it.each([
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-sonnet-5-5-20261001", "Claude Sonnet 5.5"],
    ["Claude Opus 5.5", "Claude Opus 5.5"],
    ["claude-3-5-sonnet-20241022", "Claude Sonnet 3.5"],
    ["claude-opus-4-5[1m]", "Claude Opus 4.5"],
    ["claude-haiku-5", "Claude Haiku 5"],
    ["claude", "Claude"],
    ["claude-sonnet-4-5@20250929", "Claude Sonnet 4.5"],
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "Claude Sonnet 4.5"],
    ["anthropic.claude-3-5-sonnet-20241022-v2:0", "Claude Sonnet 3.5"],
    ["gpt-5.6-sol", "GPT 5.6 Sol"],
    ["codex-mini-latest", "Codex Mini Latest"],
    ["codex", "Codex"],
    ["deepseek-v4-pro", "Deepseek V4 Pro"],
    ["kimi-k2", "Kimi K2"],
    ["kimi-code-k2", "Kimi Code K2"],
    ["GPT-5", "GPT 5"],
    ["some-model", "Some Model"],
    [null, null],
    ["", null],
    ["   ", null],
    ["---", null],
  ])("reads model %j as %j", (model, expected) => {
    expect(modelDisplayName(model)).toBe(expected);
  });
});

describe("a runtime's name on a group heading, without brackets", () => {
  it.each([
    ["claude_code", "Claude Code"],
    ["pi", "Pi"],
    ["pi_signed", "Pi signed"],
    ["undeclared_runtime", "undeclared_runtime"],
  ])("reads %s as %j", (source, expected) => {
    expect(runtimeDisplayName(source)).toBe(expected);
  });
});
