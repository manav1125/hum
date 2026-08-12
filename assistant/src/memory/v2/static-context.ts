// ---------------------------------------------------------------------------
// Memory v2 — Static context loader for user-message auto-injection
// ---------------------------------------------------------------------------
//
// Reads the four top-level memory files (essentials/threads/recent/buffer)
// and returns a concatenated, header-wrapped block ready to splice into the
// current user message via the injector chain.
//
// Pairs with the v2 per-turn activation block (`maybeRouteV2Injection` in
// `conversation-graph-memory.ts`, which threads through `injectTextBlock`)
// — that block carries activated concept pages selected by the activation
// pipeline; this static block carries the always-relevant aggregate views
// written by consolidation and the user. Both land on the user message so
// the system prompt stays cache-stable.
//
// Refresh cadence is owned by the caller: the agent loop only passes the
// content through when `mode === "full"` (first turn / post-compaction),
// matching the existing PKB auto-inject pattern.

import type { ChannelId } from "../../channels/types.js";
import { loadConfig } from "../../config/loader.js";
import { readPromptFile } from "../../prompts/system-prompt.js";
import { getWorkspacePromptPath } from "../../util/platform.js";
import {
  type BufferEntryLines,
  parseBufferEntryOrigin,
  splitBufferEntries,
} from "../buffer-format.js";

interface MemoryV2StaticBlock {
  heading: string;
  file: string;
}

const BUFFER_FILE = "memory/buffer.md";

const MEMORY_V2_STATIC_BLOCKS: readonly MemoryV2StaticBlock[] = [
  { heading: "## Essentials", file: "memory/essentials.md" },
  { heading: "## Threads", file: "memory/threads.md" },
  { heading: "## Recent", file: "memory/recent.md" },
  { heading: "## Buffer", file: BUFFER_FILE },
];

/** Heading framing for buffer entries that originated in OTHER conversations. */
const OTHER_CHATS_HEADING =
  "### From your other chats (background — may not be relevant here)";

/**
 * Leader line on a Buffer section that was capped, so the model knows the
 * section is a tail rather than the whole backlog and where the rest lives.
 */
const BUFFER_INJECTION_NOTICE =
  "(Older entries trimmed. Read memory/buffer.md for the full backlog.)";

/**
 * Cap the Buffer section at its most recent `maxLines` non-empty lines,
 * returning the content unchanged when it already fits or when `maxLines` is
 * `null`/`undefined`.
 *
 * The bound is `consolidation_max_buffer_lines`, the same threshold at which
 * the scheduler already considers the buffer overdue for consolidation (see
 * `jobs-worker.ts`). Reusing it means the injected buffer never exceeds one
 * consolidation's worth of backlog, and that a workspace whose consolidation
 * keeps up sees byte-identical output. The other three static files are
 * curated aggregate views that consolidation keeps lean; the buffer is the
 * raw append-only staging log, bounded only by how far behind consolidation
 * has fallen — without this cap a backlog injects unbounded content into
 * every full-injection turn.
 *
 * The unit is the entry, not the line. `remember()` stores a multiline fact
 * as one timestamped line plus its nested body, so trimming by raw line count
 * can land inside a fact and inject continuation lines stripped of the
 * timestamp and opening clause that give them meaning. Whole entries are
 * taken newest-first while they fit, which makes a mid-entry cut
 * unrepresentable.
 *
 * `maxLines` is still measured in non-empty lines, because that is what the
 * scheduler counts (`countBufferLines`), so the two readings of "how big is
 * the buffer" agree. See {@link capOversizedNewestEntry} for the one case
 * that can exceed it.
 */
function capBufferSection(
  content: string,
  maxLines: number | null | undefined,
): string {
  if (maxLines == null) {
    return content;
  }
  const lines = content.split("\n");
  if (countNonEmpty(lines) <= maxLines) {
    return content;
  }

  const entries = splitBufferEntries(lines);
  const kept: BufferEntryLines[] = [];
  let budget = maxLines;
  // Newest-first: the buffer is append-only, so the tail is the most recent.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    // A headless leading group is prose before the first entry, not a fact.
    if (entry.start === null) {
      break;
    }
    const cost = countNonEmpty(entry.lines);
    if (cost > budget) {
      break;
    }
    budget -= cost;
    kept.unshift(entry);
  }

  const body =
    kept.length > 0
      ? kept.flatMap((entry) => entry.lines).join("\n")
      : capOversizedNewestEntry(lines, entries, maxLines);
  return `${BUFFER_INJECTION_NOTICE}\n${body}`;
}

