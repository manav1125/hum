import type { SkillSummary } from "../config/skills.js";
import type { CatalogSkill } from "./catalog-install.js";

/**
 * Generic input for building capability statements.
 * Decoupled from CatalogSkill so other skill sources (e.g. bundled skills) can
 * produce capability memories without being shoehorned into the catalog type.
 */
export interface SkillCapabilityInput {
  id: string;
  displayName: string;
  description: string;
  activationHints?: string[];
  avoidWhen?: string[];
}

/**
 * Rebrand user-visible "Vellum" product prose to "Cue" in skill display text.
 *
 * Skill capability memories are rendered verbatim into the user-facing Memory
 * page (and injected into the model's `### Skills You Can Use` context), so the
 * product name must read "Cue". The remote skill catalog is an external
 * third-party registry that still ships display names / descriptions worded
 * around "Vellum" (e.g. "Vellum OAuth Integrations", "Vellum Assistant
 * gateway"); we cannot edit that registry, so we rebrand the derived DISPLAY
 * strings here at the point they enter our memory content.
 *
 * IMPORTANT — this only touches human-facing prose. It is applied to
 * `displayName` / `description` / `activationHints` / `avoidWhen`, NEVER to a
 * skill `id`: catalog ids like `vellum-oauth-integrations` are protocol
 * identifiers and must stay unchanged. Ids have no spaces and are excluded
 * from the fields this function is applied to.
 *
 * The multi-word phrases are replaced first (most specific wins) so
 * "Vellum Assistant gateway" becomes "Cue gateway" rather than
 * "Cue Assistant gateway". A trailing bare-word pass catches any remaining
 * standalone "Vellum" in prose. Case-preserving for the leading letter only —
 * the catalog uses title-cased product names in these strings.
 */
export function rebrandSkillDisplayText(text: string): string {
  return (
    text
      // "Vellum Assistant gateway" / "Vellum gateway" → "Cue gateway"
      .replace(/\bVellum(?:\s+Assistant)?\s+gateway\b/g, "Cue gateway")
      // "Vellum Assistant" (platform/product references) → "Cue"
      .replace(/\bVellum\s+Assistant\b/g, "Cue")
      // "Vellum platform" → "Cue"
      .replace(/\bVellum\s+platform\b/g, "Cue")
      // Any remaining standalone product-name "Vellum" in prose → "Cue".
      // Word-boundary anchored so it never touches ids (which have no spaces
      // and only appear inside `(...)` after this content is assembled).
      .replace(/\bVellum\b/g, "Cue")
  );
}

/**
 * Apply {@link rebrandSkillDisplayText} to every user-visible field of a
 * capability input, leaving `id` untouched. All producers below funnel through
 * this so no display path can leak "Vellum" into seeded memories.
 */
function rebrandCapabilityInput(
  input: SkillCapabilityInput,
): SkillCapabilityInput {
  return {
    id: input.id,
    displayName: rebrandSkillDisplayText(input.displayName),
    description: rebrandSkillDisplayText(input.description),
    ...(input.activationHints
      ? { activationHints: input.activationHints.map(rebrandSkillDisplayText) }
      : {}),
    ...(input.avoidWhen
      ? { avoidWhen: input.avoidWhen.map(rebrandSkillDisplayText) }
      : {}),
  };
}

/**
 * Convert a SkillSummary to a SkillCapabilityInput.
 * SkillSummary already has flat properties, so this is a straightforward mapping.
 */
export function fromSkillSummary(entry: SkillSummary): SkillCapabilityInput {
  return rebrandCapabilityInput({
    id: entry.id,
    displayName: entry.displayName,
    description: entry.description,
    activationHints: entry.activationHints,
    avoidWhen: entry.avoidWhen,
  });
}

/**
 * Convert a CatalogSkill to a SkillCapabilityInput.
 * CatalogSkill stores display-name and hints inside nested metadata.
 */
export function fromCatalogSkill(entry: CatalogSkill): SkillCapabilityInput {
  return rebrandCapabilityInput({
    id: entry.id,
    displayName: entry.metadata?.vellum?.["display-name"] ?? entry.name,
    description: entry.description,
    activationHints: entry.metadata?.vellum?.["activation-hints"],
    avoidWhen: entry.metadata?.vellum?.["avoid-when"],
  });
}
