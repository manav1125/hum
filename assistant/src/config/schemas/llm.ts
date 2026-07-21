import { z } from "zod";

/**
 * Unified LLM configuration schema.
 *
 * Defines the shape of the top-level `llm` config block that consolidates
 * provider/model/effort/speed/thinking/contextWindow/pricingOverrides for all
 * call sites in the assistant. Wired into `AssistantConfigSchema` as the `llm`
 * field and consumed by `resolveCallSiteConfig` in `llm-resolver.ts`.
 */

// ---------------------------------------------------------------------------
// Provider enum
// ---------------------------------------------------------------------------

const LLMProvider = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
  "openai-compatible",
  "minimax",
]);
type LLMProvider = z.infer<typeof LLMProvider>;

// ---------------------------------------------------------------------------
// Call-site enum
// ---------------------------------------------------------------------------

/**
 * The complete set of LLM call-site identifiers the assistant emits.
 *
 * Each ID corresponds to a logical place in the codebase that produces an LLM
 * request. Adding or removing a call site is a config-schema change — keep
 * this list in sync with the resolver and registry (introduced in PR 2).
 */
export const LLMCallSiteEnum = z.enum([
  "mainAgent",
  "subagentSpawn",
  "heartbeatAgent",
  "filingAgent",
  "compactionAgent",
  "analyzeConversation",
  "callAgent",
  "memoryExtraction",
  "meetingRecap",
  "memoryConsolidation",
  "memoryRetrieval",
  "memoryV2Migration",
  "memoryV2Sweep",
  "memoryRouter",
  "memoryV3SelectL2",
  "memoryV2Consolidation",
  "memoryRetrospective",
  "recall",
  "narrativeRefinement",
  "patternScan",
  "conversationSummarization",
  "conversationStarters",
  "replySuggestion",
  "conversationTitle",
  "commitMessage",
  "identityIntro",
  "emptyStateGreeting",
  "notificationDecision",
  "preferenceExtraction",
  "guardianQuestionCopy",
  "approvalCopy",
  "approvalConversation",
  "interactionClassifier",
  "styleAnalyzer",
  "inviteInstructionGenerator",
  "skillCategoryInference",
  "meetConsentMonitor",
  "meetChatOpportunity",
  "inference",
  "trustRuleSuggestion",
  "homeGreeting",
  "homeSuggestedPrompts",
  "actionBoard",
  "autoDraft",
  "homeAction",
  // Cue Live's screen-vision pass (Look / Do it). Separate from mainAgent
  // because it REQUIRES image input: the general brain is chosen for context
  // and cost and may be text-only (deepseek-v4-flash is), which silently broke
  // every Look with "This model doesn't support image input". Point this at a
  // vision-capable model; it's the only call site that can't fall back to text.
  "cueLiveVision",
  // The advisor consult (WS-B): a mid-task second opinion from a stronger
  // model before the main brain commits a high-stakes/uncertain action. Its
  // own call site so operators can pin provider/model/effort independently of
  // mainAgent; the per-call model override in `agent/advisor.ts` still wins.
  "advisor",
]);
export type LLMCallSite = z.infer<typeof LLMCallSiteEnum>;

// ---------------------------------------------------------------------------
// Effort, Speed & Verbosity
// ---------------------------------------------------------------------------

/**
 * Reasoning/thinking effort tier. `"none"` is a Vellum-specific value meaning
 * "the user has opted out of provider-side reasoning". Each provider
 * translates it however actually disables reasoning on that wire format:
 * OpenAI Responses sends `reasoning.effort: "none"` and Chat Completions
 * sends `reasoning_effort: "none"` explicitly, because omitting the field
 * causes OpenAI to default to `"medium"`; Anthropic omits
 * `output_config.effort` entirely, which is the documented opt-out there.
 * When adding a new provider, pick whichever encoding actually disables
 * reasoning on that wire format — do not assume omission is universally safe.
 * All other values map to provider-specific tiers via each provider's own
 * mapping table.
 */
