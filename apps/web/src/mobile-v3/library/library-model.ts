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
 * DATA: `GET /v1/assistants/:id/library` — the composed scope: files Cue
 * generated, the documents it wrote, the apps it built, and the deliverables
 * work runs registered. It used to be `GET /outputs`, on the reasoning that
 * only outputs carry `projectId` and `agent`. That reasoning held; the
 * conclusion did not. `/outputs` holds a row only where a work item ran to
 * completion AND produced a file, so on the owner's daemon it was two rows out
 * of a 89-asset library — a frame's two fields are not worth 87 missing files.
 * `/library` keeps both fields where they exist and leaves them null where
 * they do not, which `cardMeta` already renders honestly.
 */

import type { LibraryGetResponses } from "@/generated/daemon/types.gen";

/** One made thing, exactly as the daemon returns it. Nothing re-shaped. */
export type LibraryEntry = LibraryGetResponses[200]["items"][number];

export type OutputKind = LibraryEntry["kind"];

/**
 * The chip row. "All" always leads; the rest are the C3 frame's four (Docs ·
 * Decks · Sheets · Images) plus the kinds the daemon can also return.
 *
 * A chip is only offered when something behind it exists — an empty filter is
 * a dead end you can tap into and a lie about what you have. The corollary
 * bit us the other way round: the phone showed only `Docs | Images` because
 * only two entries were ever fetched, so the row was quietly asserting that
 * the owner had no videos, decks or sheets. He had 8 videos and 12 sheets.
 */
export const KIND_FILTER_ORDER = [
  "Docs",
  "Decks",
  "Sheets",
  "Images",
  "Video",
  "Apps",
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
    case "app":
      return "Apps";
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
 * C3's header line — "114 things made with Cue · 3 this week". The second leg is
 * dropped when nothing landed this week rather than printing "0 this week",
 * and the whole line is a plain count of what the fetch returned.
 *
 * It used to read "N things Cue made", which was a claim about AUTHORSHIP the
 * list could not keep: the fetch behind it was the work-run deliverable
 * registry, so "2 things Cue made" was really "2 things a work run happened to
 * register" — and the owner, holding dozens of files Cue had made him, had no
 * way to tell which of those two sentences he was reading. "Made with Cue" is
 * the scope this list actually applies, and `libraryScopeNote` says out loud
 * what it leaves out.
 */
export function madeLine(entries: LibraryEntry[], now: number): string {
  const total = entries.length;
  const noun = total === 1 ? "thing" : "things";
  const week = countThisWeek(entries, now);
  const head = `${total} ${noun} made with Cue`;
  return week > 0 ? `${head} · ${week} this week` : head;
}

/**
 * The one sentence that keeps the header honest: what this list holds, and
 * where the things it does not hold live. A narrow scope is allowed; a narrow
 * scope that does not say where the rest went is how "I have no idea what it's
 * showing me" happens.
 */
export const libraryScopeNote =
  "Files, docs and apps you made with Cue. Things you sent it stay in their chat.";

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
    case "app":
      return "◈";
    case "document":
      return "≣";
    default:
      return "◻";
  }
}
