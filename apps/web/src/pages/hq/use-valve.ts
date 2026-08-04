/**
 * The volume valve (C1), as HQ reads and teaches it.
 *
 * The valve lives in the watcher/work pipeline: every open work item carries a
 * `band` (urgent > needs_you > everything), the owner sets a `stop`, and an
 * item interrupts iff its band clears the stop. Nothing is deleted, hidden or
 * re-judged — held work is still in Work, one stop-change away.
 *
 * Two things this module exists to keep honest:
 *
 * **`unbanded` is not zero and is not an error.** An item with no band row
 * reads as *urgent*: being unknown is the loudest state, which is the valve's
 * fail-open guarantee. On the day it ships, every standing item is unbanded and
 * every one of them still interrupts. So a surface that shows a full lane must
 * be able to say "the valve has not sized these up" — otherwise an unfiltered
 * lane passes for a filtered one, which is the most flattering lie available
 * about a filter.
 *
 * **The ✕ is the learning loop.** Design's promise that "the holding count
 * shrinks on its own" is not a property of the rules; it is a property of
 * feedback being recorded. A dismiss control that only removes a row from the
 * screen teaches nothing, so {@link useValveFeedback} is wired to the same
 * gesture rather than offered as an extra.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  hqValveFeedbackPostMutation,
  hqValveGetOptions,
  hqValveGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { HqValveGetResponses } from "@/generated/daemon/types.gen";

import type { ValveFacts } from "./hq-census";
import { known, unavailable, type LaneState } from "./hq-tiers";

export type ValveStop = "everything" | "needs_you" | "only_urgent";
export type ValveState = HqValveGetResponses[200];
export type ValveSubjectKind = "sender" | "channel" | "rule";

/**
 * The valve's own census, over ALL open work — not just one status.
 *
 * HQ's per-status reads each report their own `held`, but those are slices; the
 * number the owner wants behind "Cue is holding" is this one, and taking it
 * from a single endpoint is also what stops two lanes from disagreeing about
 * how much is being held back.
 */
export function useValveState(assistantId: string) {
  const query = useQuery({
    ...hqValveGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
  return {
    /** `undefined` until it lands — callers must not read that as zeroes. */
    state: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * The valve's answer as a lane state — **the one place `?? 0` is refused.**
 *
 * A pending or failed valve read must become `unavailable`, never
 * `{held: 0, unbanded: 0}`: "the valve is holding nothing back" and "I have not
 * asked the valve yet" are different sentences, and only the first is a claim
 * about the owner's work. This is a pure function of the query's three states
 * precisely so that rule is testable rather than a habit at a call site.
 */
export function valveLaneState(query: {
  state: ValveState | undefined;
  isError: boolean;
}): LaneState<ValveFacts> {
  if (query.isError) {
    return unavailable("Cue couldn't read your volume valve.");
  }
  if (query.state == null) {
    return unavailable("Still reading your volume valve…");
  }
  return known({
    stop: query.state.stop,
    held: query.state.held,
    unbanded: query.state.unbanded,
  });
}

/**
 * "Not relevant" — and its opposite.
 *
 * The subject is a structural fact about where the item came from, never the
 * item itself: teaching Cue that *this one email* did not matter would teach it
 * nothing, because that email will never arrive again. Sender when we know it,
 * channel when we do not.
 */
export function useValveFeedback(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...hqValveFeedbackPostMutation(),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: hqValveGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      // …and what Guardrails says the ✕ has taught. Without this the policy
      // page would keep reporting a demotion count taken before the dismissal
      // that changed it — the surface whose entire job is to be the record of
      // what you have taught, quietly a minute behind.
      void queryClient.invalidateQueries({ queryKey: ["valve-teaching"] });
    },
  });
}

/**
 * What to teach the valve about an item, or `null` when there is nothing
 * honest to say.
 *
 * `sourceContext` is the JSON provenance snapshot stamped at ingress. A
 * malformed or absent one means no sender, and we fall back to the channel
 * rather than guessing — a wrong subject key would quiet the wrong stream, and
 * the owner would have no way to see that it was our mistake rather than the
 * valve's judgement.
 */
export function feedbackSubject(item: {
  sourceContext?: string | null;
  sourceType?: string | null;
}): { subjectKind: ValveSubjectKind; subjectKey: string } | null {
  try {
    const raw = item.sourceContext ? JSON.parse(item.sourceContext) : null;
    const sender = (raw as { sender?: unknown } | null)?.sender;
    if (typeof sender === "string" && sender.trim()) {
      return { subjectKind: "sender", subjectKey: sender.trim().toLowerCase() };
    }
  } catch {
    // Malformed snapshot — fall through to the channel.
  }
  const channel = item.sourceType?.trim();
  return channel ? { subjectKind: "channel", subjectKey: channel } : null;
}