const EffortEnum = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);

export const SpeedEnum = z.enum(["standard", "fast"]);
export type Speed = z.infer<typeof SpeedEnum>;

/**
 * Response verbosity. Currently consumed by OpenAI's Responses API as
 * `text.verbosity` (low|medium|high). Providers that don't support this knob
 * are stripped in `retry.ts` normalization.
 */
const VerbosityEnum = z.enum(["low", "medium", "high"]);

// ---------------------------------------------------------------------------
// Leaf primitives (shared between LLMConfigBase and LLMConfigFragment)
//
// Each primitive is a Zod schema with no defaults attached. `LLMConfigBase`
// composes them with `.default(...)` so `LLMConfigBase.parse({})` returns a
// fully-defaulted object; `LLMConfigFragment` composes them with `.optional()`
// so absent fields stay absent. Centralizing the validation rules here keeps
// the two views consistent.
// ---------------------------------------------------------------------------

const ModelSchema = z.string().min(1);
const MaxTokensSchema = z.number().int().positive();
const TemperatureSchema = z.number().min(0).max(2).nullable();
// Named, code-resolved logit-bias preset a profile may opt into. The value is a
// preset *name*, not an inline token→bias map, so the workspace config stays
// small. This is profile-identity metadata, not inheritable config: the resolver
// strips it from the deep-merge and re-attaches it from the winning profile (see
// `profileConfigFragment` / `resolveCallSiteConfig`), and `RetryProvider`
// resolves it to a `logit_bias` map at request time, forwarded only on the
// Fireworks (OpenAI-compatible) path. Keep these literals in sync with the
// presets handled by `resolveLogitBiasPreset` in
// `providers/inference/logit-bias.ts` (kept separate to avoid a schema →
// provider import cycle).
const LogitBiasPresetSchema = z.enum(["suppress-cjk"]);

// ---------------------------------------------------------------------------
// Thinking & ContextWindow
//
// These mirror the shapes already declared in `schemas/inference.ts` but are
// redeclared here so the new `llm` namespace owns its own types. PRs 3 and
// beyond will deprecate the legacy declarations once the resolver is the
// single source of truth.
//
// Every leaf in the defaulted view carries a `.default(...)`, so
// `Schema.parse({})` returns a fully-defaulted object. This is critical for
// the loader's leaf-deletion recovery path: if any leaf in the user's config
// is invalid, the loader strips that leaf and re-parses; without
// schema-level defaults the parse would fail on missing required siblings,
// and the loader would fall back to `cloneDefaultConfig()`, discarding the
// user's other valid settings.
//
// Each defaulted schema has a sibling "fragment" schema with the same leaves
// wrapped in `.optional()` instead of `.default(...)`. The fragment view is
// used by `LLMConfigFragment` so partial overrides remain partial — Zod
// would inject defaults for absent fields if we used `Schema.partial()`, and
// the fragment contract is "any field may be absent and stays absent".
// ---------------------------------------------------------------------------

// Leaf primitives for thinking fields — defined once and reused by both the
// defaulted (`ThinkingSchema`) and fragment (`ThinkingFragmentSchema`) views.
const ThinkingEnabledSchema = z.boolean();
const ThinkingStreamThinkingSchema = z.boolean();
// Gemini-style thinking depth knob. Maps to Gemini's `thinkingLevel`. Other
// providers (Anthropic, OpenRouter) ignore this field — they use `effort`
// instead to size reasoning. Optional with no default so the underlying
// provider can pick its own default (Gemini 3.x defaults to "medium").
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const ThinkingLevelSchema = z.enum(THINKING_LEVELS);

const ThinkingSchema = z.object({
  enabled: ThinkingEnabledSchema.default(true),
  streamThinking: ThinkingStreamThinkingSchema.default(true),
  level: ThinkingLevelSchema.optional(),
});

