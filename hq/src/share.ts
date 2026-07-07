/**
 * Cue HQ — public, shareable skill pages (WS6 growth loops).
 *
 * GET /skills/{slug} renders a marketplace skill's detail as a static,
 * UNAUTHENTICATED page with OG meta tags, source attribution, a
 * "requires these integrations" list when the skill declares one, and an
 * install CTA that deep-links into the app via the sign-in flow.
 *
 * Render inputs are STATIC only:
 *   1. The first-party skills catalog (repo-root skills/catalog.json —
 *      HQ_SKILLS_CATALOG overrides the path) for `cue-official` skills.
 *   2. The WS1 marketplace seed-source list (mirrored below from
 *      assistant/src/skills/marketplace/sources.ts DEFAULT_SOURCES) for
 *      community skills, addressed as `{owner}--{repo}--{skillName}` slugs.
 *      Only seeded sources render — arbitrary owner/repo slugs 404, so the
 *      page can't be abused to dress up unvetted links.
 *
 * This module takes NO database handle and calls NO daemon endpoint — the
 * render path cannot leak customer data because it never touches any.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// ── seed sources (mirror of WS1 DEFAULT_SOURCES; keep in sync) ──────────

interface SeedSource {
  /** `owner/repo`. */
  address: string;
  label: string;
  license?: string;
}

/**
 * Vetted community sources the marketplace ships enabled — the only GitHub
 * addresses share pages will render. Source of truth:
 * assistant/src/skills/marketplace/sources.ts (DEFAULT_SOURCES).
 */
export const SHARE_SEED_SOURCES: SeedSource[] = [
  { address: "anthropics/skills", label: "Anthropic skills" },
  {
    address: "anthropics/knowledge-work-plugins",
    label: "Anthropic knowledge work",
    license: "Apache-2.0",
  },
  {
    address: "davila7/claude-code-templates",
    label: "Claude Code templates",
    license: "MIT",
  },
  {
    address: "alirezarezvani/claude-skills",
    label: "Claude skills (community)",
    license: "MIT",
  },
  { address: "github/awesome-copilot", label: "Awesome Copilot", license: "MIT" },
  { address: "obra/superpowers", label: "Superpowers", license: "MIT" },
];

// ── catalog loading (repo-root skills/catalog.json) ─────────────────────

interface CatalogSkillRaw {
  id?: string;
  name?: string;
  description?: string;
  metadata?: {
    emoji?: string;
    vellum?: {
      "display-name"?: string;
      category?: string;
      emoji?: string;
      includes?: string[];
      /** Declared integration requirements (capability manifest style). */
      connectors?: string[];
    };
  };
}

export interface ShareSkill {
  slug: string;
  name: string;
  description: string;
  emoji?: string;
  category?: string;
  /** Attribution: label + `owner/repo` (or "Cue official"). */
  sourceLabel: string;
  sourceAddress: string;
  /** Browsable source URL (GitHub) — absent for first-party skills. */
  sourceUrl?: string;
  license?: string;
  /** Declared "requires these integrations" list (may be empty). */
  integrations: string[];
  /** Companion skills this one composes with (catalog `includes`). */
  worksWith: string[];
}

/** Resolve the catalog path (HQ_SKILLS_CATALOG, default repo-root). */
export function resolveSkillsCatalogPath(): string {
  const fromEnv = process.env.HQ_SKILLS_CATALOG;
  if (fromEnv) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
  }
  // hq/src/share.ts → hq/ → repo root → skills/catalog.json
  return resolve(import.meta.dir, "..", "..", "skills", "catalog.json");
}

let catalogCache: { path: string; mtimeMs: number; skills: ShareSkill[] } | null =
  null;

