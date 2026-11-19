import { agentRuntimeLabel } from "./agent-runtimes.js";

const WORD_SEPARATOR = /[-_\s]+/;
const CODEBASE_SEPARATOR = /[-_.\s]+/;
const NUMERIC_TOKEN = /^\d+(\.\d+)*$/;
const RELEASE_DATE_TOKEN = /^\d{8}$/;

const KNOWN_CAPITALS: Readonly<Record<string, string>> = { gpt: "GPT", glm: "GLM" };

const capitalise = (word: string): string => {
  const known = KNOWN_CAPITALS[word.toLowerCase()];
  if (known !== undefined) return known;
  return word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word;
};

/**
 * A codebase label in proper case. A label with no capital letters is split on
 * hyphens, underscores, dots and spaces and each word is capitalised
 * (`code-goblins` reads Code Goblins). A label with its own capitals is kept
 * as it is, because the capitals are the name's own (`SIQshift`).
 */
export const codebaseDisplayName = (label: string): string => {
  const trimmed = label.trim();
  if (trimmed !== trimmed.toLowerCase()) return trimmed;
  const words = trimmed.split(CODEBASE_SEPARATOR).filter((word) => word !== "");
  return words.length === 0 ? trimmed : words.map(capitalise).join(" ");
};

/// `claude-opus-5-5`, `claude-sonnet-5-5-20261001` and `Claude Opus 5.5` all
/// read as the model family and its dotted version. Null when the model is not
/// a Claude model, so the caller falls through to the general rule.
const claudeModelName = (model: string, shouldKeepBrand: boolean): string | null | undefined => {
  const tokens = model.replace(/\[[^\]]*\]/g, "").split(WORD_SEPARATOR).filter((token) => token !== "");
  const [brand, ...rest] = tokens;
  if (brand?.toLowerCase() !== "claude") return undefined;
  const details = rest.filter((token) => !RELEASE_DATE_TOKEN.test(token));
  const family = details.filter((token) => !NUMERIC_TOKEN.test(token)).map(capitalise);
  const version = details.filter((token) => NUMERIC_TOKEN.test(token)).join(".");
  const parts = [...(shouldKeepBrand ? ["Claude"] : []), ...family, ...(version === "" ? [] : [version])];
  return parts.length === 0 ? null : parts.join(" ");
};

/**
 * A model in proper case without the runtime's own name, which the group
 * heading already says. Null when there is no model to show.
 */
export const modelDisplayName = (source: string, model: string | null): string | null => {
  const trimmed = model?.trim() ?? "";
  if (trimmed === "") return null;
  const claude = claudeModelName(trimmed, source !== "claude_code");
  if (claude !== undefined) return claude;
  const runtimeWords = agentRuntimeLabel(source).toLowerCase().split(WORD_SEPARATOR);
  const words = trimmed.split(WORD_SEPARATOR).filter((word) => word !== "");
  const repeatsRuntime = runtimeWords.every((word, index) => words[index]?.toLowerCase() === word);
  const named = repeatsRuntime ? words.slice(runtimeWords.length) : words;
  return named.length === 0 ? null : named.map(capitalise).join(" ");
};