/**
 * Marker replacing the elided head of an entry too large to inject whole, so
 * the retained tail reads as a fragment of the entry above it rather than as
 * the whole fact.
 */
const ENTRY_BODY_TRIMMED_NOTICE =
  "(This entry's body was trimmed. Read memory/buffer.md for the rest of it.)";

/**
 * Render the tail when not even the newest entry fits inside the cap.
 *
 * There is no whole entry to fall back to here, and all three options cost
 * something. Dropping the entry would leave the section with a "trimmed"
 * notice and no facts at all, which is the worst outcome because the newest
 * fact is usually the one that mattered. Admitting it whole would reopen the
 * unbounded injection the cap exists to prevent, since a fact has no size
 * limit. So the entry keeps its opening line, which carries the timestamp and
 * first clause the tail needs to be readable, then the marker, then as much
 * of the tail as the cap allows. Every injected line stays attributable to a
 * timestamped entry, at a fixed cost of two lines over `maxLines`.
 *
 * Two cases return early. When the cut falls on the opening line's immediate
 * successor nothing was actually elided, so the entry is returned whole
 * without a marker that would claim a trim that did not happen. When the
 * buffer has no entry structure at all, it is hand-written and never went
 * through `remember()`, so there is nothing to preserve and the plain line
 * cut stands.
 */
function capOversizedNewestEntry(
  lines: string[],
  entries: readonly BufferEntryLines[],
  maxLines: number,
): string {
  const cut = lineCutStart(lines, maxLines);
  const newest = entries.at(-1);
  if (newest === undefined || newest.start === null) {
    return lines.slice(cut).join("\n");
  }
  const elidedHead = countNonEmpty(lines.slice(newest.firstLine + 1, cut)) > 0;
  if (!elidedHead) {
    return lines.slice(newest.firstLine).join("\n");
  }
  return [
    lines[newest.firstLine]!,
    ENTRY_BODY_TRIMMED_NOTICE,
    ...lines.slice(cut),
  ].join("\n");
}

/**
 * Index of the first line in the trailing window of `maxLines` non-empty
 * lines, advanced past any blank lines that would otherwise open the section.
 */
function lineCutStart(lines: readonly string[], maxLines: number): number {
  let kept = 0;
  let cut = lines.length;
  while (cut > 0 && kept < maxLines) {
    cut--;
    if (lines[cut]!.trim().length > 0) {
      kept++;
    }
  }
  while (cut < lines.length && lines[cut]!.trim().length === 0) {
    cut++;
  }
  return cut;
}

/** Non-empty line count, the unit the scheduler's `countBufferLines` uses. */
function countNonEmpty(lines: readonly string[]): number {
  return lines.filter((line) => line.trim().length > 0).length;
}

/**
 * Render the `## Buffer` section: cap it (see {@link capBufferSection}), then
 * partition its entries by origin conversation when `currentConversationId`
 * is supplied.
 *
 * Entries stamped with a different `<!--cid:...-->` than the current
 * conversation are grouped under {@link OTHER_CHATS_HEADING} so the model
 * treats them as ambient recall rather than active task context. Entries that
 * match the current conversation — and untagged/legacy entries with no known
 * origin — stay in the primary list (untagged entries are conservatively kept
 * primary so the framing change never hides existing data).
 *
 * Partitioning is entry-aware: an entry moves as a unit with its continuation
 * lines, classified by the `<!--cid:...-->` marker found on any of its lines
 * (the writer stamps the opening line; legacy multiline entries carried it on
 * the last). Splitting per raw line would detach a multiline fact's body from
 * its opening — and let a body line's content decide its own grouping.
 *
 * The `<!--cid:...-->` markers are stripped from the rendered output; they are
 * write-time metadata, not content for the model to read.
 *
 * When `currentConversationId` is undefined (e.g. background jobs with no
 * single source conversation), the buffer is rendered verbatim with markers
 * stripped — no partitioning.
 */
