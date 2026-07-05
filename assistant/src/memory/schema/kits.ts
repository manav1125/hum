import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Create Studio "fan-out kit" — a coordinated single-pass asset kit. One `kits`
 * row is one launched kit (a shared brief + the compiled design-contract + the
 * brand kit applied to every asset); one `kit_assets` row is one format in the
 * kit (deck / one-pager / social / …), each produced in its own background
 * generation conversation so the set reads as coordinated while each asset
 * renders in the right Create surface.
 *
 * `assistantId` / `brandKitId` reference their owners by convention (no FK,
 * matching the sibling HQ tables — brand_profiles, missions, work_outputs).
 * `contractPreamble` is captured on the kit so a regenerate re-seeds with the
 * exact same constraints the original run used.
 */
export const kits = sqliteTable("kits", {
  id: text("id").primaryKey(),
  assistantId: text("assistant_id").notNull(), // scope; indexed for the kit list
  brief: text("brief").notNull(), // the shared source brief seeded into every asset
  brandKitId: text("brand_kit_id"), // brand_profiles.id by convention; null = un-branded
  contractPreamble: text("contract_preamble"), // compiled design-contract prepended to each seed
  title: text("title"), // optional display name ("Series A launch kit")
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** One format in a kit — its own background generation run + tracked output. */
export const kitAssets = sqliteTable("kit_assets", {
  id: text("id").primaryKey(),
  kitId: text("kit_id").notNull(), // kits.id by convention; indexed for the status view
  format: text("format").notNull(), // 'slides' | 'one_pager' | 'social' | 'email' | 'landing' | …
  mode: text("mode").notNull(), // Create mode the format resolves to (slides → app-builder, …)
  conversationId: text("conversation_id"), // background generation conversation; null until launched
  status: text("status").notNull().default("pending"), // 'pending' | 'running' | 'done' | 'failed'
  outputRef: text("output_ref"), // attachment id of the produced deliverable, or null
  error: text("error"), // failure message when status = 'failed'
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
