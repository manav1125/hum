/**
 * Mobile v3 Create — what Cue already knows.
 *
 * Design's rule 1: fill states what Cue knows as a checkable block and asks only
 * the gaps ("the 8-field form becomes 2 questions"). That is only an improvement
 * if the "known" block is TRUE. A fabricated known block is worse than an empty
 * form, because the user accepts it without reading.
 *
 * So this module is a SEAM, not a source. It defines the shape of a known fact
 * and the provider interface that supplies them. The default provider returns
 * nothing, because as of this build the web client has no typed fact store to
 * read from — see `create-known-facts.md` reasoning in the module docs below.
 *
 * ## What is genuinely readable, and what is not
 *
 * **Readable, and used here:**
 * - The active **Brand Kit** (`useActiveBrand` → `GET .../brand-profiles`) —
 *   real, server-backed, returns `null` rather than defaults when unset.
 * - **Memory statements** (`memoryitemsGet` → `GET .../memory-items`) — real
 *   retrieved recollections, each a `{ subject, statement, sourceType }`.
 *
 * **NOT readable, and deliberately absent:**
 * - Typed business metrics. Design's mock states `MRR $38.4K · Growth 18% mom ·
 *   Runway 14 months` as a metric grid. The memory store has no `value`, no
 *   `unit` and no key — only free-text `statement` sentences. Rendering a metric
 *   grid would mean the client parsing numbers out of prose and presenting them
 *   as retrieved facts. So memory facts are rendered VERBATIM as the sentence
 *   Cue actually holds, never re-shaped into a metric row.
 * - Connected-source values. Connector tool schemas are withheld from the model
 *   until it calls `tool_search` mid-run, and no daemon route executes a
 *   connector on the client's behalf. So "pre-filled from your connected Sheet"
 *   is unavailable at form-render time; the honest form of that statement is a
 *   capability line ("Sheets is connected — I'll pull the numbers as I build"),
 *   which is a different claim and belongs to the build step, not the fill step.
 *
 * The existing desktop code reached the same conclusion independently:
 * `create-sheet-form.tsx` documents that it does NOT render the mock's
 * "PRE-FILLED FROM MEMORY" badge because "there is no real prefill source, so the
 * provenance label would be fake."
 *
 * A fact that cannot be proven is simply absent. There is no placeholder path.
 */

/**
 * How a known fact reached us — shown to the user so they can judge it.
 *
 * v29 withdrew the prefill badge in favour of "verbatim statements, origin
 * labelled — *you told me · Jun 12* not *from memory*". So the token below is
 * the machine-readable origin and `originLabel()` is the only thing a surface
 * may render: a bare `memory` on screen is the badge under another name.
 */
export type FactOrigin =
  /** Read from the assistant's saved Brand Kit (server-backed). */
  | "brand"
  /** Retrieved from the memory store, verbatim, and the user said it. */
  | "memory"
  /**
   * Retrieved from the memory store, but Cue observed or inferred it rather
   * than being told it. Separate from `memory` on purpose: labelling an
   * inferred recollection "you told me" would be a fresh piece of the fabricated
   * provenance v29 exists to remove.
   */
  | "noticed"
  /** Carried in from the text the user just typed. */
  | "your words"
  /** Supplied by the surface that opened Create (e.g. an open project). */
  | "context";

/**
 * One thing Cue genuinely holds, ready to render as a `✓ Label  Value` row.
 *
 * `fieldKey` ties the fact to a template input so the fill step can treat that
 * input as answered. A fact with no matching field still renders in the block
 * (it is context the build will use) but never silently fills a field.
 */
export interface KnownFact {
  /** Stable id for keys and tests. */
  id: string;
  /** Row label — "MRR", "Brand". */
  label: string;
  /** Row value — "$38.4K", "Northwind". */
  value: string;
  /** The template input key this answers, when it answers one. */
  fieldKey?: string;
  /** Where it came from. Rendered, never hidden. */
  origin: FactOrigin;
  /**
   * When the fact was recorded, already formatted for display ("Jul 28").
   * Absent when the source carries no date — the label then simply omits it
   * rather than inventing a plausible one.
   */
  asOf?: string;
}

/**
 * The origin as the user reads it — v29's "labelled origins".
 *
 * Each label says who supplied the fact, in the second person where the user
 * supplied it, so the block reads as an account of what Cue was told rather than
 * a claim about what Cue worked out.
 */
