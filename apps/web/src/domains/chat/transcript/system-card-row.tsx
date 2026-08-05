import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * System card — the daemon speaks quietly (design ruling 4, Wave C).
 *
 * One treatment for every daemon-authored result card (the summarize-up-to,
 * /compact, and /clean result cards; future error/skipped notices): centered,
 * no avatar, no chat bubble — a hairline-bounded row with a DM Mono
 * microlabel ("COMPACTED · 41 MESSAGES → 1 SUMMARY"), muted body text, and a
 * timestamp. Distinct from assistant turns (bubbled, first person — the
 * daemon states facts and never says "I") and from user bubbles.
 *
 * Rows are detected via the wire `ConversationMessage.systemCard` marker the
 * daemon stamps on canned result cards. The card body follows the daemon's
 * copy contract (see `formatCompactResult` in
 * `assistant/src/daemon/conversation-process.ts`): the first line is the
 * microlabel source (rendered uppercased via CSS), any remaining lines are
 * the muted body.
 */

/**
 * Split a system card's plain-text content into its microlabel (first line)
 * and muted body (the rest). The daemon composes the first line as the
 * headline fact ("Compacted · 41 messages → 1 summary"); rendering derives
 * the microlabel from it rather than duplicating the copy client-side.
 */
export function splitSystemCardText(text: string): {
  label: string;
  body: string;
} {
  const trimmed = text.trim();
  const newlineIndex = trimmed.indexOf("\n");
  if (newlineIndex === -1) {
    return { label: trimmed, body: "" };
  }
  return {
    label: trimmed.slice(0, newlineIndex).trim(),
    body: trimmed
      .slice(newlineIndex + 1)
      .replace(/\n+/g, " · ")
      .trim(),
  };
}

/** Flat text of a system-card row: joined text blocks, segments fallback. */
export function systemCardText(message: DisplayMessage): string {
  const blockText = (message.contentBlocks ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  if (blockText.trim().length > 0) return blockText;
  return (message.textSegments ?? []).join("\n");
}

function formatCardTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SystemCardRow({ message }: { message: DisplayMessage }) {
  const { label, body } = splitSystemCardText(systemCardText(message));
  if (!label) return null;
  const time =
    message.timestamp != null ? formatCardTime(message.timestamp) : null;

  return (
    <div
      role="status"
      data-system-card={message.systemCard}
      className="flex justify-center"
    >
      <div className="w-full border-y border-[var(--border-subtle)] px-4 py-2.5 text-center">
        <div className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--content-secondary)]">
          {label}
        </div>
        {body && (
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            {body}
          </p>
        )}
        {time && (
          <time className="mt-0.5 block text-[11px] text-[var(--content-quiet)]">
            {time}
          </time>
        )}
      </div>
    </div>
  );
}