// Fragment view: every field optional, no defaults injected. Defining this
// separately (rather than `ThinkingSchema.partial()`) avoids having Zod
// inject defaults for absent fields when a partial override is parsed —
// the fragment contract is "any field may be absent and stays absent".
const ThinkingFragmentSchema = z.object({
  enabled: ThinkingEnabledSchema.optional(),
  streamThinking: ThinkingStreamThinkingSchema.optional(),
  level: ThinkingLevelSchema.optional(),
});

// Leaf primitives for context-overflow recovery.
const OverflowEnabledSchema = z.boolean();
const OverflowSafetyMarginRatioSchema = z.number().finite().gt(0).lt(1);
const OverflowMaxAttemptsSchema = z.number().int().positive();
const OverflowLatestTurnCompressionSchema = z.enum([
  "truncate",
  "summarize",
  "drop",
]);

const ContextOverflowRecoverySchema = z.object({
  enabled: OverflowEnabledSchema.default(true),
  safetyMarginRatio: OverflowSafetyMarginRatioSchema.default(0.05),
  maxAttempts: OverflowMaxAttemptsSchema.default(3),
  interactiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.default("summarize"),
  nonInteractiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.default("truncate"),
});

const ContextOverflowRecoveryFragmentSchema = z.object({
  enabled: OverflowEnabledSchema.optional(),
  safetyMarginRatio: OverflowSafetyMarginRatioSchema.optional(),
  maxAttempts: OverflowMaxAttemptsSchema.optional(),
  interactiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.optional(),
  nonInteractiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.optional(),
});

// Leaf primitives for context-window fields.
const ContextEnabledSchema = z.boolean();
export const DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS = 200000;

const ContextMaxInputTokensSchema = z.number().int().positive();
const ContextTargetBudgetRatioSchema = z.number().finite().gt(0).lte(1);
const ContextCompactThresholdSchema = z.number().finite().gt(0).lte(1);
const ContextSummaryBudgetRatioSchema = z.number().finite().gt(0).lte(1);

const ContextWindowSchema = z.object({
  enabled: ContextEnabledSchema.default(true),
  maxInputTokens: ContextMaxInputTokensSchema.default(
    DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  ),
  targetBudgetRatio: ContextTargetBudgetRatioSchema.default(0.3),
  compactThreshold: ContextCompactThresholdSchema.default(0.8),
  summaryBudgetRatio: ContextSummaryBudgetRatioSchema.default(0.05),
  overflowRecovery: ContextOverflowRecoverySchema.default(
    ContextOverflowRecoverySchema.parse({}),
  ),
});
export type ContextWindow = z.infer<typeof ContextWindowSchema>;

// Fragment view of `ContextWindowSchema` — all fields optional and no defaults
// injected. Nested `overflowRecovery` likewise uses its fragment view, so a
// partial override like `{ overflowRecovery: { maxAttempts: 5 } }` produces
// exactly that and nothing else.
const ContextWindowDeepPartialSchema = z.object({
  enabled: ContextEnabledSchema.optional(),
  maxInputTokens: ContextMaxInputTokensSchema.optional(),
  targetBudgetRatio: ContextTargetBudgetRatioSchema.optional(),
  compactThreshold: ContextCompactThresholdSchema.optional(),
  summaryBudgetRatio: ContextSummaryBudgetRatioSchema.optional(),
  overflowRecovery: ContextOverflowRecoveryFragmentSchema.optional(),
});

// ---------------------------------------------------------------------------
// OpenRouter provider-routing preferences
//
// OpenRouter's `/v1/chat/completions` and `/v1/messages` endpoints both accept
// a `provider: { only: [...] }` body field that restricts which upstream
// providers (Anthropic, Google, etc.) may fulfill a request. Exposed here so
// users can pin routing via config without touching the wire-format knobs
// directly. Nested shape keeps room for sibling OpenRouter knobs (`order`,
// `allow_fallbacks`, …) to be added later without another schema reshape.
// ---------------------------------------------------------------------------

const OpenRouterOnlyItemSchema = z.string().min(1);

