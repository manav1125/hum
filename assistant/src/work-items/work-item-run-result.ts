/**
 * Extraction of a work item's run result.
 *
 * A work item runs in its OWN conversation, separate from whatever thread
 * asked for it. This module is the single source of truth for turning that run
 * conversation back into a readable result — the latest assistant summary plus
 * bullet highlights.
 *
 * It lives in the work-items domain rather than the routes layer because three
 * different consumers need it and only one of them is an HTTP handler: the
 * `getWorkItemOutput` route (poll-based), the runner's `work_item_completed`
 * event (push-based), and the `spawned-work` turn-context injector (which
 * hands the originating thread the result it already produced, so the agent
 * answers "where are the results" by reading instead of re-running).
 */
import { getMessages } from "../memory/conversation-crud.js";
import { getTaskRun } from "../tasks/task-store.js";
import { truncate } from "../util/truncate.js";

/**
 * Extract only the latest assistant text block from stored content.
 * Consolidation merges multiple assistant messages into one DB row; scanning
 * from the end keeps task output focused on the final assistant response.
 */
function extractLatestTextFromContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        const block = parsed[i] as { type?: unknown; text?: unknown };
        if (block.type !== "text") continue;
        if (typeof block.text !== "string") continue;
        if (!block.text.trim()) continue;
        return block.text;
      }
      return "";
    }
  } catch {
    // Plain text content — use as-is
  }
  return content;
}

/** Extract tool_result blocks from a user message's content. */
function extractToolResults(
  content: string,
): Array<{ tool_use_id: string; content: string; is_error?: boolean }> {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b: { type: string }) => b.type === "tool_result")
        .map(
          (b: {
            tool_use_id: string;
            content?: string | Array<{ type: string; text?: string }>;
            is_error?: boolean;
          }) => {
            let text = "";
            if (typeof b.content === "string") {
              text = b.content;
            } else if (Array.isArray(b.content)) {
              text = b.content
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text!)
                .join("\n");
            }
            return {
              tool_use_id: b.tool_use_id,
              content: text,
              is_error: b.is_error,
            };
          },
        );
    }
  } catch {
    // Not JSON — no tool_result blocks
  }
  return [];
}

/**
 * Build highlights from tool outcomes in the conversation. Scans for
 * tool_use (assistant) and tool_result (user) pairs, extracting concrete
 * outcomes like errors, file paths, and URLs.
 */
function extractToolHighlights(
  msgs: Array<{ role: string; content: string }>,
  maxHighlights: number,
): string[] {
  const highlights: string[] = [];

  // Build a map of tool_use_id -> tool name from assistant messages
  const toolNameById = new Map<string, string>();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    try {
      const parsed = JSON.parse(m.content);
      if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block.type === "tool_use" && block.id && block.name) {
            toolNameById.set(block.id, block.name);
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  // Scan tool_result messages in reverse order (most recent first)
  for (
    let i = msgs.length - 1;
    i >= 0 && highlights.length < maxHighlights;
    i--
  ) {
    const m = msgs[i];
    if (m.role !== "user") continue;

    const results = extractToolResults(m.content);
    for (const result of results) {
      if (highlights.length >= maxHighlights) break;

      const toolName = toolNameById.get(result.tool_use_id) ?? "tool";
      const resultText = result.content.trim();

      if (result.is_error) {
        // Always surface errors
        const errorSnippet = truncate(resultText, 200, "...");
        highlights.push(`- ${toolName}: Error — ${errorSnippet}`);
      } else if (resultText) {
        // Extract notable signal from successful results: file paths, URLs, or
        // a short summary of what happened
        const firstLine = resultText.split("\n")[0].trim();
        if (firstLine.length > 0 && firstLine.length <= 200) {
          highlights.push(`- ${toolName}: ${firstLine}`);
        } else if (firstLine.length > 200) {
          highlights.push(`- ${toolName}: ${truncate(firstLine, 200, "...")}`);
        }
      }
    }
  }

  return highlights;
}
/**
 * The extracted result of a work-item run: the latest assistant summary plus
 * bullet highlights, anchored to the run conversation. Shared by the
 * `getWorkItemOutput` route (poll-based) and the `work_item_completed` event
 * emitted by the runner (push-based) so both surfaces report the same thing.
 */
export interface WorkItemRunResult {
  conversationId: string;
  summary: string;
  highlights: string[];
}

/**
 * Resolve the authoritative conversation id for a work item's most recent run.
 * Prefers the task run's recorded conversationId, falling back to the work
 * item's stored `lastRunConversationId`.
 */
export function resolveWorkItemRunConversationId(workItem: {
  lastRunId: string | null;
  lastRunConversationId: string | null;
}): { conversationId: string | null; completedAt: number | null } {
  let conversationId: string | null = null;
  let completedAt: number | null = null;

  if (workItem.lastRunId) {
    const run = getTaskRun(workItem.lastRunId);
    if (run) {
      conversationId = run.conversationId;
      completedAt =
        run.finishedAt != null ? Math.floor(run.finishedAt / 1000) : null;
    }
  }

  if (!conversationId) {
    conversationId = workItem.lastRunConversationId;
  }

  return { conversationId, completedAt };
}

/**
 * Extract the summary + highlights for a completed run conversation. This is
 * the single source of truth for work-item result extraction: scan the run's
 * messages for the latest assistant text (summary) and bullet highlights,
 * supplementing with tool outcomes when the prose is thin.
 */
export function extractWorkItemResult(
  conversationId: string,
): WorkItemRunResult {
  let summary = "";
  let highlights: string[] = [];

  const msgs = getMessages(conversationId);

  // Find the last assistant message with text content
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;

    const text = extractLatestTextFromContent(m.content);
    if (!text.trim()) continue;

    summary = truncate(text, 2000, "");

    // Extract bullet points from the assistant's prose
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        (trimmed.startsWith("-") || trimmed.startsWith("*")) &&
        trimmed.length > 2
      ) {
        highlights.push(trimmed);
        if (highlights.length >= 5) break;
      }
    }
    break;
  }

  // Supplement with tool outcomes
  if (highlights.length < 5) {
    const toolHighlights = extractToolHighlights(msgs, 5 - highlights.length);
    highlights = [...highlights, ...toolHighlights];
  }

  // Synthesize from tool results if no assistant summary
  if (!summary && msgs.length > 0) {
    const toolHighlights = extractToolHighlights(msgs, 10);
    if (toolHighlights.length > 0) {
      summary = "Task completed. Tool outcomes:\n" + toolHighlights.join("\n");
      highlights = toolHighlights.slice(0, 5);
    }
  }

  return { conversationId, summary, highlights };
}
