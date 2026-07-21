import { type LLMCallSite } from "./schemas/llm.js";

type CallSiteDefaultConfig = {
  profile: string;
  maxTokens?: number;
  effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  temperature?: number | null;
  thinking?: { enabled?: boolean; streamThinking?: boolean };
  contextWindow?: { maxInputTokens?: number };
  /**
   * Opt the call site out of prompt caching. Set for one-shot call sites
   * whose prompts never repeat — or repeat slower than the cache TTL — so
   * each call would pay the cache-write premium without a future read.
   * Telemetry confirms ~0–5% cache hit rates on these sites.
   */
  disableCache?: boolean;
};

export const CALL_SITE_DEFAULTS: Record<LLMCallSite, CallSiteDefaultConfig> = {
  mainAgent: { profile: "balanced" },
  // One-shot screenshot → answer; the prompt never repeats, so caching would
  // only ever pay the write premium.
  cueLiveVision: { profile: "balanced", disableCache: true },
  // The advisor's actual model is pinned per-call by `agent/advisor.ts`
  // (resolveAdvisorModel), so this profile is only a transport fallback. Each
  // consult is a unique one-shot prompt, so caching would only pay the write
  // premium.
  advisor: { profile: "balanced", disableCache: true },
  // Cue Live's front-model presence layer (WS-E): a one-bit endpoint decision
  // or a one-shot ack phrasing on the end-of-turn hot path. Cost-optimized for
  // latency, low output budget, and never cached (each prompt is unique).
  voiceFrontDecision: {
    profile: "cost-optimized",
    maxTokens: 64,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    temperature: 0,
    disableCache: true,
  },
  subagentSpawn: { profile: "balanced" },
  compactionAgent: { profile: "balanced" },
  analyzeConversation: { profile: "balanced" },
  patternScan: { profile: "balanced" },
  narrativeRefinement: { profile: "balanced" },
  callAgent: { profile: "balanced" },
  memoryConsolidation: { profile: "balanced", disableCache: true },
  identityIntro: { profile: "balanced" },
  emptyStateGreeting: { profile: "balanced" },

  memoryRouter: {
    profile: "cost-optimized",
    contextWindow: { maxInputTokens: 1000000 },
  },
  memoryV3SelectL2: { profile: "balanced", temperature: 0 },
  recall: {
    profile: "balanced",
    maxTokens: 4096,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    temperature: 0,
    disableCache: true,
  },
  conversationStarters: {
    profile: "balanced",
    effort: "low",
    thinking: { enabled: false },
  },

  filingAgent: { profile: "cost-optimized" },
  memoryExtraction: { profile: "cost-optimized" },
  // Structured recap of a meeting transcript via a forced tool call — match
  // the proven cost-optimized forced-tool path that memoryExtraction uses.
  meetingRecap: {
    profile: "cost-optimized",
    thinking: { enabled: false },
    disableCache: true,
  },
  memoryRetrieval: { profile: "cost-optimized" },
  memoryRetrospective: { profile: "cost-optimized" },
  memoryV2Migration: { profile: "cost-optimized" },
  memoryV2Sweep: { profile: "cost-optimized" },
  memoryV2Consolidation: { profile: "balanced" },
  conversationSummarization: { profile: "cost-optimized" },
  conversationTitle: { profile: "cost-optimized", disableCache: true },
  approvalCopy: { profile: "cost-optimized" },
  approvalConversation: { profile: "cost-optimized" },
  trustRuleSuggestion: { profile: "cost-optimized" },
  styleAnalyzer: { profile: "cost-optimized" },
  meetConsentMonitor: { profile: "cost-optimized" },
  meetChatOpportunity: { profile: "cost-optimized" },
  inference: { profile: "cost-optimized" },

  heartbeatAgent: {
    profile: "cost-optimized",
  },
  commitMessage: {
    profile: "cost-optimized",
    maxTokens: 120,
    temperature: 0.2,
    effort: "low",
    thinking: { enabled: false },
  },
  replySuggestion: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
    disableCache: true,
  },
  guardianQuestionCopy: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  notificationDecision: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  preferenceExtraction: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  interactionClassifier: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  inviteInstructionGenerator: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  skillCategoryInference: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  homeGreeting: {
    profile: "cost-optimized",
    maxTokens: 60,
    effort: "low",
    thinking: { enabled: false },
    temperature: 0.7,
    disableCache: true,
  },
  homeSuggestedPrompts: {
    profile: "cost-optimized",
    maxTokens: 512,
    effort: "low",
    thinking: { enabled: false },
    disableCache: true,
  },
  // Triage/synthesis of inbox + calendar into action items. Uses a forced
  // tool call for structured output, so thinking is explicitly disabled
  // (extended thinking is incompatible with forced tool_choice and would be
  // stripped anyway) and we match the proven cost-optimized path that other
  // forced-tool call sites (e.g. memoryExtraction) use reliably.
  actionBoard: {
    profile: "cost-optimized",
    maxTokens: 4096,
    thinking: { enabled: false },
    disableCache: true,
  },
  // Reply drafting — quality of writing matters, so use the balanced profile.
  // Plain-text completion (no forced tool), so thinking is fine at the
  // profile default.
  autoDraft: {
    profile: "balanced",
    maxTokens: 1024,
    disableCache: true,
  },
  // A Home action item dispatched to run in the background as its own agent
  // turn (research/draft work). It's a full agentic loop, so use the balanced
  // profile — capable enough to use tools and complete the task.
  homeAction: {
    profile: "balanced",
  },
};