const OpenRouterSchema = z.object({
  only: z.array(OpenRouterOnlyItemSchema).default([]),
});

const OpenRouterDeepPartialSchema = z.object({
  only: z.array(OpenRouterOnlyItemSchema).optional(),
});

// ---------------------------------------------------------------------------
// Profile metadata
// ---------------------------------------------------------------------------

/**
 * Distinguishes daemon-managed profiles (overwritten on every startup) from
 * user-created ones (never touched by the daemon).
 */
const ProfileSource = z.enum(["managed", "user"]);
type ProfileSource = z.infer<typeof ProfileSource>;

// ---------------------------------------------------------------------------
// Pricing overrides
// ---------------------------------------------------------------------------

const PricingOverrideSchema = z.object({
  provider: z.string(),
  modelPattern: z.string(),
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
});

// ---------------------------------------------------------------------------
// Base config (all fields defaulted) and Fragment (all fields optional)
// ---------------------------------------------------------------------------

/**
 * Fully specified LLM config. Used for `llm.default` — every knob has a
 * schema-level default, so `LLMConfigBase.parse({})` returns a complete
 * fallback object. This is essential for the loader's leaf-deletion recovery
 * path; see the comment on `ThinkingSchema` above.
 */
export const LLMConfigBase = z.object({
  provider: LLMProvider.default("anthropic"),
  /**
   * Name of a `provider_connections` row to use for this resolved config.
   * Optional and additive: when set, the dispatcher resolves auth from the
   * connection (mix-and-match managed/your-own per profile). When unset,
   * the dispatcher falls back to the legacy `provider` lookup.
   *
   * Lives on the merged base type so it flows through `resolveCallSiteConfig`
   * naturally — the underlying profile-level field is on `ProfileEntry`.
   */
  provider_connection: z.string().min(1).optional(),
  model: ModelSchema.default("claude-opus-4-8"),
  maxTokens: MaxTokensSchema.default(64000),
  effort: EffortEnum.default("max"),
  speed: SpeedEnum.default("standard"),
  verbosity: VerbosityEnum.default("medium"),
  temperature: TemperatureSchema.default(null),
  thinking: ThinkingSchema.default(ThinkingSchema.parse({})),
  contextWindow: ContextWindowSchema.default(ContextWindowSchema.parse({})),
  openrouter: OpenRouterSchema.default(OpenRouterSchema.parse({})),
  // Not deep-merged like the other fields: `resolveCallSiteConfig` sets this
  // from the single highest-precedence profile that won resolution (see
  // `profileConfigFragment`, which strips it from the merge), so a preset
  // can't bleed from a lower-precedence profile into one that didn't opt in.
  logitBias: LogitBiasPresetSchema.optional(),
  /**
   * Opt this config out of prompt caching. Providers send no cache
   * breakpoints and strip caller-stamped `cache_control` markers. Intended
   * for one-shot call sites whose prompts never repeat (or repeat slower
   * than the cache TTL), where every breakpoint is a paid cache write with
   * no future read. Optional (no schema default) so it only appears in
   * resolved configs when a layer sets it.
   */
  disableCache: z.boolean().optional(),
});
export type LLMConfigBase = z.infer<typeof LLMConfigBase>;

/**
 * Partial LLM config used for profiles and call-site overrides. Each top-level
 * field is optional; nested `thinking` and `contextWindow` accept partial
 * objects so callers can override individual leaves (e.g. `{ thinking:
 * { enabled: false } }`).
 */
export const LLMConfigFragment = z.object({
  provider: LLMProvider.optional(),
  model: ModelSchema.optional(),
  maxTokens: MaxTokensSchema.optional(),
  effort: EffortEnum.optional(),
  speed: SpeedEnum.optional(),
  verbosity: VerbosityEnum.optional(),
  temperature: TemperatureSchema.optional(),
  thinking: ThinkingFragmentSchema.optional(),
  contextWindow: ContextWindowDeepPartialSchema.optional(),
  openrouter: OpenRouterDeepPartialSchema.optional(),
  logitBias: LogitBiasPresetSchema.optional(),
  disableCache: z.boolean().optional(),
});
export type LLMConfigFragment = z.infer<typeof LLMConfigFragment>;

