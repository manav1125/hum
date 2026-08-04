/**
 * What the INSTANCE says about itself, for the first-run intro to tell the
 * truth with.
 *
 * WHY THIS EXISTS
 * ---------------
 * The intro's landing screen used to state, as a flat fact, "Nothing has
 * happened here yet." That is a claim about the instance made without asking
 * the instance — and it is false on any instance that has been in use, because
 * the flag that decides whether the intro runs (`cue:signon:introDone`) is
 * DEVICE-scoped by design. Sign in on a second device against an instance with
 * 420 conversations and the first thing Cue says is provably wrong.
 *
 * The device scoping is right and stays (see `intro-state.ts`): a single-tenant
 * instance cannot be locked out by a per-device key. The defect was never the
 * gate — it was a sentence asserting something nobody had looked up. So we look
 * it up: `GET /v1/assistants/{id}/home/state` is the same daemon this page is
 * already talking to, it is one request, and its `conversationCount` is a real
 * `COUNT(*)` over active standard conversations (`countConversations`) — the
 * same figure the Home surface prints. Nothing here is estimated, paginated, or
 * inferred from a window of rows.
 *
 * FAIL OPEN — THE RULE THAT OUTRANKS THE COPY
 * -------------------------------------------
 * The read is advisory. Every unknown — no active assistant yet, daemon
 * unreachable, request in flight, request failed, response malformed —
 * collapses to `null`, and `null` renders a sentence that claims nothing in
 * either direction. The screen never waits on this query, never gates a button
 * on it, and never shows a spinner for it. A first-run screen that cannot
 * render because a count did not load is far worse than a slightly vague
 * sentence, and this project has already emptied a task list once by letting an
 * outage read as a judgement.
 *
 * The corollary matters just as much: we do not claim the opposite either. A
 * genuinely fresh instance is told it is fresh, and the claim we make there is
 * the narrow one we actually measured ("no conversations here yet"), not the
 * unprovable global one ("nothing has happened").
 */
import { useQuery } from "@tanstack/react-query";

import { homeStateGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export type InstanceFacts = {
  /**
   * Active standard conversations on this instance, or `null` when the
   * instance has not answered. Never a placeholder, never a fallback figure —
   * a number here has come off the daemon's own `COUNT(*)`.
   */
  conversationCount: number | null;
  /**
   * The name the instance already has for this person, or `null`.
   *
   * The daemon leaves `userName` off the wire entirely when the persona file
   * has no name line, so a value here is proof the instance has genuinely been
   * told — which makes it safe to stop asking.
   */
  knownUserName: string | null;
  /**
   * The name the instance answers to, or `null`.
   *
   * Weaker evidence than `knownUserName`: the daemon falls back to "Cue" when
   * IDENTITY.md has no usable name bullet, so this cannot distinguish "the user
   * chose Cue" from "nobody has chosen". It is therefore only ever used as the
   * placeholder of the field that asks — where "Cue" is already the placeholder
   * and the ambiguity costs nothing — and never to decide whether to ask.
   */
  knownAssistantName: string | null;
};

/** What every failure, timeout and cold start reads as. */
export const UNKNOWN_INSTANCE_FACTS: InstanceFacts = {
  conversationCount: null,
  knownUserName: null,
  knownAssistantName: null,
};

/** Trim to a real value, or null. Blank strings are not answers. */
function cleaned(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

/**
 * Ask the instance about itself, once, without blocking anything.
 *
 * `retry: false` on purpose: a dead daemon should settle into "unknown"
 * immediately rather than spend three backoffs deciding, and there is nothing
 * to gain by retrying — the neutral copy is already correct.
 */
export function useInstanceFacts(): InstanceFacts {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  const { data } = useQuery({
    ...homeStateGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
    retry: false,
  });

  if (!data) return UNKNOWN_INSTANCE_FACTS;

  const count = data.conversationCount;
  return {
    conversationCount:
      typeof count === "number" && Number.isFinite(count) && count >= 0
        ? Math.floor(count)
        : null,
    knownUserName: cleaned(data.userName),
    knownAssistantName: cleaned(data.assistantName),
  };
}

/**
 * The landing sentence, for each of the three honest states.
 *
 * Pure, and exported, because this is the part that was wrong — it deserves to
 * be assertable without rendering anything.
 *
 * - `null` — we asked and got no answer. Say the parts that are true on any
 *   instance and make no claim about history in either direction.
 * - `0` — no conversations. Claim exactly that, which is what was measured;
 *   "nothing has happened here" would be a wider claim than the evidence.
 * - `n > 0` — say so, with the real number.
 */
export function arrivedBody(conversationCount: number | null): string {
  const OWNERSHIP = "This Cue is yours alone — it runs on your own instance";

  if (conversationCount === null) {
    return `${OWNERSHIP}. Two quick questions and it's set up on this device.`;
  }
  if (conversationCount === 0) {
    return `${OWNERSHIP}. There are no conversations here yet; two quick questions and it starts working.`;
  }
  const threads =
    conversationCount === 1
      ? "1 conversation"
      : `${conversationCount} conversations`;
  return `${OWNERSHIP}, and it has been working: ${threads} here already. Two quick questions and it's set up on this device.`;
}
