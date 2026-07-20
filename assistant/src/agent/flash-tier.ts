/**
 * Flash-tier routing: send structurally TRIVIAL mainAgent turns to a
 * designated cheaper/faster model while everything else keeps the main path.
 *
 * Flagged OFF by default (`llm.flashTier.enabled`); the owner flips it with
 * eval numbers in hand.
 *
 * Design constraints (see docs/perf-2026-07-20/turn-latency.md §3.5):
 *
 * - **Structural signals only.** No LLM pre-classifier call — the decision is
 *   made from the shape of the turn (short user text, no attachments, no
 *   recent tool activity). A semantic classifier would itself cost a
 *   round-trip, which defeats the point on the very turns this targets.
 * - **Misclassification degrades, never breaks.** The flash call carries the
 *   SAME (pruned) tool set and the SAME system prompt as the main path; only
 *   the per-call model id changes. A trivial-looking turn that actually needs
 *   tools still calls them — it just runs the round on a cheaper model. And
 *   because the classifier re-runs every round via `resolveSystemPrompt`, the
 *   moment tool blocks appear in history the turn escalates back to the main
 *   model for subsequent rounds.
 * - **Transport is not re-routed.** The per-call `config.model` override wins
 *   over call-site resolution in `RetryProvider.normalizeSendMessageOptions`
 *   (and therefore also over the self-host FORCE_OPENROUTER env pin), but
 *   `CallSiteRoutingProvider` still selects the mainAgent transport. The
 *   flash model must therefore be servable by the mainAgent provider; a
 *   catalog-known model on a different provider is rejected here.
 * - **Explicit user choices win.** A pinned per-conversation inference
 *   profile, a tool-routed profile, or an explicit model override disables
 *   flash routing for the turn.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import type { LLMConfig } from "../config/schemas/llm.js";
import {
  type InjectionMatcher,
  RUNTIME_INJECTION_PREFIXES,
  stripUserTextBlocksByPrefix,
} from "../context/strip-injections.js";
import { getCatalogProviderForModel } from "../providers/model-catalog.js";
import type { Message } from "../providers/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("flash-tier");

/**
 * Matchers that identify runtime-injected text blocks inside a user message.
 * Extends the compaction strip list with `<turn_context>` (persisted in
 * history by design, but still not user-authored) so the classifier measures
 * only what the user actually typed.
 */
const CLASSIFIER_INJECTION_MATCHERS: InjectionMatcher[] = [
  ...RUNTIME_INJECTION_PREFIXES,
  "<turn_context>",
];

/**
 * How many trailing messages (including the latest user message) are scanned
 * for tool activity. Any `tool_use` / `tool_result` / `server_tool_use` block
 * in this window means the conversation is mid-task (or just finished one) —
 * a follow-up there frequently needs the main model's tool competence, so we
 * conservatively keep it on the main path.
 */
const MID_TASK_WINDOW = 5;

export interface FlashTierDecision {
  route: boolean;
  /** The structural signal that decided the classification (for logs/evals). */
  reason:
    | "trivial_structural"
    | "empty_history"
    | "last_message_not_user"
    | "attachments_present"
    | "recent_tool_activity"
    | "no_user_text"
    | "user_text_too_long";
}

/**
 * Purely structural triviality classifier. No I/O, no LLM call — safe to run
 * on every round of every turn.
 */