export const ProfileStatusSchema = z.enum(["active", "disabled"]);
export type ProfileStatus = z.infer<typeof ProfileStatusSchema>;

// ---------------------------------------------------------------------------
// Mix profiles
//
// A "mix" profile carries no model config of its own. Instead it references a
// weighted list of other (standard) profiles; at resolve time exactly one
// constituent is chosen by weight. The pick is a deterministic function of a
// per-conversation seed (the conversation id — see `resolveCallSiteConfig`'s
// `selectionSeed`), so a conversation always lands on the same arm across all
// its turns, retries, and even daemon restarts, while different conversations
// split according to the weights — and the chosen arm is recordable for A/B
// evaluation. Weights are relative (normalized by their sum at pick time), so
// `[{weight:80},{weight:20}]` and `[{weight:4},{weight:1}]` are equivalent.
// ---------------------------------------------------------------------------
const MixArmSchema = z.object({
  profile: z.string().min(1),
  weight: z.number().finite().positive(),
});
export type MixArm = z.infer<typeof MixArmSchema>;

const MixSchema = z.array(MixArmSchema).min(2);

/**
 * A named profile entry: an `LLMConfigFragment` augmented with
 * presentation/ownership metadata. These fields are intentionally kept off
 * `LLMConfigFragment` so they don't leak into `LLMCallSiteConfig` or the
 * resolver's deep-merge output.
 */
export const ProfileEntry = LLMConfigFragment.extend({
  source: ProfileSource.optional(),
  /**
   * `.nullable()` is intentional: the PUT `/v1/config/llm/profiles/:name`
   * route uses `null` as the "clear this override" sentinel for managed
   * profiles (see `patchManagedProfileFields` in
   * `runtime/routes/conversation-query-routes.ts`). Without `.nullable()`,
   * Zod rejects `{ label: null }` at parse time before the route handler
   * ever sees it, and the clear-back-to-seed path is unreachable from any
   * client. `.min(1)` still applies to string values so empty strings
   * remain rejected — `null` is the only non-string-non-undefined input
   * accepted.
   */
  label: z.string().min(1).nullable().optional(),
  description: z.string().optional(),
  /**
   * Name of a `provider_connections` row to use for this profile.
   * The dispatcher resolves auth from this connection; the legacy `provider`
   * and `source` fields remain as read-only deprecated fallbacks for profiles
   * not yet backfilled by the boot-time migration.
   */
  provider_connection: z.string().min(1).optional(),
  /**
   * Absent means active. `.nullable()` matches `label` so the PUT route's
   * "send `null` to clear" sentinel works for status edits too — see
   * `patchManagedProfileFields`, which has handled `status === null` since
   * #30362 even though the schema didn't accept it until now.
   */
  status: ProfileStatusSchema.nullable().optional(),
  /**
   * When present, this profile is a "mix": it carries no model config and
   * instead references a weighted list of standard profiles. The resolver
   * expands a mix by a seeded weighted pick (see `resolveCallSiteConfig`).
   * `LLMSchema.superRefine` enforces that (a) every referenced profile exists,
   * (b) no referenced profile is itself a mix (no nesting), (c) no arm
   * references the mix itself, and (d) a mix carries no `LLMConfigFragment`
   * config field — only metadata (`label`, `description`, `status`, `source`)
   * may accompany `mix`.
   */
  mix: MixSchema.optional(),
});
export type ProfileEntry = z.infer<typeof ProfileEntry>;

/**
 * Per-call-site config: a fragment plus an optional `profile` reference.
 * The resolver merges in the named profile (if any) before applying
 * call-site-level overrides.
 */
const LLMCallSiteConfig = LLMConfigFragment.extend({
  profile: z.string().min(1).optional(),
});
type LLMCallSiteConfig = z.infer<typeof LLMCallSiteConfig>;

