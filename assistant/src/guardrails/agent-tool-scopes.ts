/**
 * Agent tool scopes — the enforcement half of the Guardrails "AGENT SCOPES"
 * band. An agent row may carry `tool_scopes`: a JSON array of coarse
 * skill/domain ids matching the R1 UI chips ("email", "calendar", "research",
 * "files", "code", "docs", "design", "outreach", "social", "ads");
 * null = unrestricted.
 *
 * ENFORCEMENT MODEL (honest about its granularity):
 *
 *   - Applies to background work-item runs only. The runner resolves the
 *     item's assignee to a registry agent and, when that agent has scopes,
 *     installs the filter built here on the run conversation
 *     (`conversation.toolScopeFilter`). The conversation's tool resolver
 *     drops filtered tools from the wire definitions each turn (the model
 *     never sees them) and the tool executor rejects any call that slips
 *     through. Interactive chat has no agent identity and is never filtered.
 *
 *   - Only EXTENSION-OWNED tools (skill / plugin / MCP, per the tool
 *     registry's ownership map) are eligible for filtering. Core plumbing —
 *     bash, file ops, web search, ui surfaces, memory, subagents — is always
 *     available: gating it would break every run in ways unrelated to the
 *     agent's domain (and core tools still pass through risk gates, trust
 *     rules, and the per-category autonomy policy per call).
 *
 *   - Domain matching is LEXICAL: a tool belongs to a domain when its name or
 *     its owning extension id carries one of the domain's segments
 *     (`mcp__gmail__send_email` → email; `document_open` owned by
 *     `document-editor` → docs). A tool that matches NO known domain is
 *     shared plumbing and stays available. A tool that matches only domains
 *     outside the agent's scopes is filtered.
 *
 * Fail-open toward availability by design: an unknown owner, an unknown
 * scope id, or a name matching no domain never blocks a tool. The filter is
 * a scoping layer on top of the permission system, not a replacement for it.
 */

import { getToolOwner } from "../tools/registry.js";
import type { OwnerInfo } from "../tools/types.js";

// ── Domain vocabulary ────────────────────────────────────────────────

/**
 * The known scope ids and the tool-name/owner-id segments that map a tool
 * into each. Segment-matched (split on non-alphanumerics and camelCase,
 * plural-insensitive) — never substring-matched — so "recorder" is not
 * "order"-style false positives.
 *
 * The house-agent chips ("triage", "summaries", "capture") are deliberately
 * absent: they describe the implicit `cue` agent, which is not a registry row
 * and can never be scoped — and mapping them would gate the tasks/followups
 * plumbing that every run needs.
 */
const SCOPE_DOMAIN_SEGMENTS: Readonly<Record<string, ReadonlySet<string>>> = {
  email: new Set([
    "email",
    "mail",
    "gmail",
    "outlook",
    "inbox",
    "smtp",
    "imap",
    "mailgun",
  ]),
  calendar: new Set(["calendar", "gcal", "ical"]),
  files: new Set(["file", "folder", "drive", "dropbox"]),
  research: new Set(["search", "research", "fetch", "crawl", "scrape", "web"]),
  code: new Set(["code", "git", "github", "gitlab", "repo", "app", "deploy"]),
  docs: new Set([
    "doc",
    "document",
    "notion",
    "sheet",
    "spreadsheet",
    "slide",
    "deck",
    "pdf",
    "page",
  ]),
  design: new Set([
    "design",
    "image",
    "figma",
    "canva",
    "media",
    "video",
    "audio",
    "photo",
    "icon",
    "replicate",
  ]),
  outreach: new Set([
    "outreach",
    "message",
    "messaging",
    "sms",
    "dm",
    "call",
    "phone",
    "dial",
    "sequence",
    "contact",
  ]),
  social: new Set([
    "social",
    "tweet",
    "twitter",
    "linkedin",
    "instagram",
    "facebook",
    "tiktok",
    "youtube",
    "reddit",
  ]),
  ads: new Set([
    "ads",
    "ad",
    "adset",
    "campaign",
    "creative",
    "audience",
    "pixel",
  ]),
};

/** The scope ids the enforcement layer understands (exported for validation/UI). */
export const KNOWN_AGENT_TOOL_SCOPES: ReadonlyArray<string> = Object.keys(
  SCOPE_DOMAIN_SEGMENTS,
);

// ── Segment matching ─────────────────────────────────────────────────

/**
 * Split an identifier into lowercase word segments on non-alphanumeric
 * separators and camelCase boundaries (mirrors the autonomy classifier's
 * segmenter — segment matching, not substring matching, is load-bearing).
 */
function segments(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether any segment is in `terms` (plural-insensitive). */
function hasSegmentFrom(parts: string[], terms: ReadonlySet<string>): boolean {
  return parts.some(
    (s) => terms.has(s) || (s.endsWith("s") && terms.has(s.slice(0, -1))),
  );
}

/**
 * The known domains a tool belongs to, judged from its name plus its owning
 * extension id. Empty = shared plumbing (never filtered).
 */
export function toolScopeDomains(toolName: string, ownerId?: string): string[] {
  const parts = [...segments(toolName), ...(ownerId ? segments(ownerId) : [])];
  return Object.entries(SCOPE_DOMAIN_SEGMENTS)
    .filter(([, terms]) => hasSegmentFrom(parts, terms))
    .map(([domain]) => domain);
}

// ── The filter ───────────────────────────────────────────────────────

/**
 * Build the per-conversation tool filter for an agent's scopes. Returns a
 * predicate: `true` = the tool stays available, `false` = it is dropped from
 * the run's tool surface (and rejected at execution time).
 *
 * Rules, in order:
 *   1. Core tools (no registry owner) are always available.
 *   2. Extension-owned tools matching no known domain are shared plumbing —
 *      always available.
 *   3. Extension-owned tools matching ≥1 known domain are available iff at
 *      least one matched domain is in the agent's scopes.
 */
export function buildAgentToolScopeFilter(
  scopes: string[],
  deps?: {
    /** Ownership lookup override (tests); defaults to the tool registry. */
    getOwner?: (toolName: string) => OwnerInfo | undefined;
  },
): (toolName: string) => boolean {
  const getOwner = deps?.getOwner ?? getToolOwner;
  const normalized = new Set(
    scopes.map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  return (toolName: string): boolean => {
    const owner = getOwner(toolName);
    if (!owner) return true; // core plumbing — never filtered
    const domains = toolScopeDomains(toolName, owner.id);
    if (domains.length === 0) return true; // shared plumbing
    return domains.some((d) => normalized.has(d));
  };
}
