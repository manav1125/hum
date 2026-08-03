/**
 * The Library's model — one place that decides what a made thing IS, how it
 * is labelled, and how a gallery is ordered and split.
 *
 * Both doors render from here (v24 F1): the destination — Work's third view
 * (v23 C3) — and the sheet that rises over whatever you are doing. Keeping
 * the model out of the components is what lets the sheet lead with the
 * current thing's files while the full view leads with recency, without two
 * renderings of "what Cue made" drifting apart.
 *
 * DATA: `GET /v1/assistants/:id/outputs` — "newest-first deliverables across
 * every mission and project". It is the ONLY library source that carries the
 * two fields C3 puts on every card: `projectId` (the thing) and `agent` (who
 * made it). Apps/documents/attachments — what the desktop Library reads —
 * carry neither, so a card built on them could not say what the frame says.
 */

import type { OutputsGetResponses } from "@/generated/daemon/types.gen";

/** One made thing, exactly as the daemon returns it. Nothing re-shaped. */
export type LibraryEntry = OutputsGetResponses[200]["outputs"][number];

export type OutputKind = LibraryEntry["kind"];

/**
 * The chip row. "All" always leads; the rest are the C3 frame's four (Docs ·
 * Decks · Sheets · Images) plus the two kinds the daemon can also return.
 *
 * A chip is only offered when something behind it exists — an empty filter is
 * a dead end you can tap into and a lie about what you have.
 */
export const KIND_FILTER_ORDER = [
  "Docs",
  "Decks",
  "Sheets",
  "Images",
  "Video",
  "Other",
] as const;

export type KindFilter = (typeof KIND_FILTER_ORDER)[number];
export type LibraryFilter = "All" | KindFilter;

/** Which chip an output's kind lives under. */
export function filterOf(kind: OutputKind): KindFilter {
  switch (kind) {
    case "document":
    case "pdf":
      return "Docs";
    case "deck":
      return "Decks";
    case "spreadsheet":
      return "Sheets";
    case "image":
      return "Images";
    case "video":
      return "Video";
    default:
      return "Other";
  }
}

/** The chips this set of entries can honestly offer, in canonical order. */
export function availableFilters(entries: LibraryEntry[]): LibraryFilter[] {
  const present = new Set(entries.map((e) => filterOf(e.kind)));
  return ["All", ...KIND_FILTER_ORDER.filter((f) => present.has(f))];
}

export function filterEntries(
  entries: LibraryEntry[],
  filter: LibraryFilter,
): LibraryEntry[] {
  if (filter === "All") return entries;
  return entries.filter((e) => filterOf(e.kind) === filter);
}

/**
 * The sheet's contextual lead (F1): the current thing's files first, then
 * everything else. Both halves keep the daemon's newest-first order.
 *
 * A null `projectId` means "opened from nowhere in particular" (the composer's
 * ▦) — then there is no lead section and everything is simply the list.
 */
export function partitionByThing(
  entries: LibraryEntry[],
  projectId: string | null | undefined,
): { fromThing: LibraryEntry[]; rest: LibraryEntry[] } {
  if (!projectId) return { fromThing: [], rest: entries };
  const fromThing: LibraryEntry[] = [];
  const rest: LibraryEntry[] = [];
  for (const e of entries) {
    if (e.projectId === projectId) fromThing.push(e);
    else rest.push(e);
  }
  return { fromThing, rest };
}

const WEEK_MS = 7 * 86_400_000;

/**
 * The destination's grouping (C3): THIS WEEK, then EARLIER. Sections with
 * nothing in them are omitted rather than rendered as an empty heading.
 */
export function groupByRecency(
  entries: LibraryEntry[],
  now: number,
): Array<{ key: string; entries: LibraryEntry[] }> {
  const thisWeek: LibraryEntry[] = [];
  const earlier: LibraryEntry[] = [];
  for (const e of entries) {
    if (now - e.createdAt < WEEK_MS) thisWeek.push(e);
    else earlier.push(e);
  }
  const out: Array<{ key: string; entries: LibraryEntry[] }> = [];
  if (thisWeek.length > 0) out.push({ key: "THIS WEEK", entries: thisWeek });
  if (earlier.length > 0) out.push({ key: "EARLIER", entries: earlier });
  return out;
}

/** How many of these landed in the last seven days. */
export function countThisWeek(entries: LibraryEntry[], now: number): number {
  return entries.filter((e) => now - e.createdAt < WEEK_MS).length;
}

/**
 * C3's header line — "48 things Cue made · 11 this week". The second leg is
 * dropped when nothing landed this week rather than printing "0 this week",
 * and the whole line is a plain count of what the fetch returned.
 */
export function madeLine(entries: LibraryEntry[], now: number): string {
  const total = entries.length;
  const noun = total === 1 ? "thing" : "things";
  const week = countThisWeek(entries, now);
  const head = `${total} ${noun} Cue made`;
  return week > 0 ? `${head} · ${week} this week` : head;
}

/**
 * Who made it. `agent` is the producing assignee and null reads as "cue" —
 * the daemon says so in the field's own description, so this invents nobody.
 */
export function agentLabel(agent: string | null): string {
  const value = (agent ?? "cue").trim();
  if (!value) return "Cue";
  const lower = value.toLowerCase();
  if (lower === "cue") return "Cue";
  if (lower === "you") return "You";
  return value;
}

/**
 * The card's second line: agent, then the thing it was made for — the two
 * facts C3 puts on every card. The thing leg is omitted when the output was
 * never filed, rather than printing a placeholder for a real null.
 */
export function cardMeta(
  entry: LibraryEntry,
  thingTitle: string | null | undefined,
): string {
  const agent = agentLabel(entry.agent);
  return thingTitle ? `◆ ${agent} · ${thingTitle}` : `◆ ${agent}`;
}

/** "JUL 16" / "TODAY" — the quiet date leg on a sheet card. */
export function entryDate(entry: LibraryEntry, now: number): string {
  const created = new Date(entry.createdAt);
  if (created.toDateString() === new Date(now).toDateString()) return "today";
  return created
    .toLocaleDateString(undefined, { month: "short", day: "numeric" })
    .toLowerCase();
}

/**
 * Every state carries a glyph, never a colour alone — the kind glyph is what
 * survives a greyscale screenshot when the cover art does not.
 */
export function kindGlyph(kind: OutputKind): string {
  switch (kind) {
    case "deck":
      return "▤";
    case "spreadsheet":
      return "▦";
    case "image":
      return "◑";
    case "video":
      return "▷";
    case "pdf":
      return "▥";
    case "document":
      return "≣";
    default:
      return "◻";
  }
}