// ---------------------------------------------------------------------------
// Top-level LLM schema
// ---------------------------------------------------------------------------

/**
 * Per-turn wire tool-set pruning. When enabled, connector-origin (MCP) tool
 * schemas are withheld from the LLM request unless the conversation has
 * already discovered or used them — the `tool_search` meta-tool activates
 * gated tools on demand. Execution is never gated by pruning: a gated tool
 * called by name still runs. `keepTools` entries are exact tool names, or
 * prefixes when the entry ends with `*` (e.g. `mcp__composio__GMAIL_*`).
 */
const ToolPruningSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "When true (default), MCP/connector tool schemas are pruned from LLM requests and discovered on demand via the tool_search meta-tool. Set false for an instant rollback to sending every tool schema on every call.",
      ),
    keepTools: z
      .array(z.string())
      .default([])
      .describe(
        "Tool names that are always kept on the wire even when pruning is enabled. Exact names, or prefix patterns ending in `*`.",
      ),
  })
  .describe("Per-turn LLM tool-schema pruning configuration");

export type ToolPruningConfig = z.infer<typeof ToolPruningSchema>;

/**
 * Flash-tier routing for structurally trivial mainAgent turns.
 *
 * When enabled, a turn that passes a purely structural classifier (short
 * user text, no attachments, no recent tool activity — see
 * `agent/flash-tier.ts`) is sent to a designated cheaper/faster model
 * instead of the mainAgent model. The flash call still carries the full
 * (pruned) tool set and the unchanged system prompt, so a misclassified
 * turn degrades to "same turn on a cheaper model", never a broken turn.
 * Default OFF — flip `llm.flashTier.enabled` only with eval numbers in hand.
 */
const FlashTierSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "When true, structurally trivial mainAgent turns are routed to the flash-tier model. Default false (no behavior change).",
      ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Model id for flash-tier turns. Must be servable by the mainAgent provider (the transport is not re-routed). When unset, falls back to the resolved flash call-site model (conversationTitle's resolution, which honors CUE_OPENROUTER_FLASH_MODEL on self-host).",
      ),
    maxUserChars: z
      .number()
      .int()
      .positive()
      .default(280)
      .describe(
        "Maximum length (characters) of the user's own text — runtime injections excluded — for a turn to qualify as trivial.",
      ),
  })
  .describe(
    "Flash-tier routing of structurally trivial turns to a cheaper/faster model",
  );

export type FlashTierConfig = z.infer<typeof FlashTierSchema>;

/**
 * Vision-tier routing for image-bearing agent rounds.
 *
 * When enabled (the default), a round whose request payload carries image
 * blocks AND whose resolved model is known text-only in the model catalog is
 * pinned to a vision-capable model instead (see `agent/vision-tier.ts` for
 * the model resolution order: this config's `model`, else the resolved
 * `cueLiveVision` call-site model, else an OpenRouter default). Tools,
 * system prompt, and transport are unchanged — only the model id.
 *
 * Default ON, unlike flash-tier: the alternative to routing is a hard
 * provider error ("This model doesn't support image input"), so opting out
 * must be the explicit choice.
 */
const VisionTierSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "When true (default), image-bearing rounds that resolved to a known text-only model are routed to the vision-tier model. Set false to always keep the resolved model (image turns on a text-only model will fail).",
      ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Model id for image-bearing rounds. Must be servable by the turn's resolved provider (the transport is not re-routed). When unset, falls back to the resolved cueLiveVision call-site model, then to a proven OpenRouter vision default.",
      ),
  })
  .describe(
    "Vision-tier routing of image-bearing rounds to a vision-capable model",
  );

export type VisionTierConfig = z.infer<typeof VisionTierSchema>;

