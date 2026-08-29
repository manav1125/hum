/**
 * Conversation — thin coordinator that delegates to extracted modules.
 *
 * Each concern lives in its own file:
 * - conversation-lifecycle.ts    — loadFromDb, abort, dispose
 * - conversation-messaging.ts    — enqueueMessage, persistUserMessage, redirectToSecurePrompt
 * - conversation-agent-loop.ts   — runAgentLoop, generateTitle
 * - conversation-notifiers.ts    — call notifier registration
 * - conversation-tool-setup.ts   — tool definitions, executor, resolveTools callback
 * - conversation-media-retry.ts  — media trimming + raceWithTimeout
 * - conversation-process.ts      — drainQueue, processMessage
 * - conversation-history.ts      — undo, consolidateAssistantMessages
 * - conversation-surfaces.ts     — handleSurfaceAction, handleSurfaceUndo
 * - conversation-workspace.ts    — refreshWorkspaceTopLevelContext
 * - conversation-usage.ts        — recordUsage
 */

import type { AgentLoopConfig, ResolvedSystemPrompt } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import { resolveModelRouteForTurn } from "../agent/vision-tier.js";
import type { AssistantActivityStateEvent } from "../api/events/assistant-activity-state.js";
import type {
  ChannelId,
  InterfaceId,
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { parseChannelId, parseInterfaceId } from "../channels/types.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import {
  contextWindowConfigFromEffective,
  resolveEffectiveContextWindow,
} from "../config/llm-context-resolution.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite, Speed } from "../config/schemas/llm.js";
import { EventBus } from "../events/bus.js";
import type { AssistantDomainEvents } from "../events/domain-events.js";
import { createToolAuditListener } from "../events/tool-audit-listener.js";
import { createToolDomainEventPublisher } from "../events/tool-domain-event-publisher.js";
import { registerToolMetricsLoggingListener } from "../events/tool-metrics-listener.js";
import { registerToolPermissionTelemetryListener } from "../events/tool-permission-telemetry-listener.js";
import {
  registerToolProfilingListener,
  ToolProfiler,
} from "../events/tool-profiling-listener.js";
import { registerToolTraceListener } from "../events/tool-trace-listener.js";
import { resolveCanonicalGuardianRequest } from "../memory/canonical-guardian-store.js";
import {
  getConversation,
  getMessages,
  type MessageRow,
  resolveOverrideProfile,
  setConversationHistoryStrippedAt,
  setConversationProcessingStartedAt,
} from "../memory/conversation-crud.js";
import { getResolvedConversationDirPath } from "../memory/conversation-directories.js";
import { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import { unwrapMemoryBlock, wrapMemoryBlock } from "../memory/memory-marker.js";
import { classifyRisk } from "../permissions/checker.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { SecretPrompter } from "../permissions/secret-prompter.js";
import { RiskLevel, type UserDecision } from "../permissions/types.js";
import { defaultCompact } from "../plugins/defaults/compaction/compact.js";
import {
  createContextWindowManager,
  getContextWindowManager,
} from "../plugins/defaults/compaction/manager-store.js";
import {
  type ContextWindowManager,
  type ContextWindowResult,
  createContextSummaryMessage,
} from "../plugins/defaults/compaction/window-manager.js";
import { repairHistory } from "../plugins/defaults/history-repair/terminal.js";
import {
  getPrunedSlugs,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
} from "../plugins/defaults/memory-v3-shadow/ever-injected-store.js";
import { filterPrunedCardSections } from "../plugins/defaults/memory-v3-shadow/prune.js";
import {
  applyBootstrapTemplate,
  buildSystemPrompt,
  type SystemPromptPersonaOverride,
} from "../prompts/system-prompt.js";
import type { ContentBlock, Message } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import {
  isUntrustedTrustClass,
  type TrustClass,
} from "../runtime/actor-trust-resolver.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import type { AuthContext } from "../runtime/auth/types.js";
import type { InteractiveUiResult } from "../runtime/interactive-ui.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import {
  type ActivationMomentParam,
  isActivationMomentParam,
} from "../telemetry/activation-funnel.js";
import { ToolExecutor } from "../tools/executor.js";
import { getAllToolDefinitions, getTool } from "../tools/registry.js";
import type { ToolPruningScanCache } from "../tools/tool-pruning.js";
import type { ToolLifecycleEvent } from "../tools/types.js";
import type { OnboardingContext } from "../types/onboarding-context.js";
import type { AbortReason } from "../util/abort-reasons.js";
import { UserError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type { WorkspaceGitService } from "../workspace/git-service.js";
import type { commitTurnChanges } from "../workspace/turn-commit.js";
import type { AssistantAttachmentDraft } from "./assistant-attachments.js";
import type { AssistantSurface } from "./conversation-agent-loop.js";
import {
  applyCompactionResult,
  runAgentLoopImpl,
} from "./conversation-agent-loop.js";
import type { HistoryConversationContext } from "./conversation-history.js";
import { undo as undoImpl } from "./conversation-history.js";
import {
  abortConversation,
  disposeConversation,
  reinjectImageSourcePaths,
  rescueLeakedProcessing,
} from "./conversation-lifecycle.js";
import type {
  EnqueueMessageOptions,
  PersistMessageOptions,
  RedirectToSecurePromptOptions,
} from "./conversation-messaging.js";
import {
  enqueueMessage as enqueueMessageImpl,
  persistUserMessage as persistUserMessageImpl,
  redirectToSecurePrompt as redirectToSecurePromptImpl,
} from "./conversation-messaging.js";
// Extracted modules
import { registerConversationNotifiers } from "./conversation-notifiers.js";
import type { ProcessMessageOptions } from "./conversation-process.js";
import {
  drainQueue as drainQueueImpl,
  processMessage as processMessageImpl,
} from "./conversation-process.js";
import type { QueueDrainReason } from "./conversation-queue-manager.js";
import { MessageQueue } from "./conversation-queue-manager.js";
import {
  type ChannelCapabilities,
  getSlackCompactionWatermarkForPrefix,
  getSlackWatermarkAdvanceForRowPrefix,
  type InboundActorContext,
  loadSlackChronologicalContext,
  stripInjectionsForCompaction,
} from "./conversation-runtime-assembly.js";
import type { SkillProjectionCache } from "./conversation-skill-tools.js";
import {
  createSurfaceMutex,
  flushPendingSurfaceDataPersists,
  handleSurfaceAction as handleSurfaceActionImpl,
  handleSurfaceUndo as handleSurfaceUndoImpl,
  type SurfaceActionResult,
} from "./conversation-surfaces.js";
import type {
  SubagentToolGateMode,
  ToolSetupContext,
  WakeToolContextPin,
} from "./conversation-tool-setup.js";
import {
  createResolveToolsCallback,
  createToolExecutor,
} from "./conversation-tool-setup.js";
import { canonicalizeTimeZone } from "./date-context.js";
import { HostAppControlProxy } from "./host-app-control-proxy.js";
import { HostCuProxy } from "./host-cu-proxy.js";
import { shouldAttachHostProxyForCapability } from "./host-proxy-preactivation.js";
import type {
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UsageStats,
} from "./message-protocol.js";
import { filterMessagesForUntrustedActor } from "./message-provenance.js";
import type { ConversationTransportMetadata } from "./message-types/conversations.js";
import { isHostProxyTransport } from "./message-types/conversations.js";
import type { ConfirmationStateChanged } from "./message-types/messages.js";
import { conversationMetadataSyncTag } from "./message-types/sync.js";
import { resolveSummarizeBoundary } from "./summarize-boundary.js";
import { TraceEmitter } from "./trace-emitter.js";

const log = getLogger("conversation");

/**
 * Shell tools whose REAL risk is per-invocation: their static
 * `defaultRiskLevel` is only Medium because a command's risk (`rm -rf …` vs
 * `ls`) is judged per-command by the gateway's classifier at execution, not by
 * static tool metadata. The advisor gate classifies these proposed commands so
 * their high-risk invocations trip the destructive signal. Matches the
 * bash/host_bash branch of `buildClassifyRiskParams`.
 */
const PER_COMMAND_RISK_TOOLS = new Set(["bash", "host_bash"]);

function isPerCommandRiskTool(toolName: string): boolean {
  return PER_COMMAND_RISK_TOOLS.has(toolName);
}

export interface CleanResult {
  previousEstimatedInputTokens: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  preservedMessages: number;
}

/**
 * First text block of a persisted message row's content, mirroring
 * `loadFromDb`'s parse: non-JSON / non-array content loads as a single text
 * block holding the raw string. Returns null when the row's block array has
 * no text block. Used to verify the row→history boundary mapping in
 * {@link Conversation.summarizeUpToMessage}.
 */
function firstPersistedTextBlockText(content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const block = parsed.find(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      );
      return block?.text ?? null;
    }
  } catch {
    // Non-JSON content loads as a raw text block.
  }
  return content;
}

/**
 * Row-addressed view of the in-memory history a {@link Conversation.loadFromDb}
 * pass just built, for callers that need to translate a persisted row position
 * into a `messages` index (e.g. "summarize up to here").
 */
export interface LoadFromDbResult {
  /** Full persisted row set the load read (before any trust filtering). */
  rows: MessageRow[];
  /**
   * Persisted-row index (into `rows`) → index into the conversation's
   * `messages`, folding in the compacted-prefix slice, injection-strip drops,
   * history-repair merges/insertions, and the prepended summary message.
   * Per-row `null` when the row has no in-memory counterpart (behind the
   * compacted boundary, or dropped by the pre-clean injection strip); `null`
   * overall when the load was trust-filtered (a filtered view has no stable
   * row↔history correspondence). Valid only until the conversation next
   * mutates — turns append to `messages` without updating any mapping.
   */
  rowToHistoryIndex: (number | null)[] | null;
}

/**
 * Optional context-window sizing inputs for {@link Conversation.maybeCompact}.
 *
 * The auto-threshold gate sizes its window against `mainAgent` by default,
 * but an agent wake can run under a different call site (and a forced
 * override profile) that resolves a SMALLER effective window — sized against
 * `mainAgent`, such a wake passes the gate un-compacted and then overflows at
 * the provider. Wakes thread their already-resolved inputs here so the gate's
 * threshold matches the window the wake's calls actually get. Sizing only:
 * the compaction execution (summary call profile) is unchanged.
 */
export interface CompactionSizing {
  /** Call site the upcoming run resolves its context window against. */
  callSite: LLMCallSite;
  /** Inference profile the run resolves under, if any. */
  overrideProfile?: string;
  /** Float `overrideProfile` above the call-site layers (resolver escape hatch). */
  forceOverrideProfile?: boolean;
}

export { findLastUndoableUserMessageIndex } from "./conversation-history.js";
export type {
  QueueDrainReason,
  QueuePolicy,
} from "./conversation-queue-manager.js";
import {
  INTERNAL_GUARDIAN_TRUST_CONTEXT,
  isPersonalMemoryAllowed,
  type TrustContext,
} from "./trust-context.js";

export interface ConversationConstructorOptions {
  maxTokens?: number;
  speedOverride?: Speed;
  cacheTtl?: "5m" | "1h";
  modelOverride?: string;
}

