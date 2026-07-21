/**
 * Plugin curation vocabulary — shared by the desktop marketplace, the desktop
 * detail page, and the mobile-v3 plugin surfaces.
 *
 * Curation is AUTHORITATIVE FROM THE REGISTRY. `plugins/registry.json` carries
 * a `reviewStatus` per entry and the daemon exposes it on both
 * `GET /v1/plugins/search` (every match) and `GET /v1/plugins/:name`, so the UI
 * reads the real curation decision instead of guessing from the repo owner.
 *
 * The previous heuristic — "the repo slug starts with `vellum-ai/` therefore
 * it is official" — was wrong in both directions: it claimed ownership of
 * third-party repos Cue neither wrote nor maintains, and it had no way to
 * express a plugin Cue genuinely does maintain that lives under someone else's
 * org. `curated` is an ownership/review claim, so it is only ever set in the
 * registry for entries Cue actually stands behind.
 *
 * Wording matters here: the badge says "Cue reviewed", never "Cue official".
 * Cue publishes no first-party plugins today, so an "official" badge on any
 * catalog entry would be a false authorship claim.
 */

/** Mirrors the daemon's `PluginReviewStatus`. `null` = no registry entry. */
export type PluginReviewStatus = "curated" | "community" | "unreviewed";

/** The curation axis the marketplace filters on. */
export type CurationFilter = "all" | "curated" | "community";

/**
 * Normalize whatever the wire hands us into a review status. The detail route
 * returns `null` for an installed copy that no registry entry claims (a
 * direct/CLI install); those are `unreviewed` for display purposes — Cue has
 * genuinely not reviewed them.
 */
export function reviewStatusOf(
  value: string | null | undefined,
): PluginReviewStatus {
  return value === "curated" || value === "community" ? value : "unreviewed";
}

/** True for entries Cue authored, adopted, or maintains the adapter for. */
export function isCurated(value: string | null | undefined): boolean {
  return reviewStatusOf(value) === "curated";
}

/** Badge text. Deliberately a review claim, not an ownership claim. */
export function curationBadge(value: string | null | undefined): string {
  switch (reviewStatusOf(value)) {
    case "curated":
      return "Cue reviewed";
    case "community":
      return "Community";
    default:
      return "Unreviewed";
  }
}

/**
 * The consent sentence rendered next to the ✓ / ‖ glyph on the detail
 * surfaces. Each line is something we can actually stand behind.
 */
export function curationConsentLine(value: string | null | undefined): {
  tone: "ok" | "caution";
  glyph: "✓" | "‖";
  text: string;
} {
  switch (reviewStatusOf(value)) {
    case "curated":
      return {
        tone: "ok",
        glyph: "✓",
        text: "Reviewed by Cue and pinned to a commit.",
      };
    case "community":
      return {
        tone: "caution",
        glyph: "‖",
        text: "Third-party plugin — its license and manifest were verified and it's pinned to a commit, but Cue didn't write or maintain it.",
      };
    default:
      return {
        tone: "caution",
        glyph: "‖",
        text: "Not reviewed — Cue hasn't checked this plugin.",
      };
  }
}

/**
 * Rail/segment labels for the curation filter. `curated` reads "Cue reviewed"
 * rather than "Official" for the reason above; when the count is zero the
 * surfaces show an honest empty state instead of hiding the filter.
 */
export const CURATION_FILTER_LABELS: Record<CurationFilter, string> = {
  all: "All plugins",
  curated: "Cue reviewed",
  community: "Community",
};

/** Does an entry with `status` belong in `filter`? */
export function matchesCuration(
  filter: CurationFilter,
  status: string | null | undefined,
): boolean {
  if (filter === "all") return true;
  if (filter === "curated") return isCurated(status);
  return !isCurated(status);
}
