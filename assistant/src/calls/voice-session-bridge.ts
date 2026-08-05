/**
 * Bridge between voice relay and the daemon conversation pipeline.
 *
 * Provides a `startVoiceTurn()` function that manages a voice turn
 * directly through the conversation, translating agent-loop events into
 * simple callbacks suitable for real-time TTS streaming.
 *
 * Dependency injection follows the same module-level setter pattern used by
 * setRelayBroadcast in relay-server.ts: the daemon lifecycle injects
 * dependencies at startup via `setVoiceBridgeDeps()`.
 */

import { consumeGrantForInvocation } from "../approvals/approval-primitive.js";
import type {
  ChannelId,
  InterfaceId,
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import type { Conversation } from "../daemon/conversation.js";
import { resolveChannelCapabilities } from "../daemon/conversation-runtime-assembly.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { TrustContext } from "../daemon/trust-context.js";
import {
  deleteMessageById,
  getMessageById,
  updateMessageContent,
} from "../memory/conversation-crud.js";
import type { ContentBlock } from "../providers/types.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import { getAllTools } from "../tools/registry.js";
import { summarizeToolInput } from "../tools/tool-input-summary.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import {
  CALL_OPENING_MARKER,
  CALL_VERIFICATION_COMPLETE_MARKER,
  ESCALATE_VERDICT_TOKEN,
  HOLD_VERDICT_TOKEN,
  MINIMIZE_ROOM_MARKER,
  stripInternalSpeechMarkers,
} from "./voice-control-protocol.js";
import {
  escalatedContinuationRule,
  ESCALATION_CONTINUATION_CONTENT,
  frontDoorCapabilityDigest,
  frontDoorDecisionRule,
  spokenBridgeText,
  type VoiceRoutingLeg,
} from "./voice-triage-escalate.js";

const log = getLogger("voice-session-bridge");

/**
 * Front-door decision rule with the registry-derived capability digest. The
 * front-door leg runs toolless (see the `toolsDisabledDepth` bracket in
 * `startVoiceTurn`), so the digest is its only knowledge of what the
 * escalated leg can do. Registry unavailability degrades to the bare rule.
 * `includeHold` adds the mid-thought verdict branch (unified front-door
 * speculative legs only).
 */
function frontDoorRuleWithDigest(
  includeHold: boolean,
  callerUtterance?: string,
): string {
  let toolNames: string[] = [];
  try {
    toolNames = getAllTools().map((tool) => tool.name);
  } catch {
    // Tool registry not initialized (e.g. unit tests): digest-less rule.
  }
  return frontDoorDecisionRule({
    includeHold,
    capabilityDigest: frontDoorCapabilityDigest(toolNames),
    ...(callerUtterance !== undefined ? { callerUtterance } : {}),
  });
}

// ---------------------------------------------------------------------------
// Module-level dependency injection
// ---------------------------------------------------------------------------

export interface VoiceBridgeDeps {
  getOrCreateConversation: (
    conversationId: string,
    transport?: {
      channelId: ChannelId;
      hints?: string[];
      uxBrief?: string;
    },
  ) => Promise<Conversation>;
  resolveAttachments: (attachmentIds: string[]) => Array<{
    id: string;
    filename: string;
    mimeType: string;
    data: string;
    filePath?: string;
  }>;
}

let deps: VoiceBridgeDeps | undefined;

/**
 * Inject dependencies from daemon lifecycle.
 * Must be called during daemon startup before any voice turns are executed.
 */
export function setVoiceBridgeDeps(d: VoiceBridgeDeps): void {
  deps = d;
}

/**
 * Pending teardown of the most recent voice turn, per conversation id.
 *
 * The processing lock releases inside the agent loop's own `finally`, BEFORE
 * the bridge's `finally` runs `cleanup()` (per-turn conversation state reset)
 * and the transcript-hygiene pass. A next leg that starts on the lock release
 * alone — the escalated leg of a front-door hand-off, or a hold-replay leg —
 * could install its per-turn state and then have the prior leg's cleanup null
 * it mid-turn, or snapshot history the hygiene pass is still rewriting. The
 * next turn awaits this promise (bounded) so teardown always completes first.
 */
const pendingTurnTeardowns = new Map<string, Promise<void>>();

/** Bounded wait for a prior voice turn's teardown to settle. */
const TEARDOWN_WAIT_MS = 3000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Real-time event sink for voice TTS streaming. Agent-loop events are
 * forwarded here for real-time text-to-speech without modifying the
 * standard channel path.
 */
export interface VoiceRunEventSink {
  onTextDelta(
    msg: Extract<ServerMessage, { type: "assistant_text_delta" }>,
  ): void;
  onMessageComplete(
    msg: Extract<
      ServerMessage,
      { type: "message_complete" } | { type: "generation_cancelled" }
    >,
  ): void;
  onError(message: string): void;
  onToolUse(toolName: string, input: Record<string, unknown>): void;
}

export interface VoiceTurnCallbacks {
  assistant_text_delta?: (
    msg: Extract<ServerMessage, { type: "assistant_text_delta" }>,
  ) => void;
  message_complete?: (
    msg: Extract<
      ServerMessage,
      { type: "message_complete" } | { type: "generation_cancelled" }
    >,
  ) => void;
  persisted_user_message_id?: (messageId: string) => void;
  persisted_assistant_message_id?: (messageId: string) => void;
  /**
   * Visual surface events produced by the agent loop during this turn (e.g. the
   * `ui_show` tool). Non-phone voice clients forward these to the live-voice
   * socket as `card` frames so results render inline alongside the spoken reply.
   * The SSE broadcast is unaffected — these callbacks are additive.
   */
  ui_surface_show?: (
    msg: Extract<ServerMessage, { type: "ui_surface_show" }>,
  ) => void;
  ui_surface_update?: (
    msg: Extract<ServerMessage, { type: "ui_surface_update" }>,
  ) => void;
  ui_surface_dismiss?: (
    msg: Extract<ServerMessage, { type: "ui_surface_dismiss" }>,
  ) => void;
  /**
   * A tool this turn has actually started executing. Already observed here (it
   * is the `tool_use_start` logged below and handed to the phone event sink);
   * this callback simply lets a non-phone voice client see the same fact.
   *
   * It exists so a voice surface can say what it is doing IN WORDS while it
   * thinks. Without it the only honest thing a call screen can render during a
   * long tool call is an unattributed wait, because the alternative — guessing
   * a plausible activity — is a caption that is confidently wrong whenever the
   * guess misses.
   */
  tool_use_start?: (
    msg: Extract<ServerMessage, { type: "tool_use_start" }>,
  ) => void;
}

