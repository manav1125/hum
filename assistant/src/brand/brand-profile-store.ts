/**
 * Brand Kit store — CRUD for `brand_profiles` (migration 297), the stored
 * per-assistant brand identity behind Create Studio (Layer 2 of the
 * Create-Studio direction). Each row is one saved brand (palette / fonts /
 * logo / voice / approved assets) that Create outputs are rendered in.
 *
 * The five structured sub-objects (palette / fonts / logo / voice / assets) are
 * persisted as JSON blobs in TEXT columns so the design-token set can evolve
 * without a migration per field; this module is the single place that
 * serializes them on write and parses them on read, so every consumer gets a
 * typed `BrandProfile`.
 *
 * SINGLE-ACTIVE INVARIANT: at most one profile per assistant has
 * `isActive = 1` — the kit applied to every Create output. `setActive` enforces
 * this transactionally (clear all, then set the one), so the flag can never
 * split-brain across two rows for the same assistant. Referential integrity to
 * the owning assistant is by convention (no FK), matching the sibling HQ stores.
 */

import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { brandProfiles } from "../memory/schema/brand.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("brand-profile-store");

// ── Types ────────────────────────────────────────────────────────────

/** How the brand kit was loaded. */
export type BrandSource = "upload" | "website" | "guided";

export const BRAND_SOURCES: readonly BrandSource[] = [
  "upload",
  "website",
  "guided",
];

/** Structured colour tokens. All fields optional — a draft may be partial. */
export interface BrandPalette {
  primary?: string;
  accent?: string;
  bg?: string;
  surface?: string;
  text?: string;
  [key: string]: string | undefined;
}

/** Heading + body typefaces. */
export interface BrandFonts {
  heading?: string;
  body?: string;
}

/** Logo refs (urls or storage refs) for light/dark backgrounds + the mark. */
export interface BrandLogo {
  light?: string;
  dark?: string;
  mark?: string;
}

/** Brand voice: tone, do/don't guidance, and reusable boilerplate copy. */
export interface BrandVoice {
  tone?: string;
  doList?: string[];
  dontList?: string[];
  boilerplate?: string;
}

/** A brand profile as seen by consumers (JSON columns parsed). */
export interface BrandProfile {
  id: string;
  assistantId: string;
  name: string;
  palette: BrandPalette;
  fonts: BrandFonts;
  logo: BrandLogo;
  voice: BrandVoice;
  assets: string[];
  source: BrandSource;
  /** 0/1 — the kit applied everywhere. */
  isActive: number;
  createdAt: number;
  updatedAt: number;
}

/** The mutable content of a brand profile (everything but id + timestamps). */
export interface BrandProfileInput {
  name: string;
  palette?: BrandPalette;
  fonts?: BrandFonts;
  logo?: BrandLogo;
  voice?: BrandVoice;
  assets?: string[];
  source?: BrandSource;
}

// ── (de)serialization ────────────────────────────────────────────────

/** The raw table row shape (JSON columns still strings). */
interface BrandProfileRow {
  id: string;
  assistantId: string;
  name: string;
  palette: string | null;
  fonts: string | null;
  logo: string | null;
  voice: string | null;
  assets: string | null;
  source: string;
  isActive: number;
  createdAt: number;
  updatedAt: number;
}

/** Parse a JSON blob column, tolerating null/garbage by returning the default. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function normalizeSource(raw: string): BrandSource {
  return (BRAND_SOURCES as readonly string[]).includes(raw)
    ? (raw as BrandSource)
    : "guided";
}

/** Map a raw row into a typed BrandProfile (JSON columns parsed). */
function rowToProfile(row: BrandProfileRow): BrandProfile {
  const assets = parseJson<unknown>(row.assets, []);
  return {
    id: row.id,
    assistantId: row.assistantId,
    name: row.name,
    palette: parseJson<BrandPalette>(row.palette, {}),
    fonts: parseJson<BrandFonts>(row.fonts, {}),
    logo: parseJson<BrandLogo>(row.logo, {}),
    voice: parseJson<BrandVoice>(row.voice, {}),
    assets: Array.isArray(assets)
      ? assets.filter((a): a is string => typeof a === "string")
      : [],
    source: normalizeSource(row.source),
    isActive: row.isActive ? 1 : 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────

/** List an assistant's brand profiles, newest first. */
export function listBrandProfiles(assistantId: string): BrandProfile[] {
  const db = getDb();
  const rows = db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.assistantId, assistantId))
    .orderBy(asc(brandProfiles.createdAt))
    .all() as BrandProfileRow[];
  return rows.map(rowToProfile);
}