export class Conversation {
  public readonly conversationId: string;
  /** @internal */ provider: Provider;
  /** @internal */ messages: Message[] = [];
  /** @internal */ agentLoop: AgentLoop;
  private _processing = false;
  /** Epoch-ms when `_processing` last flipped false→true; null while idle. */
  private _processingSince: number | null = null;
  /**
   * Number of agent-loop runs currently executing for this conversation
   * (normally 0 or 1). The stale-processing sweep uses this to distinguish
   * a genuinely busy conversation from one whose `_processing` flag leaked
   * past a failed teardown — only the latter may be force-cleared.
   */
  private _activeAgentRunCount = 0;
  private stale = false;
  /** @internal */ abortController: AbortController | null = null;
  /** @internal */ prompter: PermissionPrompter;
  /** @internal */ secretPrompter: SecretPrompter;
  private executor: ToolExecutor;
  /** @internal */ profiler: ToolProfiler;
  /** @internal */ sendToClient: (msg: ServerMessage) => void;
  /** @internal */ eventBus = new EventBus<AssistantDomainEvents>();
  /** @internal */ workingDir: string;
  /** @internal */ allowedToolNames?: Set<string>;
  /**
   * Durable copy of the full tool set resolved on the most recent turn,
   * kept for read-only inventory queries. Unlike {@link allowedToolNames}
   * — the per-turn execution gate the agent loop clears at turn teardown —
   * this survives between turns so a query against an idle conversation
   * still reports the skill/MCP tools it gained over its lifecycle.
   * @internal
   */
  lastResolvedToolNames?: Set<string>;
  /** @internal */ diskPressureCleanupModeActive?: boolean;
  /** @internal */ toolsDisabledDepth = 0;
  /** @internal */ preactivatedSkillIds?: string[];
  /** @internal */ subagentAllowedTools?: Set<string>;
  /**
   * Guardrails agent tool-scope filter — set by the work-item runner on
   * background run conversations whose agent has `tool_scopes`. Tools
   * failing the predicate are dropped from the wire tool definitions and
   * rejected at execution time (see guardrails/agent-tool-scopes.ts).
   * @internal
   */
  toolScopeFilter?: (toolName: string) => boolean;
  /**
   * How {@link subagentAllowedTools} is enforced — see
   * {@link SubagentToolGateMode}. Set and restored alongside the allowlist
   * by `scopeWakeAllowedTools`.
   * @internal
   */
  subagentToolGateMode?: SubagentToolGateMode;
  /**
   * Client-context pin for execution-gate-mode wakes — see
   * {@link WakeToolContextPin}. Set and restored alongside the allowlist by
   * `scopeWakeAllowedTools`; read only by tool-DEFINITION resolution
   * (`isToolActiveForContext`), never by executor or host-proxy paths.
   * @internal
   */
  toolContextPin?: WakeToolContextPin;
  /** @internal */ coreToolNames: Set<string>;
  /** @internal */ readonly skillProjectionState = new Map<string, string>();
  /** @internal */ readonly skillProjectionCache: SkillProjectionCache = {};
  /**
   * Incremental history-scan cache for wire tool pruning — see
   * `tools/tool-pruning.ts`. Conversation-scoped, like
   * {@link skillProjectionCache}.
   * @internal
   */
  readonly toolPruningScanCache: ToolPruningScanCache = {
    messageCount: 0,
    firstMessage: undefined,
    names: new Set<string>(),
  };
  /**
   * Sticky set of connector tools activated by this conversation (via
   * `tool_search` markers or direct calls) so wire pruning keeps them
   * visible across compaction for the conversation's in-memory lifetime.
   * @internal
   */
  readonly wireLoadedToolNames = new Set<string>();
  /** @internal */ usageStats: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
  };
  /** @internal */ readonly systemPrompt: string;
  /** @internal */ contextCompactedMessageCount = 0;
  /** @internal */ contextCompactedAt: number | null = null;
  /** @internal */ contextSummary: string | null = null;
  /** @internal */ slackContextCompactionWatermarkTs: string | null = null;
  /** @internal */ lastNotifiedInferenceProfile: string | null = null;
  /**
   * Per-conversation inference-profile override mirrored from the DB row.
   * `inferenceProfileSessionId`/`inferenceProfileExpiresAt` are set when the
   * override is session-backed (expiring); both are null for a sticky
   * override or when no override is active. Hydrated on load and kept in sync
   * by the HTTP setters and the background expiry reaper so the live instance
   * is the single source of truth for the per-turn override derivation.
   * @internal
   */
  inferenceProfile: string | null = null;
  /** @internal */ inferenceProfileSessionId: string | null = null;
  /** @internal */ inferenceProfileExpiresAt: number | null = null;
  /** @internal */ currentRequestId?: string;
  /**
   * The {@link LLMCallSite} of the in-flight turn, set at turn start from
   * `options?.callSite ?? "mainAgent"`. Lets the per-turn plugin context tell
   * the main reply apart from background agent-loop work (compaction,
   * subagents, …) on this same conversation. Per-turn mutable, mirroring
   * {@link currentRequestId}.
   * @internal
   */
  currentCallSite?: LLMCallSite;
  /** @internal */ hasNoClient = false;
  /** @internal */ isSubagent = false;
  /** @internal */ headlessLock = false;
  /** @internal */ taskRunId?: string;
  /** @internal */ callSessionId?: string;
  /** @internal */ hostCuProxy?: HostCuProxy;
  /**
   * Per-conversation host app-control proxy. Set via
   * `setHostAppControlProxy` and disposed in `dispose()`. The
   * `/v1/host-app-control-result` route forwards result payloads to the
   * awaiting promise via this reference.
   * @internal
   */
  hostAppControlProxy?: HostAppControlProxy;
  /** @internal */ readonly queue = new MessageQueue();
  /** @internal */ currentActiveSurfaceId?: string;
  /** @internal */ currentPage?: string;
  /** @internal */ channelCapabilities?: ChannelCapabilities;
  /** @internal */ trustContext?: TrustContext;
  /**
   * Per-turn snapshots of persona-relevant context, captured at the start of
   * each message processing turn. The system prompt callback reads these
   * instead of the live fields so that a concurrent request cannot swap
   * another actor's persona mid-turn.
   */
  /** @internal */ currentTurnTrustContext?: TrustContext;
  /**
   * The model-facing inbound actor context resolved once at turn start from
   * {@link currentTurnTrustContext}. Frozen here because resolving it reads the
   * live contact/member registry (member status/policy, contact notes,
   * interaction count), which a contact tool or the guardian can mutate
   * mid-turn; post-compaction re-injection reads this snapshot so it re-emits
   * the actor context the turn's initial assembly saw rather than re-resolving
   * against drifted registry state. `null` on guardian turns and when there is
   * no trust context (the actor section is suppressed).
   * @internal
   */
  currentTurnInboundActorContext?: InboundActorContext | null;
  /** @internal */ currentTurnChannelCapabilities?: ChannelCapabilities;
  /**
   * Explicit persona/channel slugs for the system-prompt build, set (and
   * cleared) by `wakeAgentForOpportunity` around a wake's agent-loop run.
   * Wakes bypass the orchestrator's turn-start snapshots above, so without
   * this their prompt is built from whatever snapshot the conversation
   * already holds (for a freshly hydrated conversation: the no-trust-context
   * persona derivation) regardless of which actor/channel the conversation
   * belongs to. Takes precedence over the trust-context derivation when set.
   * Persona selection only — never read for trust/approval decisions.
   * @internal
   */
  wakePersonaOverride?: SystemPromptPersonaOverride;
  /**
   * Identity of the roster agent this conversation belongs to, set from the
   * persisted binding on every hydration. Rebuilt into the system prompt each
   * turn so the agent keeps being that agent across a long thread and across
   * a restart, rather than only for the run that created it.
   */
  agentCharter?: string;
  /** @internal */ currentTurnOverrideProfile?: string;
  /** @internal */ toolRoutedProfile?: string;
  /** @internal */ authContext?: AuthContext;
  /** @internal */ currentTurnAuthContext?: AuthContext;
  /** @internal */ currentTurnSourceActorPrincipalId?: string;
  /** @internal */ loadedHistoryTrustClass?: TrustClass;
  /** @internal */ loadedHistoryPersonalMemoryAllowed?: boolean;
  /** @internal */ voiceCallControlPrompt?: string;
  /** @internal */ transportHints?: string[];
  /**
   * Optional workspace-git seams, overridable in tests to stub the git
   * initializer and turn-commit behavior. Default to the real
   * implementations in the agent loop when unset.
   * @internal
   */
  getWorkspaceGitService?: (
    workspaceDir: string,
  ) => Pick<WorkspaceGitService, "ensureInitialized">;
  /** @internal */ commitTurnChanges?: typeof commitTurnChanges;
  /**
   * The conversation's immutable creation type (`interactive`, `background`,
   * `scheduled`, …) as stored on the DB row. Cached on load (and set directly
   * for subagent conversations) so the runtime-assembly path can derive the
   * background-turn flag from live state without a per-injection DB read.
   * @internal
   */
  conversationType?: string;
  /**
   * The conversation's creation source (`user`, …) as stored on the DB row,
   * cached on load so the runtime-assembly and disk-pressure paths can read it
   * from live state without a per-turn DB row read.
   * @internal
   */
  source?: string;
  /** @internal */ assistantId?: string;
  /** @internal */ commandIntent?: {
    type: string;
    payload?: string;
    languageCode?: string;
  };
  /** @internal */ surfaceActionRequestIds = new Set<string>();
  /** @internal */ approvedViaPromptThisTurn = false;
  /**
   * Set by `steerToMessage` to signal the drain path that it should inject
   * synthetic tool_result messages for any pending tool_use blocks abandoned
   * by the aborted generation. Cleared after repair.
   * @internal
   */
  pendingSteerRepair = false;
  /**
   * When true, side-effect tools must prompt even if a trust/allow rule
   * would auto-allow. Set by non-interactive callers (e.g. non-guardian
   * phone voice) so their auto-deny handler reliably sees a
   * `confirmation_request` event. See ToolSetupContext.forcePromptSideEffects.
   * @internal
   */
  forcePromptSideEffects = false;
  /** @internal */ pendingSurfaceActions = new Map<
    string,
    { surfaceType: SurfaceType }
  >();
  /** @internal */ lastSurfaceAction = new Map<
    string,
    { actionId: string; data?: Record<string, unknown> }
  >();
  /** @internal */ surfaceState = new Map<
    string,
    {
      surfaceType: SurfaceType;
      data: SurfaceData;
      title?: string;
      actions?: Array<{
        id: string;
        label: string;
        style?: string;
        data?: Record<string, unknown>;
      }>;
      /**
       * Commit-timing activation-rail tag (daemon-only). Rehydrated by
       * `restoreSurfaceStateFromHistory` so a post-reload commit still records
       * its funnel milestone. Never sent to the client.
       */
      activationMoment?: ActivationMomentParam;
    }
  >();
  /** @internal */ surfaceUndoStacks = new Map<string, string[]>();
  /** @internal */ accumulatedSurfaceState = new Map<
    string,
    Record<string, unknown>
  >();
  /**
   * Pending standalone UI requests keyed by surfaceId.
   * Daemon-driven surfaces that block the caller until user response or timeout.
   * @internal
   */
  pendingStandaloneSurfaces = new Map<
    string,
    {
      resolve: (result: InteractiveUiResult) => void;
      timer: ReturnType<typeof setTimeout>;
      surfaceType: SurfaceType;
    }
  >();
  /**
   * Short-lived tombstone set of recently-completed standalone surface IDs.
   * Prevents late client actions from falling through to the LLM path.
   * @internal
   */
  recentlyCompletedStandaloneSurfaces = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** @internal */ withSurface = createSurfaceMutex();
  /** @internal */ currentTurnSurfaces: AssistantSurface[] = [];
  /** @internal */ workspaceTopLevelContext: string | null = null;
  /** @internal */ workspaceTopLevelDirty = true;
  /**
   * Host home directory reported by the client (e.g. macOS
   * `NSHomeDirectory()`). Populated from `HostProxyTransportMetadata` when
   * a message arrives from an interface that supports host-proxy tools
   * (see `supportsHostProxy`). Consumed by the `<workspace>` block renderer
   * so platform-managed (containerized) daemons show the user's actual
   * client-side home dir instead of the container's `os.homedir()`.
   * @internal
   */
  hostHomeDir?: string;
  /**
   * Host username reported by the client (e.g. macOS `NSUserName()`).
   * See `hostHomeDir`.
   * @internal
   */
  hostUsername?: string;
  /** @internal */ clientTimezone?: string;
  /**
   * Per-turn temporal snapshot frozen by the agent loop and read by
   * `applyRuntimeInjections` to build the `<turn_context>` timezone-mismatch
   * affordance and `time_since_last_message` line. Holds the client-reported
   * timezone captured at turn start and the human-readable gap since the
   * previous user message (null unless it exceeds the long-absence threshold).
   *
   * Frozen here rather than read live in assembly so the client timezone is not
   * clobbered when a newer message for the same conversation overwrites the
   * live {@link clientTimezone} mid-turn (every inbound message re-applies
   * transport metadata before it is enqueued). Its presence also gates the
   * `<turn_context>` block: assembly emits the block only for turns the loop has
   * frozen a snapshot for. The `current_time` value is computed fresh at each
   * injection so post-compaction re-injections reflect the current wall clock.
   * @internal
   */
  currentTurnTemporalSnapshot?: {
    clientTimezone: string | null;
    timeSinceLastMessage: string | null;
  };
  public readonly traceEmitter: TraceEmitter;
  /** @internal */ hasSystemPromptOverride: boolean;
  /** @internal */ readonly graphMemory: ConversationGraphMemory;
  /** @internal */ activeContextNodeIds?: string[];
  /** @internal */ streamThinking: boolean;
  /** @internal */ turnCount = 0;
  public lastAssistantAttachments: AssistantAttachmentDraft[] = [];
  public lastAttachmentWarnings: string[] = [];
  /**
   * Pre-chat onboarding context provided by the native client.
   * In-memory only — not persisted to the DB. Only relevant for the first
   * turn of a brand-new conversation so the system prompt can personalize
   * the opener and skip redundant discovery.
   * @internal
   */
  private onboardingContext?: OnboardingContext;
  /** @internal */ currentTurnChannelContext: TurnChannelContext | null = null;
  /** @internal */ currentTurnInterfaceContext: TurnInterfaceContext | null =
    null;
  /**
   * The conversation's recorded origin interface, cached from the DB row at
   * load time. It is immutable once recorded, so it backs the `<turn_context>`
   * interface fallback for turns that don't set a per-turn interface context
   * (regenerate, wake, subagent) without a per-injection DB lookup.
   * @internal
   */
  originInterface: InterfaceId | undefined = undefined;
  /**
   * The conversation's recorded origin channel, cached from the DB row at load
   * time. It is immutable once recorded, so it backs the `<turn_context>`
   * channel fallback for turns that don't set a per-turn channel context
   * (regenerate, wake, subagent) without a per-injection DB lookup.
   * @internal
   */
  originChannel: ChannelId | undefined = undefined;
  /** @internal */ activityVersion = 0;
  /** Last emitted activity state message, retained for replay on SSE reconnection. */
  /** @internal */ lastActivityStateMsg: ServerMessage | null = null;
  /** Set by the agent loop to track confirmation outcomes for persistence. */
  onConfirmationOutcome?: (
    requestId: string,
    state: string,
    toolUseId?: string,
  ) => void;
  private cacheWarmAbort?: AbortController;

  constructor(
    conversationId: string,
    provider: Provider,
    systemPrompt: string,
    sendToClient: (msg: ServerMessage) => void,
    workingDir: string,
    options?: ConversationConstructorOptions,
  ) {
    const { maxTokens, speedOverride, cacheTtl, modelOverride } = options ?? {};
    this.conversationId = conversationId;
    this.systemPrompt = systemPrompt;
    this.provider = provider;
    this.workingDir = workingDir;
    this.sendToClient = sendToClient;
    this.graphMemory = new ConversationGraphMemory(conversationId);
    this.traceEmitter = new TraceEmitter(conversationId, sendToClient);
    this.prompter = new PermissionPrompter(sendToClient);
    this.prompter.setOnStateChanged((requestId, state, source, toolUseId) => {
      // Route through emitConfirmationStateChanged so the event reaches
      // the client via sendToClient (wired to the SSE hub for HTTP conversations).
      this.emitConfirmationStateChanged({
        conversationId: this.conversationId,
        requestId,
        state,
        source,
        toolUseId,
      });
      // Notify the agent loop so it can track requestId → toolUseId mappings
      // and record confirmation outcomes for persistence.
      this.onConfirmationOutcome?.(requestId, state, toolUseId);
      // Emit activity state transitions for confirmation lifecycle
      if (state === "pending") {
        this.emitActivityState(
          "awaiting_confirmation",
          "confirmation_requested",
        );
      } else if (state === "timed_out") {
        this.emitActivityState("thinking", "confirmation_resolved", {
          statusText: "Resuming after timeout",
        });
      }
    });
    this.secretPrompter = new SecretPrompter();

    // Register call notifiers (reads ctx properties lazily)
    registerConversationNotifiers(conversationId, this);

    // Tool infrastructure
    this.executor = new ToolExecutor(this.prompter);
    this.profiler = new ToolProfiler();
    registerToolMetricsLoggingListener(this.eventBus);
    registerToolTraceListener(this.eventBus, this.traceEmitter);
    registerToolProfilingListener(this.eventBus, this.profiler);
    registerToolPermissionTelemetryListener(this.eventBus);
    const auditToolLifecycleEvent = createToolAuditListener();
    const publishToolDomainEvent = createToolDomainEventPublisher(
      this.eventBus,
    );
    const handleToolLifecycleEvent = (event: ToolLifecycleEvent) => {
      auditToolLifecycleEvent(event);
      return publishToolDomainEvent(event);
    };

    const toolDefs = getAllToolDefinitions();
    this.coreToolNames = new Set(toolDefs.map((d) => d.name));
    const toolExecutor = createToolExecutor(
      this.executor,
      this.prompter,
      this.secretPrompter,
      this as ToolSetupContext,
      handleToolLifecycleEvent,
    );

    const config = getConfig();
    const resolvedMainAgent = resolveCallSiteConfig("mainAgent", config.llm);
    this.streamThinking = resolvedMainAgent.thinking.streamThinking ?? false;

    const resolveTools = createResolveToolsCallback(toolDefs, this);

    const configuredMaxTokens = maxTokens;
    // When a systemPromptOverride was provided, use it as-is; otherwise
    // rebuild the full prompt each turn (picks up any workspace file changes).
    const hasSystemPromptOverride = systemPrompt !== buildSystemPrompt();
    this.hasSystemPromptOverride = hasSystemPromptOverride;

    // If an explicit modelOverride is supplied, use it verbatim. Otherwise
    // leave the model unset and let `RetryProvider`'s call-site resolver pick
    // it up from `llm.default` / `llm.callSites.<id>` on every turn.
    const resolvedModel: string | undefined = modelOverride;

    const resolveSystemPromptCallback = (
      history: Message[],
    ): ResolvedSystemPrompt => {
      const resolved: ResolvedSystemPrompt = {
        systemPrompt: this.hasSystemPromptOverride
          ? systemPrompt
          : buildSystemPrompt({
              hasNoClient: this.hasNoClient,
              trustContext: this.currentTurnTrustContext,
              channelCapabilities: this.currentTurnChannelCapabilities,
              personaOverride: this.wakePersonaOverride,
              ...(this.agentCharter ? { agentCharter: this.agentCharter } : {}),
              onboardingContext: this.getOnboardingContext(),
              conversationId: this.conversationId,
            }),
      };
      if (configuredMaxTokens !== undefined) {
        resolved.maxTokens = configuredMaxTokens;
      }
      // Per-round model-tier routing, vision first then flash (see
      // `agent/vision-tier.ts` for the precedence contract):
      // - Vision-tier (llm.visionTier, default ON): an image-bearing round
      //   that resolved to a known text-only model (e.g. the deepseek prod
      //   brains) is pinned to a vision-capable model — the alternative is a
      //   hard "doesn't support image input" provider error. This applies
      //   even over an explicit modelOverride / pinned profile: a pinned
      //   text-only model literally cannot serve the request.
      // - Flash-tier (llm.flashTier, default OFF): structurally trivial
      //   mainAgent rounds run on the flash model. Skipped entirely when an
      //   explicit modelOverride is set.
      // Either way the per-call model override wins over call-site resolution
      // downstream, but transport, tools, and system prompt are unchanged —
      // a misclassified round is just a different model, and the per-round
      // re-classification restores the configured model on later rounds.
      const tierRoute = resolveModelRouteForTurn({
        llm: getConfig().llm,
        history,
        callSite: this.currentCallSite,
        overrideProfile:
          this.currentTurnOverrideProfile ?? this.toolRoutedProfile,
        ...(resolvedModel !== undefined
          ? { explicitModel: resolvedModel }
          : {}),
        selectionSeed: this.conversationId,
      });
      if (tierRoute != null) {
        resolved.model = tierRoute.model;
        const logPayload = {
          conversationId: this.conversationId,
          model: tierRoute.model,
          reason: tierRoute.reason,
        };
        if (tierRoute.tier === "vision") {
          log.info(logPayload, "vision_tier_routed");
        } else {
          log.debug(logPayload, "flash_tier_routed");
        }
      } else if (resolvedModel !== undefined) {
        resolved.model = resolvedModel;
      }
      return resolved;
    };

    const fastModeEnabled = isAssistantFeatureFlagEnabled("fast-mode", config);
    const resolvedSpeed = speedOverride ?? resolvedMainAgent.speed;
    const initialContextWindow = resolveEffectiveContextWindow({
      llm: config.llm,
      callSite: "mainAgent",
    });
    const initialContextWindowConfig = contextWindowConfigFromEffective(
      resolvedMainAgent.contextWindow,
      initialContextWindow,
    );

    const agentLoopConfig: Partial<AgentLoopConfig> = {
      thinking: resolvedMainAgent.thinking,
      effort: resolvedMainAgent.effort,
      ...(fastModeEnabled && resolvedSpeed === "fast"
        ? { speed: resolvedSpeed }
        : {}),
      ...(cacheTtl ? { cacheTtl } : {}),
    };
    if (configuredMaxTokens !== undefined) {
      agentLoopConfig.maxTokens = configuredMaxTokens;
    }

    this.agentLoop = new AgentLoop({
      provider,
      systemPrompt,
      conversationId: this.conversationId,
      config: agentLoopConfig,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      toolExecutor: toolDefs.length > 0 ? toolExecutor : undefined,
      resolveTools,
      resolveSystemPrompt: resolveSystemPromptCallback,
      resolveConversationDir: () => {
        const conv = getConversation(this.conversationId);
        if (!conv) return null;
        return getResolvedConversationDirPath(
          this.conversationId,
          conv.createdAt,
        );
      },
      // Advisor gate (`agent/advisor.ts`) STATIC high-stakes signal: a tool
      // whose registered default risk is "high" (destructive/irreversible).
      // Derived from the tool registry so the loop stays decoupled from tool
      // metadata.
      isHighStakesTool: (toolName: string) =>
        getTool(toolName)?.defaultRiskLevel === "high",
      // Advisor gate PER-COMMAND high-stakes signal: bash/shell risk is judged
      // per-command by the gateway's classifier (`rm -rf …` is high, `ls` is
      // low), not by static tool metadata — bash's static risk is only Medium,
      // so without this its destructive commands would never trip the advisor.
      // Only per-command-risk shell tools whose static risk is Medium are worth
      // a gateway round-trip; everything else returns undefined cheaply.
      classifyCallRisk: async (toolName, input) => {
        const tool = getTool(toolName);
        if (
          !tool ||
          tool.defaultRiskLevel !== RiskLevel.Medium ||
          !isPerCommandRiskTool(toolName)
        ) {
          return undefined;
        }
        const { level } = await classifyRisk(toolName, input, this.workingDir);
        return level;
      },
    });
    createContextWindowManager({
      provider,
      systemPrompt: () => resolveSystemPromptCallback([]).systemPrompt,
      config: initialContextWindowConfig,
      toolTokenBudget: this.agentLoop.getToolTokenBudget(),
      conversationId: this.conversationId,
      resolveTools: resolveTools
        ? () => resolveTools(this.messages)
        : undefined,
    });
  }

  /**
   * The conversation's {@link ContextWindowManager}, owned by the compaction
   * module's per-conversation store. The constructor builds and registers it
   * there; this accessor resolves it on demand so the conversation holds no
   * separate handle. Present for the conversation's whole in-memory lifetime
   * (registered at construction, released on teardown), so a live conversation
   * always resolves an instance.
   */
  /** @internal */ get contextWindowManager(): ContextWindowManager {
    const manager = getContextWindowManager(this.conversationId);
    if (manager == null) {
      throw new Error(
        `ContextWindowManager missing for conversation ${this.conversationId} — the compaction store entry was released while the conversation is still live`,
      );
    }
    return manager;
  }

  // ── Onboarding context ───────────────────────────────────────────

  setOnboardingContext(ctx: OnboardingContext): void {
    this.onboardingContext = ctx;
    // Reseed BOOTSTRAP.md and mark the activation session at the earliest point
    // the conversation knows its bootstrap selection — before the first turn's
    // tool resolution, which `buildSystemPrompt` is too late for. See
    // `applyBootstrapTemplate`.
    if (ctx.bootstrapTemplate) {
      applyBootstrapTemplate(ctx.bootstrapTemplate, this.conversationId);
    }
  }

  getOnboardingContext(): OnboardingContext | undefined {
    return this.onboardingContext;
  }

  /**
   * Mirror an inference-profile override write onto the live instance so the
   * per-turn override derivation reads current state without re-fetching the
   * DB row. Called alongside the corresponding DB write by the HTTP setters
   * and the background expiry reaper.
   */
  applyInferenceProfileState(state: {
    profile: string | null;
    sessionId: string | null;
    expiresAt: number | null;
  }): void {
    this.inferenceProfile = state.profile;
    this.inferenceProfileSessionId = state.sessionId;
    this.inferenceProfileExpiresAt = state.expiresAt;
  }

  // ── Prompt Cache Warming ─────────────────────────────────────────

  /**
   * Fire-and-forget LLM call with max_tokens=1 to populate the provider's
   * prompt cache (system prompt + tools). Called after the canned first
   * greeting so the user's next real message gets a cache hit.
   */
  warmPromptCache(): void {
    this.cacheWarmAbort?.abort();
    const abort = new AbortController();
    this.cacheWarmAbort = abort;

    const systemPrompt = this.hasSystemPromptOverride
      ? this.systemPrompt
      : buildSystemPrompt({
          hasNoClient: this.hasNoClient,
          trustContext: this.currentTurnTrustContext,
          channelCapabilities: this.currentTurnChannelCapabilities,
          personaOverride: this.wakePersonaOverride,
          onboardingContext: this.getOnboardingContext(),
          conversationId: this.conversationId,
        });
    const tools = getAllToolDefinitions();
    const provider = this.provider;

    const warmMessage: Message = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };

    provider
      .sendMessage([warmMessage], {
        tools,
        systemPrompt,
        config: {
          max_tokens: 1,
          callSite: "mainAgent",
          usageTracking: "manual",
        },
        signal: abort.signal,
      })
      .then(() => {
        log.info("Prompt cache warmed successfully");
      })
      .catch((err) => {
        if (!abort.signal.aborted) {
          log.warn({ err }, "Prompt cache warming failed (non-fatal)");
        }
      })
      .finally(() => {
        if (this.cacheWarmAbort === abort) {
          this.cacheWarmAbort = undefined;
        }
      });
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async loadFromDb(): Promise<LoadFromDbResult> {
    const trustClass = this.trustContext?.trustClass;
    const canAccessMemory = !isUntrustedTrustClass(trustClass);
    const allDbMessages = getMessages(this.conversationId);
    const dbMessages = canAccessMemory
      ? allDbMessages
      : filterMessagesForUntrustedActor(allDbMessages);

    const conv = getConversation(this.conversationId);
    this.conversationType = conv?.conversationType ?? undefined;
    this.originInterface = parseInterfaceId(conv?.originInterface) ?? undefined;
    this.originChannel = parseChannelId(conv?.originChannel) ?? undefined;
    this.source = conv?.source ?? undefined;
    this.contextSummary = conv?.contextSummary ?? null;
    this.slackContextCompactionWatermarkTs =
      conv?.slackContextCompactionWatermarkTs ?? null;
    this.lastNotifiedInferenceProfile =
      conv?.lastNotifiedInferenceProfile ?? null;
    this.inferenceProfile = conv?.inferenceProfile ?? null;
    this.inferenceProfileSessionId = conv?.inferenceProfileSessionId ?? null;
    this.inferenceProfileExpiresAt = conv?.inferenceProfileExpiresAt ?? null;
    this.contextCompactedMessageCount = Math.max(
      0,
      conv?.contextCompactedMessageCount ?? 0,
    );
    this.contextCompactedAt = conv?.contextCompactedAt ?? null;

    // Untrusted actor views never receive summary-based compaction: a
    // compacted summary can embed trusted/guardian-only detail, so the
    // summary message is suppressed and the persisted history is rendered
    // unsliced. The slice boundary is clamped so it can never drop more rows
    // than exist. Slack chronological context is a separate consumer that
    // applies its own trust filtering downstream, so it reads the raw
    // mirrored count rather than this in-context boundary.
    const inContextCompactedCount = isUntrustedTrustClass(trustClass)
      ? 0
      : Math.min(this.contextCompactedMessageCount, dbMessages.length);
    const contextSummaryForHistory = isUntrustedTrustClass(trustClass)
      ? null
      : this.contextSummary?.trim() || null;

    // Every injection-strip event (`/clean` or compaction) updates
    // `historyStrippedAt`. Messages older than this should skip metadata
    // rehydration and have any injection prefixes still embedded in their
    // content stripped, so the post-strip view survives reload and forks.
    const historyStrippedAt = conv?.historyStrippedAt ?? null;
    const slicedDbMessages = dbMessages.slice(inContextCompactedCount);
    let preStrippedCount = 0;
    if (historyStrippedAt != null) {
      const boundary = slicedDbMessages.findIndex(
        (m) => m.createdAt >= historyStrippedAt,
      );
      preStrippedCount = boundary === -1 ? slicedDbMessages.length : boundary;
    }

    // The injection-time personal-memory gate, so background/local
    // conversations (sourceChannel `undefined` or `"vellum"`) can rehydrate
    // the persisted v2 static memory block. The shared helper folds in the
    // HTTP-auth-disabled dev bypass so rehydration and injection agree on the
    // effective trust class.
    const personalMemoryAllowed = isPersonalMemoryAllowed(this.trustContext);
    // Pruned v3 card slugs, read lazily on the first row that carries a v3
    // block (most conversations carry none, so most loads never query). The
    // prune valve marks cards pruned in the everInjected store instead of
    // rewriting the persisted metadata, so the v3 rehydration splice below
    // re-applies the filter on every load — that is what makes a prune
    // survive daemon restarts. Defensive catch: a store failure degrades to
    // an unfiltered (pre-prune) rehydration rather than a failed load.
    let v3PrunedSlugsMemo: Set<string> | null = null;
    const v3PrunedSlugs = (): Set<string> => {
      if (v3PrunedSlugsMemo === null) {
        try {
          v3PrunedSlugsMemo = getPrunedSlugs(this.conversationId);
        } catch {
          v3PrunedSlugsMemo = new Set();
        }
      }
      return v3PrunedSlugsMemo;
    };
    const parsedMessages: Message[] = slicedDbMessages.map((m, index, arr) => {
      const isPreStripped = index < preStrippedCount;
      const role = m.role as "user" | "assistant";
      let content: ContentBlock[];
      try {
        const parsed = JSON.parse(m.content);
        content = Array.isArray(parsed)
          ? parsed
          : [{ type: "text", text: m.content }];
      } catch {
        log.warn(
          { conversationId: this.conversationId, messageId: m.id },
          "Invalid JSON in persisted message content, replacing with safe text block",
        );
        content = [{ type: "text", text: m.content }];
      }

      content = reinjectImageSourcePaths(content, role, m.metadata);

      // Re-inject persisted injection blocks from metadata so it survives
      // conversation reloads (eviction, restart, fork).
      if (role === "user" && m.metadata && !isPreStripped) {
        try {
          const meta = JSON.parse(m.metadata);
          const isTail = index === arr.length - 1;

          // Rehydrate in reverse injection order (innermost block first)
          // so the resulting layout matches `applyRuntimeInjections`'s
          // after-memory-prefix splices in ascending injector order
          // (pkb-context 30, pkb-reminder 35, memory-v2-static 38,
          // now-md 40, memory-v3-shadow 1000 — the v2 static block lands
          // inside the memory prefix, so now-md splices *after* it; the
          // v3 card block is `<memory>`-wrapped and splices LAST, landing
          // at the memory boundary after the `<info>` block but before
          // now-md's earlier splice):
          //   [<memory>dynamic</memory>,
          //    <info>v2static</info>, <memory>v3cards</memory>, <NOW.md>,
          //    <system_reminder>, <knowledge_base>, ...original,
          //    <turn_context>]
          // (`<turn_context>` appends at the end, matching the live
          // injector's append-user-tail placement; `<workspace>` is
          // ephemeral and not rehydrated at all.)
          // The v2 static block is replayed verbatim from stored metadata,
          // so rows may carry either `<info>…</info>` or `<memory>…</memory>`
          // depending on when they were persisted.
          // Required so Anthropic's prefix cache keeps matching msg[0]
          // across daemon restart and conversation eviction. The tail
          // row only rehydrates `memoryInjectedBlock` and the v3 card
          // block — the next turn re-injects the rest fresh.
          if (!isTail && typeof meta.pkbContextBlock === "string") {
            content = [
              { type: "text" as const, text: meta.pkbContextBlock },
              ...content,
            ];
          }

          if (!isTail && typeof meta.pkbSystemReminderBlock === "string") {
            content = [
              { type: "text" as const, text: meta.pkbSystemReminderBlock },
              ...content,
            ];
          }

          if (!isTail && typeof meta.nowScratchpadBlock === "string") {
            content = [
              { type: "text" as const, text: meta.nowScratchpadBlock },
              ...content,
            ];
          }

          // The memory-v3 frozen card block (net-new compact cards) persists
          // under its own key, stored UNWRAPPED like v2's dynamic block below.
          // Rehydrated on ALL rows (tail included): the next turn injects only
          // net-new cards — deduped via the v3 everInjected store — so this
          // row's block must be back in history byte-identical for the dedup
          // (and the provider prefix cache) to hold. A row carries at most one
          // of the v3 and v2-dynamic keys (the user-prompt-submit hook
          // persists them mutually exclusively). Spliced here — before the v2
          // static and dynamic blocks — because prepends invert: executing
          // first leaves it BELOW both in the final content, matching the
          // live after-memory-prefix splice (order 1000 lands at the memory
          // boundary, after `<info>` / `<memory>` prefix blocks).
          // Pruned slugs' card sections are filtered out here (the metadata
          // itself is never rewritten — auditable and reversible); an
          // all-pruned block is skipped entirely, matching the live strip in
          // `memory-v3-shadow/prune.ts`.
          if (typeof meta[MEMORY_V3_INJECTED_BLOCK_METADATA_KEY] === "string") {
            const v3Block = meta[
              MEMORY_V3_INJECTED_BLOCK_METADATA_KEY
            ] as string;
            const v3Resident = filterPrunedCardSections(
              unwrapMemoryBlock(v3Block),
              v3PrunedSlugs(),
            );
            if (v3Resident.length > 0) {
              content = [
                { type: "text" as const, text: wrapMemoryBlock(v3Resident) },
                ...content,
              ];
            }
          }

          // The v2 static memory block (essentials/threads/recent/buffer
          // wrapped in either `<info>…</info>` or `<memory>…</memory>`)
          // carries personal user memory. Trust-gated to mirror
          // `isPersonalMemoryAllowed` at injection time — untrusted-actor
          // views must not read persisted personal memory back through
          // metadata. Skipped on the tail row because the next turn
          // re-injects fresh content on full-mode turns.
          if (
            !isTail &&
            personalMemoryAllowed &&
            typeof meta.memoryV2StaticBlock === "string"
          ) {
            content = [
              { type: "text" as const, text: meta.memoryV2StaticBlock },
              ...content,
            ];
          }

          // Memory remains rehydrated on all rows (existing behavior).
          // Strip any pre-existing wrapper before re-wrapping so historical
          // rows persisted with the wrapper (v2 path before the
          // injectedBlockText contract was unified with v1's unwrapped form)
          // don't render double-wrapped after rehydrate. Only unwrap when
          // the full <memory>...</memory> pair is present so we don't mutate
          // legitimate unwrapped payloads that happen to start with
          // "<memory>\n" or end with "\n</memory>".
          if (typeof meta.memoryInjectedBlock === "string") {
            content = [
              {
                type: "text" as const,
                text: wrapMemoryBlock(
                  unwrapMemoryBlock(meta.memoryInjectedBlock),
                ),
              },
              ...content,
            ];
          }

          // Appended (not prepended) to match the live injector's
          // append-user-tail placement, so rehydrated rows stay
          // byte-positionally identical to the history the provider saw
          // before the reload.
          if (!isTail && typeof meta.turnContextBlock === "string") {
            content = [
              ...content,
              { type: "text" as const, text: meta.turnContextBlock },
            ];
          }

          // `meta.workspaceBlock` is intentionally NOT rehydrated: the
          // `<workspace>` listing is ephemeral (strip-and-replaced at the
          // tail each turn by runtime assembly), so historical rows carry no
          // workspace copy in live history. The metadata key is still
          // persisted per turn for auditability.
        } catch {
          /* ignore parse errors — metadata may be malformed */
        }
      }

      return { role, content };
    });

    // Strip pre-clean messages only; post-clean messages keep the fresh
    // injections they were generated with. Strips run per message (the
    // transform is 1:1-or-drop) so the sliced-row → pre-repair index map
    // below stays exact: a dropped message records `null` instead of
    // shifting every later row's position.
    const messagesBeforeRepair: Message[] = [];
    const preRepairIndexBySlicedRow: (number | null)[] = new Array(
      parsedMessages.length,
    );
    for (const [index, message] of parsedMessages.entries()) {
      const stripped =
        index < preStrippedCount
          ? stripInjectionsForCompaction([message])
          : [message];
      if (stripped.length === 0) {
        preRepairIndexBySlicedRow[index] = null;
        continue;
      }
      preRepairIndexBySlicedRow[index] = messagesBeforeRepair.length;
      messagesBeforeRepair.push(stripped[0]);
    }

    // Normalize the canonical persisted history once at load. Every consumer
    // of `this.messages` outside the agent loop (history edit/undo, PKB context
    // tracking, surfaces) reads this list directly, so it must satisfy the
    // provider pairing/alternation rules before any of them run. The agent
    // loop's pre-run repair only repairs the transient per-turn message list it
    // sends to the provider and never writes back here, so this pass is not
    // redundant with it.
    const {
      messages: repairedMessages,
      stats,
      inputToOutputIndex,
    } = repairHistory(messagesBeforeRepair);
    if (
      stats.assistantToolResultsMigrated > 0 ||
      stats.missingToolResultsInserted > 0 ||
      stats.orphanToolResultsDowngraded > 0 ||
      stats.consecutiveSameRoleMerged > 0
    ) {
      log.warn(
        { conversationId: this.conversationId, phase: "load", ...stats },
        "Repaired persisted history",
      );
    }
    this.messages = repairedMessages;

    if (contextSummaryForHistory) {
      this.messages.unshift(
        createContextSummaryMessage(contextSummaryForHistory),
      );
    }

    if (conv) {
      this.usageStats = {
        inputTokens: conv.totalInputTokens,
        outputTokens: conv.totalOutputTokens,
        estimatedCost: conv.totalEstimatedCost,
      };
    }

    this.loadedHistoryTrustClass = trustClass;
    this.loadedHistoryPersonalMemoryAllowed = personalMemoryAllowed;

    log.info(
      { conversationId: this.conversationId, count: this.messages.length },
      "Loaded messages from DB",
    );

    this.restoreSurfaceStateFromHistory();
    this.graphMemory.restoreState();

    // Row→history correspondence for this load: slice offset, then the
    // injection-strip drop map, then the repair merge/insertion map, then the
    // summary head. Untrusted views are trust-filtered row subsets with no
    // stable correspondence — callers get null.
    const summaryHeadOffset = contextSummaryForHistory ? 1 : 0;
    const rowToHistoryIndex = canAccessMemory
      ? allDbMessages.map((_, rowIndex): number | null => {
          const slicedIndex = rowIndex - inContextCompactedCount;
          if (slicedIndex < 0) {
            return null;
          }
          const preRepairIndex = preRepairIndexBySlicedRow[slicedIndex];
          if (preRepairIndex == null) {
            return null;
          }
          const historyIndex = inputToOutputIndex?.[preRepairIndex];
          return historyIndex == null ? null : historyIndex + summaryHeadOffset;
        })
      : null;
    return { rows: allDbMessages, rowToHistoryIndex };
  }

  /**
   * Scan loaded conversation history for ui_surface content blocks and
   * populate surfaceState so that findConversationBySurfaceId works for
   * surfaces restored from history (e.g. after daemon restart).
   *
   * Only scans live (non-compacted) messages in this.messages — not all DB
   * rows — because surface IDs are not globally unique and restoring stale
   * compacted surfaces would let findConversationBySurfaceId route actions
   * to the wrong conversation.
   */
  private restoreSurfaceStateFromHistory(): void {
    this.surfaceState.clear();
    for (const msg of this.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as unknown as Record<string, unknown>;
        if (b.type === "ui_surface" && typeof b.surfaceId === "string") {
          // Rehydrate the daemon-only commit-timing activation tag so a commit
          // after reload still records its funnel milestone. Validated and
          // dropped if malformed; this field never reaches the client.
          const activationMoment =
            typeof b.activationMoment === "string" &&
            isActivationMomentParam(b.activationMoment)
              ? b.activationMoment
              : undefined;
          this.surfaceState.set(b.surfaceId, {
            surfaceType: (b.surfaceType ?? "dynamic_page") as SurfaceType,
            data: (b.data ?? {}) as SurfaceData,
            title: b.title as string | undefined,
            actions: Array.isArray(b.actions)
              ? (b.actions as Array<{
                  id: string;
                  label: string;
                  style?: string;
                  data?: Record<string, unknown>;
                }>)
              : undefined,
            ...(activationMoment ? { activationMoment } : {}),
          });
        }
      }
    }
  }

  async ensureActorScopedHistory(): Promise<void> {
    const currentTrustClass = this.trustContext?.trustClass;
    // `loadFromDb` gates personal-memory rehydration on `sourceChannel` too
    // (via `isPersonalMemoryAllowed`), so a same-trust-class reuse from a
    // different channel (e.g. internal `vellum` → remote channel) must also
    // trigger a reload. Otherwise stale personal-memory blocks can leak to
    // an untrusted remote turn, or be hidden when they should be present.
    const currentPersonalMemoryAllowed = isPersonalMemoryAllowed(
      this.trustContext,
    );
    if (
      this.loadedHistoryTrustClass === currentTrustClass &&
      this.loadedHistoryPersonalMemoryAllowed === currentPersonalMemoryAllowed
    ) {
      return;
    }
    await this.loadFromDb();
  }

  updateClient(
    sendToClient: (msg: ServerMessage) => void,
    hasNoClient = false,
  ): void {
    this.sendToClient = sendToClient;
    this.hasNoClient = hasNoClient;
    this.prompter.updateSender(sendToClient);
    this.traceEmitter.updateSender(sendToClient);

    // Replay last activity state so a reconnecting client sees the current phase
    // instead of being stuck on the last state it received before disconnection.
    if (!hasNoClient && this.lastActivityStateMsg) {
      try {
        sendToClient(this.lastActivityStateMsg);
      } catch (err) {
        log.warn(
          { err, conversationId: this.conversationId },
          "Failed to replay activity state on client reconnection",
        );
      }
    }
  }

  /** Returns the current sendToClient reference for identity comparison. */
  getCurrentSender(): (msg: ServerMessage) => void {
    return this.sendToClient;
  }

  setSubagentAllowedTools(tools: Set<string> | undefined): void {
    this.subagentAllowedTools = tools;
  }

  setIsSubagent(value: boolean): void {
    this.isSubagent = value;
  }

  /**
   * Prepend inherited parent messages into the in-memory message array so that
   * the AgentLoop includes them in provider calls (enabling KV cache sharing).
   *
   * These messages are NOT persisted to the database — they exist only in
   * memory. When the conversation is later read from DB via getMessages(),
   * only the conversation's own persisted messages appear.
   *
   * Must be called before the first persistUserMessage() call — i.e. while
   * `this.messages` is still empty.
   */
  injectInheritedContext(messages: Message[]): void {
    if (this.messages.length !== 0) {
      throw new Error(
        "injectInheritedContext must be called before any messages have been added",
      );
    }
    this.messages = [...messages];
    this.contextWindowManager.seedNonPersistedPrefix(messages.length);
  }

  /**
   * Return the system prompt string set at construction time (or its override).
   * Fork consumers use this to pass the parent's system prompt to the fork.
   */
  getCurrentSystemPrompt(): string {
    return this.systemPrompt;
  }

  isProcessing(): boolean {
    return this._processing;
  }

  /** Epoch-ms since the processing flag was set; null while idle. */
  processingSince(): number | null {
    return this._processingSince;
  }

  /** True while an agent-loop run is actually executing for this conversation. */
  hasLiveAgentRun(): boolean {
    return this._activeAgentRunCount > 0;
  }

  /**
   * Force-clear a `processing` flag that no live run is backing. Called by
   * the periodic stale-processing sweep ({@link ConversationEvictor}) as the
   * TTL backstop behind the run-settle rescue in {@link runAgentLoop}.
   * Returns true when a leaked flag was actually cleared.
   */
  forceClearStaleProcessing(source: string): boolean {
    return rescueLeakedProcessing(this, { source });
  }

  /**
   * Mutate the server-authoritative `processing` flag. Web/Capacitor/CLI
   * caches treat this flag as the source of truth for the avatar streaming
   * ring and thinking indicator, so the `true → false` clear must announce
   * itself: the daemon flips it in the agent-loop `finally` (after an awaited
   * turn-boundary commit), which is later than the user-visible terminal SSE
   * events, and a racing metadata refetch can otherwise re-read the
   * not-yet-cleared `true` and clobber the client's optimistic `false`.
   *
   * Emitting a metadata invalidation on the clear lets every client GET the
   * authoritative `false`, per the multi-client-sync contract in AGENTS.md
   * ("emit the invalidation after the canonical state write succeeds").
   */
  setProcessing(value: boolean): void {
    const wasProcessing = this._processing;
    this._processing = value;
    if (value && !wasProcessing) {
      this._processingSince = Date.now();
    } else if (!value) {
      this._processingSince = null;
    }
    // Persist a durable mid-turn marker so the daemon at the NEXT boot can
    // detect a turn a dead prior process was running (see
    // `daemon/interrupted-turn-reconciler.ts`). Best-effort: a DB error here
    // must never break the turn, and the marker is only ever read at startup.
    // The clear (`null`) also resets the resume-attempt streak.
    if (wasProcessing !== value) {
      try {
        setConversationProcessingStartedAt(
          this.conversationId,
          value ? Date.now() : null,
        );
      } catch (err) {
        log.warn(
          { err, conversationId: this.conversationId, value },
          "conversation: failed to persist processing_started_at (non-fatal)",
        );
      }
    }
    if (wasProcessing && !value) {
      void publishSyncInvalidation([
        conversationMetadataSyncTag(this.conversationId),
      ]);
    }
  }

  markStale(): void {
    this.stale = true;
    // Invalidate the cached skill catalog so the next projection picks up
    // filesystem changes (e.g. a skill created during this run).
    this.skillProjectionCache.catalog = undefined;
  }

  isStale(): boolean {
    return this.stale;
  }

  abort(reason?: AbortReason): void {
    abortConversation(this, reason);
  }

  dispose(): void {
    // Cancel all pending standalone surfaces so callers get a clean
    // cancellation instead of hanging forever. Emit dismiss notifications
    // to the client so surfaces don't remain visually active if the client
    // reconnects after dispose.
    for (const [surfaceId, entry] of this.pendingStandaloneSurfaces) {
      clearTimeout(entry.timer);
      try {
        broadcastMessage({
          type: "ui_surface_dismiss",
          conversationId: this.conversationId,
          surfaceId,
        });
      } catch {
        // Best-effort: the client may already be disconnected during dispose.
      }
      entry.resolve({
        status: "cancelled",
        surfaceId,
        cancellationReason: "resolver_unavailable",
      });
    }
    this.pendingStandaloneSurfaces.clear();
    // Clear tombstone timers to prevent dangling references after dispose.
    for (const timer of this.recentlyCompletedStandaloneSurfaces.values()) {
      clearTimeout(timer);
    }
    this.recentlyCompletedStandaloneSurfaces.clear();
    // Flush any pending debounced surface-data persists for this
    // conversation so updates that arrived inside the debounce window
    // still land in the DB before teardown. Flushing also clears the
    // pending entries, so no separate cancel call is needed.
    flushPendingSurfaceDataPersists(this.conversationId);
    // Only dispose the per-conversation CU and app-control proxies.
    // Bash/File/Transfer are singletons — their lifecycle is managed by
    // static disposeInstance().
    this.hostCuProxy?.dispose();
    this.hostAppControlProxy?.dispose();
    this.hostAppControlProxy = undefined;
    this.activeContextNodeIds = this.graphMemory.tracker.getActiveNodeIds();
    this.graphMemory.persistState();
    this.graphMemory.dispose();
    disposeConversation(this);
  }

  // ── Messaging ────────────────────────────────────────────────────

  redirectToSecurePrompt(
    detectedTypes: string[],
    options?: RedirectToSecurePromptOptions,
  ): void {
    redirectToSecurePromptImpl(
      this.conversationId,
      this.secretPrompter,
      detectedTypes,
      options,
    );
  }

  enqueueMessage(options: EnqueueMessageOptions): {
    queued: boolean;
    requestId: string;
    rejected?: boolean;
  } {
    return enqueueMessageImpl(this, {
      ...options,
      onEvent: options.onEvent ?? this.sendToClient,
    });
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  hasQueuedMessages(): boolean {
    return !this.queue.isEmpty;
  }

  removeQueuedMessage(requestId: string): boolean {
    return this.queue.removeByRequestId(requestId) !== undefined;
  }

  canHandoffAtCheckpoint(): boolean {
    return this._processing && this.hasQueuedMessages();
  }

  hasPendingConfirmation(requestId: string): boolean {
    return this.prompter.hasPendingRequest(requestId);
  }

  hasAnyPendingConfirmation(): boolean {
    return this.prompter.hasPending;
  }

  denyAllPendingConfirmations(): void {
    this.prompter.denyAllPending();
  }

  hasPendingSecret(requestId: string): boolean {
    return this.secretPrompter.hasPendingRequest(requestId);
  }

  handleConfirmationResponse(
    requestId: string,
    decision: UserDecision,
    options?: {
      selectedPattern?: string;
      decisionContext?: string;
      emissionContext?: {
        source?: ConfirmationStateChanged["source"];
        causedByRequestId?: string;
        decisionText?: string;
      };
    },
  ): void {
    // Guard: only proceed if the confirmation is still pending. Stale or
    // already-resolved requests must not activate overrides or emit events.
    if (!this.prompter.hasPendingRequest(requestId)) {
      return;
    }

    // Capture toolUseId before resolving (resolution deletes the pending entry)
    const toolUseId = this.prompter.getToolUseId(requestId);

    this.prompter.resolveConfirmation(requestId, decision, {
      selectedPattern: options?.selectedPattern,
      decisionContext: options?.decisionContext,
    });

    // Emit authoritative confirmation state and activity transition centrally
    // so ALL callers (HTTP handlers, /v1/confirm, channel bridges) get
    // consistent events without duplicating emission logic.
    const resolvedState =
      decision === "deny" ? ("denied" as const) : ("approved" as const);
    this.emitConfirmationStateChanged({
      conversationId: this.conversationId,
      requestId,
      state: resolvedState,
      source: options?.emissionContext?.source ?? "button",
      toolUseId,
      ...(options?.emissionContext?.causedByRequestId
        ? { causedByRequestId: options.emissionContext.causedByRequestId }
        : {}),
      ...(options?.emissionContext?.decisionText
        ? { decisionText: options.emissionContext.decisionText }
        : {}),
    });
    // Notify the agent loop of the confirmation outcome for persistence
    this.onConfirmationOutcome?.(requestId, resolvedState, toolUseId);
    this.emitActivityState("thinking", "confirmation_resolved", {
      statusText: "Resuming after approval",
    });

    // Sync the canonical guardian request status so stale "pending" DB
    // records don't get matched by later guardian reply routing. Best-effort:
    // CAS may harmlessly fail if the canonical decision primitive already
    // resolved the request (e.g. channel approval path).
    try {
      resolveCanonicalGuardianRequest(requestId, "pending", {
        status: resolvedState,
      });
    } catch {
      // Canonical request tracking should not break the primary approval flow.
    }
  }

  handleSecretResponse(
    requestId: string,
    value?: string,
    delivery?: "store" | "transient_send",
  ): void {
    this.secretPrompter.resolveSecret(requestId, value, delivery);
  }

  setHostCuProxy(proxy: HostCuProxy | undefined): void {
    if (this.hostCuProxy && this.hostCuProxy !== proxy) {
      this.hostCuProxy.dispose();
    }
    this.hostCuProxy = proxy;
  }

  setHostAppControlProxy(proxy: HostAppControlProxy | undefined): void {
    if (this.hostAppControlProxy && this.hostAppControlProxy !== proxy) {
      this.hostAppControlProxy.dispose();
    }
    this.hostAppControlProxy = proxy;
  }

  ensureHostProxiesForTurn(
    sourceInterface: import("../channels/types.js").InterfaceId | undefined,
    sourceActorPrincipalId = this.currentTurnSourceActorPrincipalId ??
      this.currentTurnAuthContext?.actorPrincipalId ??
      this.authContext?.actorPrincipalId,
  ): void {
    if (
      shouldAttachHostProxyForCapability(
        "host_cu",
        sourceInterface,
        sourceActorPrincipalId,
      ) &&
      !this.hostCuProxy
    ) {
      this.setHostCuProxy(new HostCuProxy());
    }
    if (
      shouldAttachHostProxyForCapability(
        "host_app_control",
        sourceInterface,
        sourceActorPrincipalId,
      ) &&
      !this.hostAppControlProxy
    ) {
      this.setHostAppControlProxy(new HostAppControlProxy(this.conversationId));
    }
  }

  // ── Server-authoritative state signals ─────────────────────────────

  emitConfirmationStateChanged(
    params: Omit<ConfirmationStateChanged, "type">,
  ): void {
    const msg: ServerMessage = {
      type: "confirmation_state_changed",
      ...params,
    } as ServerMessage;
    try {
      this.sendToClient(msg);
    } catch (err) {
      log.warn(
        { err, conversationId: this.conversationId },
        "sendToClient threw in emitConfirmationStateChanged",
      );
    }
  }

  emitActivityState(
    phase: AssistantActivityStateEvent["phase"],
    reason: AssistantActivityStateEvent["reason"],
    options?: {
      anchor?: AssistantActivityStateEvent["anchor"];
      requestId?: string;
      statusText?: string;
    },
  ): void {
    const { anchor = "assistant_turn", requestId, statusText } = options ?? {};
    this.activityVersion++;
    const msg: ServerMessage = {
      type: "assistant_activity_state",
      conversationId: this.conversationId,
      activityVersion: this.activityVersion,
      phase,
      anchor,
      requestId,
      reason,
      ...(statusText ? { statusText } : {}),
    } as ServerMessage;
    this.lastActivityStateMsg = msg;
    try {
      this.sendToClient(msg);
    } catch (err) {
      log.warn(
        { err, conversationId: this.conversationId },
        "sendToClient threw in emitActivityState",
      );
    }
  }

  /**
   * Token count for `messages` used to render the user-facing `/compact`,
   * `/clean`, and "summarize up to here" figures. Prefers the provider's real
   * `count_tokens` tokenizer (so the numbers match the context-window
   * indicator's provider-reported usage) and falls back to the context-window
   * manager's local estimate when the provider has no count endpoint or the
   * count call fails — both measure the same system-prompt + tools
   * composition the manager sizes against.
   *
   * The count is a network round-trip with its own rate limit, so this is for
   * user-initiated actions only, never the per-turn auto-compaction gate.
   */
  private async calculateTokens(messages: Message[]): Promise<number> {
    const countInputTokens = this.provider.countInputTokens;
    if (!countInputTokens) {
      return this.contextWindowManager.estimateInputTokens(messages);
    }
    try {
      const { systemPrompt, tools } =
        this.contextWindowManager.tokenCountInputs;
      return await countInputTokens.call(
        this.provider,
        messages,
        systemPrompt,
        tools,
      );
    } catch (err) {
      log.warn(
        { err, conversationId: this.conversationId },
        "Provider token count failed — falling back to local estimate",
      );
      return this.contextWindowManager.estimateInputTokens(messages);
    }
  }

  /**
   * Push the conversation's current context-window usage to clients so the
   * context-window indicator matches the numbers a user-initiated compaction
   * card reports. Turn-driven compaction needs no push: the turn's own
   * `usage_update` carries the post-compaction count.
   *
   * Defaults to the conversation's own sender, the channel `emitActivityState`
   * and `context_compacted` already use, so a queued `/compact` reaches the
   * same client its result card does. Routes that resolve a conversation
   * outside the send path never wire that sender and pass their own `onEvent`.
   */
  private emitContextWindowUsage(
    tokens: number,
    maxTokens: number,
    onEvent?: (msg: ServerMessage) => void,
  ): void {
    try {
      (onEvent ?? this.sendToClient)({
        type: "context_window_usage",
        conversationId: this.conversationId,
        tokens,
        maxTokens,
      });
    } catch (err) {
      log.warn(
        { err, conversationId: this.conversationId },
        "sendToClient threw in emitContextWindowUsage",
      );
    }
  }

  /**
   * Run a user-initiated compaction (`run`), reporting its before/after with
   * the provider's real tokenizer (count_tokens) rather than the local chars/4
   * estimate the compaction pipeline runs internally (it under-counts by ~25%
   * on typical histories), and pushing the resulting count to clients.
   * `calculateTokens` falls back to that estimate when the provider has no
   * count endpoint or the count call fails, so behavior degrades gracefully.
   *
   * Only the *displayed* numbers are overridden: the compaction log and
   * circuit-breaker accounting inside `runCompaction` keep the estimate-based
   * figures, leaving calibration and historical logs untouched.
   *
   * `run` must leave the compacted history applied to `this.messages`, which
   * every `runCompaction` path does. `onEvent` overrides the sink the usage
   * push goes to.
   */
  private async runUserCompaction(
    run: () => Promise<ContextWindowResult>,
    onEvent?: (msg: ServerMessage) => void,
  ): Promise<ContextWindowResult> {
    const before = await this.calculateTokens(this.messages);
    const result = await run();
    // A no-op leaves the context unchanged, so before === after.
    const after = result.compacted
      ? await this.calculateTokens(this.messages)
      : before;
    this.emitContextWindowUsage(after, result.maxInputTokens, onEvent);
    return {
      ...result,
      previousEstimatedInputTokens: before,
      estimatedInputTokens: after,
    };
  }

  /**
   * `/compact`. `onEvent` is the sink for the context-window usage push, and
   * callers pass whatever sink they render the result card through: the queue
   * drain carries the queued item's own `onEvent`, and `sendToClient` is reset
   * to a no-op once an interactive turn finishes (`process-message.ts`), so a
   * `/compact` draining behind that turn would otherwise push into nothing
   * while its card still reaches the client.
   */
  async forceCompact(
    onEvent?: (msg: ServerMessage) => void,
  ): Promise<ContextWindowResult> {
    return this.runUserCompaction(() => this.runCompaction(true), onEvent);
  }

  /**
   * "Summarize up to here": summarize everything before the turn containing
   * `beforeMessageId`, keeping that turn and everything after it verbatim.
   * Runs the same durable compaction pipeline as {@link forceCompact} but
   * with a caller-fixed tail boundary instead of the token-budget cut.
   *
   * Owner self-maintenance operates on the full (guardian) history, so an
   * untrusted trust context is temporarily swapped for the internal guardian
   * context and restored afterward. Throws {@link UserError} (messages are
   * user-facing) when the boundary cannot be resolved or the row→history
   * index mapping cannot be verified.
   *
   * `onEvent` is the sink for the context-window usage push. The management
   * route that owns this action resolves its conversation outside the send
   * path, so the instance can still hold the store's no-op sender; it passes
   * the same broadcast path its result card goes out on.
   */
  async summarizeUpToMessage(
    beforeMessageId: string,
    onEvent?: (msg: ServerMessage) => void,
  ): Promise<ContextWindowResult> {
    const priorTrustContext = this.trustContext;
    if (isUntrustedTrustClass(priorTrustContext?.trustClass)) {
      this.setTrustContext(INTERNAL_GUARDIAN_TRUST_CONTEXT);
    }
    try {
      // Fresh guardian-scoped load so `this.messages`, the row set, and the
      // row→history mapping all describe the same instant (rare user action;
      // the reload cost is acceptable).
      const { rows, rowToHistoryIndex } = await this.loadFromDb();
      const { boundaryRowIndex } = resolveSummarizeBoundary(
        rows,
        beforeMessageId,
        this.contextCompactedMessageCount,
      );
      // Row-space → history-space via the load's own mapping, which folds in
      // history-repair merges/insertions and injection-strip drops. Offset
      // arithmetic would drift by one for every repair upstream of the
      // boundary — e.g. the user(tool_result-only) + user(text) row pair an
      // awaiting-user-action surface pause persists, which repair merges into
      // a single in-memory message.
      const tailIndex = rowToHistoryIndex?.[boundaryRowIndex] ?? null;
      const boundaryRow = rows[boundaryRowIndex];
      const mapped: Message | undefined =
        tailIndex == null ? undefined : this.messages[tailIndex];
      const rowText = firstPersistedTextBlockText(boundaryRow.content);
      // Injection rehydration PREPENDS blocks to user messages, and repair
      // can merge a preceding continuation row's blocks in front of the
      // boundary row's, so the row's text must appear somewhere among the
      // mapped message's text blocks — never assume block 0. A mismatch
      // means the in-memory view diverged from the mapping's invariants;
      // fail safe rather than summarize at the wrong boundary.
      const matches =
        mapped !== undefined &&
        mapped.role === boundaryRow.role &&
        (rowText === null ||
          mapped.content.some(
            (b) => b.type === "text" && b.text.includes(rowText),
          ));
      if (rowToHistoryIndex == null || tailIndex == null || !matches) {
        log.warn(
          {
            conversationId: this.conversationId,
            beforeMessageId,
            boundaryRowIndex,
            tailIndex,
            rowRole: boundaryRow.role,
            mappedRole: mapped?.role,
            rowCount: rows.length,
            historyLength: this.messages.length,
            contextCompactedMessageCount: this.contextCompactedMessageCount,
          },
          "summarizeUpToMessage: row→history boundary mapping mismatch",
        );
        throw new UserError(
          "Conversation history is being reorganized — try again in a moment",
        );
      }
      // Everything between the compacted watermark and the clicked turn
      // lives inside the boundary's own merged message (at most the summary
      // head precedes it) — there is no earlier content to summarize.
      if (tailIndex <= (this.contextSummary?.trim() ? 1 : 0)) {
        throw new UserError("Nothing to summarize before this message");
      }
      // First persisted row contributing to each in-memory message — the
      // inverse of `rowToHistoryIndex` (descending walk so the earliest row
      // wins a merged message's slot; summary-head/synthetic entries stay
      // null). The compaction pipeline derives its persisted and Slack
      // watermarks from this against the cut the compactor ACTUALLY uses,
      // which may retreat from the requested boundary for tool pairing.
      const firstRowByHistoryIndex: (number | null)[] = new Array(
        this.messages.length,
      ).fill(null);
      for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
        const historyIndex = rowToHistoryIndex[rowIndex];
        if (historyIndex != null) {
          firstRowByHistoryIndex[historyIndex] = rowIndex;
        }
      }
      return await this.runUserCompaction(
        () =>
          this.runCompaction(true, undefined, {
            fixedTailStartIndex: tailIndex,
            // When repair merged preceding continuation rows into the
            // boundary's message, the row boundary retreats to the message's
            // first contributing row: the summary call reads
            // messages[0..tailIndex), which excludes the merged rows' content,
            // so the image manifest and watermarks must not treat them as
            // summarized.
            fixedBoundaryRowIndex:
              firstRowByHistoryIndex[tailIndex] ?? boundaryRowIndex,
            fixedBoundaryRowView: { rows, firstRowByHistoryIndex },
          }),
        onEvent,
      );
    } finally {
      // Only undo the temporary guardian context this method installed. If
      // trustContext was legitimately updated at an `await` boundary, the
      // reference differs and is left alone.
      if (this.trustContext === INTERNAL_GUARDIAN_TRUST_CONTEXT) {
        this.setTrustContext(priorTrustContext ?? null);
      }
    }
  }

  /**
   * Auto-threshold compaction gate. Runs the same durable compaction
   * pipeline as {@link forceCompact} (summary call, circuit-breaker
   * accounting, Slack provenance, in-memory + DB commit) but honors the
   * `compaction.autoThreshold` check — an under-threshold history is a
   * cheap no-op — and the compaction circuit breaker, returning `null`
   * without estimating anything while the breaker is open. Used by the
   * agent-wake path (`runtime/agent-wake.ts`), which bypasses the daemon
   * orchestrator's in-loop budget gate and needs an equivalent turn-start
   * compaction before snapshotting its run input.
   *
   * `sizing` lets a wake thread its own call-site/profile resolution into
   * the gate's context-window sizing — see {@link CompactionSizing}. Absent,
   * the gate sizes against `mainAgent` (the live-turn behavior).
   */
  async maybeCompact(
    sizing?: CompactionSizing,
  ): Promise<ContextWindowResult | null> {
    if (await this.agentLoop.compactionCircuit.isOpen()) {
      return null;
    }
    return this.runCompaction(false, sizing);
  }

  /**
   * Shared compaction pipeline behind {@link forceCompact},
   * {@link maybeCompact}, and {@link summarizeUpToMessage}. `force` skips the
   * auto-threshold check inside the context-window manager (user-initiated
   * `/compact`); without it the manager no-ops below the threshold.
   * `opts.fixedTailStartIndex` pins the kept tail to a caller-chosen history
   * index ("summarize up to here") instead of the token-budget cut;
   * `opts.fixedBoundaryRowIndex` is the same boundary in row space, which
   * bounds the compactor's image manifest to rows being summarized away;
   * `opts.fixedBoundaryRowView` carries the load's row set and the
   * first-contributing-row inverse of its row→history mapping, from which
   * this pipeline derives row-exact persisted and Slack watermarks against
   * the cut the compactor actually used (the requested cut may retreat to
   * keep tool_use/tool_result pairs together).
   */
  private async runCompaction(
    force: boolean,
    sizing?: CompactionSizing,
    opts?: {
      fixedTailStartIndex?: number;
      fixedBoundaryRowIndex?: number;
      fixedBoundaryRowView?: {
        rows: MessageRow[];
        firstRowByHistoryIndex: (number | null)[];
      };
    },
  ): Promise<ContextWindowResult> {
    const overrideProfile = resolveOverrideProfile(this) ?? null;
    const config = getConfig();
    // Threshold/window sizing. The default (`mainAgent` + the conversation's
    // own pinned profile) matches live turns; caller-supplied `sizing` makes
    // the gate's threshold reflect the window the caller's run will actually
    // resolve. Sizing only — the summary call below still runs under the
    // conversation's own profile.
    const sizingCallSite = sizing?.callSite ?? "mainAgent";
    const sizingOverrideProfile = sizing
      ? sizing.overrideProfile
      : (overrideProfile ?? undefined);
    const effectiveContextWindow = resolveEffectiveContextWindow({
      llm: config.llm,
      callSite: sizingCallSite,
      overrideProfile: sizingOverrideProfile,
      forceOverrideProfile: sizing?.forceOverrideProfile,
    });
    this.contextWindowManager.updateConfig(
      contextWindowConfigFromEffective(
        resolveCallSiteConfig(sizingCallSite, config.llm, {
          overrideProfile: sizingOverrideProfile,
          forceOverrideProfile: sizing?.forceOverrideProfile,
        }).contextWindow,
        effectiveContextWindow,
      ),
    );
    // A caller-fixed tail boundary is computed and verified against
    // `this.messages`; the Slack chronological projection is a different
    // array (watermark-sliced, actor-filtered, re-rendered) whose indices
    // don't correspond. Fixed-boundary runs therefore always compact
    // `this.messages`; their Slack watermark is derived post-hoc in
    // row-space from the compactor's actual cut (a null context makes
    // `getSlackCompactionWatermarkForPrefix` return null below).
    const slackChronologicalContext =
      opts?.fixedTailStartIndex == null &&
      this.channelCapabilities?.channel === "slack"
        ? loadSlackChronologicalContext(
            this.conversationId,
            this.channelCapabilities,
            {
              trustClass: this.trustContext?.trustClass,
              contextSummary: this.contextSummary,
              contextCompactedMessageCount: this.contextCompactedMessageCount,
              slackContextCompactionWatermarkTs:
                this.slackContextCompactionWatermarkTs,
            },
          )
        : null;
    const messagesToCompact =
      slackChronologicalContext?.messages ?? this.messages;
    const compactedRowCountAtCall = this.contextCompactedMessageCount;
    let result = await defaultCompact({
      conversationId: this.conversationId,
      messages: messagesToCompact,
      signal: this.abortController?.signal ?? undefined,
      force,
      overrideProfile,
      actorTrustClass: this.trustContext?.trustClass,
      fixedTailStartIndex: opts?.fixedTailStartIndex,
      fixedBoundaryRowIndex: opts?.fixedBoundaryRowIndex,
    });
    // Row-exact watermark accounting for a caller-fixed boundary, derived
    // from the cut the compactor ACTUALLY used (`result.compactedMessages`
    // is the kept tail's history-space start): the compactor may retreat
    // the requested cut to keep tool_use/tool_result pairs together, and
    // pinning the watermark to the requested row would hide those
    // kept-but-unsummarized rows from every future load. The compactor's
    // message-space count is equally unusable as a row count — it
    // undercounts whenever load-time repair merged (or the injection strip
    // dropped) rows in the summarized range. Mapping the actual cut through
    // the load's first-contributing-row inverse handles both. The null
    // fallback (a cut landing on an unmapped synthetic message) degrades to
    // a zero advance — conservative: rows get re-summarized later rather
    // than hidden.
    let fixedBoundarySlackWatermarkTs: string | null = null;
    if (result.compacted && opts?.fixedBoundaryRowView != null) {
      const { rows, firstRowByHistoryIndex } = opts.fixedBoundaryRowView;
      const rowBoundary =
        firstRowByHistoryIndex[result.compactedMessages] ??
        compactedRowCountAtCall;
      result = {
        ...result,
        compactedPersistedMessages: Math.max(
          0,
          rowBoundary - compactedRowCountAtCall,
        ),
      };
      // Slack projections gate on the persisted watermark, not on
      // `contextCompactedMessageCount` — without an advance, the summarized
      // rows would reappear verbatim in the projection alongside the new
      // summary. Null for non-Slack rows or a non-advancing boundary.
      fixedBoundarySlackWatermarkTs = getSlackWatermarkAdvanceForRowPrefix(
        rows,
        rowBoundary,
        this.slackContextCompactionWatermarkTs,
      );
    }
    // Track circuit-breaker state for every compaction that ran a summary
    // call — user-initiated `/compact`, other forced paths, and the wake's
    // auto gate — so a success clears a stuck counter and a run of failures
    // still trips the breaker. `summaryFailed` is `undefined` on
    // early-return paths (no eligible messages, disabled, below the auto
    // threshold, etc.) — skip those so they don't silently reset the
    // counter. A user Stop aborts the summary's provider call, which the
    // compactor reports as `summaryFailed: true`; that is a cancellation, not
    // a genuine failure, so skip recording when the signal is aborted rather
    // than tripping the breaker on user cancels.
    if (
      result.summaryFailed !== undefined &&
      !this.abortController?.signal.aborted
    ) {
      await this.agentLoop.compactionCircuit.recordOutcome(
        result.summaryFailed,
        this.sendToClient,
      );
    }
    if (result.compacted) {
      await applyCompactionResult(this, result, this.sendToClient, null, {
        slackContextCompactionWatermarkTs:
          fixedBoundarySlackWatermarkTs ??
          getSlackCompactionWatermarkForPrefix(
            slackChronologicalContext,
            result.compactedMessages,
          ),
      });
    }
    return result;
  }

  /**
   * Strip stale runtime injections from the message history and reset the
   * memory-injection ledger without summarizing any history. Mirrors the
   * non-LLM side effects of `forceCompact`: the next turn re-injects fresh
   * NOW.md / knowledge-base / memory-v2 static blocks, and per-turn memory
   * activations are no longer deduped against the prior session.
   */
  async forceClean(): Promise<CleanResult> {
    // Use the provider's real tokenizer for the displayed before/after (see
    // `forceCompact` for why); falls back to the local estimate when count
    // isn't available.
    const previousEstimatedInputTokens = await this.calculateTokens(
      this.messages,
    );
    const stripped = stripInjectionsForCompaction(this.messages);
    this.messages = stripped;
    await this.graphMemory.onCompacted(0);
    setConversationHistoryStrippedAt(this.conversationId, Date.now());
    const estimatedInputTokens = await this.calculateTokens(this.messages);
    return {
      previousEstimatedInputTokens,
      estimatedInputTokens,
      maxInputTokens: this.contextWindowManager.maxInputTokens,
      preservedMessages: this.messages.length,
    };
  }

  setChannelCapabilities(caps: ChannelCapabilities | null): void {
    this.channelCapabilities = caps ?? undefined;
    this.secretPrompter.setChannelContext(
      caps
        ? {
            channel: caps.channel,
            supportsDynamicUi: caps.supportsDynamicUi,
          }
        : undefined,
    );
  }

  setTrustContext(ctx: TrustContext | null): void {
    this.trustContext = ctx ?? undefined;
  }

  setAuthContext(ctx: AuthContext | null): void {
    this.authContext = ctx ?? undefined;
  }

  getAuthContext(): AuthContext | undefined {
    return this.authContext;
  }

  /**
   * The actor principal that owns the current turn, for host-proxy routing.
   * Prefers the in-flight turn's actor over the conversation's resting
   * authContext so a /v1/messages turn (which sets only
   * `currentTurnSourceActorPrincipalId`/`currentTurnAuthContext`) scopes
   * correctly. Returns `undefined` when no actor identity is known.
   */
  getTurnActorPrincipalId(): string | undefined {
    return (
      this.currentTurnSourceActorPrincipalId ??
      this.currentTurnAuthContext?.actorPrincipalId ??
      this.authContext?.actorPrincipalId
    );
  }

  setVoiceCallControlPrompt(prompt: string | null): void {
    this.voiceCallControlPrompt = prompt ?? undefined;
  }

  setTransportHints(hints: string[] | undefined): void {
    this.transportHints = hints;
  }

  /**
   * Apply client-reported host environment (home dir, username) from
   * transport metadata onto the conversation. Only interfaces whose
   * interfaceId passes `supportsHostProxy()` contribute values — all other
   * interfaces (CLI, channels, iOS, chrome-extension) clear any previously
   * stored values so a conversation reused across interfaces doesn't leak
   * stale paths into later `<workspace>` blocks.
   *
   * Gating on `supportsHostProxy` (rather than a specific interface name)
   * keeps this in lock-step with the capability set defined in
   * `HostProxyInterfaceId` — adding a new host-capable client only requires
   * extending those two, not touching this method.
   *
   * Invalidates the cached workspace top-level block when values change so
   * the next render picks up the new host env.
   */
  applyHostEnvFromTransport(transport: ConversationTransportMetadata): void {
    const prevHomeDir = this.hostHomeDir;
    const prevUsername = this.hostUsername;
    if (isHostProxyTransport(transport)) {
      this.hostHomeDir = transport.hostHomeDir;
      this.hostUsername = transport.hostUsername;
    } else {
      this.hostHomeDir = undefined;
      this.hostUsername = undefined;
    }
    if (
      prevHomeDir !== this.hostHomeDir ||
      prevUsername !== this.hostUsername
    ) {
      this.workspaceTopLevelDirty = true;
    }
  }

  applyClientTimezoneFromTransport(
    transport: ConversationTransportMetadata,
  ): void {
    this.clientTimezone =
      canonicalizeTimeZone(transport.clientTimezone) ?? undefined;
  }

  setAssistantId(assistantId: string | null): void {
    this.assistantId = assistantId ?? undefined;
  }

  setCommandIntent(
    intent: { type: string; payload?: string; languageCode?: string } | null,
  ): void {
    this.commandIntent = intent ?? undefined;
  }

  setPreactivatedSkillIds(ids: string[] | undefined): void {
    this.preactivatedSkillIds = ids;
  }

  /**
   * Add a skill ID to the preactivated set without replacing existing entries.
   * No-op if the ID is already present.
   */
  addPreactivatedSkillId(id: string): void {
    if (!this.preactivatedSkillIds) {
      this.preactivatedSkillIds = [id];
    } else if (!this.preactivatedSkillIds.includes(id)) {
      this.preactivatedSkillIds.push(id);
    }
  }

  setTurnChannelContext(ctx: TurnChannelContext): void {
    this.currentTurnChannelContext = ctx;
  }

  getTurnChannelContext(): TurnChannelContext | null {
    return this.currentTurnChannelContext;
  }

  setTurnInterfaceContext(ctx: TurnInterfaceContext): void {
    this.currentTurnInterfaceContext = ctx;
  }

  getTurnInterfaceContext(): TurnInterfaceContext | null {
    return this.currentTurnInterfaceContext;
  }

  /**
   * Implements the `transportInterface` field of `SkillProjectionContext` so
   * that `isToolActiveForContext` can gate host tools by per-capability
   * `supportsHostProxy(transport, capability)`. Derived from the live turn
   * interface context so it tracks the connected client across turns.
   */
  get transportInterface(): InterfaceId | undefined {
    return this.currentTurnInterfaceContext?.userMessageInterface;
  }

  async persistUserMessage(
    options: PersistMessageOptions,
  ): Promise<{ id: string; deduplicated: boolean }> {
    if (!this._processing) {
      await this.ensureActorScopedHistory();
    }
    return persistUserMessageImpl(this, options);
  }

  // ── Agent Loop ───────────────────────────────────────────────────

  async runAgentLoop(
    content: string,
    userMessageId: string,
    options?: {
      onEvent?: (msg: ServerMessage) => void;
      isInteractive?: boolean;
      isUserMessage?: boolean;
      titleText?: string;
      callSite?: LLMCallSite;
      /**
       * Optional ad-hoc inference-profile override applied to every LLM call
       * the loop issues for this turn. Forwarded into
       * {@link runAgentLoopImpl} and threaded through to
       * {@link AgentLoop.run} so each provider call carries
       * `config.overrideProfile`. Subagents spawned during the turn inherit
       * this value via {@link SubagentManager.spawn}.
       */
      overrideProfile?: string;
      /**
       * See {@link runAgentLoopImpl}: trust this turn runs under. Queue
       * drains and `processMessage` pass the sender's trust captured at turn
       * start so the run is not reset to the conversation's most recent
       * actor.
       */
      turnTrustContext?: TrustContext;
    },
  ): Promise<void> {
    const { onEvent, ...rest } = options ?? {};
    // Snapshot the request id that owns this run. If the loop's own teardown
    // throws before it clears the processing flag, the settle guard in the
    // finally below rescues it — matched on the request id so a queued turn
    // that already started via `drainQueue` is never clobbered. This is the
    // "derive in-progress from actually-live state" invariant: `_processing`
    // cannot outlive the run promise that set it.
    const requestIdAtStart = this.currentRequestId;
    this._activeAgentRunCount++;
    try {
      return await runAgentLoopImpl(
        this,
        content,
        userMessageId,
        onEvent ?? this.sendToClient,
        rest,
      );
    } finally {
      this._activeAgentRunCount--;
      if (requestIdAtStart !== undefined) {
        rescueLeakedProcessing(this, {
          source: "runAgentLoop.settle",
          requestId: requestIdAtStart,
        });
      }
    }
  }

  drainQueue(reason: QueueDrainReason = "loop_complete"): Promise<void> {
    return drainQueueImpl(this, reason);
  }

  async processMessage(options: ProcessMessageOptions): Promise<string> {
    this.cacheWarmAbort?.abort();
    this.cacheWarmAbort = undefined;
    return processMessageImpl(this, {
      ...options,
      onEvent: options.onEvent ?? this.sendToClient,
    });
  }

  // ── Tools ────────────────────────────────────────────────────────

  /**
   * The set of tool names available to this conversation as of its most
   * recent turn — including skill/MCP tools registered over the
   * conversation's lifecycle. Reads the durable {@link lastResolvedToolNames}
   * snapshot the `resolveTools` callback records each turn (which, unlike the
   * per-turn `allowedToolNames` gate, is not cleared at turn teardown); before
   * the first turn it falls back to the core tool set. This is a pure read: it
   * does not re-run `resolveTools`, which has registry/projection side effects
   * that must not fire outside a turn.
   */
  getRegisteredToolNames(): Set<string> {
    return new Set(this.lastResolvedToolNames ?? this.coreToolNames);
  }

  // ── History ──────────────────────────────────────────────────────

  getMessages(): Message[] {
    return this.messages;
  }

  undo(): number {
    return undoImpl(this as HistoryConversationContext);
  }

  // ── Surfaces ─────────────────────────────────────────────────────

  handleSurfaceAction(
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ): Promise<SurfaceActionResult> {
    return handleSurfaceActionImpl(this, surfaceId, actionId, data);
  }

  handleSurfaceUndo(surfaceId: string): void {
    handleSurfaceUndoImpl(this, surfaceId);
  }

  // ── Workspace ────────────────────────────────────────────────────

  markWorkspaceTopLevelDirty(): void {
    this.workspaceTopLevelDirty = true;
  }

  getWorkspaceTopLevelContext(): string | null {
    return this.workspaceTopLevelContext;
  }

  isWorkspaceTopLevelDirty(): boolean {
    return this.workspaceTopLevelDirty;
  }
}