/**
 * A confirmation this voice turn left pending for the user to answer instead
 * of deciding it (`approvalMode: "local-live-voice"` only). The payload is
 * what a voice surface needs to present the moment; resolution stays on the
 * ordinary `POST /v1/confirm` path.
 */
export interface VoicePendingApprovalEvent {
  requestId: string;
  toolName: string;
  /** Risk level from the confirmation request. */
  riskLevel: string;
  /** Redacted tool input, as broadcast on the confirmation request. */
  input: Record<string, unknown>;
  /** Short human summary of the input, when derivable (may be empty). */
  summary: string;
}

/**
 * How a pending voice approval was decided, mapped from the conversation's
 * `confirmation_state_changed` states:
 * `approved` / `denied` — a decision landed (voice card, chat card, or a
 * channel bridge); `expired` — the prompter's own timeout fired (the
 * chat-surface expiry, `timeouts.permissionTimeoutSec`); `superseded` — the
 * request was resolved out from under the wait (stale tap, a newer message's
 * deny-all, system cancellation).
 */
export type VoiceApprovalOutcome =
  | "approved"
  | "denied"
  | "expired"
  | "superseded";

/** Map a confirmation_state_changed state to a voice approval outcome. */
function voiceApprovalOutcomeForState(
  state: "pending" | "approved" | "denied" | "timed_out" | "resolved_stale",
): VoiceApprovalOutcome | null {
  switch (state) {
    case "approved":
      return "approved";
    case "denied":
      return "denied";
    case "timed_out":
      return "expired";
    case "resolved_stale":
      return "superseded";
    case "pending":
      return null;
  }
}

export interface VoiceTurnOptions {
  /** The conversation ID for this voice call's session. */
  conversationId: string;
  /** Voice session ID for scoped grant matching. Defaults to callSessionId. */
  voiceSessionId?: string;
  /** The call session ID for scoped grant matching. */
  callSessionId?: string;
  /** Source channel for persisted user messages. Defaults to phone. */
  userMessageChannel?: ChannelId;
  /** Source channel for persisted assistant messages. Defaults to userMessageChannel. */
  assistantMessageChannel?: ChannelId;
  /** Source interface for persisted user messages. Defaults to phone. */
  userMessageInterface?: InterfaceId;
  /** Source interface for persisted assistant messages. Defaults to userMessageInterface. */
  assistantMessageInterface?: InterfaceId;
  /** Per-turn control prompt. Undefined uses the phone prompt; null disables it. */
  voiceControlPrompt?: string | null;
  /** The transcribed caller utterance or synthetic marker. */
  content: string;
  /** Assistant scope for multi-assistant channels. */
  assistantId?: string;
  /** Guardian trust context for the caller. */
  trustContext?: TrustContext;
  /** Permission handling mode. Defaults to phone-call auto policy. */
  approvalMode?: "phone-call" | "local-live-voice";
  /**
   * Skill IDs to preactivate for this turn so their tools are available
   * immediately, without a `skill_load` round-trip. Live voice uses this to give
   * the assistant its common capabilities (tasks, schedule, contacts, …) on the
   * first turn — both for capability and to cut latency.
   */
  preactivatedSkillIds?: string[];
  /** Whether this is an inbound call (no outbound task). */
  isInbound: boolean;
  /** The outbound call task, if any. */
  task?: string | null;
  /** When true, skip the disclosure announcement for this call. */
  skipDisclosure?: boolean;
  /** Called for each streaming text token from the agent loop. */
  onTextDelta?: (text: string) => void;
  /** Called when the agent loop completes a full response. */
  onComplete?: () => void;
  /** Called when the agent loop encounters an error. */
  onError?: (message: string) => void;
  /** Event-name callbacks used by non-phone voice clients. */
  callbacks?: VoiceTurnCallbacks;
  /**
   * Called when this turn leaves a confirmation for the user to answer
   * instead of deciding it (`approvalMode: "local-live-voice"` only), so the
   * voice client can put the prompt where the caller can see it — the
   * live-voice room is a full-screen overlay, and the approval card renders
   * in the app behind it. The bridge cannot reach a client's own surfaces,
   * so it reports THAT a decision is waiting (with the presentation payload)
   * and the session decides what to do about it.
   */
  onApprovalPending?: (approval: VoicePendingApprovalEvent) => void;
  /**
   * Called when a confirmation previously reported via
   * {@link VoiceTurnOptions.onApprovalPending} is decided, however it was
   * decided — the user answered (any surface), the chat-surface expiry timed
   * it out, or it was superseded. Fires once per request, with the outcome.
   */
  onApprovalResolved?: (
    requestId: string,
    outcome: VoiceApprovalOutcome,
  ) => void;
  /** Optional AbortSignal for external cancellation (e.g. barge-in). */
  signal?: AbortSignal;
  /**
   * Which leg of a triaged turn this is (unified front-door routing, V-1c).
   * `"front-door"` runs toolless on the `voiceFrontDoor` call site with the
   * verdict-first decision rule appended to its control prompt;
   * `"escalated"` runs the ordinary call-agent resolution with the
   * continuation rule appended. Undefined = routing off; the turn runs
   * exactly as before (the phone channel never sets this).
   */
  routingLeg?: VoiceRoutingLeg;
  /**
   * The holding phrase the caller actually heard before this leg started
   * (the front-door leg's own capped bridge, or the canned fallback).
   * Quoted verbatim in the escalated continuation rule so the quality model
   * knows the exact words already spoken and does not re-announce them.
   * Only meaningful with `routingLeg: "escalated"`.
   */
  spokenEscalationBridge?: string;
  /**
   * Marks this turn's `content` as an internal instruction rather than user
   * speech: it persists `hidden` so `/messages` filters it after a reload.
   * Set by callers whose synthetic prompt text is not a fixed sentinel.
   */
  hiddenSyntheticPrompt?: boolean;
  /**
   * Unified front-door: this leg was dispatched speculatively at a silence
   * boundary, so its decision rule includes the hold branch (leading token
   * `[0]` = the caller is mid-thought). Only ever set on front-door legs —
   * a leg that doesn't know the hold token can't accidentally emit it, and
   * a leg that does must be one whose leading tokens are interpreted.
   */
  unifiedVerdict?: boolean;
}

