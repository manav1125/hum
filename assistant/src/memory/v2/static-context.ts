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
import { parseBufferEntryOrigin } from "../graph/tool-handlers.js";

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
 * Render the `## Buffer` section, partitioning its entries by origin
 * conversation when `currentConversationId` is supplied.
 *
 * Entries stamped with a different `<!--cid:...-->` than the current
 * conversation are grouped under {@link OTHER_CHATS_HEADING} so the model
 * treats them as ambient recall rather than active task context. Entries that
 * match the current conversation — and untagged/legacy entries with no known
 * origin — stay in the primary list (untagged entries are conservatively kept
 * primary so the framing change never hides existing data).
 *
 * The `<!--cid:...-->` markers are stripped from the rendered output; they are
 * write-time metadata, not content for the model to read.
 *
 * When `currentConversationId` is undefined (e.g. background jobs with no
 * single source conversation), the buffer is rendered verbatim with markers
 * stripped — no partitioning, identical to the pre-framing behaviour.
 */
function renderBufferSection(
  heading: string,
  content: string,
  currentConversationId: string | undefined,
): string {
  const primary: string[] = [];
  const other: string[] = [];

  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    const { conversationId, display } = parseBufferEntryOrigin(line);
    const isOther =
      currentConversationId !== undefined &&
      conversationId !== undefined &&
      conversationId !== currentConversationId;
    (isOther ? other : primary).push(display);
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

  const sections: string[] = [];
  for (const { heading, file } of MEMORY_V2_STATIC_BLOCKS) {
    if (options.excludeBuffer === true && file === BUFFER_FILE) {
      continue;
    }
    const content = readPromptFile(getWorkspacePromptPath(file));
    if (!content) continue;
    if (file === BUFFER_FILE) {
      sections.push(
        renderBufferSection(heading, content, options.currentConversationId),
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