export function originLabel(fact: KnownFact): string {
  const base = (() => {
    switch (fact.origin) {
      case "brand":
        return "from Brand Kit";
      case "memory":
        return "you told me";
      case "noticed":
        return "I noticed";
      case "your words":
        return "from what you just typed";
      case "context":
        return "from what you had open";
    }
  })();
  return fact.asOf ? `${base} · ${fact.asOf}` : base;
}

/** Supplies the facts Cue holds for a given build. */
export interface KnownFactsProvider {
  /**
   * Facts relevant to this type/template. Returning `[]` is the correct answer
   * when nothing is genuinely known — callers must render that case, not treat
   * it as an error.
   */
  factsFor(typeId: string, templateId?: string): KnownFact[];
}

/** The honest default: we know nothing until a real source says otherwise. */
export const EMPTY_FACTS_PROVIDER: KnownFactsProvider = {
  factsFor: () => [],
};

/**
 * Build the brand fact from a real active Brand Kit.
 *
 * Returns `null` when there is no active kit — never a placeholder name. The
 * brand is the ONE fact this client can prove at form-render time, so it is the
 * one fact the known block starts with.
 */
export function brandFact(
  brand: { id: string; name?: string } | null | undefined,
): KnownFact | null {
  const name = brand?.name?.trim();
  if (!brand || !name) return null;
  return {
    id: `brand:${brand.id}`,
    label: "Brand",
    value: name,
    origin: "brand",
  };
}

/**
 * Build a fact from the surface that opened Create — e.g. "you were looking at
 * this project". The caller must pass a value it actually read; this function
 * only shapes it.
 */
export function contextFact(
  label: string,
  value: string | null | undefined,
  fieldKey?: string,
): KnownFact | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return {
    id: `context:${label.toLowerCase()}`,
    label,
    value: trimmed,
    fieldKey,
    origin: "context",
  };
}

/** A provider over a fixed list — used by hosts that already resolved facts. */
export function staticFactsProvider(facts: KnownFact[]): KnownFactsProvider {
  return { factsFor: () => facts };
}

/* ----------------------------------------------------------------------- */
/* Memory                                                                   */
/* ----------------------------------------------------------------------- */

/**
 * A memory item as the daemon returns it. Typed structurally — the generated
 * SDK types `items` as `unknown[]`, and the intelligence domain narrows it with
 * its own interface, which this module must not import across.
 */
export interface MemoryItemLike {
  id?: string;
  subject?: string | null;
  statement?: string | null;
  sourceType?: string | null;
  /** Epoch ms the memory was first recorded. Real, and used for the date. */
  firstSeenAt?: number | null;
}

/**
 * The date beside an origin — "Jul 28".
 *
 * Returns `undefined` for anything that is not a usable timestamp, so a bad
 * value drops the date rather than rendering "Invalid Date" or today's.
 */
function asOfLabel(at?: number | null): string | undefined {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return undefined;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Statements shorter than this are too fragmentary to show on their own. */
const MIN_STATEMENT = 8;
/** Design shows four rows before the block starts to feel like a form again. */
export const MAX_MEMORY_FACTS = 4;

/**
 * Turn retrieved memory items into known facts.
 *
 * The statement is carried through VERBATIM as the value. It is not summarised,
 * not truncated into a metric, and not paired with a number extracted from its
 * prose — Cue shows what it actually remembers, in the words it remembers it in.
 * Items missing a usable statement are dropped rather than filled in.
 *
 * These facts carry no `fieldKey`: a sentence cannot be proven to answer a typed
 * input, so they inform the build as context but never silently complete a form
 * field the user would then not be asked about.
 *
 * The origin follows the item's own `sourceType` rather than defaulting to "you
 * told me": only a `direct` memory was actually said by the user, and the store
 * also holds observed and inferred ones.
 */
export function memoryFacts(
  items: readonly MemoryItemLike[] | null | undefined,
  limit: number = MAX_MEMORY_FACTS,
): KnownFact[] {
  if (!items?.length) return [];
  const out: KnownFact[] = [];
  for (const item of items) {
    const statement = item.statement?.trim();
    if (!statement || statement.length < MIN_STATEMENT) continue;
    out.push({
      id: `memory:${item.id ?? out.length}`,
      label: item.subject?.trim() || "Remembered",
      value: statement,
      origin: item.sourceType === "direct" ? "memory" : "noticed",
      asOf: asOfLabel(item.firstSeenAt),
    });
    if (out.length >= limit) break;
  }
  return out;
}