function renderBufferSection(
  heading: string,
  content: string,
  currentConversationId: string | undefined,
  maxLines: number | null | undefined,
): string {
  const capped = capBufferSection(content, maxLines);

  const primary: string[] = [];
  const other: string[] = [];
  for (const entry of splitBufferEntries(capped.split("\n"))) {
    const displayLines: string[] = [];
    let entryOrigin: string | undefined;
    for (const line of entry.lines) {
      if (line.trim().length === 0) continue;
      const { conversationId, display } = parseBufferEntryOrigin(line);
      entryOrigin ??= conversationId;
      displayLines.push(display);
    }
    if (displayLines.length === 0) continue;
    const isOther =
      // A headless group (cap notice, hand-written prose) is not an entry
      // and always stays primary, in place.
      entry.start !== null &&
      currentConversationId !== undefined &&
      entryOrigin !== undefined &&
      entryOrigin !== currentConversationId;
    (isOther ? other : primary).push(...displayLines);
  }

  const body: string[] = [];
  if (primary.length > 0) body.push(primary.join("\n"));
  if (other.length > 0) {
    body.push(`${OTHER_CHATS_HEADING}\n\n${other.join("\n")}`);
  }
  // Caller already skipped empty files, but a buffer of only blank lines
  // leaves no body — fall back to the heading alone rather than emit a
  // dangling blank section.
  return body.length === 0 ? heading : `${heading}\n\n${body.join("\n\n")}`;
}

/**
 * Build the v2 static memory block, gated on `config.memory.enabled` and
 * `config.memory.v2.enabled`. Empty/missing files are skipped; returns `null`
 * when either gate is off or every file is empty.
 *
 * `excludeBuffer` drops the `## Buffer` section. The consolidation run sets
 * it: the agent's contract there is the `memory/buffer.md` FILE — it reads,
 * routes, and rewrites it through file tools — so injecting a static snapshot
 * of the same content would duplicate the entire (potentially unbounded)
 * backlog into the turn's context and go stale the moment the agent edits
 * the file.
 *
 * `currentConversationId` frames the buffer by origin: entries from OTHER
 * conversations are grouped under a "from your other chats (background)"
 * heading so cross-conversation recall reads as ambient rather than active
 * context. Omit it to render the buffer verbatim (markers stripped).
 */
export function readMemoryV2StaticContent(
  options: { excludeBuffer?: boolean; currentConversationId?: string } = {},
): string | null {
  let config;
  try {
    config = loadConfig();
  } catch {
    return null;
  }
  if (config.memory.enabled === false || !config.memory.v2.enabled) {
    return null;
  }

  const maxBufferLines = config.memory.v2.consolidation_max_buffer_lines;

  const sections: string[] = [];
  for (const { heading, file } of MEMORY_V2_STATIC_BLOCKS) {
    if (options.excludeBuffer === true && file === BUFFER_FILE) {
      continue;
    }
    const content = readPromptFile(getWorkspacePromptPath(file));
    if (!content) continue;
    if (file === BUFFER_FILE) {
      sections.push(
        renderBufferSection(
          heading,
          content,
          options.currentConversationId,
          maxBufferLines,
        ),
      );
      continue;
    }
    sections.push(`${heading}\n\n${content}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Trust-class predicate for personal-memory injection. Personal memory
 * spans v2 static blocks (essentials/threads/recent/buffer), the PKB
 * context, and NOW.md — all of which can hold private user content. Block
 * injection when a non-guardian actor reaches the assistant over a remote
 * channel — otherwise the model can be prompt-injected into reciting
 * private memory. Internal flows (`sourceChannel: "vellum"`) and turns
 * with no trust context pass through unchanged; this gate exists only to
 * keep remote untrusted actors out.
 *
 * This is the trust-only gate. Cadence (first-turn / post-compaction) is
 * applied separately by the caller so that the freshest content remains
 * available for re-injection after a mid-turn reducer-triggered compaction
 * — the initial-injection turn may not have been a `shouldInjectNowAndPkb`
 * turn, but compaction strips the existing personal-memory blocks and we
 * still need the freshest content to re-inject.
 */
export function shouldExposePersonalMemory(args: {
  sourceChannel: ChannelId | undefined;
  isTrustedActor: boolean;
}): boolean {
  const isRemoteUntrustedActor =
    args.sourceChannel !== undefined &&
    args.sourceChannel !== "vellum" &&
    !args.isTrustedActor;
  return !isRemoteUntrustedActor;
}
