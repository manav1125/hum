/**
 * SpawnedWorkSlot — "you started this here".
 *
 * A commitment captured in a thread becomes a work item that runs in its own
 * background conversation, and its result lands in the Review lane. That
 * separation is right, but it left the originating thread showing nothing but a
 * transcript — the user had to find the finished work by chance in HQ, and the
 * thread agent, equally blind, re-did research that had already run.
 *
 * This strip closes the loop on the UI side: a quiet row above the composer
 * naming what this conversation started, its live state, and — when it's
 * finished — where to read it.
 *
 * Honesty rules: every label is derived from the item's actual status. A
 * running item says running; it never offers a "see the result" affordance for
 * work that hasn't produced one. When the conversation spawned nothing (or the
 * query failed) the strip renders nothing at all.
 *
 * Zero props by design (the `QuestionPromptSlot` pattern): it reads the active
 * assistant + conversation from their stores, so `ChatBody` doesn't need new
 * prop threading. Tokens are inlined semantic CSS vars — `domains/chat` must
 * not import from `domains/activity` or `pages/projects`.
 */

import { Link } from "react-router";

import {
  useSpawnedWork,
  type SpawnedWorkItem,
} from "@/domains/chat/hooks/use-spawned-work";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

/** Most rows shown before the strip collapses to a count. */
const MAX_ROWS = 4;

type Tone = "running" | "queued" | "review" | "done" | "failed";

const TONE_COLOR: Record<Tone, string> = {
  running: "var(--system-informative-strong, #3b82f6)",
  queued: "var(--system-warning-strong, #d97706)",
  review: "var(--system-warning-strong, #d97706)",
  done: "var(--system-positive-strong, #16a34a)",
  failed: "var(--system-negative-strong, #dc2626)",
};

interface RowView {
  tone: Tone;
  /** Short state word shown in the chip. */
  label: string;
  /** Where the user goes to see it, or null when there is nothing to see. */
  href: string | null;
  /** Accessible description of that destination. */
  linkLabel: string | null;
}

/**
 * Map an item's real status onto what we may claim about it. Anything we don't
 * recognise gets the status verbatim and no link — never a fabricated one.
 */
function viewFor(item: SpawnedWorkItem): RowView {
  switch (item.status) {
    case "running":
      return {
        tone: "running",
        label: "Running",
        href: routes.workLive(item.id),
        linkLabel: "Watch it run",
      };
    case "queued":
      return { tone: "queued", label: "Queued", href: null, linkLabel: null };
    case "awaiting_review":
      return {
        tone: "review",
        label: "Ready to review",
        href: `${routes.reviewQueue}?item=${encodeURIComponent(item.id)}`,
        linkLabel: "See the result",
      };
    case "done":
      return {
        tone: "done",
        label: "Done",
        href: item.lastRunConversationId
          ? routes.conversation(item.lastRunConversationId)
          : null,
        linkLabel: item.lastRunConversationId ? "See the work" : null,
      };
    case "failed":
      return { tone: "failed", label: "Failed", href: null, linkLabel: null };
    case "cancelled":
      return {
        tone: "failed",
        label: "Cancelled",
        href: null,
        linkLabel: null,
      };
    default:
      return {
        tone: "queued",
        label: item.status.replace(/_/g, " "),
        href: null,
        linkLabel: null,
      };
  }
}

function SpawnedWorkRow({ item }: { item: SpawnedWorkItem }) {
  const view = viewFor(item);
  const color = TONE_COLOR[view.tone];
  return (
    <li className="flex min-w-0 items-center gap-2 py-1">
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: color }}
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--content-default)]">
        {item.title}
      </span>
      <span
        className="shrink-0 whitespace-nowrap text-[11.5px] font-medium"
        style={{ color }}
      >
        {view.label}
      </span>
      {view.href && view.linkLabel ? (
        <Link
          to={view.href}
          className="shrink-0 whitespace-nowrap text-[11.5px] font-medium text-[var(--content-secondary)] underline underline-offset-2"
        >
          {view.linkLabel}
        </Link>
      ) : null}
    </li>
  );
}

export function SpawnedWorkSlot() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const conversationId = useConversationStore.use.activeConversationId();
  const { items } = useSpawnedWork(assistantId, conversationId);

  // Quiet when there is nothing — no empty state, no placeholder.
  if (items.length === 0) return null;

  const shown = items.slice(0, MAX_ROWS);
  const hidden = items.length - shown.length;

  return (
    <div
      className="mb-2 rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] px-3 py-2"
      data-testid="spawned-work-slot"
    >
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--content-secondary)]">
        Started from this conversation
      </div>
      <ul className="m-0 list-none p-0">
        {shown.map((item) => (
          <SpawnedWorkRow key={item.id} item={item} />
        ))}
      </ul>
      {hidden > 0 ? (
        <Link
          to={routes.allWork}
          className="mt-1 inline-block text-[11.5px] text-[var(--content-secondary)] underline underline-offset-2"
        >
          {hidden} more
        </Link>
      ) : null}
    </div>
  );
}
