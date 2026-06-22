// ---------------------------------------------------------------------------
// Memory Tool handlers
//
// remember: save facts to the PKB (buffer.md + daily archive) under the v1
// path, or to memory/buffer.md + memory/archive/<today>.md when memory v2 is
// active.
// ---------------------------------------------------------------------------

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { enqueuePkbIndexJob } from "../jobs/embed-pkb-file.js";
import { PKB_WORKSPACE_SCOPE } from "../pkb/types.js";

const log = getLogger("graph-tool-handlers");

// ---------------------------------------------------------------------------
// remember handler — writes to PKB (v1) or memory/ (v2) buffer + daily archive
// ---------------------------------------------------------------------------

export interface RememberInput {
  content: string;
  finish_turn?: boolean;
}

export interface RememberResult {
  success: boolean;
  message: string;
}

export function handleRemember(
  input: RememberInput,
  conversationId: string,
  _scopeId: string,
  config: AssistantConfig,
): RememberResult {
  if (!input.content || input.content.trim().length === 0) {
    return { success: false, message: "content is required" };
  }
  if (config.memory.enabled === false) {
    return { success: false, message: "Memory is disabled." };
  }

  const workspaceDir = getWorkspaceDir();
  const now = new Date();
  // Stamp the entry with its source conversation so the static-context
  // injector can frame cross-conversation recall as background recall (rather
  // than active context) when another chat later re-reads the global buffer.
  const entry = formatRememberEntry(input.content.trim(), now, conversationId);

  if (config.memory.v2.enabled) {
    appendBufferAndArchive({
      rootDir: join(workspaceDir, "memory"),
      entry,
      now,
    });
    // v2 path skips the PKB re-index queue — embedding for memory v2 happens
    // via the dedicated `embed_concept_page` job after consolidation, not on
    // every remember() write.
    return { success: true, message: "Saved to knowledge base." };
  }

  const pkbDir = join(workspaceDir, "pkb");
  const { bufferPath, archivePath } = appendBufferAndArchive({
    rootDir: pkbDir,
    entry,
    now,
  });
  enqueuePkbReindex(pkbDir, bufferPath);
  enqueuePkbReindex(pkbDir, archivePath);

  return { success: true, message: "Saved to knowledge base." };
}

/**
 * Format `now` as a buffer-entry timestamp (`Mon D, h:mm AM/PM`). Exported so
 * the memory v2 consolidation job can present its cutoff in the same shape
 * the buffer entries use, making the agent's "timestamp ≥ cutoff" comparison
 * unambiguous at minute precision.
 */
export function formatBufferTimestamp(now: Date): string {
  const month = now.toLocaleString("en-US", { month: "short" });
  const day = now.getDate();
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${month} ${day}, ${displayHour}:${minutes} ${ampm}`;
}

/**
 * Trailing HTML-comment marker that stamps a buffer entry with the
 * conversation it originated in, e.g. `<!--cid:abc123-->`. Kept as an HTML
 * comment so the entry stays human-readable and renders invisibly in any
 * markdown view, while the static-context injector can split entries by
 * origin (current chat vs. "your other chats").
 *
 * Backward-compatible: entries written before this change (and sweep-job
 * entries, which span many conversations and carry no single origin) simply
 * omit the marker. {@link parseBufferEntryOrigin} treats a missing marker as
 * "no known origin".
 */
const CID_MARKER_RE = /\s*<!--\s*cid:([^\s>]+)\s*-->\s*$/;

/**
 * Build a timestamped bullet entry for `buffer.md` / `archive/<date>.md`.
 *
 * Format mirrors the long-standing v1 PKB layout so v2 buffers stay
 * human-readable and downstream consumers (sweep, consolidation) can parse
 * the same shape regardless of which path produced the entry.
 *
 * When `conversationId` is supplied, a trailing `<!--cid:...-->` marker is
 * appended so the injector can frame entries from other conversations as
 * background recall. Callers with no single source conversation (e.g. the
 * cross-conversation sweep job) omit it — those entries stay untagged and
 * parse exactly as pre-marker entries did.
 *
 * Exported so memory v2 sweep / extractor jobs format their auto-remembered
 * entries identically to user-facing `remember()` calls.
 */
export function formatRememberEntry(
  content: string,
  now: Date,
  conversationId?: string,
): string {
  const marker =
    conversationId && conversationId.trim().length > 0
      ? ` <!--cid:${conversationId.trim()}-->`
      : "";
  return `- [${formatBufferTimestamp(now)}] ${content}${marker}\n`;
}

/**
 * Split a single buffer-entry line into its origin conversation id (if the
 * line carries a `<!--cid:...-->` marker) and the line with that marker
 * stripped for display.
 *
 * Backward-compatible: a line with no marker returns `{ conversationId:
 * undefined, display: <line unchanged> }`, so old/untagged entries are
 * treated as having no known origin.
 *
 * Exported for the static-context injector, which partitions the buffer into
 * current-conversation vs. other-conversation entries.
 */
export function parseBufferEntryOrigin(line: string): {
  conversationId: string | undefined;
  display: string;
} {
  const match = line.match(CID_MARKER_RE);
  if (!match) return { conversationId: undefined, display: line };
  return {
    conversationId: match[1],
    display: line.replace(CID_MARKER_RE, ""),
  };
}

/**
 * Append `entry` to `<rootDir>/buffer.md` and `<rootDir>/archive/<today>.md`,
 * creating the archive directory and seeding the archive header if missing.
 *
 * Returns the absolute paths of both files so callers can fan out follow-up
 * work (e.g. PKB re-indexing in the v1 path).
 *
 * Exported so memory v2 background jobs (`sweep`, future LLM-driven
 * extractors) can append to `memory/buffer.md` + `memory/archive/<today>.md`
 * with exactly the same format `remember()` produces, keeping the two write
 * paths byte-compatible for downstream consumers (consolidation, search).
 */
export function appendBufferAndArchive(args: {
  rootDir: string;
  entry: string;
  now: Date;
}): { bufferPath: string; archivePath: string } {
  const { rootDir, entry, now } = args;
  const archiveDir = join(rootDir, "archive");
  mkdirSync(archiveDir, { recursive: true });

  const bufferPath = join(rootDir, "buffer.md");
  appendFileSync(bufferPath, entry, "utf-8");

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const archivePath = join(archiveDir, `${yyyy}-${mm}-${dd}.md`);
  if (!existsSync(archivePath)) {
    const month = now.toLocaleString("en-US", { month: "short" });
    appendFileSync(
      archivePath,
      `# ${month} ${now.getDate()}, ${yyyy}\n\n`,
      "utf-8",
    );
  }
  appendFileSync(archivePath, entry, "utf-8");

  return { bufferPath, archivePath };
}

/**
 * Fire-and-forget enqueue of a PKB re-index job for a file we just wrote.
 *
 * Always indexes under {@link PKB_WORKSPACE_SCOPE}. See the comment on that
 * constant for why PKB points are not per-conversation-scoped.
 *
 * Wrapped in try/catch so an enqueue failure (e.g. DB hiccup) cannot break
 * the remember call — the write has already succeeded and the user's fact
 * is safe on disk.
 */
function enqueuePkbReindex(pkbRoot: string, absPath: string): void {
  try {
    enqueuePkbIndexJob({
      pkbRoot,
      absPath,
      memoryScopeId: PKB_WORKSPACE_SCOPE,
    });
  } catch (err) {
    log.warn({ err, absPath }, "Failed to enqueue PKB re-index job");
  }
}