export interface VoiceTurnHandle {
  /** Unique identifier for this turn. */
  turnId: string;
  /** Abort the in-flight turn (e.g. for barge-in). */
  abort: () => void;
  /**
   * Abort the turn AND roll back its persisted user message, restoring the
   * conversation to its pre-turn state (delete row + reload in-memory
   * history, then notify sync consumers). The leg's reserved assistant row
   * is removed too, by the teardown transcript-hygiene pass once the agent
   * loop settles. Used by the unified front-door hold verdict: a
   * mid-thought pause must leave no trace of the fragment in history.
   * Idempotent; safe to call after abort. Optional so the PHONE PATH and
   * test doubles aren't forced to model rollback — a missing discard
   * degrades to abort-without-rollback.
   */
  discard?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Call-control protocol prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the call-control protocol prompt injected into each voice turn.
 *
 * This contains the marker protocol rules that the model needs to emit
 * control markers during voice calls. It intentionally omits the "You are
 * on a live phone call" framing (the session system prompt already
 * provides assistant identity) and guardian context (injected separately).
 */
function buildVoiceCallControlPrompt(opts: {
  isInbound: boolean;
  task?: string | null;
  isCallerGuardian?: boolean;
  skipDisclosure?: boolean;
}): string {
  const config = getConfig();
  const disclosureEnabled =
    config.calls?.disclosure?.enabled === true && !opts.skipDisclosure;
  const disclosureText = config.calls?.disclosure?.text?.trim();
  const disclosureRule =
    disclosureEnabled && disclosureText
      ? opts.isInbound
        ? `0. ${disclosureText} This is an inbound call you are answering, so rewrite any disclosure naturally for pickup context. Do NOT say "I'm calling", "I called you", or "I'm calling on behalf of".`
        : `0. ${disclosureText}`
      : "0. Begin the conversation naturally.";

  const lines: string[] = ["<voice_call_control>"];

  if (!opts.isInbound && opts.task) {
    lines.push(`Task: ${opts.task}`);
    lines.push("");
  }

  // Inbound receptionist persona (calls.receptionist.persona) — shapes how Cue
  // presents itself when answering. Kept out of the outbound path (outbound
  // behaviour is driven by the per-call Task above).
  const receptionistPersona = opts.isInbound
    ? config.calls?.receptionist?.persona?.trim()
    : undefined;
  if (receptionistPersona) {
    lines.push(
      `Receptionist persona: ${receptionistPersona}`,
      "Embody this persona for the whole call — it governs your tone, how you introduce yourself, and what you will and won't do. It never overrides the safety and guardian-consult rules below.",
      "",
    );
  }

  lines.push(
    "CALL PROTOCOL RULES:",
    disclosureRule,
    "1. Be concise — keep responses to 1-3 sentences. Phone conversations should be brief and natural.",
    ...(opts.isCallerGuardian
      ? [
          "2. You are speaking directly with your guardian (your user). Do NOT use [ASK_GUARDIAN:]. If you need permission, information, or confirmation, ask them directly in the conversation. They can answer you right now.",
        ]
      : [
          [
            "2. You can consult your guardian in two ways:",
            "   - For general questions or information: [ASK_GUARDIAN: your question here]",
            '   - For tool/action permission requests: [ASK_GUARDIAN_APPROVAL: {"question":"Describe what you need permission for","toolName":"the_tool_name","input":{...tool input object...}}]',
            '   Use ASK_GUARDIAN_APPROVAL when you need permission to execute a specific tool or action. Use ASK_GUARDIAN for everything else (general questions, advice, information). When you use either marker, add a natural hold message like "Let me check on that for you."',
          ].join("\n"),
        ]),
  );

  if (opts.isInbound) {
    lines.push(
      "3. If information is provided preceded by [USER_ANSWERED: ...], use that answer naturally in the conversation.",
      "4. If you see [USER_INSTRUCTION: ...], treat it as a high-priority steering directive from your user. Follow the instruction immediately, adjusting your approach or response accordingly.",
      "5. When the caller indicates they are done or the conversation reaches a natural conclusion, include [END_CALL] in your response along with a polite goodbye.",
    );
  } else {
    lines.push(
      "3. If the callee provides information preceded by [USER_ANSWERED: ...], use that answer naturally in the conversation.",
      "4. If you see [USER_INSTRUCTION: ...], treat it as a high-priority steering directive from your user. Follow the instruction immediately, adjusting your approach or response accordingly.",
      "5. When the call's purpose is fulfilled, include [END_CALL] in your response along with a polite goodbye.",
    );
  }

  lines.push(
    '6. When caller text includes [SPEAKER id="..." label="..."], treat each speaker as a distinct person and personalize responses using that speaker\'s prior context in this call.',
  );

  if (opts.isInbound) {
    if (opts.isCallerGuardian) {
      lines.push(
        '7. If the latest user turn is "(call connected — deliver opening greeting)", this is your user calling you. Answer casually and briefly, like picking up a call from someone you know well. For example: "Hey!" or "What\'s up?" Do NOT introduce yourself, do NOT say you are calling on behalf of anyone, and do NOT ask how you can help in a formal way. Keep it short and natural.',
      );
    } else {
      lines.push(
        '7. If the latest user turn is "(call connected — deliver opening greeting)", this is an inbound call you are answering (not a call you initiated). Greet the caller warmly and ask how you can help. Introduce yourself once at the start using your assistant name if you know it (for example: "Hey there, this is Ava, Sam\'s assistant. How can I help?"). If your assistant name is not known, skip the name and just identify yourself as the guardian\'s assistant. Never use a UUID-shaped internal assistant ID as your spoken name. Do NOT say "I\'m calling" or "I\'m calling on behalf of". Vary the wording; do not use a fixed template.',
      );
    }
    lines.push(
      "8. If the latest user turn includes [CALL_OPENING_ACK], treat it as the caller acknowledging your greeting and continue the conversation naturally.",
    );
  } else {
    const disclosureReminder =
      disclosureEnabled && disclosureText
        ? " However, the disclosure text from rule 0 is separate from self-introduction and must always be included in your opening greeting, even if the Task does not mention introducing yourself."
        : "";
    lines.push(
      '7. If the latest user turn is "(verification completed — transitioning into conversation)", the caller just completed a phone verification code challenge on this call. Greet them naturally and ask if there is anything you can help with. Keep it casual and brief.',
      `If the latest user turn is "(call connected — deliver opening greeting)", deliver your opening greeting based solely on the Task context above. The Task already describes how to open the call — follow it directly without adding any extra introduction on top. If the Task says to introduce yourself, do so once. If the Task does not mention introducing yourself, skip the introduction.${disclosureReminder} Vary the wording naturally; do not use a fixed template.`,
      "8. If the latest user turn includes [CALL_OPENING_ACK], treat it as the callee acknowledging your opener and continue the conversation naturally without re-introducing yourself or repeating the initial check-in question.",
    );
  }

  lines.push(
    "9. After the opening greeting turn, treat the Task field as background context only — do not re-execute its instructions on subsequent turns.",
    '10. Do not make up information. If you are unsure, use [ASK_GUARDIAN: your question] to consult your guardian. For tool permission requests, use [ASK_GUARDIAN_APPROVAL: {"question":"...","toolName":"...","input":{...}}].',
    `11. Your text is sent directly to a text-to-speech engine. Never use markdown formatting (asterisks, headers, backticks, links) or emojis in your spoken responses. Write plain conversational text only. Protocol markers like ${opts.isCallerGuardian ? "[END_CALL]" : "[ASK_GUARDIAN: ...] and [END_CALL]"} are not spoken text and should still be used normally.`,
    "</voice_call_control>",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Transcript hygiene
// ---------------------------------------------------------------------------

/**
 * Parse a persisted message row's `content` string into content blocks.
 * Assistant rows store `JSON.stringify(ContentBlock[])`; a plain-text or
 * single-object payload is wrapped so the hygiene pass can treat every row
 * uniformly.
 */
function parseRowContentBlocks(content: string): ContentBlock[] {
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed as ContentBlock[];
    }
    if (parsed !== null && typeof parsed === "object") {
      return [parsed as ContentBlock];
    }
    return [{ type: "text", text: String(parsed) }];
  } catch {
    return [{ type: "text", text: content }];
  }
}