/** Load + map the first-party catalog, cached by file mtime. Never throws. */
export function loadCatalogSkills(): ShareSkill[] {
  const path = resolveSkillsCatalogPath();
  try {
    if (!existsSync(path)) return [];
    const mtimeMs = statSync(path).mtimeMs;
    if (catalogCache && catalogCache.path === path && catalogCache.mtimeMs === mtimeMs) {
      return catalogCache.skills;
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      skills?: CatalogSkillRaw[];
    };
    const skills = (parsed.skills ?? [])
      .filter((s): s is CatalogSkillRaw & { id: string } => typeof s.id === "string" && s.id.length > 0)
      .map((s): ShareSkill => {
        const vellum = s.metadata?.vellum ?? {};
        return {
          slug: s.id,
          name: vellum["display-name"] ?? s.name ?? s.id,
          description: s.description ?? "",
          emoji: s.metadata?.emoji ?? vellum.emoji,
          category: vellum.category,
          sourceLabel: "Cue official",
          sourceAddress: "cue-official",
          integrations: Array.isArray(vellum.connectors) ? vellum.connectors : [],
          worksWith: Array.isArray(vellum.includes) ? vellum.includes : [],
        };
      });
    catalogCache = { path, mtimeMs, skills };
    return skills;
  } catch {
    return []; // malformed catalog degrades to "no share pages", never a 500
  }
}

// ── slug resolution ──────────────────────────────────────────────────────

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** "pdf-tools" → "Pdf Tools" (display fallback for community slugs). */
function titleize(raw: string): string {
  return raw
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Resolve a share slug to a renderable skill, or null (404).
 * First-party catalog ids win; `{owner}--{repo}--{skillName}` slugs render
 * for seeded sources only, with attribution and a GitHub link (their detail
 * lives in the source repo — we index, never host).
 */
export function getShareSkill(slug: string): ShareSkill | null {
  if (!SLUG_RE.test(slug)) return null;

  const catalogHit = loadCatalogSkills().find((s) => s.slug === slug);
  if (catalogHit) return catalogHit;

  for (const source of SHARE_SEED_SOURCES) {
    const prefix = source.address.replace("/", "--") + "--";
    if (!slug.startsWith(prefix) || slug.length <= prefix.length) continue;
    const skillName = slug.slice(prefix.length);
    return {
      slug,
      name: titleize(skillName),
      description: `A community skill from ${source.label} (${source.address}), indexed by the Cue skill marketplace. Install it into your Cue assistant with one click.`,
      sourceLabel: source.label,
      sourceAddress: source.address,
      sourceUrl: `https://github.com/${source.address}`,
      license: source.license,
      integrations: [],
      worksWith: [],
    };
  }
  return null;
}

// ── rendering ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function chips(items: string[]): string {
  return items.map((i) => `<span class="chip">${esc(i)}</span>`).join("");
}

/**
 * Render the share page. Static inputs only — no customer data, tokens, or
 * daemon URLs can appear here because none are reachable from this scope.
 */
