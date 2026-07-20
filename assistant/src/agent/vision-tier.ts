/**
 * Vision-tier routing: send image-bearing agent rounds to a vision-capable
 * model when the round would otherwise run on a KNOWN text-only model.
 *
 * This is the mirror image of flash-tier (`agent/flash-tier.ts`): same
 * mechanism (per-round structural classification inside
 * `resolveSystemPrompt`, pinning `resolved.model` which wins over call-site
 * resolution — and therefore over the self-host FORCE_OPENROUTER env pin —
 * in `RetryProvider.normalizeSendMessageOptions`), opposite trigger. Flash
 * routes trivial text turns DOWN to a cheaper model; vision routes
 * image-bearing turns SIDEWAYS to a model that can read them at all.
 *
 * Why proactive: the prod brains (deepseek v4-pro / v4-flash via OpenRouter)
 * are text-only, so any request whose payload carries an image block 400s
 * with "This model doesn't support image input". A reactive one-shot retry
 * exists in `chat-completions-provider.ts` (`detectVisionNotSupported`), but
 * its fallback is `CUE_OPENROUTER_MODEL` — the main brain itself — so on a
 * text-only-brain deploy it is a no-op and the error surfaces to the user.
 * Routing here intercepts BEFORE the request is ever sent.
 *
 * Design constraints (mirroring flash-tier):
 *
 * - **Structural signals only.** The trigger is "does the request payload
 *   carry an image block" — scanned over the FULL history, not just the
 *   trailing message, because providers serialize every historical image
 *   into the request (`messagesContainImageInput` in the provider's reactive
 *   fallback uses the same rule). An image pasted three turns ago still
 *   breaks a text-only model today. `file` blocks do NOT trigger: the
 *   OpenAI-compat wire serializes them as extracted text
 *   (`fileBlockToText`), so they never hit the vision wall.
 * - **Only provably-broken rounds are re-routed.** Routing fires only when
 *   the resolved model is KNOWN text-only in the model catalog
 *   (`supportsVision: false`). Vision-capable models are left alone, and
 *   catalog-unknown models are left alone too (a custom endpoint may well be
 *   multimodal; the provider-level reactive fallback still covers the
 *   residual failures).
 * - **Transport is not re-routed.** Same rule as flash-tier: the per-call
 *   `config.model` override changes only the model id; the turn's call-site
 *   transport is unchanged. The vision model must therefore be servable by
 *   the turn's resolved provider — a catalog-known model on a different
 *   provider is rejected.
 * - **Explicit user pins do NOT disable vision routing.** This deliberately
 *   diverges from flash-tier: a user who pinned a text-only profile and then
 *   sends an image wants the image answered, not a provider 400 — the pinned
 *   model literally cannot serve the request. The reroute is logged
 *   (`vision_tier_routed`) and lasts only for image-bearing rounds; the pin
 *   resumes on the next text-only round via per-round re-evaluation.
 * - **Vision beats flash.** An image-bearing round must never land on the
 *   flash-tier text model. `resolveModelRouteForTurn` below encodes the
 *   ordering; it is the single entry point the conversation wiring calls.
 * - **Tools and system prompt are untouched.** Only the model id changes, so
 *   a misrouted round degrades to "same turn on the vision model", never a
 *   broken turn.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import type { LLMCallSite, LLMConfig } from "../config/schemas/llm.js";
import {
  getCatalogProviderForModel,
  getCatalogVisionSupport,
} from "../providers/model-catalog.js";
import type { Message } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { resolveFlashTierRouteForTurn } from "./flash-tier.js";

const log = getLogger("vision-tier");

/**
 * The vision fallback model for OpenRouter deploys when neither
 * `llm.visionTier.model` nor a usable `cueLiveVision` resolution provides
 * one. Must support BOTH image input and tool calling: agent-loop rounds
 * carry the tool set, and OpenRouter 404s ("No endpoints found that support
 * tool use") on vision models whose endpoints lack tools — qwen2.5-vl-72b
 * (the Cue Live pick) fails exactly that way. qwen3.6-flash was probe-
 * verified on the prod key with an image + tools payload. Deliberately not
 * in the model catalog — catalog-unknown models pass the provider-compat
 * check.
 */
