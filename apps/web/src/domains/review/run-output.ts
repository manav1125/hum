/**
 * Shaping the opaque run `output` payload for display.
 *
 * Kept out of the page component so it can be tested without pulling the
 * design library (and the whole React tree) in behind it.
 */

/** Strip a leading markdown bullet marker, if the producer stored one. */
export function stripBullet(line: string): string {
  return line.replace(/^\s*[-*]\s*/, "").trim();
}

/**
 * Highlights that the summary does not already say.
 *
 * `extractWorkItemResult` builds `highlights` by scanning the *same* assistant
 * text it stores as `summary` for bullet lines
 * (assistant/src/work-items/work-item-run-result.ts). So for any run whose
 * prose contained bullets, the two fields overlap entirely and the review
 * panel printed the item body twice — once as prose, then again as a list
 * underneath. The tool-outcome highlights appended afterwards are the part
 * that genuinely adds something, and those survive this filter.
 *
 * Comparison is on the bullet-stripped text because the producer stores
 * markers inconsistently: prose-derived entries keep their leading "-", while
 * tool-derived ones do not. That same inconsistency made the renderer's own
 * `- ${h}` emit "- - item", so stripping fixes the markup too.
 */
export function novelHighlights(
  summary: string | null,
  highlights: string[],
): string[] {
  const cleaned = highlights.map(stripBullet).filter(Boolean);
  if (!summary) return cleaned;
  const haystack = summary.replace(/\s+/g, " ");
  return cleaned.filter((h) => !haystack.includes(h.replace(/\s+/g, " ")));
}
