import { getConfig } from "../../config/loader.js";
import type { SkillCapabilityInput } from "../../skills/skill-memory.js";

/**
 * Cap for the SHORT form rendered into `### Skills You Can Use` (and the
 * page index). Matches v1's 500-char behavior so injection stays compact.
 */
export const SKILL_INJECTION_CONTENT_MAX_CHARS = 500;

/**
 * Cap for the RICH form that is embedded (dense + sparse) into the unified
 * `memory_v2_concept_pages` collection. Wide enough that full activation-hint
 * and avoid-when lists survive intact and carry semantic weight at retrieval
 * time; embedding backends tokenize far beyond this, and the rich form is
 * never injected into the prompt, so the only cost is embedding input size.
 */
export const SKILL_EMBEDDING_CONTENT_MAX_CHARS = 1500;

/**
 * Render the prose-style capability statement for a skill: display name + id
 * + description, then the full activation-hints and avoid-when lists, capped
 * at `maxChars`. The default cap yields the short injected form; pass
 * `SKILL_EMBEDDING_CONTENT_MAX_CHARS` for the rich embedded form.
 */
export function buildSkillContent(
  input: SkillCapabilityInput,
  maxChars: number = SKILL_INJECTION_CONTENT_MAX_CHARS,
): string {
  let content = `The "${input.displayName}" skill (${input.id}) is available. ${input.description}.`;
  if (input.activationHints && input.activationHints.length > 0) {
    content += ` Use when: ${input.activationHints.join("; ")}.`;
  }
  if (input.avoidWhen && input.avoidWhen.length > 0) {
    content += ` Avoid when: ${input.avoidWhen.join("; ")}.`;
  }
  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
  }
  return content;
}

/**
 * Render both forms of a skill's capability statement in one pass: the short
 * `content` that gets injected verbatim, and the rich `embeddingContent`
 * that only the vectors see. Splitting the two keeps the injection block's
 * token budget unchanged while giving retrieval the full hint lists.
 */
export function buildSkillContents(input: SkillCapabilityInput): {
  content: string;
  embeddingContent: string;
} {
  return {
    content: buildSkillContent(input),
    embeddingContent: buildSkillContent(
      input,
      SKILL_EMBEDDING_CONTENT_MAX_CHARS,
    ),
  };
}

/** Input for rendering a third-party marketplace skill's statement. */
export interface MarketplaceSkillContentInput {
  /** Namespaced marketplace install id (`{owner}--{repo}--{skillName}`). */
  id: string;
  displayName: string;
  description: string;
  /** Human label of the source repo (e.g. "Anthropic skills"). */
  sourceLabel?: string;
}

/**
 * Render both forms of a marketplace skill's statement. The prose makes the
 * not-installed state explicit so neither the model (reading the injected
 * short form) nor retrieval (matching the embedded rich form) can mistake a
 * marketplace listing for a loadable skill.
 */
export function buildMarketplaceSkillContents(
  input: MarketplaceSkillContentInput,
): { content: string; embeddingContent: string } {
  const from = input.sourceLabel ? ` from "${input.sourceLabel}"` : "";
  let content = `The "${input.displayName}" skill (${input.id}) is available in the skill marketplace${from} but is NOT installed. ${input.description}.`;
  content += ` It must be installed by the user via the marketplace UI before it can be used.`;
  const embeddingContent =
    content.length > SKILL_EMBEDDING_CONTENT_MAX_CHARS
      ? content.slice(0, SKILL_EMBEDDING_CONTENT_MAX_CHARS)
      : content;
  if (content.length > SKILL_INJECTION_CONTENT_MAX_CHARS) {
    content = content.slice(0, SKILL_INJECTION_CONTENT_MAX_CHARS);
  }
  return { content, embeddingContent };
}

/**
 * mcp-setup is special-cased in v1 (`capability-seed.ts:102-112`):
 * its description is augmented with the list of configured MCP server
 * names so the model can pattern-match against them. Port verbatim.
 */
export function augmentMcpSetupDescription(
  input: SkillCapabilityInput,
): SkillCapabilityInput {
  if (input.id !== "mcp-setup") return input;
  const servers = getConfig().mcp?.servers;
  if (!servers) return input;
  const names = Object.keys(servers).filter(
    (name) => servers[name]?.enabled !== false,
  );
  if (names.length === 0) return input;
  return {
    ...input,
    description: `${input.description} Configured: ${names.join(", ")}`,
  };
}
