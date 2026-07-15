/**
 * skill_search — model-facing skill discovery.
 *
 * Cheap, deterministic keyword search across (a) locally installed skills,
 * (b) the first-party catalog (installed or not), and (c) the third-party
 * marketplace index (already-indexed entries only — this tool never triggers
 * a marketplace re-index or any GitHub fetch). It is the fallback for when
 * per-turn embedding retrieval misses: token-overlap ranking, no embeddings,
 * no LLM calls.
 *
 * The only network activity possible here is the first-party catalog refresh
 * that `getCatalog()` in `catalog-cache.ts` already performs (5-minute
 * in-memory cache, offline fallback to the bundled local catalog).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/schema.js";
import { skillFlagKey } from "../../config/skill-state.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { RiskLevel } from "../../permissions/types.js";
import { getCatalog } from "../../skills/catalog-cache.js";
import {
  getMarketplaceCacheDir,
  sanitizeSegment,
} from "../../skills/marketplace/indexer.js";
import {
  CUE_OFFICIAL_ADDRESS,
  loadSources,
} from "../../skills/marketplace/sources.js";
import type { MarketplaceItem } from "../../skills/marketplace/types.js";
import { getLogger } from "../../util/logger.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition, ToolExecutionResult } from "../types.js";

const log = getLogger("skill-search");

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

// ─── Candidates + ranking (pure, exported for tests) ─────────────────────────

export type SkillSearchAvailability = "installed" | "catalog" | "marketplace";

export interface SkillSearchCandidate {
  id: string;
  name: string;
  displayName: string;
  description: string;
  /** Compact routing cues from frontmatter (`activation-hints`). */
  activationHints?: string[];
  availability: SkillSearchAvailability;
  /** Marketplace source label (e.g. "Anthropic skills"). */
  sourceLabel?: string;
}

const NAME_WEIGHT = 3;
const HINT_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;

/** Prefer installed over catalog over marketplace on score ties. */
const AVAILABILITY_RANK: Record<SkillSearchAvailability, number> = {
  installed: 0,
  catalog: 1,
  marketplace: 2,
};

/**
 * Function words stripped from QUERY tokens only (candidate fields keep
 * them). Prevents "make me a video" from matching every description that
 * contains "a" or "me".
 */
const QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "from",
  "by",
  "is",
  "are",
  "was",
  "be",
  "been",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "how",
  "what",
  "when",
  "which",
  "who",
  "need",
  "want",
  "please",
  "use",
  "using",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Match strength of one query token against a field's tokens: 1 for an exact
 * token match, 0.5 for a near-prefix match (inflection-ish: "spreadsheets"
 * hits "spreadsheet", "deploy" hits "deployment"), 0 otherwise. The prefix
 * rule requires the shorter token to be at least 4 chars and the tokens to
 * differ by at most 4 chars, so long words don't match short common words
 * ("nothing" must not hit "not").
 */
function isNearPrefixMatch(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return (
    shorter.length >= 4 &&
    longer.length - shorter.length <= 4 &&
    longer.startsWith(shorter)
  );
}

function tokenMatchStrength(
  queryToken: string,
  fieldTokens: readonly string[],
): number {
  let best = 0;
  for (const fieldToken of fieldTokens) {
    if (fieldToken === queryToken) return 1;
    if (isNearPrefixMatch(queryToken, fieldToken)) {
      best = 0.5;
    }
  }
  return best;
}

/**
 * Token-overlap score: each unique query token contributes the best weighted
 * match across the candidate's fields (name/display-name/id weighted highest,
 * then activation hints, then description). Deterministic and dependency-free.
 */
export function scoreSkillSearchCandidate(
  candidate: SkillSearchCandidate,
  queryTokens: readonly string[],
): number {
  const nameTokens = tokenize(
    `${candidate.id} ${candidate.name} ${candidate.displayName}`,
  );
  const hintTokens = tokenize((candidate.activationHints ?? []).join(" "));
  const descriptionTokens = tokenize(candidate.description);

  let score = 0;
  for (const queryToken of new Set(queryTokens)) {
    score += Math.max(
      NAME_WEIGHT * tokenMatchStrength(queryToken, nameTokens),
      HINT_WEIGHT * tokenMatchStrength(queryToken, hintTokens),
      DESCRIPTION_WEIGHT * tokenMatchStrength(queryToken, descriptionTokens),
    );
  }
  return score;
}