/** Fetch a single profile by id, or undefined. */
export function getBrandProfile(id: string): BrandProfile | undefined {
  const db = getDb();
  const row = db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.id, id))
    .get() as BrandProfileRow | undefined;
  return row ? rowToProfile(row) : undefined;
}

/** The assistant's active brand kit (applied everywhere), or undefined. */
export function getActiveBrandProfile(
  assistantId: string,
): BrandProfile | undefined {
  const db = getDb();
  const row = db
    .select()
    .from(brandProfiles)
    .where(
      and(
        eq(brandProfiles.assistantId, assistantId),
        eq(brandProfiles.isActive, 1),
      ),
    )
    .get() as BrandProfileRow | undefined;
  return row ? rowToProfile(row) : undefined;
}

/**
 * Create a brand profile. The first profile an assistant creates is made
 * active automatically (so a lone kit is applied without a separate activate
 * call); subsequent ones are inactive until explicitly activated.
 */
export function createBrandProfile(
  assistantId: string,
  input: BrandProfileInput,
): BrandProfile {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const firstForAssistant = listBrandProfiles(assistantId).length === 0 ? 1 : 0;
  db.insert(brandProfiles)
    .values({
      id,
      assistantId,
      name: input.name,
      palette: JSON.stringify(input.palette ?? {}),
      fonts: JSON.stringify(input.fonts ?? {}),
      logo: JSON.stringify(input.logo ?? {}),
      voice: JSON.stringify(input.voice ?? {}),
      assets: JSON.stringify(input.assets ?? []),
      source: input.source ?? "guided",
      isActive: firstForAssistant,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const created = getBrandProfile(id);
  if (!created) {
    // Should be impossible — we just inserted it. Surface loudly.
    throw new Error(`brand profile ${id} vanished immediately after insert`);
  }
  return created;
}

/**
 * Patch a brand profile. Only provided fields are written; the rest keep their
 * current value. `isActive` is intentionally NOT patchable here — use
 * {@link setActiveBrandProfile} so the single-active invariant is enforced.
 */
export function updateBrandProfile(
  id: string,
  updates: Partial<BrandProfileInput>,
): BrandProfile | undefined {
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: Date.now() };
  if (updates.name !== undefined) set.name = updates.name;
  if (updates.palette !== undefined)
    set.palette = JSON.stringify(updates.palette);
  if (updates.fonts !== undefined) set.fonts = JSON.stringify(updates.fonts);
  if (updates.logo !== undefined) set.logo = JSON.stringify(updates.logo);
  if (updates.voice !== undefined) set.voice = JSON.stringify(updates.voice);
  if (updates.assets !== undefined) set.assets = JSON.stringify(updates.assets);
  if (updates.source !== undefined) set.source = updates.source;
  db.update(brandProfiles).set(set).where(eq(brandProfiles.id, id)).run();
  return getBrandProfile(id);
}

/** Delete a brand profile. Hard delete. */
export function deleteBrandProfile(id: string): void {
  const db = getDb();
  db.delete(brandProfiles).where(eq(brandProfiles.id, id)).run();
}

/**
 * Make one profile the active kit for its assistant, clearing the flag on all
 * the assistant's other profiles in the SAME transaction so at most one row is
 * ever active. No-op-safe: returns undefined if the id doesn't exist.
 */
export function setActiveBrandProfile(id: string): BrandProfile | undefined {
  const target = getBrandProfile(id);
  if (!target) return undefined;

  const raw = getSqliteFrom(getDb());
  const now = Date.now();
  const activate = raw.transaction(() => {
    // Clear every active flag for this assistant, then set the one target.
    raw
      .prepare(
        /*sql*/ `UPDATE brand_profiles SET is_active = 0, updated_at = ?1
                 WHERE assistant_id = ?2 AND is_active = 1`,
      )
      .run(now, target.assistantId);
    raw
      .prepare(
        /*sql*/ `UPDATE brand_profiles SET is_active = 1, updated_at = ?1
                 WHERE id = ?2`,
      )
      .run(now, id);
  });
  try {
    activate();
  } catch (err) {
    log.error({ err: String(err), id }, "failed to set active brand profile");
    throw err;
  }
  return getBrandProfile(id);
}

/** Test/diagnostic helper: how many profiles the assistant holds. */
export function countBrandProfiles(assistantId: string): number {
  return listBrandProfiles(assistantId).length;
}