/**
 * Advisor escalation (WS-B): before the main brain commits a high-stakes or
 * uncertain action, consult a stronger model for a second opinion and feed the
 * critique back into the loop before executing.
 *
 * The gate is SELECTIVE (see `agent/advisor.ts`): it fires only on a
 * tool-bearing round that either (a) proposes a high-stakes / destructive tool
 * or (b) carries explicit uncertainty in the assistant's own text — and never
 * more than `maxConsultsPerTurn` times per turn, so the extra round-trip is
 * bounded. A consult that errors or returns nothing fails OPEN: the round runs
 * exactly as it would have without the advisor.
 *
 * The advisor model is routed via the per-call `config.model` override (the
 * same mechanism as flash/vision-tier), so the advisor call runs on the
 * mainAgent transport but a different model. `CUE_ADVISOR_MODEL` env-overrides
 * `model` for self-host operators.
 *
 * Default ON with a bounded consult budget: the whole point is to catch a bad
 * irreversible action before it runs, so it must be on by default, but the
 * cost bound keeps a runaway turn from consulting on every round.
 */
const AdvisorSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "When true (default), high-stakes or uncertain tool-bearing rounds consult the advisor model before executing. Set false to disable the second-opinion escalation entirely.",
      ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Model id for the advisor consult. Overridden by the CUE_ADVISOR_MODEL env var; when neither is set, defaults to moonshotai/kimi-k3. Should be a stronger model than the main brain and servable by the mainAgent provider (the transport is not re-routed).",
      ),
    fallbackModel: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Model id tried when the primary advisor model errors. Defaults to z-ai/glm-5.2. Set to the empty case (unset) to disable the fallback.",
      ),
    consultOnDestructiveTools: z
      .boolean()
      .default(true)
      .describe(
        "When true (default), a round that proposes a high-stakes/destructive tool (defaultRiskLevel === 'high') triggers a consult.",
      ),
    consultOnUncertainty: z
      .boolean()
      .default(true)
      .describe(
        "When true (default), a tool-bearing round whose assistant text expresses explicit uncertainty (hedging/low-confidence language) triggers a consult.",
      ),
    uncertaintyMarkers: z
      .array(z.string().min(1))
      .default([
        "i'm not sure",
        "i am not sure",
        "i'm not certain",
        "i am not certain",
        "not entirely sure",
        "not entirely certain",
        "i'm unsure",
        "hard to say",
        "difficult to say",
        "it's unclear",
        "it is unclear",
        "i could be wrong",
        "i might be wrong",
        "no guarantee",
        "double-check",
        "double check",
        "please verify",
        "you should verify",
        "not confident",
        "low confidence",
      ])
      .describe(
        "Lowercased substrings that, when found in the assistant's own text, count as explicit uncertainty (a low-confidence proxy — the provider gives no numeric confidence).",
      ),
    maxConsultsPerTurn: z
      .number()
      .int()
      .positive()
      .default(2)
      .describe(
        "Hard cap on advisor consults per user turn. Bounds the extra latency/cost of the escalation; once reached, later rounds skip the gate.",
      ),
    idleTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(20_000)
      .describe(
        "Abort the consult after this many ms with no streamed token (a reasoning advisor spends most of its window thinking, so this is idle-based, not wall-clock).",
      ),
    maxTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(90_000)
      .describe(
        "Absolute backstop for a single consult, independent of streaming progress.",
      ),
  })
  .describe(
    "Advisor escalation: consult a stronger model before committing high-stakes/uncertain actions",
  );

export type AdvisorConfig = z.infer<typeof AdvisorSchema>;