export const DEFAULT_OPENROUTER_VISION_MODEL = "qwen/qwen3.6-flash";

/**
 * True when any message in the request history carries an image content
 * block — either a top-level `image` block (pasted/attached/generated
 * images) or an `image` block nested in a `tool_result`'s `contentBlocks`
 * (e.g. `browser_screenshot`), which providers hoist into user-message
 * image parts on the wire.
 */
export function historyCarriesImageInput(history: Message[]): boolean {
  for (const message of history) {
    for (const block of message.content) {
      if (block.type === "image") return true;
      if (
        block.type === "tool_result" &&
        block.contentBlocks?.some((cb) => cb.type === "image")
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolve the model id image-bearing rounds should run on, or `undefined`
 * when no usable vision model exists for the turn's provider.
 *
 * Source order:
 *   1. `llm.visionTier.model` (explicit config). Unlike flash-tier, an
 *      invalid explicit model (wrong provider / known text-only) falls
 *      through to the next source instead of disabling routing — failing to
 *      route here means a hard provider error, so a working fallback beats
 *      strict pin semantics. An explicit model EQUAL to the turn's model is
 *      respected as a deliberate no-op.
 *   2. The resolved `cueLiveVision` call-site model — the one call site that
 *      is already required to be vision-capable, and on prod the model the
 *      operator proved works (`llm.callSites.cueLiveVision`).
 *   3. On OpenRouter only: `DEFAULT_OPENROUTER_VISION_MODEL`. Other
 *      providers have no sane cross-provider default, so resolution fails
 *      and the round proceeds unrouted (reactive fallback still applies).
 */
export function resolveVisionTierModel(
  llm: LLMConfig,
  opts: {
    /** The turn's resolved provider (transport is not re-routed). */
    mainProvider: string;
    /** The turn's resolved (known text-only) model. */
    mainModel: string;
    selectionSeed?: string;
  },
): string | undefined {
  const { mainProvider, mainModel } = opts;

  const explicit = llm.visionTier.model;
  if (explicit != null) {
    if (explicit === mainModel) return undefined;
    const catalogProvider = getCatalogProviderForModel(explicit);
    const providerMismatch =
      catalogProvider != null && catalogProvider !== mainProvider;
    const knownTextOnly = getCatalogVisionSupport(explicit) === false;
    if (!providerMismatch && !knownTextOnly) return explicit;
    log.warn(
      {
        visionModel: explicit,
        visionModelProvider: catalogProvider,
        mainProvider,
        knownTextOnly,
      },
      "llm.visionTier.model is unusable for this turn (wrong provider or known text-only) — falling back to the cueLiveVision/default resolution",
    );
  }

  const cueLive = resolveCallSiteConfig("cueLiveVision", llm, {
    selectionSeed: opts.selectionSeed,
  });
  if (
    cueLive.provider === mainProvider &&
    cueLive.model !== mainModel &&
    getCatalogVisionSupport(cueLive.model) !== false
  ) {
    return cueLive.model;
  }

  if (
    mainProvider === "openrouter" &&
    DEFAULT_OPENROUTER_VISION_MODEL !== mainModel
  ) {
    return DEFAULT_OPENROUTER_VISION_MODEL;
  }
  return undefined;
}

export interface VisionTierRoute {
  model: string;
  reason: "image_with_text_only_model";
}

/**
 * Full per-round gate: config flag → image blocks present in the request →
 * resolved model known text-only → usable vision model for the provider.
 * Returns the model to pin on the call, or `null` to keep the current path.
 *
 * Unlike flash-tier this is NOT gated to `mainAgent`: any conversation-loop
 * call site (subagents, background actions) whose payload carries an image
 * hits the same provider wall, and the provider-compat check inside
 * `resolveVisionTierModel` already guards cross-provider call sites.
 */
export function resolveVisionTierRouteForTurn(opts: {
  llm: LLMConfig;
  history: Message[];
  /** The turn's LLM call site; defaults to `mainAgent` when unset. */
  callSite: LLMCallSite | undefined;
  /**
   * Any pinned/tool-routed inference profile for the turn. Vision routing
   * resolves THROUGH the profile (so a pinned vision-capable model is left
   * alone) and overrides it only when the pinned model provably cannot
   * serve the request.
   */
  overrideProfile: string | undefined;
  /**
   * An explicit per-conversation model override (constructor-level
   * `modelOverride`). When set it is the effective model for the turn and is
   * checked for vision support directly.
   */
  explicitModel?: string;
  /** Conversation id, for deterministic mix-profile expansion. */
  selectionSeed?: string;
}): VisionTierRoute | null {
  const { llm, history, overrideProfile, explicitModel } = opts;
  // Image scan first: it is pure and needs no config, so the overwhelmingly
  // common image-free round exits without touching `llm.visionTier` at all.
  if (!historyCarriesImageInput(history)) return null;
  if (!llm.visionTier.enabled) return null;

  const callSite = opts.callSite ?? "mainAgent";
  const resolved = resolveCallSiteConfig(callSite, llm, {
    ...(overrideProfile != null ? { overrideProfile } : {}),
    selectionSeed: opts.selectionSeed,
  });
  const effectiveModel = explicitModel ?? resolved.model;

  // Route only provably-broken rounds: vision-capable (true) and
  // catalog-unknown (undefined) models are left on their configured path.
  if (getCatalogVisionSupport(effectiveModel) !== false) return null;

  const model = resolveVisionTierModel(llm, {
    mainProvider:
      getCatalogProviderForModel(effectiveModel) ?? resolved.provider,
    mainModel: effectiveModel,
    selectionSeed: opts.selectionSeed,
  });
  if (model == null) {
    log.warn(
      { callSite, textOnlyModel: effectiveModel, provider: resolved.provider },
      "Image-bearing round on a known text-only model but no vision model resolved — request will likely fail with 'doesn't support image input'",
    );
    return null;
  }
  return { model, reason: "image_with_text_only_model" };
}

export interface ModelTierRoute {
  model: string;
  tier: "vision" | "flash";
  reason: string;
}

/**
 * Combined per-round model routing, in precedence order: vision-tier first
 * (an image-bearing round must never land on the flash text model — flash's
 * own classifier only inspects the TRAILING message, so an image earlier in
 * history plus a trivial follow-up would otherwise flash-route a payload the
 * flash model cannot parse), then flash-tier.
 *
 * Flash-tier is additionally skipped whenever an explicit per-conversation
 * `modelOverride` is set (`explicitModel`), preserving the pre-existing
 * conversation wiring where an explicit model bypassed flash entirely.
 * Vision-tier still evaluates in that case — see its docstring.
 */
export function resolveModelRouteForTurn(opts: {
  llm: LLMConfig;
  history: Message[];
  callSite: LLMCallSite | undefined;
  overrideProfile: string | undefined;
  explicitModel?: string;
  selectionSeed?: string;
}): ModelTierRoute | null {
  const vision = resolveVisionTierRouteForTurn(opts);
  if (vision != null) return { ...vision, tier: "vision" };

  if (opts.explicitModel != null) return null;
  const flash = resolveFlashTierRouteForTurn({
    llm: opts.llm,
    history: opts.history,
    callSite: opts.callSite,
    overrideProfile: opts.overrideProfile,
    ...(opts.selectionSeed != null
      ? { selectionSeed: opts.selectionSeed }
      : {}),
  });
  if (flash != null) return { ...flash, tier: "flash" };
  return null;
}
