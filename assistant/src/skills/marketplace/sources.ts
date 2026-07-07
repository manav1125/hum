/**
 * Marketplace source registry — a `marketplace-sources.json` in the workspace
 * dir listing the GitHub repos (plus the built-in "Cue official" catalog
 * source) the indexer aggregates.
 *
 * Seeded on first read with the vetted default sources. Licenses were
 * verified per repo before seeding (global guardrail #8); repos without a
 * permissive license are NOT seeded (ComposioHQ/awesome-claude-skills was
 * dropped — no license file). anthropics/skills is licensed per skill
 * (mostly Apache-2.0; the docx/pdf/pptx/xlsx document skills are
 * source-available) — the per-skill `license` frontmatter is surfaced on
 * every card so users see attribution + terms.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { MarketplaceSource } from "./types.js";

const log = getLogger("marketplace-sources");

/** Reserved address for the first-party catalog source. */
export const CUE_OFFICIAL_ADDRESS = "cue-official";

/**
 * Seed sources, enabled by default. Order matters — this is the Explore
 * tab's default source order.
 */
export const DEFAULT_SOURCES: MarketplaceSource[] = [
  {
    address: CUE_OFFICIAL_ADDRESS,
    kind: "catalog",
    label: "Cue official",
    enabled: true,
    builtIn: true,
  },
  {
    address: "anthropics/skills",
    kind: "github",
    label: "Anthropic skills",
    enabled: true,
    builtIn: true,
    // Licensed per skill: most are Apache-2.0; the document skills
    // (docx/pdf/pptx/xlsx) are source-available. Per-skill `license`
    // frontmatter is shown on cards.
  },
  {
    address: "anthropics/knowledge-work-plugins",
    kind: "github",
    label: "Anthropic knowledge work",
    enabled: true,
    builtIn: true,
    license: "Apache-2.0",
  },
  {
    address: "davila7/claude-code-templates",
    kind: "github",
    label: "Claude Code templates",
    enabled: true,
    builtIn: true,
    license: "MIT",
  },
  {
    address: "alirezarezvani/claude-skills",
    kind: "github",
    label: "Claude skills (community)",
    enabled: true,
    builtIn: true,
    license: "MIT",
  },
  {
    address: "github/awesome-copilot",
    kind: "github",
    label: "Awesome Copilot",
    enabled: true,
    builtIn: true,
    license: "MIT",
  },
  {
    address: "obra/superpowers",
    kind: "github",
    label: "Superpowers",
    enabled: true,
    builtIn: true,
    license: "MIT",
  },
];

export function getSourcesFilePath(): string {
  return join(getWorkspaceDir(), "marketplace-sources.json");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, filePath);
}

const GITHUB_ADDRESS_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Normalize a user-entered source address to `owner/repo`. Accepts bare
 * `owner/repo` and full github.com URLs. Returns null when unparseable.
 */
export function normalizeGithubAddress(input: string): string | null {
  let address = input.trim();
  const urlMatch = address.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+)/i,
  );
  if (urlMatch) {
    address = `${urlMatch[1]}/${urlMatch[2]}`;
  }
  address = address.replace(/\.git$/, "");
  if (!GITHUB_ADDRESS_RE.test(address)) return null;
  return address;
}

function isValidSource(raw: unknown): raw is MarketplaceSource {
  if (typeof raw !== "object" || raw === null) return false;
  const s = raw as Record<string, unknown>;
  return (
    typeof s.address === "string" &&
    s.address.length > 0 &&
    (s.kind === "github" || s.kind === "catalog") &&
    typeof s.enabled === "boolean"
  );
}

/**
 * Read the source registry, seeding the defaults on first use. Malformed
 * files fall back to the defaults (never throw — degraded, not broken).
 */
export function loadSources(): MarketplaceSource[] {
  const filePath = getSourcesFilePath();
  if (!existsSync(filePath)) {
    try {
      atomicWriteJson(filePath, { version: 1, sources: DEFAULT_SOURCES });
    } catch (err) {
      log.warn({ err, filePath }, "Failed to seed marketplace sources file");
    }
    return [...DEFAULT_SOURCES];
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as {
      sources?: unknown;
    };
    if (!Array.isArray(parsed.sources)) return [...DEFAULT_SOURCES];
    return parsed.sources.filter(isValidSource);
  } catch (err) {
    log.warn({ err, filePath }, "Failed to read marketplace sources file");
    return [...DEFAULT_SOURCES];
  }
}

export function saveSources(sources: MarketplaceSource[]): void {
  atomicWriteJson(getSourcesFilePath(), { version: 1, sources });
}

export function getSource(address: string): MarketplaceSource | undefined {
  return loadSources().find((s) => s.address === address);
}

export interface AddSourceInput {
  address: string;
  ref?: string;
  label?: string;
  license?: string;
}

/** Add (or re-enable) a github source. Returns the stored source. */
export function addSource(input: AddSourceInput): MarketplaceSource {
  const sources = loadSources();
  const existing = sources.find((s) => s.address === input.address);
  if (existing) {
    existing.enabled = true;
    if (input.ref) existing.ref = input.ref;
    if (input.label) existing.label = input.label;
    if (input.license) existing.license = input.license;
    saveSources(sources);
    return existing;
  }
  const source: MarketplaceSource = {
    address: input.address,
    kind: "github",
    enabled: true,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.license ? { license: input.license } : {}),
  };
  sources.push(source);
  saveSources(sources);
  return source;
}

/**
 * Remove a source. Built-in sources are disabled rather than deleted so the
 * seed list can't be permanently lost. Returns false when unknown.
 */
export function removeSource(address: string): boolean {
  const sources = loadSources();
  const idx = sources.findIndex((s) => s.address === address);
  if (idx === -1) return false;
  if (sources[idx].builtIn) {
    sources[idx].enabled = false;
  } else {
    sources.splice(idx, 1);
  }
  saveSources(sources);
  return true;
}

/** Enable/disable a source in place. Returns false when unknown. */
export function setSourceEnabled(address: string, enabled: boolean): boolean {
  const sources = loadSources();
  const source = sources.find((s) => s.address === address);
  if (!source) return false;
  source.enabled = enabled;
  saveSources(sources);
  return true;
}