export const LLMSchema = z
  .object({
    default: LLMConfigBase.default(LLMConfigBase.parse({})),
    toolPruning: ToolPruningSchema.default(ToolPruningSchema.parse({})),
    flashTier: FlashTierSchema.default(FlashTierSchema.parse({})),
    visionTier: VisionTierSchema.default(VisionTierSchema.parse({})),
    advisor: AdvisorSchema.default(AdvisorSchema.parse({})),
    profiles: z.record(z.string().min(1), ProfileEntry).default({}),
    // Presentation-only order for named profiles. The resolver ignores this;
    // clients use it to render profile pickers consistently.
    profileOrder: z.array(z.string().min(1)).default([]),
    // `partialRecord` (vs `record`) makes call-site keys optional while still
    // rejecting keys that aren't members of `LLMCallSiteEnum` — exactly the
    // behavior we want (typo detection without requiring callers to declare
    // every call site). Latency-optimized defaults for background call sites
    // are seeded into the user's on-disk config by migration 040, not at
    // schema level, so `LLMSchema.parse({})` yields an empty map.
    callSites: z.partialRecord(LLMCallSiteEnum, LLMCallSiteConfig).default({}),
    activeProfile: z.string().min(1).optional(),
    // TTL bounds for inference profile sessions. `defaultTtlSeconds` is read by
    // the CLI to apply when `--ttl` is omitted; the daemon handler itself only
    // reads `maxTtlSeconds` (to clamp caller-supplied values).
    profileSession: z
      .object({
        defaultTtlSeconds: z.number().int().min(1).default(1800),
        maxTtlSeconds: z.number().int().min(1).default(43200),
      })
      .default({ defaultTtlSeconds: 1800, maxTtlSeconds: 43200 }),
    pricingOverrides: z.array(PricingOverrideSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const profileNames = new Set(Object.keys(config.profiles ?? {}));
    for (const [siteId, siteConfig] of Object.entries(config.callSites ?? {})) {
      if (siteConfig?.profile == null) continue;
      if (!profileNames.has(siteConfig.profile)) {
        ctx.addIssue({
          code: "custom",
          path: ["callSites", siteId, "profile"],
          message: `Profile "${siteConfig.profile}" referenced by call site "${siteId}" is not defined in llm.profiles`,
        });
      }
    }
    if (
      config.activeProfile != null &&
      !profileNames.has(config.activeProfile)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["activeProfile"],
        message: `Profile "${config.activeProfile}" referenced by llm.activeProfile is not defined in llm.profiles`,
      });
    }

    // --- Mix profile validation --------------------------------------------
    // Config keys a mix profile must NOT also set (a mix only references other
    // profiles + metadata). Derived from the fragment shape plus the
    // ProfileEntry-only `provider_connection` so it can't drift if a new config
    // field is added to `LLMConfigFragment`.
    const MIX_DISALLOWED_CONFIG_KEYS = [
      ...Object.keys(LLMConfigFragment.shape),
      "provider_connection",
    ];
    const mixProfileNames = new Set(
      Object.entries(config.profiles ?? {})
        .filter(([, profile]) => profile?.mix != null)
        .map(([name]) => name),
    );
    for (const [name, profile] of Object.entries(config.profiles ?? {})) {
      if (profile?.mix == null) continue;
      // (d) A mix must not also carry model config — the resolved config comes
      // entirely from the chosen constituent.
      for (const key of MIX_DISALLOWED_CONFIG_KEYS) {
        if ((profile as Record<string, unknown>)[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", name, key],
            message: `Mix profile "${name}" cannot also set "${key}" — a mix only references other profiles plus metadata (label, description, status).`,
          });
        }
      }
      for (const [index, arm] of profile.mix.entries()) {
        // (c) No self-reference.
        if (arm.profile === name) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", name, "mix", index, "profile"],
            message: `Mix profile "${name}" cannot reference itself.`,
          });
          continue;
        }
        // (a) Referenced profile must exist.
        if (!profileNames.has(arm.profile)) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", name, "mix", index, "profile"],
            message: `Mix profile "${name}" references profile "${arm.profile}" which is not defined in llm.profiles.`,
          });
          continue;
        }
        // (b) No nesting — a mix arm must be a standard (non-mix) profile.
        if (mixProfileNames.has(arm.profile)) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", name, "mix", index, "profile"],
            message: `Mix profile "${name}" references another mix profile "${arm.profile}" — mixes cannot be nested; constituents must be standard profiles.`,
          });
        }
      }
    }
  });

export type LLMConfig = z.infer<typeof LLMSchema>;