/** The concatenated text of a row's text blocks. */
function joinedTextOfBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

/**
 * Strip internal speech markers from every text block, dropping text blocks
 * the strip leaves empty; non-text blocks pass through untouched. Shared by
 * the front-door stray-token rewrite and the terminal minimize-marker
 * rewrite.
 */
function stripMarkersFromBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const kept: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type !== "text") {
      kept.push(block);
      continue;
    }
    const cleaned = stripInternalSpeechMarkers(block.text);
    if (cleaned.trim().length > 0) {
      kept.push({ ...block, text: cleaned });
    }
  }
  return kept;
}

/**
 * Remove the terminal MINIMIZE_ROOM_MARKER from the end of a row's text,
 * walking text blocks from the last one backward so a marker split across
 * block boundaries (e.g. `"Done [-"` + `"1]"`) is removed whole — the
 * per-block strip in {@link stripMarkersFromBlocks} only sees fragments and
 * would leave both halves in place. Callers must have established that the
 * row's joined text ends with the marker after trimming trailing whitespace.
 */
function stripTerminalMinimizeMarker(blocks: ContentBlock[]): ContentBlock[] {
  const result = blocks.map((block) => ({ ...block }));
  const joined = joinedTextOfBlocks(result);
  const cutAt = joined.trimEnd().length - MINIMIZE_ROOM_MARKER.length;
  let blockEnd = joined.length;
  for (let i = result.length - 1; i >= 0 && blockEnd > cutAt; i--) {
    const block = result[i]!;
    if (block.type !== "text") {
      continue;
    }
    const blockStart = blockEnd - block.text.length;
    block.text = block.text.slice(0, Math.max(0, cutAt - blockStart));
    blockEnd = blockStart;
  }
  return result;
}

/**
 * Trim whitespace stranded at a rewritten row's outer edges by a stripped
 * edge marker (e.g. "Done, take a look [-1]"), leaving inter-block spacing
 * untouched.
 */
function trimOuterTextEdges(blocks: ContentBlock[]): ContentBlock[] {
  const result = blocks.map((block) => ({ ...block }));
  for (const block of result) {
    if (block.type === "text") {
      block.text = block.text.trimStart();
      break;
    }
  }
  for (let i = result.length - 1; i >= 0; i--) {
    const block = result[i]!;
    if (block.type === "text") {
      block.text = block.text.trimEnd();
      break;
    }
  }
  return result;
}

/**
 * Reduce a front-door leg's persisted content to what was actually spoken
 * under the verdict-first protocol.
 *
 * Returns null when the content carries no verdict token (a committed
 * front-door answer — nothing to do). A leg that led with
 * `ESCALATE_VERDICT_TOKEN` reduces to a single text block holding the
 * capped bridge; empty spoken text means the caller heard only the canned
 * fallback bridge, which is audio-only and never a transcript row, so the
 * caller should delete the row. Stray verdict tokens elsewhere in an
 * answer were never spoken (the live gate strips them) and are stripped
 * from the persisted text to match.
 */
export function cutFrontDoorContentAtVerdict(
  blocks: ContentBlock[],
): { blocks: ContentBlock[]; spokenText: string } | null {
  const joinedText = joinedTextOfBlocks(blocks);
  if (joinedText.trimStart().startsWith(ESCALATE_VERDICT_TOKEN)) {
    const spokenText = spokenBridgeText(joinedText);
    return {
      blocks: spokenText.length > 0 ? [{ type: "text", text: spokenText }] : [],
      spokenText,
    };
  }
  if (
    !joinedText.includes(ESCALATE_VERDICT_TOKEN) &&
    !joinedText.includes(HOLD_VERDICT_TOKEN)
  ) {
    return null;
  }
  const kept = stripMarkersFromBlocks(blocks);
  const spokenText = joinedTextOfBlocks(kept).trim();
  return { blocks: kept, spokenText };
}

// ---------------------------------------------------------------------------
// startVoiceTurn
// ---------------------------------------------------------------------------

/**
 * Execute a single voice turn through the daemon conversation pipeline.
 *
 * Manages the conversation directly with voice-specific defaults:
 *   - sourceChannel: 'phone'
 *   - event sink wired to the provided callbacks
 *   - abort propagated from the returned handle
 *
 * The caller (CallController via relay-server) can use the returned handle
 * to cancel the turn on barge-in.
 */
