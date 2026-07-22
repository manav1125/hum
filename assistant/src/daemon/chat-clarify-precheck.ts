/**
 * Pre-run clarify pre-check for DIRECT CHAT turns — the chat-side sibling of
 * the work-item pre-run assessment (`work-items/work-item-assessment.ts`).
 *
 * The work-item assessor only runs on task-queue runs. A direct chat message
 * like "book the flights" therefore gets no clarify: the agent just executes,
 * inferring the trip/dates/travellers from memory and running for minutes on a
 * guess. This module gives an under-specified, CONSEQUENTIAL chat request the
 * same "ask ONE high-value question first" treatment — surgically, so simple
 * turns pay nothing.
 *
 * Two gates, cheapest first:
 *
 *   1. {@link shouldConsiderClarify} — a pure, synchronous heuristic. It fires
 *      ONLY when the message carries a consequential-action signal (booking,
 *      buying, paying, sending, scheduling, cancelling, travel). "what's 2+2"
 *      and "summarise this thread" carry none, so they never reach the model
 *      call — zero added latency on the hot path. This is deliberately the
 *      cheap "is this even worth a look" gate, NOT the under-specification
 *      judge.
 *   2. one cheap flash-tier call (reusing the assessment's verdict + single-
 *      question shape via {@link parseAssessmentResponse}) that decides
 *      execute vs. clarify. It is biased hard toward execute — over-asking in
 *      chat is more annoying than in a task queue — so a clarify only survives
 *      when a wrong guess would genuinely waste minutes or take a consequential
 *      action, and only above a confidence floor.
 *
 * FAIL OPEN, always: no provider, a timeout, a malformed reply, any error →
 * returns null and the turn runs exactly as it does today. The pre-check must
 * never be the reason a chat message did not get answered.
 *
 * On a `clarify`, the caller does NOT build a parallel question surface: it
 * appends a one-line steering directive to the turn telling the agent to ask
 * that ONE question via the existing `ask_question` tool, which renders the
 * existing answerable question card. See `conversation-agent-loop.ts`.
 *
 * Config: `conversations.clarify.{enabled,timeoutMs,minConfidence}`.
 */

import {
  buildCapabilitySnapshot,
  type CapabilitySnapshot,
} from "../capabilities/capability-snapshot.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import type { Message } from "../providers/types.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getLogger } from "../util/logger.js";
import { parseAssessmentResponse } from "../work-items/work-item-assessment.js";

const log = getLogger("chat-clarify-precheck");

// ---------------------------------------------------------------------------
// Gate 1 — the cheap heuristic
// ---------------------------------------------------------------------------

/**
 * Consequential ACTIONS whose wrong inference wastes real time or is hard to
 * undo — the class the work-item assessor guards, applied to chat. Word-
 * boundary matched so "order" in "order of operations" or "post" in
 * "post-mortem" are not caught by the noun senses below.
 */
const CONSEQUENTIAL_ACTION =
  /\b(book|booked|booking|rebook|reserve|reserved|reserving|reservation|buy|buys|buying|bought|purchase|purchases|purchasing|purchased|checkout|pay|pays|paying|invoice|wire|remit|venmo|paypal|subscribe|unsubscribe|resubscribe|reschedule|cancel|cancels|cancelling|canceling|cancelled|rsvp|renew|renewing|order|orders|ordering)\b/i;

/** Travel/ticketing nouns — "book the flights", "get the tickets". */
const TRAVEL =
  /\b(flight|flights|airfare|hotel|hotels|airbnb|ticket|tickets)\b/i;

/**
 * Outbound-communication verbs — sending something on the user's behalf is
 * consequential (it reaches another person). Kept narrower than the noun
 * senses: "message" the noun and "schedule" the noun are common, so only the
 * clearly-imperative send/reply/forward/schedule verbs are listed.
 */
const OUTBOUND_COMMS =
  /\b(email|e-mail|emailing|reply|replying|forward|forwarding|schedule|scheduling|reschedule)\b/i;

/**
 * Self-directed phrasing ("send me", "show me the options") — the "send"/
 * "give" here targets the USER, so it is low-stakes output, not an outbound
 * action. Used to keep a bare "send" from tripping the gate on its own.
 */
const SELF_DIRECTED =
  /\b(send|give|show|get|find|pull|bring)\s+(me|us|it|them|over|back)\b/i;

