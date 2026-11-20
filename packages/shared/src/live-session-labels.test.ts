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

describe("a model in proper case without its runtime's name", () => {
  it.each([
    ["claude_code", "claude-opus-5-5", "Opus 5.5"],
    ["claude_code", "claude-sonnet-5-5-20261001", "Sonnet 5.5"],
    ["claude_code", "Claude Opus 5.5", "Opus 5.5"],
    ["claude_code", "claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["claude_code", "claude-opus-4-5[1m]", "Opus 4.5"],
    ["claude_code", "claude-haiku-5", "Haiku 5"],
    ["claude_code", "claude", null],
    ["codex", "gpt-5.6-sol", "GPT 5.6 Sol"],
    ["codex", "codex-mini-latest", "Mini Latest"],
    ["codex", "codex", null],
    ["pi", "deepseek-v4-pro", "Deepseek V4 Pro"],
    ["kimi_code", "kimi-k2", "Kimi K2"],
    ["kimi_code", "kimi-code-k2", "K2"],
    ["cursor", "claude-opus-5-5", "Claude Opus 5.5"],
    ["cursor", "GPT-5", "GPT 5"],
    ["undeclared_runtime", "some-model", "Some Model"],
    ["codex", null, null],
    ["codex", "", null],
    ["codex", "   ", null],
  ])("reads %s model %j as %j", (source, model, expected) => {
    expect(modelDisplayName(source, model)).toBe(expected);
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
