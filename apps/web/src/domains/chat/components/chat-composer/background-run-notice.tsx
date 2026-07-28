/**
 * BackgroundRunNotice — "that one went somewhere else".
 *
 * When a message is handed to a background run it leaves the thread entirely:
 * no user bubble, no streaming reply, nothing. Without this strip the composer
 * would simply empty itself and the user would have no idea where the work
 * went — the exact failure `SpawnedWorkSlot` was built to fix, one step
 * earlier in the flow.
 *
 * Copy follows `spawned-work-slot.tsx`'s honesty rule, which this component is
 * modelled on: every label is derived from what actually happened, and we never
 * offer a "see the result" affordance for work that has not produced one.
 * Concretely:
 *   · dispatching — no destination claimed yet.
 *   · running     — the runner accepted it, so "watch it run" is real; the
 *                   Review lane is named as a FUTURE landing place, not a
 *                   place to go read something now.
 *   · filed       — created but NOT started. Says so, and points at the queue.
 *   · error       — nothing was created; the message is back in the composer.
 *
 * This strip is about the hand-off moment only. Once the item exists,
 * `SpawnedWorkSlot` and the Activity / Review surfaces are the durable views —
 * so the strip is dismissible and disappears on the next send.
 */

import { X } from "lucide-react";
import { Link } from "react-router";

import type { BackgroundRunState } from "@/domains/chat/components/chat-composer/use-background-run";
import { routes } from "@/utils/routes";

interface NoticeView {
  color: string;
  /** Leading line — what happened. */
  headline: string;
  /** Second line — where it went. Omitted when there is nothing true to say. */
  detail: string | null;
  href: string | null;
  linkLabel: string | null;
  /** Dot pulses only while something is genuinely in motion. */
  pulse: boolean;
}

function viewFor(state: BackgroundRunState): NoticeView | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "dispatching":
      return {
        color: "var(--content-tertiary)",
        headline: `Handing off: ${state.title}`,
        detail: "Starting a background run…",
        href: null,
        linkLabel: null,
        pulse: true,
      };
    case "running":
      return {
        color: "var(--system-informative-strong, #3b82f6)",
        headline: `Running in the background: ${state.title}`,
        detail: "It lands in your Review lane when it finishes.",
        href: routes.workLive(state.workItemId),
        linkLabel: "Watch it run",
        pulse: true,
      };
    case "filed":
      return {
        color: "var(--system-warning-strong, #d97706)",
        headline: `Queued: ${state.title}`,
        detail: "It didn't start — it's waiting in your work queue.",
        href: routes.allWork,
        linkLabel: "See the queue",
        pulse: false,
      };
    case "error":
      return {
        color: "var(--system-negative-strong, #dc2626)",
        headline: state.message,
        detail: null,
        href: null,
        linkLabel: null,
        pulse: false,
      };
  }
}

export function BackgroundRunNotice({
  state,
  onDismiss,
}: {
  state: BackgroundRunState;
  onDismiss: () => void;
}) {
  const view = viewFor(state);
  if (!view) return null;

  return (
    <div
      data-testid="background-run-notice"
      role="status"
      aria-live="polite"
      className="mb-2 flex items-start gap-2 rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] px-3 py-2"
    >
      <span
        aria-hidden
        className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${
          view.pulse ? "animate-pulse" : ""
        }`}
        style={{ background: view.color }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span
            className="min-w-0 text-[12.5px] font-medium"
            style={{ color: view.color }}
          >
            {view.headline}
          </span>
          {view.href && view.linkLabel ? (
            <Link
              to={view.href}
              className="shrink-0 whitespace-nowrap text-[11.5px] font-medium text-[var(--content-secondary)] underline underline-offset-2"
            >
              {view.linkLabel}
            </Link>
          ) : null}
        </div>
        {view.detail ? (
          <p className="mt-0.5 text-[11.5px] text-[var(--content-tertiary)]">
            {view.detail}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-1 shrink-0 rounded p-1 text-[var(--content-tertiary)] hover:text-[var(--content-default)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
