import { agentRuntimeLabel } from "./agent-runtimes.js";

const WORD_SEPARATOR = /[-_\s]+/;
const CODEBASE_SEPARATOR = /[-_.\s]+/;
const NUMERIC_TOKEN = /^\d+(\.\d+)*$/;
const RELEASE_DATE_TOKEN = /^\d{8}$/;
const CLOUD_PROVIDER_PREFIX = /^(?:[a-z]+\.)?anthropic\./i;
const CLOUD_PROVIDER_SUFFIX = /(?:@\d{8}|-v\d+:\d+)$/i;

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
/// read as Claude, the model family and its dotted version. A Bedrock id such
/// as `us.anthropic.claude-sonnet-4-5-20250929-v1:0` and a Vertex id such as
/// `claude-sonnet-4-5@20250929` read the same once the provider's prefix and
/// suffix are dropped. Undefined when the model is not a Claude model, so the
/// caller falls through to the general rule.
const claudeModelName = (model: string): string | undefined => {
  const bare = model.replace(/\[[^\]]*\]/g, "").replace(CLOUD_PROVIDER_PREFIX, "").replace(CLOUD_PROVIDER_SUFFIX, "");
  const [brand, ...rest] = bare.split(WORD_SEPARATOR).filter((token) => token !== "");
  if (brand?.toLowerCase() !== "claude") return undefined;
  const details = rest.filter((token) => !RELEASE_DATE_TOKEN.test(token));
  const family = details.filter((token) => !NUMERIC_TOKEN.test(token)).map(capitalise);
  const version = details.filter((token) => NUMERIC_TOKEN.test(token)).join(".");
  return ["Claude", ...family, ...(version === "" ? [] : [version])].join(" ");
};

/** A model in proper case, its whole name kept. Null when there is no model to show. */
export const modelDisplayName = (model: string | null): string | null => {
  const trimmed = model?.trim() ?? "";
  if (trimmed === "") return null;
  const claude = claudeModelName(trimmed);
  if (claude !== undefined) return claude;
  const words = trimmed.split(WORD_SEPARATOR).filter((word) => word !== "");
  return words.length === 0 ? null : words.map(capitalise).join(" ");
};

/** A runtime's name for a group heading, without the brackets the roster's label may carry (`Pi (signed)` reads Pi signed). */
export const runtimeDisplayName = (source: string): string => agentRuntimeLabel(source).replace(/[()]/g, "");