export function classifyTurnForFlashTier(
  history: Message[],
  opts: { maxUserChars: number },
): FlashTierDecision {
  if (history.length === 0) return { route: false, reason: "empty_history" };

  const last = history[history.length - 1];
  // Rounds ≥ 2 of a tool-using turn end with a tool_result user message; the
  // mid-task scan below also catches this, but the role check keeps the
  // classifier honest when the caller passes a mid-loop history snapshot.
  if (last.role !== "user") {
    return { route: false, reason: "last_message_not_user" };
  }
  for (const block of last.content) {
    if (block.type === "image" || block.type === "file") {
      return { route: false, reason: "attachments_present" };
    }
  }

  const windowStart = Math.max(0, history.length - MID_TASK_WINDOW);
  for (let i = windowStart; i < history.length; i++) {
    for (const block of history[i].content) {
      if (
        block.type === "tool_use" ||
        block.type === "tool_result" ||
        block.type === "server_tool_use"
      ) {
        return { route: false, reason: "recent_tool_activity" };
      }
    }
  }

  // Measure only the user's own text: strip runtime-injected blocks
  // (<memory>, <workspace>, <turn_context>, …) before counting.
  const stripped = stripUserTextBlocksByPrefix(
    [last],
    CLASSIFIER_INJECTION_MATCHERS,
  );
  const userText = (stripped[0]?.content ?? [])
    .filter(
      (block): block is Extract<typeof block, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (userText.length === 0) return { route: false, reason: "no_user_text" };
  if (userText.length > opts.maxUserChars) {
    return { route: false, reason: "user_text_too_long" };
  }

  return { route: true, reason: "trivial_structural" };
}

/**
 * Resolve the model id flash-tier turns should run on, or `undefined` when
 * flash routing cannot apply (disabled, no distinct model, or a configured
 * model that the mainAgent provider cannot serve).
 *
 * Source order:
 *   1. `llm.flashTier.model` (explicit config)
 *   2. The resolved `conversationTitle` call-site model — the canonical
 *      "flash" resolution, which on self-host already honors
 *      `CUE_OPENROUTER_FLASH_MODEL` via the resolver's env force.
 *
 * A resolution equal to the mainAgent model is reported as `undefined`
 * (routing would be a no-op — e.g. prod today, where main == flash env).
 */
export function resolveFlashTierModel(
  llm: LLMConfig,
  opts: { selectionSeed?: string } = {},
): string | undefined {
  if (!llm.flashTier.enabled) return undefined;

  // `selectionSeed` keeps mix-profile expansion deterministic per
  // conversation, matching the dispatch path's resolution — without it a mix
  // activeProfile would re-roll its arm here and the equality check below
  // could flap between rounds.
  const mainResolved = resolveCallSiteConfig("mainAgent", llm, {
    selectionSeed: opts.selectionSeed,
  });

  const explicit = llm.flashTier.model;
  if (explicit != null) {
    // Reject a catalog-known model that lives on a different provider — the
    // transport is NOT re-routed, so the request would hard-fail upstream.
    const catalogProvider = getCatalogProviderForModel(explicit);
    if (catalogProvider != null && catalogProvider !== mainResolved.provider) {
      log.warn(
        {
          flashModel: explicit,
          flashProvider: catalogProvider,
          mainProvider: mainResolved.provider,
        },
        "llm.flashTier.model belongs to a different provider than mainAgent — flash tier disabled for this resolution",
      );
      return undefined;
    }
    return explicit === mainResolved.model ? undefined : explicit;
  }

  const flashResolved = resolveCallSiteConfig("conversationTitle", llm, {
    selectionSeed: opts.selectionSeed,
  });
  if (flashResolved.provider !== mainResolved.provider) return undefined;
  if (flashResolved.model === mainResolved.model) return undefined;
  return flashResolved.model;
}

export interface FlashTierRoute {
  model: string;
  reason: FlashTierDecision["reason"];
}

/**
 * Full per-round gate: config flag → mainAgent turn → no explicit profile
 * override → structural classifier → distinct, provider-compatible model.
 * Returns the model to pin on the call, or `null` to keep the main path.
 */
export function resolveFlashTierRouteForTurn(opts: {
  llm: LLMConfig;
  history: Message[];
  /** The turn's LLM call site (only `mainAgent` turns are eligible). */
  callSite: string | undefined;
  /**
   * Any pinned/tool-routed inference profile for the turn. A non-null value
   * is an explicit model choice and disables flash routing.
   */
  overrideProfile: string | undefined;
  /** Conversation id, for deterministic mix-profile expansion. */
  selectionSeed?: string;
}): FlashTierRoute | null {
  const { llm, history, callSite, overrideProfile } = opts;
  if (!llm.flashTier.enabled) return null;
  if (callSite !== "mainAgent") return null;
  if (overrideProfile != null) return null;

  const decision = classifyTurnForFlashTier(history, {
    maxUserChars: llm.flashTier.maxUserChars,
  });
  if (!decision.route) return null;

  const model = resolveFlashTierModel(llm, {
    selectionSeed: opts.selectionSeed,
  });
  if (model == null) return null;
  return { model, reason: decision.reason };
}
