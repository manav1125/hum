/**
 * Kit store — CRUD for `kits` + `kit_assets` (migration 298), the coordinated
 * single-pass "asset kit" behind Create Studio's fan-out (one brief → deck +
 * one-pager + social set + … produced together and tracked as a set).
 *
 * A kit is one launched set: the shared brief, the compiled design-contract
 * preamble every asset was seeded with, and the brand kit applied to all of
 * them. Each asset is one format (deck / one-pager / social / …) that runs in
 * its own background generation conversation — this store is the single place
 * that binds the assets to their kit and tracks each run's status + output.
 *
 * Referential integrity to the owning assistant + brand profile is by
 * convention (no FK), matching the sibling HQ stores (brand-profile-store,
 * work-output-store, mission-store).
 */

import { randomUUID } from "node:crypto";

import { asc, desc, eq, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { kitAssets, kits } from "../memory/schema/kits.js";

// ── Types ────────────────────────────────────────────────────────────

/** Lifecycle of one asset's background generation run. */
export type KitAssetStatus = "pending" | "running" | "done" | "failed";

export const KIT_ASSET_STATUSES: readonly KitAssetStatus[] = [
  "pending",
  "running",
  "done",
  "failed",
];

/** A kit as seen by consumers. */
export interface Kit {
  id: string;
  assistantId: string;
  brief: string;
  brandKitId: string | null;
  contractPreamble: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One format in a kit — its own generation run + tracked output. */
export interface KitAsset {
  id: string;
  kitId: string;
  format: string;
  mode: string;
  conversationId: string | null;
  status: KitAssetStatus;
  outputRef: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A kit joined with its assets — the shape both the create + status routes return. */
export interface KitWithAssets extends Kit {
  assets: KitAsset[];
}

/** The content of a kit at creation time (everything but id + timestamps). */
export interface KitInput {
  brief: string;
  brandKitId?: string | null;
  contractPreamble?: string | null;
  title?: string | null;
  /** The formats to fan out into, each a { format, mode } pair. */
  formats: Array<{ format: string; mode: string }>;
}

// ── (de)serialization ────────────────────────────────────────────────

interface KitRow {
  id: string;
  assistantId: string;
  brief: string;
  brandKitId: string | null;
  contractPreamble: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

interface KitAssetRow {
  id: string;
  kitId: string;
  format: string;
  mode: string;
  conversationId: string | null;
  status: string;
  outputRef: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

function normalizeStatus(raw: string): KitAssetStatus {
  return (KIT_ASSET_STATUSES as readonly string[]).includes(raw)
    ? (raw as KitAssetStatus)
    : "pending";
}

function rowToKit(row: KitRow): Kit {
  return {
    id: row.id,
    assistantId: row.assistantId,
    brief: row.brief,
    brandKitId: row.brandKitId ?? null,
    contractPreamble: row.contractPreamble ?? null,
    title: row.title ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToAsset(row: KitAssetRow): KitAsset {
  return {
    id: row.id,
    kitId: row.kitId,
    format: row.format,
    mode: row.mode,
    conversationId: row.conversationId ?? null,
    status: normalizeStatus(row.status),
    outputRef: row.outputRef ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────

/**
 * Create a kit + one asset row per requested format (all `pending`). Launching
 * the generation runs is the caller's concern (kit-orchestrator) — this store
 * only persists the set so it is tracked together under one `kitId`.
 */
export function createKit(assistantId: string, input: KitInput): KitWithAssets {
  const db = getDb();
  const now = Date.now();
  const kitId = randomUUID();

  db.insert(kits)
    .values({
      id: kitId,
      assistantId,
      brief: input.brief,
      brandKitId: input.brandKitId ?? null,
      contractPreamble: input.contractPreamble ?? null,
      title: input.title ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const assets: KitAsset[] = [];
  for (const f of input.formats) {
    const asset: KitAsset = {
      id: randomUUID(),
      kitId,
      format: f.format,
      mode: f.mode,
      conversationId: null,
      status: "pending",
      outputRef: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(kitAssets)
      .values({
        id: asset.id,
        kitId: asset.kitId,
        format: asset.format,
        mode: asset.mode,
        conversationId: null,
        status: "pending",
        outputRef: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    assets.push(asset);
  }

  return { ...rowToKit(getKitRow(kitId)!), assets };
}

function getKitRow(id: string): KitRow | undefined {
  const db = getDb();
  return db.select().from(kits).where(eq(kits.id, id)).get() as
    | KitRow
    | undefined;
}

/** Fetch a kit (without assets), or undefined. */
export function getKit(id: string): Kit | undefined {
  const row = getKitRow(id);
  return row ? rowToKit(row) : undefined;
}

/** The assets of a kit, creation order (matching the launch order). */
export function listKitAssets(kitId: string): KitAsset[] {
  const db = getDb();
  const rows = db
    .select()
    .from(kitAssets)
    .where(eq(kitAssets.kitId, kitId))
    // rowid tiebreaker keeps assets in insertion order even when a whole kit's
    // assets share one createdAt millisecond (they're inserted in a tight loop).
    .orderBy(asc(kitAssets.createdAt), sql`rowid ASC`)
    .all() as KitAssetRow[];
  return rows.map(rowToAsset);
}

/** A kit joined with its assets, or undefined when the kit doesn't exist. */
export function getKitWithAssets(id: string): KitWithAssets | undefined {
  const kit = getKit(id);
  if (!kit) return undefined;
  return { ...kit, assets: listKitAssets(id) };
}

/** Fetch a single asset by id, or undefined. */
export function getKitAsset(id: string): KitAsset | undefined {
  const db = getDb();
  const row = db.select().from(kitAssets).where(eq(kitAssets.id, id)).get() as
    | KitAssetRow
    | undefined;
  return row ? rowToAsset(row) : undefined;
}

/** List an assistant's kits, newest first. */
export function listKits(assistantId: string): Kit[] {
  const db = getDb();
  const rows = db
    .select()
    .from(kits)
    .where(eq(kits.assistantId, assistantId))
    // rowid tiebreaker so kits created in the same millisecond keep a stable,
    // insertion-reversed order (matching work-output-store's ordering).
    .orderBy(desc(kits.createdAt), sql`rowid DESC`)
    .all() as KitRow[];
  return rows.map(rowToKit);
}

/**
 * Patch an asset's run state. Only provided fields are written; the rest keep
 * their current value. Bumps the asset's `updatedAt`. Returns the fresh asset,
 * or undefined if the id doesn't exist.
 */
export function updateKitAsset(
  id: string,
  updates: Partial<
    Pick<KitAsset, "conversationId" | "status" | "outputRef" | "error">
  >,
): KitAsset | undefined {
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: Date.now() };
  if (updates.conversationId !== undefined)
    set.conversationId = updates.conversationId;
  if (updates.status !== undefined) set.status = updates.status;
  if (updates.outputRef !== undefined) set.outputRef = updates.outputRef;
  if (updates.error !== undefined) set.error = updates.error;
  db.update(kitAssets).set(set).where(eq(kitAssets.id, id)).run();
  return getKitAsset(id);
}

/** Delete a kit and all its assets. Hard delete. */
export function deleteKit(id: string): void {
  const db = getDb();
  db.delete(kitAssets).where(eq(kitAssets.kitId, id)).run();
  db.delete(kits).where(eq(kits.id, id)).run();
}
