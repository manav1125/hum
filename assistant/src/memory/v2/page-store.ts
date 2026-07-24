/**
 * Memory v2 — Concept page store.
 *
 * Owns the on-disk read/write contract for `memory/concepts/<slug>.md`.
 * Pages may live directly under `memory/concepts/` or nested in subdirectories
 * (e.g. `memory/concepts/people/alice.md`); the slug encodes the relative
 * path from `concepts/` minus the `.md` extension, using forward slashes as
 * separators (so `people/alice` is a valid slug).
 *
 * Each page is a YAML-frontmatter Markdown file: a `---`-delimited block
 * (`edges`, `ref_files`) followed by prose body. This module is the only
 * v2 component that knows how to parse or render that format — every other
 * v2 module routes through `readPage` / `writePage` so the on-disk shape
 * can evolve without touching downstream callers.
 *
 * Writes are atomic (temp + rename) so a crash mid-write leaves either the
 * old file or the new file in place — never a half-written page.
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { FRONTMATTER_REGEX } from "../../skills/frontmatter.js";
import { getLogger } from "../../util/logger.js";
import { invalidateEdgeIndex } from "./edge-index.js";
import { invalidatePageIndex } from "./page-index.js";
import { type ConceptPage, ConceptPageFrontmatterSchema } from "./types.js";

const log = getLogger("memory-v2-page-store");

/** Filename suffix for concept pages. */
const PAGE_EXTENSION = ".md";

/** Cap individual slug-segment length so we stay well under filesystem limits. */
const MAX_SLUG_SEGMENT_LENGTH = 80;

/** Cap the full slug (including any folder separators) to a sane bound. */
const MAX_SLUG_TOTAL_LENGTH = 200;

/** Each path segment must match this — same shape `slugify` produces. */
const SLUG_SEGMENT_REGEX = /^[a-z0-9](?:[a-z0-9-]*)$/;

/**
 * Convert an arbitrary input string into a filesystem-safe slug **segment**.
 *
 * Returns a single path segment (no `/`). Path-shaped slugs are constructed
 * by the consolidation LLM writing files at full paths; this helper is for
 * turning free-form text (e.g. a hint phrase) into one clean segment.
 *
 * Rules:
 *   - Lowercase ASCII letters, digits, and hyphens only.
 *   - Non-ASCII / non-alphanumeric characters (including `/`) collapse to hyphens.
 *   - Consecutive hyphens collapse to one; leading/trailing hyphens trimmed.
 *   - Truncated to {@link MAX_SLUG_SEGMENT_LENGTH} characters (with trailing
 *     hyphen re-trimmed after truncation).
 *   - Empty inputs (e.g. emoji-only) fall back to `concept-<random>` so the
 *     caller always gets a non-empty, write-safe segment.
 */
export function slugify(input: string): string {
  let slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length > MAX_SLUG_SEGMENT_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_SEGMENT_LENGTH).replace(/-+$/, "");
  }

  if (!slug) {
    slug = `concept-${randomUUID().slice(0, 8)}`;
  }

  return slug;
}

/**
 * Validate a slug — possibly path-shaped — that is about to cross the storage
 * boundary. Throws on any malformed or unsafe value.
 *
 * The on-disk concept-page tree treats slugs as relative paths under
 * `memory/concepts/`. A malformed slug (e.g. `..`, leading `/`, embedded
 * null byte) could escape that root via `path.join` if it slipped through,
 * so we enforce shape here at every read/write/delete entry point rather
 * than relying on callers.
 *
 * Rules:
 *   - Non-empty, ≤ {@link MAX_SLUG_TOTAL_LENGTH} chars.
 *   - Each `/`-separated segment matches {@link SLUG_SEGMENT_REGEX}
 *     (lowercase alphanum + hyphen, no leading hyphen, ≤80 chars).
 *   - No `..` segments, no empty segments (`a//b`), no leading or trailing `/`.
 *   - No `\` (Windows separator), no null bytes, no whitespace, no non-ASCII.
 */