export async function startVoiceTurn(
  opts: VoiceTurnOptions,
): Promise<VoiceTurnHandle> {
  if (!deps) {
    throw new Error(
      "Voice bridge not initialized — setVoiceBridgeDeps() was not called",
    );
  }

  const eventSink: VoiceRunEventSink = {
    onTextDelta: (msg) => {
      opts.onTextDelta?.(msg.text);
      opts.callbacks?.assistant_text_delta?.(msg);
    },
    onMessageComplete: (msg) => {
      opts.onComplete?.();
      opts.callbacks?.message_complete?.(msg);
      if (
        msg.type === "message_complete" &&
        msg.messageId &&
        msg.source !== "aux"
      ) {
        try {
          opts.callbacks?.persisted_assistant_message_id?.(msg.messageId);
        } catch (err) {
          log.warn(
            { err, messageId: msg.messageId },
            "Voice turn assistant-message callback threw",
          );
        }
      }
    },
    onError: (message) => {
      opts.onError?.(message);
    },
    onToolUse: (toolName, input) => {
      log.debug({ toolName, input }, "Voice turn tool_use event");
    },
  };

  // Phone voice has no interactive permission/secret UI, so apply explicit
  // per-role policies by default. Local live voice opts into the normal
  // client approval path instead. Side-effect double-defense
  // (forcePromptSideEffects) is wired inside the agent-loop IIFE so it
  // is always paired with cleanup() in the IIFE's finally.
  const trustClass = opts.trustContext?.trustClass;
  const isGuardian = trustClass === "guardian";
  const approvalMode = opts.approvalMode ?? "phone-call";
  const usesLocalInteractiveApprovals = approvalMode === "local-live-voice";
  const voiceSessionId = opts.voiceSessionId ?? opts.callSessionId;
  const turnChannelContext: TurnChannelContext = {
    userMessageChannel: opts.userMessageChannel ?? "phone",
    assistantMessageChannel:
      opts.assistantMessageChannel ?? opts.userMessageChannel ?? "phone",
  };
  const turnInterfaceContext: TurnInterfaceContext = {
    userMessageInterface: opts.userMessageInterface ?? "phone",
    assistantMessageInterface:
      opts.assistantMessageInterface ?? opts.userMessageInterface ?? "phone",
  };

  // Replace the [CALL_OPENING] marker with a neutral instruction before
  // persisting. The marker must not appear as a user message in conversation
  // history — after a barge-in interruption the next turn would replay
  // the stale marker and potentially retrigger opener behavior.
  const persistedContent =
    opts.content === CALL_OPENING_MARKER
      ? "(call connected — deliver opening greeting)"
      : opts.content === CALL_VERIFICATION_COMPLETE_MARKER
        ? "(verification completed — transitioning into conversation)"
        : opts.content;

  // Build the call-control protocol prompt so the model knows how to emit
  // control markers (ASK_GUARDIAN, END_CALL, etc.) and recognize opener turns.
  const isCallerGuardian = opts.trustContext?.trustClass === "guardian";

  let voiceCallControlPrompt =
    opts.voiceControlPrompt === undefined
      ? buildVoiceCallControlPrompt({
          isInbound: opts.isInbound,
          task: opts.task,
          isCallerGuardian,
          skipDisclosure: opts.skipDisclosure,
        })
      : opts.voiceControlPrompt;

  // Triage-and-escalate routing rules (unified front door, V-1c). The
  // caller-supplied live-voice prompt bypasses buildVoiceCallControlPrompt,
  // so the leg rule is appended here — without it the front-door leg would
  // run on the fast call site but never learn the verdict protocol, so it
  // could not hold or hand off to the escalated leg. The front-door rule
  // quotes the caller's utterance (JSON-serialized — it is caller-controlled
  // STT text) so the model judges exactly those words.
  const routingLegRule =
    opts.routingLeg === "front-door"
      ? frontDoorRuleWithDigest(opts.unifiedVerdict === true, opts.content)
      : opts.routingLeg === "escalated"
        ? escalatedContinuationRule(opts.spokenEscalationBridge)
        : null;
  if (voiceCallControlPrompt != null && routingLegRule) {
    voiceCallControlPrompt = `${voiceCallControlPrompt}\n\n${routingLegRule}`;
  }

  // The escalation-continuation prompt is a pure internal instruction ("give
  // the full answer now"), not a real utterance — persist it `hidden` so
  // `/messages` filters it out after a refetch/reload. The escalated model
  // still sees the row in context; `hidden` only affects client display. A
  // caller whose prompt text is not a fixed sentinel opts into the same
  // treatment with `hiddenSyntheticPrompt`.
  const isHiddenSyntheticPrompt =
    opts.hiddenSyntheticPrompt === true ||
    opts.content === ESCALATION_CONTINUATION_CONTENT;

  // Get or create the conversation
  const transport = {
    channelId: turnChannelContext.userMessageChannel,
  };
  const conversation = await deps.getOrCreateConversation(
    opts.conversationId,
    transport,
  );

  if (conversation.isProcessing()) {
    // Voice barge-in can race with turn teardown. Wait briefly for the
    // previous turn to finish aborting before giving up.
    const maxWaitMs = 3000;
    const pollIntervalMs = 50;
    let waited = 0;
    while (conversation.isProcessing() && waited < maxWaitMs) {
      if (opts.signal?.aborted) {
        throw new Error("Turn aborted while waiting for conversation");
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      waited += pollIntervalMs;
    }
    if (opts.signal?.aborted) {
      throw new Error("Turn aborted while waiting for conversation");
    }
    if (conversation.isProcessing()) {
      throw new Error("Conversation is already processing a message");
    }
  }

  // The prior voice leg's teardown (per-turn state cleanup + transcript
  // hygiene) runs AFTER the processing lock releases; wait it out — bounded —
  // so this leg neither has its installed state clobbered by the prior leg's
  // cleanup nor snapshots history mid-rewrite. On timeout proceed anyway (the
  // teardown is best-effort and a wedged prior leg must not dead-lock voice).
  const priorTeardown = pendingTurnTeardowns.get(opts.conversationId);
  if (priorTeardown) {
    await Promise.race([
      priorTeardown,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TEARDOWN_WAIT_MS);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (opts.signal?.aborted) {
      throw new Error("Turn aborted while waiting for conversation");
    }
  }

  // Hoisted so the catch below can clear partially-applied turn state
  // when a setter or `persistUserMessage` throws — otherwise `trustContext`,
  // `callSessionId`, etc. leak into subsequent non-voice turns on the same
  // conversation. The client callback is only reset when this turn actually
  // installed it (tracked via `clientCallbackInstalled`); otherwise cleanup
  // would detach an active sender installed by a prior turn.
  let clientCallbackInstalled = false;
  /**
   * Confirmations this local-live-voice turn left pending for the user. Used
   * to scope the `confirmation_state_changed` observation in the client
   * handler below: only requests this turn announced via `onApprovalPending`
   * report a resolution, so unrelated interactions (secrets, host proxies,
   * another surface's confirmations) never produce a spurious voice
   * `approval_resolved`.
   */
  const pendingVoiceApprovals = new Set<string>();
  const cleanup = () => {
    // Stop reporting approval resolutions once the turn is over; the
    // session-side teardown owes its client any `approval_resolved` for
    // requests still pending at that point (superseded semantics).
    pendingVoiceApprovals.clear();
    conversation.setChannelCapabilities(null);
    conversation.setTrustContext(null);
    conversation.setCommandIntent(null);
    conversation.setAssistantId("self");
    conversation.setVoiceCallControlPrompt(null);
    conversation.callSessionId = undefined;
    conversation.forcePromptSideEffects = false;
    if (clientCallbackInstalled) {
      // Reset the client callback to a no-op so the stale closure doesn't
      // intercept events from future turns on the same conversation.
      conversation.updateClient(() => {}, true);
    }
  };

  const requestId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  let messageId: string;
  try {
    conversation.setAssistantId(
      opts.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
    );
    conversation.callSessionId = voiceSessionId;
    conversation.setTrustContext(opts.trustContext ?? null);
    conversation.setCommandIntent(null);
    conversation.setTurnChannelContext(turnChannelContext);
    conversation.setTurnInterfaceContext?.(turnInterfaceContext);
    conversation.setChannelCapabilities(
      resolveChannelCapabilities(
        turnChannelContext.userMessageChannel,
        turnInterfaceContext.userMessageInterface,
      ),
    );
    conversation.setVoiceCallControlPrompt(voiceCallControlPrompt);
    if (opts.preactivatedSkillIds && opts.preactivatedSkillIds.length > 0) {
      conversation.preactivatedSkillIds = opts.preactivatedSkillIds;
    }

    const persistResult = await conversation.persistUserMessage({
      content: persistedContent,
      requestId,
      // Durable voice marker: every user turn that enters through the voice
      // bridge (live-voice sessions and phone calls) is stamped so clients
      // can render voice-originated turns distinctly after a history reload.
      // Metadata only — capability resolution stays driven by the
      // channel/interface contexts above.
      metadata: {
        voiceTurn: true,
        ...(isHiddenSyntheticPrompt ? { hidden: true } : {}),
      },
    });
    messageId = persistResult.id;
  } catch (err) {
    cleanup();
    throw err;
  }
  try {
    opts.callbacks?.persisted_user_message_id?.(messageId);
  } catch (err) {
    log.warn(
      { err, turnId, messageId },
      "Voice turn persisted-message callback threw",
    );
  }

  // Hook into conversation to intercept confirmation_request and secret_request events.
  // Voice auto-denies/auto-allows/auto-resolves these since there's no interactive UI.
  const autoDeny = !isGuardian;
  const autoAllow = isGuardian;
  let lastError: string | null = null;
  conversation.updateClient(async (msg: ServerMessage) => {
    if (msg.type === "confirmation_state_changed") {
      // A decision landed on a request this turn put to the user — however it
      // landed: the user answered (`approved`/`denied`, from the voice card,
      // the chat card, or a channel bridge), the prompter's own timeout fired
      // (`timed_out` — the chat-surface expiry, which stays the single owner
      // of the confirmation's final consequence), or something resolved it
      // out from under the wait (`resolved_stale`). Report it once so the
      // voice session can stand narration back up and tell its client.
      const outcome = voiceApprovalOutcomeForState(msg.state);
      if (outcome !== null && pendingVoiceApprovals.delete(msg.requestId)) {
        try {
          opts.onApprovalResolved?.(msg.requestId, outcome);
        } catch (err) {
          log.warn(
            { err, turnId, requestId: msg.requestId },
            "Voice turn onApprovalResolved callback threw",
          );
        }
      }
      // Fall through to the broadcast below — chat surfaces keep seeing the
      // state change exactly as before.
    }
    if (msg.type === "confirmation_request") {
      if (usesLocalInteractiveApprovals) {
        // Register only when the emitter did not. PermissionPrompter (the
        // tool pipeline AND the proxy/network prompters) registers its own
        // entry — with the RPC lifecycle: rpcResolve, the expiry timer,
        // toolUseId — BEFORE sending this event; overwriting that entry here
        // would strand the executor's `await prompt()` forever, because
        // `POST /v1/confirm` would resolve a callback-less shell instead.
        if (!pendingInteractions.get(msg.requestId)) {
          pendingInteractions.register(msg.requestId, {
            conversationId: opts.conversationId,
            kind: "confirmation",
            confirmationDetails: {
              toolName: msg.toolName,
              input: msg.input,
              riskLevel: msg.riskLevel,
              executionTarget: msg.executionTarget,
              allowlistOptions: msg.allowlistOptions,
              scopeOptions: msg.scopeOptions,
              persistentDecisionsAllowed: msg.persistentDecisionsAllowed,
              acpToolKind: msg.acpToolKind,
              acpOptions: msg.acpOptions,
            },
          });
        }
        broadcastMessage(msg);
        // The request is left pending (the whole point of this mode: the
        // approval card attached clients render is answerable), and the
        // voice session is told a decision is waiting so the call can
        // present it — a card behind a full-screen call overlay is a
        // decision nobody can see.
        pendingVoiceApprovals.add(msg.requestId);
        try {
          opts.onApprovalPending?.({
            requestId: msg.requestId,
            toolName: msg.toolName,
            riskLevel: msg.riskLevel,
            input: msg.input,
            // msg.input is already redacted at emission
            // (PermissionPrompter applies redactSensitiveFields), so the
            // summary is safe to put on the wire.
            summary: summarizeToolInput(msg.toolName, msg.input),
          });
        } catch (err) {
          log.warn(
            { err, turnId, requestId: msg.requestId },
            "Voice turn onApprovalPending callback threw",
          );
        }
        return;
      }
      if (autoDeny) {
        // Non-guardian voice callers have no interactive approval UI.
        // The pre-exec gate (tool-approval-handler.ts) handles grant
        // consumption with retry for tool execution confirmations, but
        // some confirmation_request events originate from proxy/network
        // paths (e.g. PermissionPrompter in createProxyApprovalCallback)
        // that bypass the pre-exec gate. We do a single sync lookup here
        // (maxWaitMs: 0) since the primary retry path is in the pre-exec
        // gate; this secondary path just needs a quick check.
        try {
          const inputDigest = computeToolApprovalDigest(
            msg.toolName,
            msg.input,
          );
          const consumeResult = await consumeGrantForInvocation(
            {
              requestId: msg.requestId,
              toolName: msg.toolName,
              inputDigest,
              consumingRequestId: msg.requestId,
              executionChannel: turnChannelContext.userMessageChannel,
              conversationId: opts.conversationId,
              callSessionId: voiceSessionId,
              requesterExternalUserId:
                opts.trustContext?.requesterExternalUserId,
            },
            { maxWaitMs: 0 },
          );

          if (consumeResult.ok) {
            log.info(
              {
                turnId,
                toolName: msg.toolName,
                grantId: consumeResult.grant.id,
              },
              "Consumed scoped grant — allowing non-guardian voice confirmation",
            );
            conversation.handleConfirmationResponse(msg.requestId, "allow", {
              decisionContext: `Permission approved for "${msg.toolName}": guardian pre-approved via scoped grant.`,
            });
            broadcastMessage(msg);
            return;
          }
        } catch (err) {
          log.error(
            { err, turnId, toolName: msg.toolName },
            "Error consuming grant in voice confirmation handler — falling through to deny",
          );
        }

        log.info(
          { turnId, toolName: msg.toolName },
          "Auto-denying confirmation request for non-guardian voice turn (no matching scoped grant)",
        );
        conversation.handleConfirmationResponse(msg.requestId, "deny", {
          decisionContext: `Permission denied for "${msg.toolName}": this voice call does not have interactive approval capabilities. Side-effect tools are not available for non-guardian voice callers. In your next assistant reply, explain briefly that this action requires guardian-level access and cannot be performed during this call.`,
        });
        broadcastMessage(msg);
        return;
      }
      if (autoAllow) {
        log.info(
          { turnId, toolName: msg.toolName },
          "Auto-approving confirmation request for guardian voice turn",
        );
        conversation.handleConfirmationResponse(msg.requestId, "allow", {
          decisionContext: `Permission approved for "${msg.toolName}": this is a verified guardian voice call.`,
        });
        broadcastMessage(msg);
        return;
      }
    } else if (msg.type === "secret_request") {
      if (usesLocalInteractiveApprovals) {
        // Local live voice runs alongside the desktop client, which has a
        // secret-entry UI (SecretPromptManager). Forward the broadcast and
        // let the prompter's existing registration handle the response.
        broadcastMessage(msg);
        return;
      }
      // Phone voice has no secret-entry UI, so resolve immediately.
      log.info(
        { turnId, service: msg.service, field: msg.field },
        "Auto-resolving secret request for voice turn (no secret-entry UI)",
      );
      conversation.handleSecretResponse(msg.requestId, undefined, "store");
      return;
    }
    broadcastMessage(msg);
  });
  clientCallbackInstalled = true;

  // Pairs the front-door leg's toolsDisabledDepth increment with its
  // decrement in the IIFE's finally, even when runAgentLoop throws.
  let frontDoorToolsSuppressed = false;

  // The reserved assistant row of the leg's LLM call, captured from
  // `assistant_turn_start`. Voice legs are single-call in practice (the
  // front-door leg is toolless), so the last id observed is the leg's
  // transcript row — the target of the teardown transcript-hygiene pass.
  let reservedAssistantRowId: string | null = null;
  // Set by the handle's discard(): the whole leg must leave no trace.
  let discarded = false;

  /**
   * Teardown transcript hygiene. Runs after the agent loop has fully settled
   * (the loop's own tail settles the debounced partial-content flush first,
   * so a zombie flush timer can no longer rewrite the row after this pass —
   * see `settlePendingPartialFlush` in conversation-agent-loop):
   *
   * - A discarded leg (unified front-door hold verdict) deletes its
   *   reserved assistant row: `discard` already rolled back the user row,
   *   and without this a stray row holding the leg's unspoken partial
   *   output (typically the bare hold token) survives.
   * - A front-door leg that escalated reduces to its capped spoken bridge —
   *   never the verdict token or the text streamed past the cap. A row with
   *   no spoken bridge (canned-fallback case — that bridge is audio-only) is
   *   deleted.
   * - Any leg whose row ENDS with the `[-1]` minimize marker (swallowed
   *   before TTS on the live path) has its text blocks rewritten through
   *   `stripInternalSpeechMarkers` so the marker never renders in the chat
   *   transcript. Deliberately scoped to that marker: rows without it
   *   persist byte-identical.
   *
   * After a rewrite, in-memory history is reloaded from the clean DB so the
   * escalated leg's snapshot never sees the marker text either. Best-effort:
   * a hiccup here must not escalate into a turn-level failure.
   */
  const finalizeVoiceLegTranscript = async (): Promise<void> => {
    if (reservedAssistantRowId == null) {
      if (discarded || opts.routingLeg === "front-door") {
        // A leg the pass should cover never announced a reserved row: either
        // the leg died before its LLM call, or `assistant_turn_start` did not
        // reach this bridge — the latter would leave raw verdict tokens in
        // the transcript, so make the skip loud.
        log.warn(
          { turnId, routingLeg: opts.routingLeg ?? null, discarded },
          "Voice leg transcript hygiene skipped: no reserved row observed",
        );
      }
      return;
    }
    try {
      let action = "none";
      if (discarded) {
        deleteMessageById(reservedAssistantRowId);
        action = "delete_discarded";
      } else {
        const row = getMessageById(reservedAssistantRowId, opts.conversationId);
        const blocks = row ? parseRowContentBlocks(row.content) : null;
        const cut =
          blocks && opts.routingLeg === "front-door"
            ? cutFrontDoorContentAtVerdict(blocks)
            : null;
        if (!row || !blocks) {
          action = "row_missing";
        } else if (cut) {
          if (cut.spokenText.length > 0) {
            updateMessageContent(
              reservedAssistantRowId,
              JSON.stringify(cut.blocks),
            );
            action = "rewrite_spoken";
          } else {
            deleteMessageById(reservedAssistantRowId);
            action = "delete_empty";
          }
        } else if (
          // Terminal position only — mirrors the live holdback latch: a
          // reply whose CONTENT contains "[-1]" mid-text never acted on it,
          // so its transcript keeps that content untouched too. Front-door
          // answer rows (no verdict token to cut) take this branch as well.
          joinedTextOfBlocks(blocks).trimEnd().endsWith(MINIMIZE_ROOM_MARKER)
        ) {
          // Terminal marker first (boundary-aware — it may span text
          // blocks), then the per-block strip for any interior complete
          // markers.
          const cleaned = trimOuterTextEdges(
            stripMarkersFromBlocks(stripTerminalMinimizeMarker(blocks)),
          );
          // A marker-only reply strips to nothing at all; keeping the row
          // would render a blank assistant bubble, so delete it like the
          // front-door empty case. Any surviving block — including non-text
          // blocks like tool_use — keeps the row.
          if (cleaned.length === 0) {
            deleteMessageById(reservedAssistantRowId);
            action = "delete_empty";
          } else {
            updateMessageContent(
              reservedAssistantRowId,
              JSON.stringify(cleaned),
            );
            action = "strip_minimize_marker";
          }
        }
      }
      // Main legs run the pass on every voice turn; keep the no-op case
      // out of the logs.
      const isMainLegNoOp =
        action === "none" && !discarded && opts.routingLeg !== "front-door";
      if (!isMainLegNoOp) {
        log.info(
          {
            turnId,
            messageId: reservedAssistantRowId,
            routingLeg: opts.routingLeg ?? null,
            discarded,
            action,
          },
          "Voice leg transcript hygiene",
        );
      }
      if (action !== "none" && action !== "row_missing") {
        await conversation.loadFromDb();
        publishConversationMessagesChanged(opts.conversationId);
      }
    } catch (err) {
      log.warn(
        { err, turnId, messageId: reservedAssistantRowId },
        "Voice leg transcript hygiene failed",
      );
    }
  };

  // Registered before the agent loop starts so the NEXT leg on this
  // conversation waits for this turn's `finally` (cleanup + transcript
  // hygiene) — not just the processing-flag release — before installing its
  // own per-turn state.
  let resolveTeardown!: () => void;
  const teardownSettled = new Promise<void>((resolve) => {
    resolveTeardown = resolve;
  });
  pendingTurnTeardowns.set(opts.conversationId, teardownSettled);
  const settleTurnTeardown = () => {
    if (pendingTurnTeardowns.get(opts.conversationId) === teardownSettled) {
      pendingTurnTeardowns.delete(opts.conversationId);
    }
    resolveTeardown();
  };

  // Fire-and-forget the agent loop
  void (async () => {
    try {
      // Non-guardian phone voice forces side-effect tools to prompt so the
      // auto-deny handler above reliably sees a confirmation_request. Without
      // this, a broad allow trust rule (e.g. wildcard bash) would let
      // side-effect tools execute without ever emitting an event for the
      // auto-deny / scoped-grant handler to intercept. Set inside the
      // try/finally so a failed setup before this point cannot leak the
      // flag into subsequent non-voice turns on the same conversation.
      conversation.forcePromptSideEffects =
        !isGuardian && !usesLocalInteractiveApprovals;
      // The front-door leg runs toolless: no schemas on the wire and the
      // executor gate closed (the shared depth-counter bracket). Anything
      // needing a tool must escalate — the capability digest in its control
      // prompt tells it what the escalated leg can do.
      if (opts.routingLeg === "front-door") {
        conversation.toolsDisabledDepth++;
        frontDoorToolsSuppressed = true;
      }
      await conversation.runAgentLoop(persistedContent, messageId, {
        onEvent: (msg: ServerMessage) => {
          if (msg.type === "assistant_turn_start") {
            reservedAssistantRowId = msg.messageId;
          }
          if (msg.type === "error") {
            lastError = msg.message;
          } else if (msg.type === "conversation_error") {
            lastError = msg.userMessage;
          }
          broadcastMessage(msg);

          // Forward voice-relevant events to the real-time event sink
          if (msg.type === "assistant_text_delta") {
            eventSink.onTextDelta(msg);
          } else if (msg.type === "message_complete") {
            eventSink.onMessageComplete(msg);
          } else if (msg.type === "generation_cancelled") {
            // Treat cancellation as a completed turn so the voice
            // turnComplete promise settles instead of hanging forever.
            eventSink.onMessageComplete(msg);
          } else if (msg.type === "error") {
            eventSink.onError(msg.message);
          } else if (msg.type === "conversation_error") {
            eventSink.onError(msg.userMessage);
          } else if (msg.type === "tool_use_start") {
            // info-level so prod logs show whether the voice brain actually
            // invokes tools (web_search, ui_show, …) vs. narrating from memory.
            log.info(
              { turnId, toolName: msg.toolName },
              "Voice turn tool_use_start",
            );
            eventSink.onToolUse(msg.toolName, msg.input);
            opts.callbacks?.tool_use_start?.(msg);
          } else if (msg.type === "ui_surface_show") {
            // Additive to the SSE broadcast above: also hand visual surfaces to
            // the voice client so `ui_show` results render inline as cards.
            log.info(
              {
                turnId,
                surfaceType: msg.surfaceType,
                surfaceId: msg.surfaceId,
              },
              "Voice turn forwarding ui_surface card",
            );
            opts.callbacks?.ui_surface_show?.(msg);
          } else if (msg.type === "ui_surface_update") {
            opts.callbacks?.ui_surface_update?.(msg);
          } else if (msg.type === "ui_surface_dismiss") {
            opts.callbacks?.ui_surface_dismiss?.(msg);
          }
          // Note: tool_use_preview_start is intentionally not handled here.
          // Voice only reacts to the definitive tool_use_start event.
        },
        // Front-door legs resolve through their own call site, whose shipped
        // default pins the fast verdict model (see call-site-defaults.ts
        // `voiceFrontDoor`); every other leg keeps the callAgent resolution.
        callSite:
          opts.routingLeg === "front-door" ? "voiceFrontDoor" : "callAgent",
      });
      if (lastError) {
        log.error(
          { turnId, error: lastError },
          "Voice turn failed (error event from agent loop)",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, turnId }, "Voice turn failed");
      eventSink.onError(message);
    } finally {
      if (frontDoorToolsSuppressed) {
        conversation.toolsDisabledDepth--;
      }
      cleanup();
      await finalizeVoiceLegTranscript();
      settleTurnTeardown();
    }
  })();

  const abortFn = () => {
    if (conversation.currentRequestId === requestId) {
      conversation.abort(
        createAbortReason(
          "voice_session_aborted",
          "voice-session-bridge.abortFn",
          conversation.conversationId,
        ),
      );
    }
  };

  // If the caller provided an external AbortSignal (e.g. from a
  // RelayConnection's AbortController), wire it to the turn's abort.
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortFn();
    } else {
      opts.signal.addEventListener("abort", () => abortFn(), { once: true });
    }
  }

  const discardFn = async () => {
    if (discarded) {
      return;
    }
    discarded = true;
    abortFn();
    try {
      // Same rollback pattern upstream uses: delete the row, then rebuild
      // in-memory history from the clean DB (a plain pop is fragile against
      // concurrent compaction reassigning the array), then notify sync
      // consumers so attached clients drop the fragment too.
      deleteMessageById(messageId);
      await conversation.loadFromDb();
      publishConversationMessagesChanged(opts.conversationId);
    } catch (err) {
      log.warn(
        { err, turnId, messageId },
        "Voice turn discard could not roll back the persisted user message",
      );
    }
  };

  return {
    turnId,
    abort: abortFn,
    discard: discardFn,
  };
}