/** Above this the message is a paste/dump, not a crisp command — skip. */
const MAX_TEXT_CHARS = 2_000;

/**
 * Cheap synchronous gate: is this chat message worth one flash call to check
 * for a needed clarification? True only when a consequential-action signal is
 * present. Pure — no I/O, no config — so it is trivially testable and adds
 * nothing to the hot path for the overwhelming majority of turns.
 */
export function shouldConsiderClarify(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > MAX_TEXT_CHARS) return false;

  if (CONSEQUENTIAL_ACTION.test(t)) return true;
  if (TRAVEL.test(t)) return true;
  // Outbound comms count, but not when the whole request is self-directed
  // ("send me the summary") with no other consequential signal.
  if (OUTBOUND_COMMS.test(t) && !SELF_DIRECTED.test(t)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Gate 2 — the cheap model call
// ---------------------------------------------------------------------------

/** Longest the returned question may be. Matches the work-item cap. */
const MAX_QUESTION_CHARS = 300;

/** Exported for tests; production callers go through {@link assessChatClarify}. */
export function buildChatClarifyPrompt(
  userText: string,
  capabilities: CapabilitySnapshot,
): string {
  return [
    `Today is ${new Date().toString()}.`,
    "",
    "The user just sent Cue (an AI assistant) the chat message below. Cue is about to act on it autonomously — it may run web searches, browse the web, control the user's Mac, send messages on linked accounts, or spend several minutes of work.",
    "",
    "Decide whether the message is specific enough to act on, or whether acting would require GUESSING something only the user can decide (which trip, which dates, which travellers, which recipient, which account, which item) where a WRONG guess would waste real time or take a consequential/irreversible action.",
    "",
    `MESSAGE: ${userText.trim()}`,
    "",
    capabilities.lines.length > 0
      ? `WHAT CUE CAN DO RIGHT NOW:\n${capabilities.lines.map((l) => `- ${l}`).join("\n")}`
      : "WHAT CUE CAN DO RIGHT NOW: unknown — assume a capable general assistant.",
    capabilities.connectors.length > 0
      ? `LINKED ACCOUNTS: ${capabilities.connectors.join(", ")}`
      : "LINKED ACCOUNTS: none linked.",
    "",
    "Cue also searches the user's personal memory (people, preferences, past trips, past work, past conversations) during the turn, so missing general background about the user is NOT a reason to ask.",
    "",
    "Reply with ONLY a JSON object, no prose:",
    '{"verdict": "execute" | "clarify", "understanding": "<one plain sentence naming what you understand the request to be>", "question": "<the ONE question you need answered — required for clarify>", "confidence": <0-1>}',
    "",
    "How to choose:",
    "- execute: this is the DEFAULT, and when in doubt you choose it. The message is clear enough to act on, OR any guess is cheap and reversible, OR you can produce a draft/plan the user reacts to. Broad-but-doable requests (\"research options\", \"draft the reply\", \"summarise this\") are execute.",
    "- clarify: acting would require guessing something only the user can decide AND getting it wrong would waste minutes or take a consequential/irreversible action (booking, buying, paying, sending, scheduling, cancelling). Give exactly ONE question — the single highest-value one, phrased the way you would ask a colleague. Never a list, never a question the message already answers.",
    "",
    "confidence: how sure you are that a clarifying question is genuinely needed, 0-1. Be honest — a low number is better than an annoying question.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Injectable model — takes the built prompt, returns the model's raw text (or
 * null when no assessment could be made). Production uses the flash-tier
 * side-chain; tests inject a deterministic stub.
 */
export type ChatClarifyModel = (
  prompt: string,
  opts: { timeoutMs: number },
) => Promise<string | null>;

const flashClarifyModel: ChatClarifyModel = async (prompt, { timeoutMs }) => {
  const provider = await getConfiguredProvider("conversationTitle");
  if (!provider) return null;
  const config = getConfig();
  const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
  const result = await runBtwSidechain({
    content: prompt,
    provider,
    systemPrompt:
      "You are a pre-run clarification checker for chat requests. Reply with ONLY the requested JSON object.",
    messages: [],
    tools: [],
    callSite: "conversationTitle",
    maxTokens: resolved.maxTokens,
    timeoutMs,
  });
  return result.text;
};

/**
 * Hard deadline over the whole check (provider resolution + the call), so a
 * key-less or stalled daemon cannot hold a chat turn behind the pre-check.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      if (typeof timer === "object") timer.unref?.();
    }),
  ]);
}

export interface ChatClarifyResult {
  /** The ONE clarifying question to ask the user before running. */
  question: string;
  confidence: number;
}

/**
 * Run the chat clarify pre-check for one user message. Returns the single
 * clarifying question when — and only when — the heuristic flags the message
 * AND the model returns a confident `clarify`. Returns null in every other
 * case (disabled, not consequential, execute verdict, low confidence, no
 * provider, timeout, parse failure, error): the caller then runs the turn
 * unchanged.
 */
export async function assessChatClarify(
  userText: string,
  model: ChatClarifyModel = flashClarifyModel,
): Promise<ChatClarifyResult | null> {
  try {
    const cfg = getConfig().conversations.clarify;
    if (!cfg.enabled) return null;

    // Gate 1 — cheap heuristic. The overwhelming majority of turns stop here
    // with zero added latency.
    if (!shouldConsiderClarify(userText)) return null;

    // Gate 2 — one cheap flash call.
    const capabilities = buildCapabilitySnapshot();
    const prompt = buildChatClarifyPrompt(userText, capabilities);

    let lastFailure = "no reply";
    const text = await withDeadline(
      model(prompt, { timeoutMs: cfg.timeoutMs }).catch((err: unknown) => {
        lastFailure = String(err);
        return null;
      }),
      cfg.timeoutMs,
    );
    if (!text) {
      log.debug(
        { reason: lastFailure },
        "chat clarify pre-check produced no reply (running unclarified)",
      );
      return null;
    }

    // Reuse the assessment parser + its precision guards (a clarify with no
    // question degrades to execute, so it never parks a turn with nothing to
    // ask). `notAiTaskMinConfidence` is irrelevant here — the chat prompt only
    // ever returns execute/clarify.
    const parsed = parseAssessmentResponse(text, {
      notAiTaskMinConfidence: 1,
    });
    if (!parsed || parsed.verdict !== "clarify" || !parsed.question) {
      return null;
    }

    // Confidence floor — bias hard toward execute. A low-confidence clarify is
    // exactly the annoying over-ask the hot path must avoid.
    if (parsed.confidence < cfg.minConfidence) {
      log.debug(
        { confidence: parsed.confidence, floor: cfg.minConfidence },
        "chat clarify below confidence floor (running unclarified)",
      );
      return null;
    }

    return {
      question: parsed.question.slice(0, MAX_QUESTION_CHARS),
      confidence: parsed.confidence,
    };
  } catch (err) {
    log.debug(
      { err: String(err) },
      "chat clarify pre-check failed (running unclarified)",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Steering directive
// ---------------------------------------------------------------------------

/**
 * The one-line directive appended to the turn's tail user message when a
 * clarify fires. It does NOT answer for the user or fabricate progress — it
 * routes the agent to the EXISTING `ask_question` tool (which renders the
 * existing answerable question card) and tells it to stop until answered, so
 * no parallel question surface is built.
 */
export function buildClarifyDirective(question: string): string {
  return [
    "<clarify_directive>",
    "This request looks under-specified for an action with real consequences. Before doing ANY work on it — no web searches, no browsing, no actions — call the `ask_question` tool to ask the user exactly this ONE question, then stop and wait for their answer:",
    question.trim(),
    "If, after re-reading the message and the context above, the answer is actually already clear, ignore this and proceed.",
    "</clarify_directive>",
  ].join("\n");
}

/**
 * Append the clarify directive as a text block on the tail user message,
 * mirroring the runtime-injection `append-user-tail` placement. Pure and
 * non-mutating: returns a new array (unchanged when the tail is not a user
 * message, so it can never corrupt an unexpected history shape). The directive
 * is a one-shot steering nudge for THIS run only — it is not persisted, so it
 * does not linger in the durable history.
 */
export function appendClarifyDirective(
  messages: Message[],
  question: string,
): Message[] {
  const tail = messages[messages.length - 1];
  if (!tail || tail.role !== "user") return messages;
  const textBlock = { type: "text" as const, text: buildClarifyDirective(question) };
  return [
    ...messages.slice(0, -1),
    { ...tail, content: [...tail.content, textBlock] },
  ];
}