export function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error(`Invalid concept-page slug: empty`);
  }
  if (slug.length > MAX_SLUG_TOTAL_LENGTH) {
    throw new Error(
      `Invalid concept-page slug: length ${slug.length} exceeds max ${MAX_SLUG_TOTAL_LENGTH}: ${slug}`,
    );
  }
  if (slug.includes("\\")) {
    throw new Error(
      `Invalid concept-page slug: backslash not allowed: ${slug}`,
    );
  }
  if (slug.includes("\0")) {
    throw new Error(`Invalid concept-page slug: null byte not allowed`);
  }
  if (/\s/.test(slug)) {
    throw new Error(
      `Invalid concept-page slug: whitespace not allowed: ${slug}`,
    );
  }
  if (slug.startsWith("/") || slug.endsWith("/")) {
    throw new Error(
      `Invalid concept-page slug: leading or trailing '/' not allowed: ${slug}`,
    );
  }
  const segments = slug.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error(`Invalid concept-page slug: empty path segment: ${slug}`);
    }
    if (segment === "..") {
      throw new Error(
        `Invalid concept-page slug: '..' segment not allowed: ${slug}`,
      );
    }
    if (segment.length > MAX_SLUG_SEGMENT_LENGTH) {
      throw new Error(
        `Invalid concept-page slug: segment '${segment}' exceeds max ${MAX_SLUG_SEGMENT_LENGTH} chars: ${slug}`,
      );
    }
    if (!SLUG_SEGMENT_REGEX.test(segment)) {
      throw new Error(
        `Invalid concept-page slug: segment '${segment}' must match [a-z0-9][a-z0-9-]*: ${slug}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getConceptsDir(workspaceDir: string): string {
  return join(workspaceDir, "memory", "concepts");
}

/**
 * Resolve the absolute path for a slug. Slugs may contain `/` to indicate
 * folder hierarchy under `memory/concepts/`; `path.join` handles those
 * correctly on POSIX, and `validateSlug` (called at every public entry point)
 * rejects shapes that could escape the concepts root.
 */
function getPagePath(workspaceDir: string, slug: string): string {
  return join(getConceptsDir(workspaceDir), `${slug}${PAGE_EXTENSION}`);
}

/**
 * Compute the slug for a concept-page file, given the concepts root and the
 * absolute file path. Returns the path-relative location with `.md` stripped
 * and platform separators normalized to `/`. Tolerant of paths that don't
 * end in `.md` so callers walking arbitrary content can use it defensively.
 */
export function slugFromConceptPath(
  conceptsRoot: string,
  filePath: string,
): string {
  const rel = relative(conceptsRoot, filePath);
  const withoutExt = rel.endsWith(PAGE_EXTENSION)
    ? rel.slice(0, -PAGE_EXTENSION.length)
    : rel;
  return sep === "/" ? withoutExt : withoutExt.split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Frontmatter parse / render
// ---------------------------------------------------------------------------

/**
 * Split raw file contents into (frontmatter, body). If no frontmatter block
 * is present the entire input is treated as body and an empty frontmatter
 * block is returned.
 *
 * Concept-page frontmatter is authored by the consolidation LLM writing files
 * directly (`write_file` / `edit_file`), so it is routinely YAML-hostile:
 * unquoted colons in a `summary:` line ("Nested mappings are not allowed in
 * compact mappings"), inconsistent indentation ("All mapping items must start
 * at the same column"), attempted block scalars, or a drifted key the strict
 * schema doesn't allow. A hard throw here was the single largest memory-job
 * failure class in prod (the `yaml_parse` category): every downstream reader
 * of the page throws, most damagingly the `embed_concept_page` job — which
 * then never indexes the page, so the consolidated memory is effectively lost.
 *
 * We therefore never throw on frontmatter. The fast path is a strict parse
 * (well-formed YAML satisfying the schema — the overwhelmingly common case,
 * round-tripping every known key exactly). On ANY failure we salvage what we
 * can, log a warn so the drift stays debuggable, and keep the body intact so
 * the page still persists and still embeds. Losing one malformed field is
 * strictly better than losing the whole memory.
 *
 * The schema's defaults guarantee `edges` and `ref_files` are always arrays
 * even on freshly created pages with empty frontmatter.
 */
function parsePageContent(raw: string): {
  frontmatter: ConceptPage["frontmatter"];
  body: string;
} {
  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    return {
      frontmatter: ConceptPageFrontmatterSchema.parse({}),
      body: raw,
    };
  }
  const yamlBlock = match[1];
  const body = raw.slice(match[0].length);

  try {
    const parsed = parseYaml(yamlBlock) ?? {};
    return {
      frontmatter: ConceptPageFrontmatterSchema.parse(parsed),
      body,
    };
  } catch (err) {
    log.warn(
      { err },
      "Concept page frontmatter failed strict parse — salvaging fields leniently so the page still persists",
    );
    return { frontmatter: salvageFrontmatter(yamlBlock), body };
  }
}

/**
 * Best-effort recovery of a frontmatter block that failed the strict parse.
 * Never throws. Handles both failure modes:
 *   - YAML *syntax* error → the structured parse is unusable, fall back to a
 *     lenient line-by-line extractor ({@link lenientParseFrontmatter}).
 *   - YAML valid but *schema* violation (unknown key, bad type) → the parse
 *     succeeded, so reuse it and let {@link coerceFrontmatter} strip the
 *     offending pieces.
 */
function salvageFrontmatter(yamlBlock: string): ConceptPage["frontmatter"] {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock) ?? {};
  } catch {
    parsed = lenientParseFrontmatter(yamlBlock);
  }
  return coerceFrontmatter(parsed);
}

/** Known scalar (string) frontmatter fields. */
const SCALAR_FIELDS = [
  "summary",
  "title",
  "slug",
  "main",
  "kind",
  "status",
  "current",
] as const;

/** Known string-array frontmatter fields. */
const STRING_ARRAY_FIELDS = [
  "edges",
  "ref_files",
  "leaves",
  "links",
  "tags",
] as const;

/**
 * Coerce an arbitrary parsed object into a schema-valid frontmatter, keeping
 * only recognized keys with defensively coerced values and dropping anything
 * that would make the strict schema reject the whole page. The constructed
 * shape is valid by construction, so the final `.parse()` never throws (its
 * defaults fill any missing `edges` / `ref_files` / `ref_urls`).
 */
function coerceFrontmatter(parsed: unknown): ConceptPage["frontmatter"] {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ConceptPageFrontmatterSchema.parse({});
  }
  const src = parsed as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  for (const key of SCALAR_FIELDS) {
    const v = src[key];
    if (typeof v === "string") {
      sanitized[key] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      sanitized[key] = String(v);
    }
  }

  for (const key of STRING_ARRAY_FIELDS) {
    const v = src[key];
    if (Array.isArray(v)) {
      sanitized[key] = v.filter((e): e is string => typeof e === "string");
    }
  }

  // `ref_urls` carries a `.url()` refinement — keep only entries that actually
  // parse as URLs so one bad link can't reject the field (and the page).
  const rawUrls = src.ref_urls;
  if (Array.isArray(rawUrls)) {
    sanitized.ref_urls = rawUrls.filter(
      (e): e is string => typeof e === "string" && isValidUrl(e),
    );
  }

  return ConceptPageFrontmatterSchema.parse(sanitized);
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recover frontmatter fields from a YAML block the parser rejected. This is a
 * deliberately dumb line scanner — not a YAML implementation — that pulls out
 * the fields the concept-page model cares about (`summary`, `edges`, ...) even
 * when the block is syntactically invalid YAML.
 *
 *   - `key: value`        → scalar. The value is everything after the first
 *                           `:` , so an unquoted colon inside a `summary:`
 *                           (the classic breakage) is preserved verbatim
 *                           instead of being misread as a nested mapping.
 *   - `key:` (bare)       → opens a block list; subsequent `- item` lines
 *                           accumulate under it.
 *   - `- item`            → list entry for the open block key.
 *
 * Everything else is ignored. Values are returned as strings / string arrays;
 * {@link coerceFrontmatter} does the final typing and schema-fitting.
 */
function lenientParseFrontmatter(yamlBlock: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentListKey: string | null = null;

  for (const rawLine of yamlBlock.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim().length === 0) continue;

    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentListKey) {
      const bucket = out[currentListKey];
      if (Array.isArray(bucket)) bucket.push(stripQuotes(listItem[1].trim()));
      continue;
    }

    // Leading whitespace is tolerated: a mis-indented key (the "All mapping
    // items must start at the same column" breakage) is exactly what we're
    // here to recover, so indentation carries no meaning in this salvage pass.
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (value.length === 0) {
      // Bare key — treat following `- ` lines as its block list.
      out[key] = [];
      currentListKey = key;
    } else {
      out[key] = stripQuotes(value);
      currentListKey = null;
    }
  }

  return out;
}

/** Strip a single layer of matching surrounding single/double quotes. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Render a concept page back into the on-disk Markdown form. The output is
 * always frontmatter + body; even pages with empty `edges` and `ref_files`
 * keep the explicit YAML keys so callers see the canonical shape on round-trip.
 */
export function renderPageContent(page: ConceptPage): string {
  const frontmatter = ConceptPageFrontmatterSchema.parse(page.frontmatter);
  const yamlBlock = stringifyYaml(frontmatter, { indent: 2 }).trimEnd();
  return `---\n${yamlBlock}\n---\n${page.body}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a single concept page. Returns `null` if the file does not exist.
 *
 * Malformed or schema-drifted frontmatter never throws: it is salvaged
 * leniently (see {@link parsePageContent}) and logged, so a single bad page
 * can't fail its `embed_concept_page` job or no-op a turn's whole injection
 * block. A genuine I/O failure (permission denied, etc.) still throws — unlike
 * "missing", those are errors the caller needs to see.
 */
export async function readPage(
  workspaceDir: string,
  slug: string,
): Promise<ConceptPage | null> {
  validateSlug(slug);
  const path = getPagePath(workspaceDir, slug);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const { frontmatter, body } = parsePageContent(raw);
  return { slug, frontmatter, body };
}

/**
 * File mtime for a concept page, in epoch ms. Returns 0 when the file is
 * missing or unreadable — callers treat 0 as "no mtime" so tier-1 sorting
 * can rank synthetic entries (skills, CLI commands) below real pages.
 */
export async function getPageMtimeMs(
  workspaceDir: string,
  slug: string,
): Promise<number> {
  validateSlug(slug);
  try {
    const s = await stat(getPagePath(workspaceDir, slug));
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Write a concept page atomically (temp file + rename). A crash between the
 * temp write and the rename leaves the prior file intact; a crash after the
 * rename leaves the new file. Readers therefore never observe a partial page.
 *
 * Parent directories are created on demand (`mkdir -p`) so nested-folder
 * slugs like `people/alice` work without callers pre-creating the folder.
 */
export async function writePage(
  workspaceDir: string,
  page: ConceptPage,
): Promise<void> {
  validateSlug(page.slug);
  const path = getPagePath(workspaceDir, page.slug);
  const tmpPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const content = renderPageContent(page);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup: if the rename failed (or the write succeeded but
    // the rename did not), remove the orphan tmp file so we don't leak it
    // into the concepts/ directory where listPages would then surface it.
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  invalidateEdgeIndex(workspaceDir);
  invalidatePageIndex(workspaceDir);
}

/**
 * List every concept-page slug present on disk, walking subdirectories.
 *
 * Slugs are returned in path-relative form with forward slashes as separators
 * (e.g. `people/alice`) so callers can pass them straight back to `readPage`.
 *
 * Hidden directories (segment starts with `.`), non-`.md` files, and atomic-
 * write temp files (`.tmp.<pid>.<uuid>`) are skipped. If the concepts/
 * directory does not yet exist (fresh workspace pre-migration), returns `[]`.
 */
export async function listPages(workspaceDir: string): Promise<string[]> {
  const root = getConceptsDir(workspaceDir);
  const slugs: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Root missing → return []. Nested missing dir is impossible mid-walk
        // (we only enqueue what readdir surfaced) but treat the same defensively.
        if (dir === root) return [];
        continue;
      }
      throw err;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(PAGE_EXTENSION)) continue;
      // Skip orphaned temp files left behind by a crashed atomic write.
      if (entry.name.includes(".tmp.")) continue;
      slugs.push(slugFromConceptPath(root, fullPath));
    }
  }

  slugs.sort();
  return slugs;
}

/**
 * Cheap "do any concept pages exist?" probe — walks the concepts/ tree only
 * far enough to find one `.md` file and returns immediately. Used by the
 * daemon-startup rebuild gate so the empty-after-create recovery path skips
 * a full enumeration of all 1000+ pages just to ask a yes/no question.
 */
export async function hasConceptPages(workspaceDir: string): Promise<boolean> {
  const root = getConceptsDir(workspaceDir);
  const queue: string[] = [root];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (dir === root) return false;
        continue;
      }
      throw err;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        queue.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(PAGE_EXTENSION)) continue;
      if (entry.name.includes(".tmp.")) continue;
      return true;
    }
  }

  return false;
}

/**
 * Delete a concept page. Idempotent — missing files are not an error.
 *
 * Any other failure (permission denied, etc.) throws so the caller can react.
 */
export async function deletePage(
  workspaceDir: string,
  slug: string,
): Promise<void> {
  validateSlug(slug);
  const path = getPagePath(workspaceDir, slug);
  try {
    await rm(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
  invalidateEdgeIndex(workspaceDir);
  invalidatePageIndex(workspaceDir);
}

/**
 * Check whether a concept page exists on disk. Useful for callers that want
 * to gate work on presence without paying for a full read.
 */
export async function pageExists(
  workspaceDir: string,
  slug: string,
): Promise<boolean> {
  validateSlug(slug);
  const path = getPagePath(workspaceDir, slug);
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