export interface RankedSkillSearchResult {
  candidate: SkillSearchCandidate;
  score: number;
}

export function rankSkillSearchCandidates(
  candidates: readonly SkillSearchCandidate[],
  query: string,
  limit: number,
): RankedSkillSearchResult[] {
  const queryTokens = tokenize(query).filter(
    (token) => !QUERY_STOPWORDS.has(token),
  );
  if (queryTokens.length === 0) return [];

  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreSkillSearchCandidate(candidate, queryTokens),
    }))
    .filter((result) => result.score > 0);

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      AVAILABILITY_RANK[a.candidate.availability] -
        AVAILABILITY_RANK[b.candidate.availability] ||
      a.candidate.id.localeCompare(b.candidate.id),
  );

  return scored.slice(0, limit);
}

// ─── Candidate collection ─────────────────────────────────────────────────────

function tryGetConfig(): AssistantConfig | undefined {
  try {
    return getConfig();
  } catch {
    // Config not loaded (e.g. early startup) — skip feature-flag filtering.
    return undefined;
  }
}

/**
 * Read already-indexed marketplace entries from the on-disk per-source cache.
 * Never triggers indexing or network fetches — sources that have not been
 * indexed yet (no cache file) are simply absent from the results.
 */
function readCachedMarketplaceItems(): Array<
  MarketplaceItem & { resolvedSourceLabel: string }
> {
  const items: Array<MarketplaceItem & { resolvedSourceLabel: string }> = [];
  let sources;
  try {
    sources = loadSources();
  } catch (err) {
    log.warn({ err }, "Failed to load marketplace sources for skill search");
    return items;
  }

  for (const source of sources) {
    // The first-party catalog source is covered by getCatalog() directly.
    if (!source.enabled || source.address === CUE_OFFICIAL_ADDRESS) continue;

    const filePath = join(
      getMarketplaceCacheDir(),
      `${sanitizeSegment(source.address)}.json`,
    );
    if (!existsSync(filePath)) continue;

    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as {
        version?: number;
        items?: unknown;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) continue;
      const label = source.label ?? source.address;
      for (const item of parsed.items as MarketplaceItem[]) {
        items.push({ ...item, resolvedSourceLabel: label });
      }
    } catch (err) {
      log.warn(
        { err, address: source.address },
        "Failed to read cached marketplace index for skill search",
      );
    }
  }
  return items;
}

async function collectCandidates(): Promise<SkillSearchCandidate[]> {
  const config = tryGetConfig();
  const byId = new Map<string, SkillSearchCandidate>();

  // (a) Locally installed/enabled skills (bundled, managed, workspace, …).
  for (const skill of loadSkillCatalog()) {
    const flagKey = skillFlagKey(skill);
    if (config && flagKey && !isAssistantFeatureFlagEnabled(flagKey, config)) {
      continue; // feature-gated off — skill_load would reject it anyway
    }
    byId.set(skill.id, {
      id: skill.id,
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      ...(skill.activationHints && skill.activationHints.length > 0
        ? { activationHints: skill.activationHints }
        : {}),
      availability: "installed",
    });
  }

  // (b) First-party catalog (installed entries already claimed above).
  try {
    for (const entry of await getCatalog()) {
      if (byId.has(entry.id)) continue;
      const vellum = entry.metadata?.vellum;
      const flag = vellum?.["feature-flag"];
      if (config && flag && !isAssistantFeatureFlagEnabled(flag, config)) {
        continue;
      }
      const hints = vellum?.["activation-hints"];
      byId.set(entry.id, {
        id: entry.id,
        name: entry.name,
        displayName: vellum?.["display-name"] ?? entry.name,
        description: entry.description,
        ...(hints && hints.length > 0 ? { activationHints: hints } : {}),
        availability: "catalog",
      });
    }
  } catch (err) {
    log.warn({ err }, "Catalog unavailable during skill search");
  }

  // (c) Third-party marketplace — already-indexed entries only.
  for (const item of readCachedMarketplaceItems()) {
    if (byId.has(item.id)) continue; // installed marketplace skills reuse the namespaced id
    byId.set(item.id, {
      id: item.id,
      name: item.name,
      displayName: item.displayName,
      description: item.description,
      availability: "marketplace",
      sourceLabel: item.resolvedSourceLabel,
    });
  }

  return [...byId.values()];
}

