/**
 * Send the composer's current message as a BACKGROUND run instead of a
 * foreground chat turn.
 *
 * The product's differentiator — "just go do this, I'll read it later" — was
 * only reachable from Home feed cards (`POST home/feed/:id/actions/:actionId`
 * with `mode: "background"`). There was no way to start one from the place the
 * user actually types. This hook is that path.
 *
 * It reuses the SAME execution engine the feed's background mode uses. That
 * route builds a work item and calls `runWorkItemInBackground(id)`; the two
 * generated endpoints below are the client-reachable spelling of exactly that:
 *
 *   1. `POST work-items`        — create the item (daemon mints the backing
 *                                 task template, stamps a manual origin, and
 *                                 triages it *without* auto-running).
 *   2. `POST work-items/:id/run` — the daemon's own handler delegates straight
 *                                 to `runWorkItemInBackground`, auto-approving
 *                                 required tools because an explicit click is
 *                                 explicit consent.
 *
 * From there the run is governed like every other background run — budget
 * hard-stop, tool-scope filter, model pin, progress notes, act ledger — and it
 * lands in the Review lane on success. Live status arrives over SSE
 * (`work_item_status_changed` / `work_item_completed`), which `useActivitySync`
 * already turns into `workitemsGet` invalidations app-wide, so nothing here
 * needs to poll.
 *
 * NOTE ON HONESTY: the two calls can partially succeed — the item is created
 * but the dispatch 409s (already running / not runnable) or the runner refuses
 * it. That is a genuinely different outcome from "it's running", so it gets its
 * own `filed` state rather than being smoothed over. Nothing here ever claims
 * a result exists; see `background-run-notice.tsx` for the copy rules.
 *
 * Deliberately NOT react-query: `ChatComposer` renders in contexts without a
 * `QueryClientProvider` (its own unit test, the app-editing split view), and
 * this flow needs no cache of its own — the SSE invalidation above covers the
 * surfaces that display the item.
 */

import { useCallback, useRef, useState } from "react";

import { captureError } from "@/lib/sentry/capture-error";
import {
  workitemsByIdRunPost,
  workitemsPost,
} from "@/generated/daemon/sdk.gen";

/** Longest work-item title we synthesize before eliding. */
const MAX_TITLE_LENGTH = 72;

export type BackgroundRunState =
  | { kind: "idle" }
  /** The POSTs are in flight. */
  | { kind: "dispatching"; title: string }
  /** Created AND dispatched — the runner owns it now. */
  | { kind: "running"; workItemId: string; title: string }
  /** Created but NOT dispatched — it is sitting in the queue, not running. */
  | { kind: "filed"; workItemId: string; title: string }
  /** Nothing was created; the user's text is back in the composer. */
  | { kind: "error"; message: string };

/**
 * A work item needs a short title. Take the first non-blank line, collapse its
 * whitespace, and elide on a word boundary. The FULL message is still sent as
 * `notes`, which the daemon uses verbatim as the task template (the instruction
 * the model actually receives) — so nothing the user typed is lost to this.
 */
export function deriveWorkItemTitle(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? text.trim();
  const collapsed = firstLine.replace(/\s+/g, " ");
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  const cut = collapsed.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface BackgroundRunController {
  state: BackgroundRunState;
  /**
   * Dispatch `text` as a background run. Resolves `true` when a work item was
   * created (whether or not it started), `false` when nothing was created —
   * the caller restores the composer text on `false` so the message is never
   * silently eaten.
   */
  dispatch: (text: string) => Promise<boolean>;
  /** Report a client-side problem (e.g. a bare `/background` with no task). */
  reject: (message: string) => void;
  dismiss: () => void;
}

export function useBackgroundRun(
  assistantId: string | null,
  /**
   * The thread this run is being started from. Passed to the daemon as
   * `originConversationId` so the item lands in that conversation's
   * spawned-work strip (durable provenance) rather than in the queue with a
   * null origin. Optional — surfaces with no originating thread omit it.
   */
  conversationId?: string | null,
): BackgroundRunController {
  const [state, setState] = useState<BackgroundRunState>({ kind: "idle" });
  // Monotonic token so a slow dispatch can never overwrite a newer one's state.
  const dispatchSeqRef = useRef(0);

  const dispatch = useCallback(
    async (text: string): Promise<boolean> => {
      const body = text.trim();
      if (!assistantId || body.length === 0) return false;

      const seq = ++dispatchSeqRef.current;
      const isCurrent = () => dispatchSeqRef.current === seq;
      const title = deriveWorkItemTitle(body);
      setState({ kind: "dispatching", title });

      let workItemId: string;
      try {
        const { data } = await workitemsPost({
          path: { assistant_id: assistantId },
          // `notes` becomes the task template — the instruction the run
          // receives. Omitted when the title already IS the whole message so
          // the daemon doesn't store the same string twice.
          body: {
            title,
            ...(body === title ? {} : { notes: body }),
            ...(conversationId ? { originConversationId: conversationId } : {}),
          },
          throwOnError: true,
        });
        workItemId = data.item.id;
      } catch (err) {
        captureError(err, { context: "composer_background_run_create" });
        if (isCurrent()) {
          setState({
            kind: "error",
            message:
              "Couldn't hand this off to a background run. Your message is back in the composer.",
          });
        }
        return false;
      }

      try {
        await workitemsByIdRunPost({
          path: { assistant_id: assistantId, id: workItemId },
          throwOnError: true,
        });
        if (isCurrent()) setState({ kind: "running", workItemId, title });
      } catch (err) {
        // The item exists but did not start. Say exactly that — do not report
        // a run that isn't happening.
        captureError(err, { context: "composer_background_run_dispatch" });
        if (isCurrent()) setState({ kind: "filed", workItemId, title });
      }
      return true;
    },
    [assistantId, conversationId],
  );

  const reject = useCallback((message: string) => {
    dispatchSeqRef.current++;
    setState({ kind: "error", message });
  }, []);

  const dismiss = useCallback(() => {
    dispatchSeqRef.current++;
    setState({ kind: "idle" });
  }, []);

  return { state, dispatch, reject, dismiss };
}