export function renderSkillSharePage(skill: ShareSkill, siteBase: string): string {
  const pageUrl = `${siteBase}/skills/${encodeURIComponent(skill.slug)}`;
  const installUrl = `${siteBase}/signin?install=${encodeURIComponent(skill.slug)}`;
  const title = `${skill.name} — Cue Skills`;
  const description =
    skill.description.length > 300
      ? `${skill.description.slice(0, 297)}…`
      : skill.description;

  const attribution = skill.sourceUrl
    ? `<a class="dim" href="${esc(skill.sourceUrl)}" rel="noopener">${esc(skill.sourceLabel)} · ${esc(skill.sourceAddress)}</a>`
    : `<span class="dim">${esc(skill.sourceLabel)}</span>`;

  const sections: string[] = [];
  if (skill.integrations.length > 0) {
    sections.push(
      `<h2>Requires these integrations</h2><div class="chips">${chips(skill.integrations)}</div>`,
    );
  }
  if (skill.worksWith.length > 0) {
    sections.push(
      `<h2>Works with</h2><div class="chips">${chips(skill.worksWith)}</div>`,
    );
  }
  if (skill.category) {
    sections.push(
      `<h2>Category</h2><div class="chips">${chips([skill.category])}</div>`,
    );
  }
  if (skill.license) {
    sections.push(`<h2>License</h2><p class="dim">${esc(skill.license)}</p>`);
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Cue">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:image" content="${esc(siteBase)}/assets/ui-skills.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="canonical" href="${esc(pageUrl)}">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:#0F1620; color:#E6ECF5;
         font:15px/1.6 -apple-system, "SF Pro Text", "Segoe UI", sans-serif; }
  .wrap { max-width:640px; margin:0 auto; padding:56px 24px 72px; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:40px; }
  .mark { width:34px; height:34px; border-radius:10px; background:#1A2230;
          border:1.5px solid rgba(255,255,255,.18); display:inline-flex;
          align-items:center; justify-content:center; position:relative;
          font-size:18px; font-weight:600; color:#fff; }
  .mark i { position:absolute; width:6px; height:6px; border-radius:50%;
            background:#3D6EE8; right:7px; bottom:8px; }
  .brand a { color:#E6ECF5; text-decoration:none; font-weight:600; }
  .emoji { font-size:40px; line-height:1; }
  h1 { font-size:28px; font-weight:600; letter-spacing:-.02em; margin:14px 0 6px; }
  h2 { font-size:12px; font-weight:600; text-transform:uppercase;
       letter-spacing:1.2px; color:#8b93a5; margin:28px 0 10px; }
  p { color:#AEB7C7; margin:10px 0 0; }
  .dim { color:#8b93a5; font-size:13px; text-decoration:none; }
  .chips { display:flex; gap:8px; flex-wrap:wrap; }
  .chip { display:inline-block; padding:4px 12px; border-radius:999px;
          border:1px solid rgba(255,255,255,.14); background:#161e2b;
          font-size:12.5px; color:#c6cedd; }
  .cta { margin-top:36px; display:flex; gap:12px; flex-wrap:wrap; }
  .cta a { display:inline-block; text-decoration:none; border-radius:10px;
           padding:12px 22px; font-size:14px; font-weight:500; }
  .cta .primary { background:#3D6EE8; color:#fff; }
  .cta .secondary { border:1px solid rgba(255,255,255,.18); color:#E6ECF5; }
  footer { margin-top:56px; font-size:12.5px; color:#66707f; }
  footer a { color:#8b93a5; }
</style></head><body>
<div class="wrap">
  <div class="brand"><span class="mark">C<i></i></span><a href="/">Cue</a></div>
  ${skill.emoji ? `<div class="emoji">${esc(skill.emoji)}</div>` : ""}
  <h1>${esc(skill.name)}</h1>
  ${attribution}
  <p>${esc(description)}</p>
  ${sections.join("\n  ")}
  <div class="cta">
    <a class="primary" href="${esc(installUrl)}">Install in Cue</a>
    <a class="secondary" href="/pricing">Get Cue</a>
  </div>
  <footer>Skills run inside your own Cue assistant. Community skills are
  indexed from their source repositories — review before use.
  <a href="/skills">Browse all skills</a></footer>
</div>
</body></html>`;
}

/** Branded 404 for unknown share slugs (mirrors the downloads 404 style). */
export function renderShareNotFoundPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Cue — skill not found</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center;
         justify-content:center; background:#0F1620; color:#E6ECF5;
         font:15px/1.6 -apple-system, "SF Pro Text", "Segoe UI", sans-serif; }
  .card { max-width:420px; padding:40px 32px; text-align:center; }
  h1 { font-size:22px; font-weight:600; letter-spacing:-.02em; margin:0; }
  p { color:#AEB7C7; font-size:14px; margin:12px 0 0; }
  a { display:inline-block; margin-top:22px; background:#3D6EE8; color:#fff;
      text-decoration:none; border-radius:10px; padding:11px 20px;
      font-size:13.5px; font-weight:500; }
</style></head><body>
<div class="card">
  <h1>That skill isn't here.</h1>
  <p>It may have moved or been removed from the marketplace index.</p>
  <a href="/skills">Browse all skills</a>
</div>
</body></html>`;
}