// ─── Output formatting ────────────────────────────────────────────────────────

function oneLine(text: string, maxLength = 200): string {
  const line = text.split("\n")[0].trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

function formatResult(result: RankedSkillSearchResult, index: number): string {
  const { candidate } = result;
  const lines: string[] = [];
  switch (candidate.availability) {
    case "installed":
      lines.push(
        `${index + 1}. ${candidate.displayName} (id: ${candidate.id}) [installed]`,
        `   ${oneLine(candidate.description)}`,
        `   Activate: call skill_load with skill "${candidate.id}".`,
      );
      break;
    case "catalog":
      lines.push(
        `${index + 1}. ${candidate.displayName} (id: ${candidate.id}) [installable from catalog]`,
        `   ${oneLine(candidate.description)}`,
        `   Activate: call skill_load with skill "${candidate.id}" — it auto-installs from the catalog.`,
      );
      break;
    case "marketplace":
      lines.push(
        `${index + 1}. ${candidate.displayName} (id: ${candidate.id}) [marketplace: ${candidate.sourceLabel ?? "third-party"}]`,
        `   ${oneLine(candidate.description)}`,
        `   Requires user install via the marketplace UI before it can be loaded — suggest it to the user; skill_load will NOT auto-install it.`,
      );
      break;
  }
  return lines.join("\n");
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const skillSearchTool = {
  name: "skill_search",

  description:
    'Search for skills by keyword across locally installed skills, the first-party Cue catalog (installable via skill_load), and the third-party skills marketplace index. Use this when no loaded or suggested skill fits the current request — search here BEFORE improvising a manual approach or claiming a capability is unavailable, and before telling the user something can\'t be done. Also useful when the user asks what Cue can do in some area. Ranking is simple keyword overlap against skill names, descriptions, and activation hints, so query with a few descriptive words (e.g. "invoice pdf", "edit video", "kubernetes deploy"). Each result says how to activate it: installed and catalog skills are activated with skill_load (catalog skills auto-install); marketplace-only skills require the user to install them via the marketplace UI first.',

  category: "skills",

  executionTarget: "sandbox",

  defaultRiskLevel: RiskLevel.Low,

  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Keywords describing the capability you need (e.g. "spreadsheet budget", "transcribe audio").',
      },
      limit: {
        type: "number",
        description: `Maximum number of results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
    },
    required: ["query"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const query = input.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      return {
        content: "Error: query is required and must be a non-empty string",
        isError: true,
      };
    }

    let limit = DEFAULT_LIMIT;
    if (input.limit !== undefined) {
      const raw = Number(input.limit);
      if (!Number.isFinite(raw) || raw < 1) {
        return {
          content: `Error: limit must be a number between 1 and ${MAX_LIMIT}`,
          isError: true,
        };
      }
      limit = Math.min(Math.floor(raw), MAX_LIMIT);
    }

    const candidates = await collectCandidates();
    const ranked = rankSkillSearchCandidates(candidates, query, limit);

    if (ranked.length === 0) {
      return {
        content:
          `No skills matched "${query.trim()}" across ${candidates.length} known skills ` +
          "(installed + catalog + marketplace index). Try broader or different keywords. " +
          "If nothing fits, proceed with general-purpose tools (bash, file, web) instead of " +
          "claiming the capability is missing.",
        isError: false,
      };
    }

    const header = `Found ${ranked.length} skill${ranked.length === 1 ? "" : "s"} matching "${query.trim()}":`;
    const body = ranked.map((result, index) => formatResult(result, index));

    return {
      content: [header, "", ...body].join("\n"),
      isError: false,
    };
  },
} satisfies ToolDefinition;
registerTool(skillSearchTool);
