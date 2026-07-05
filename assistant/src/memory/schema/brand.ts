import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Brand Kit registry — one row per saved brand identity (Create Studio,
 * Layer 2). Palette / fonts / logo / voice / assets are stored as JSON blobs
 * (TEXT) so the design-token set can evolve without a column migration; the
 * store (brand-profile-store.ts) parses them into typed sub-objects on read.
 *
 * `assistantId` scopes the kit to its owner (reference by convention, no FK,
 * matching the sibling HQ tables). At most one row per assistant carries
 * `isActive = 1` — the kit applied to every Create output; the store enforces
 * that invariant transactionally. `source` records which load path produced
 * the row: 'upload' (deck/PDF), 'website' (scrape), or 'guided' (visual journey).
 */
export const brandProfiles = sqliteTable("brand_profiles", {
  id: text("id").primaryKey(),
  assistantId: text("assistant_id").notNull(), // scope; indexed for list + active lookup
  name: text("name").notNull(),
  palette: text("palette"), // JSON: { primary, accent, bg, surface, text }
  fonts: text("fonts"), // JSON: { heading, body }
  logo: text("logo"), // JSON: { light, dark, mark }
  voice: text("voice"), // JSON: { tone, doList[], dontList[], boilerplate }
  assets: text("assets"), // JSON array of approved-imagery refs
  source: text("source").notNull().default("guided"), // 'upload' | 'website' | 'guided'
  isActive: integer("is_active").notNull().default(0), // 0/1 — applied everywhere
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
