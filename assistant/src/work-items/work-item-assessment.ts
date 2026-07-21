/**
 * Pre-run assessment for work items — "understand → decide → narrate".
 *
 * Today every task runs the same generic agent turn, whether or not Cue
 * understands it, whether or not the task is even something software can do,
 * and whether or not the run has the context to do it well. The honest failure
 * mode is plausible garbage: a confident answer to a question Cue misread.
 *
 * So before the execution turn, ONE cheap flash-tier call reads exactly what
 * the run itself will read — the task title/notes, the assembled context
 * preamble (project brief, attached knowledge files, the task's own context),
 * the capabilities Cue actually has right now, and how the last run of this
 * item went — and returns a typed verdict:
 *
 *   - `execute`     — Cue understands it and has what it needs. Comes with a
 *                     1–2 line plain-words PLAN, persisted and narrated as the
 *                     run starts, so a running task stops being a black box.
 *   - `clarify`     — under-specified. Exactly ONE high-value question. The
 *                     item parks with the question surfaced instead of running
 *                     and producing something plausible-but-wrong. Answering it
 *                     (as task context) changes the input hash, which re-opens
 *                     assessment on the next run.
 *   - `not_ai_task` — genuinely a human action ("sign the lease in person").
 *                     Marked honestly so surfaces can stop offering a
 *                     misleading Run button.
 *   - `blocked`     — needs one specific missing thing (a connector not linked,
 *                     a file not attached, an access it lacks), named exactly so
 *                     the UI can offer the fix.
 *
 * Design rules this module is built to:
 *
 *   - CHEAP. One call, flash tier (the `conversationTitle` call site capture
 *     triage and the auto-filer already use), hard-deadlined, and cached per
 *     item by an input hash — repeat dispatches and re-renders cost nothing.
 *   - FAIL OPEN. No provider, a timeout, a malformed reply, a DB error: the
 *     assessment returns null and the run proceeds exactly as it did before
 *     this module existed. Assessment must never be the reason a user's task
 *     did not run.
 *   - PRECISION OVER CLEVERNESS. A wrong `not_ai_task` (Cue refusing work it
 *     could do) is worse than an extra question, so a low-confidence
 *     `not_ai_task` is softened, and a verdict that arrives without its
 *     required payload (a `clarify` with no question, a `blocked` with no
 *     missing thing) degrades to `execute` rather than parking the item with
 *     nothing to show the user.
 *
 * Config: `workItems.assessment.{enabled,gate,timeoutMs,notAiTaskMinConfidence}`.
 */

import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { getDb } from "../memory/db-connection.js";
import { oauthConnections } from "../memory/schema/oauth.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getRegisteredToolNames } from "../tasks/tool-sanitizer.js";
import { getLogger } from "../util/logger.js";
import { recordWorkItemEvent } from "./work-item-events.js";
import {
  getWorkItem,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";

const log = getLogger("work-item-assessment");

// ---------------------------------------------------------------------------
// Verdict shape
// ---------------------------------------------------------------------------

export const WORK_ITEM_VERDICTS = [
  "execute",
  "clarify",
  "not_ai_task",
  "blocked",
] as const;

export type WorkItemVerdict = (typeof WORK_ITEM_VERDICTS)[number];

export interface WorkItemAssessment {
  verdict: WorkItemVerdict;
  /** One plain sentence: what Cue understood the task to be. */
  understanding: string | null;
  /** 1–2 lines of what Cue will actually do. Set with `execute`. */
  plan: string | null;
  /** Exactly ONE question. Set with `clarify`. */
  question: string | null;
  /** The one specific missing thing. Set with `blocked`. */
  missing: string | null;
  /** 0–1 confidence in the verdict. */
  confidence: number;
  /** Hash of the inputs this verdict was derived from (the cache key). */
  inputHash: string;
  /** Epoch ms the verdict was produced. */
  assessedAt: number;
}

/** Longest each narration field may be once persisted. */
const MAX_UNDERSTANDING_CHARS = 240;
const MAX_PLAN_CHARS = 400;
const MAX_QUESTION_CHARS = 300;
const MAX_MISSING_CHARS = 240;

// ---------------------------------------------------------------------------
// Capability snapshot
// ---------------------------------------------------------------------------

/**
 * What Cue can actually do right now, in the words the assessor needs to judge
 * "is this a human-only task?" honestly. Derived from the LIVE tool registry
 * and the linked-account table — never a hardcoded belief about the product.
 */
export interface CapabilitySnapshot {
  /** Human capability lines fed to the assessor. */
  lines: string[];
  /** Linked account providers ("google", "slack", …). */
  connectors: string[];
  /** Stable fingerprint — part of the assessment cache key. */
  fingerprint: string;
}

/**
 * Capability probes: a human line, and the tool-name segments whose presence
 * in the live registry proves Cue has it. Segment-matched (names split on
 * non-alphanumerics) rather than substring-matched, so `sort_order` never
 * reads as `order`.
 */
const CAPABILITY_PROBES: ReadonlyArray<{
  line: string;
  segments: readonly string[];
  /**
   * Extra check for capabilities whose tool can be registered while the thing
   * it talks to is not set up. Absent = the tool existing is proof enough.
   * Throwing counts as not configured — an overclaim is worse than an
   * underclaim, because the assessor turns claims into promises.
   */
  configured?: () => boolean;
}> = [
  {
    line: "search the web and read web pages",
    segments: ["web", "search", "fetch"],
  },
  {
    line: "drive a real web browser (open sites, fill forms, click through flows)",
    segments: ["browser"],
  },
  {
    line: "see and control the user's Mac — apps, windows, clicking and typing (computer use)",
    segments: ["computer", "cu"],
  },
  {
    line: "run shell commands and read/write files on the user's Mac",
    segments: ["host"],
  },
  {
    line: "read and write files in its own workspace (drafts, documents, data files)",
    segments: ["file"],
  },
  {
    // Gated on real credentials, not on the tool existing. A registered call
    // tool with no Twilio account behind it made the assessor promise to
    // "call the dentist's office and speak with the receptionist" — the exact
    // kind of confident, undeliverable plan this whole pass exists to stop.
    line: "place and take phone calls",
    segments: ["call", "phone", "sms"],
    configured: () => {
      const twilio = getConfig().twilio;
      return Boolean(twilio?.accountSid && twilio?.phoneNumber);
    },
  },
  {
    line: "send messages on the channels the user has connected",
    segments: ["message", "send"],
  },
  {
    line: "recall the user's personal memory — people, preferences, past work",
    segments: ["recall", "remember", "memory"],
  },
  {
    line: "run its installed skills (specialised procedures for particular jobs)",
    segments: ["skill"],
  },
  {
    line: "schedule work to happen later",
    segments: ["schedule", "cron", "reminder"],
  },
];

function toolNameSegments(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Build the live capability snapshot. Never throws: a registry or DB failure
 * degrades to an empty snapshot, which the prompt reports honestly as
 * "unknown" rather than asserting Cue can't do things it can.
 */
export function buildCapabilitySnapshot(): CapabilitySnapshot {
  let segments = new Set<string>();
  try {
    for (const tool of getRegisteredToolNames()) {
      for (const segment of toolNameSegments(tool)) segments.add(segment);
    }
  } catch (err) {
    log.debug(
      { err: String(err) },
      "tool registry unavailable for capability snapshot",
    );
    segments = new Set<string>();
  }

  const lines = CAPABILITY_PROBES.filter((probe) => {
    if (!probe.segments.some((segment) => segments.has(segment))) return false;
    if (!probe.configured) return true;
    try {
      return probe.configured();
    } catch (err) {
      log.debug(
        { err: String(err), line: probe.line },
        "capability probe unreadable — treating as not configured",
      );
      return false;
    }
  }).map((probe) => probe.line);

  let connectors: string[] = [];
  try {
    // Read the connection table directly rather than through the oauth store:
    // this is a read-only capability probe, and the store sits in the daemon's
    // heavily interlinked startup graph.
    const rows = getDb()
      .select({ provider: oauthConnections.provider })
      .from(oauthConnections)
      .where(eq(oauthConnections.status, "active"))
      .all();
    connectors = [...new Set(rows.map((r) => r.provider))].sort();
  } catch (err) {
    log.debug(
      { err: String(err) },
      "connections unavailable for capability snapshot",
    );
  }

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ lines, connectors }))
    .digest("hex")
    .slice(0, 16);

  return { lines, connectors, fingerprint };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** Everything the assessor reads about one item. */
export interface AssessmentInput {
  item: Pick<
    WorkItem,
    "id" | "title" | "notes" | "sourceType" | "lastRunStatus"
  >;
  /**
   * The run's assembled context preamble — the SAME string the execution turn
   * receives (project brief, attached knowledge file paths, task context).
   * Empty string when the item carries no context at all; the prompt says so
   * explicitly, which is what makes a context-less task assess differently
   * from the same task inside a briefed project.
   */
  contextPreamble: string;
  capabilities: CapabilitySnapshot;
  /** One line about how the previous run of this item went, when there was one. */
  priorRunNote?: string | null;
}

/** Cap on how much of the run preamble is quoted into the assessment prompt. */
const PREAMBLE_SNIPPET_CHARS = 2_000;
/** Cap on how much of an item's notes are quoted. */
const NOTES_SNIPPET_CHARS = 600;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Exported for tests; production callers go through {@link assessWorkItem}. */
export function buildAssessmentPrompt(input: AssessmentInput): string {
  const { item, capabilities } = input;
  const preamble = input.contextPreamble.trim();

  return [
    `Today is ${new Date().toString()}.`,
    "",
    "A task is about to be handed to Cue's agent to execute autonomously.",
    "Your job is to decide, BEFORE that happens, whether Cue understands the task and can actually do it with the context below.",
    "",
    `TASK: ${item.title}`,
    item.notes ? `DETAILS: ${clip(item.notes, NOTES_SNIPPET_CHARS)}` : "",
    item.sourceType ? `CAPTURED FROM: ${item.sourceType}` : "",
    input.priorRunNote ? `PREVIOUS RUN: ${input.priorRunNote}` : "",
    "",
    preamble
      ? `CONTEXT THE RUN WILL RECEIVE:\n${clip(preamble, PREAMBLE_SNIPPET_CHARS)}`
      : "CONTEXT THE RUN WILL RECEIVE: none — no project brief, no attached files, no task notes. The agent will see only the task line above.",
    "",
    capabilities.lines.length > 0
      ? `WHAT CUE CAN DO RIGHT NOW:\n${capabilities.lines.map((l) => `- ${l}`).join("\n")}`
      : "WHAT CUE CAN DO RIGHT NOW: unknown — assume a capable general assistant.",
    capabilities.connectors.length > 0
      ? `LINKED ACCOUNTS: ${capabilities.connectors.join(", ")}`
      : "LINKED ACCOUNTS: none linked.",
    "",
    "Cue also searches the user's personal memory (people, preferences, past work, past conversations) during the run, so missing general background about the user is NOT a reason to ask a question.",
    "",
    "Reply with ONLY a JSON object, no prose:",
    '{"verdict": "execute" | "clarify" | "not_ai_task" | "blocked", "understanding": "<one plain sentence naming what you understand the task to be>", "plan": "<1-2 sentences, plain words, of what you will actually do — required for execute>", "question": "<the ONE question you need answered — required for clarify>", "missing": "<the ONE specific thing you lack — required for blocked>", "confidence": <0-1>}',
    "",
    "How to choose:",
    '- execute: you understand the task and have what you need. This is the DEFAULT. A broad but doable task ("draft a summary", "research options", "write the follow-up") is execute — do the work and let the user react to a draft. In the plan, name the specific things you will use (a file from project knowledge, a linked account, the web) so the user can see whether you understood.',
    "- clarify: you would have to GUESS something only the user can decide — which of several things they mean, which recipient or account, what the deliverable actually is. Give exactly ONE question, the highest-value one, phrased the way you would ask a colleague. Never a list, never a question the context above already answers.",
    "- not_ai_task: only a human can do this — it needs the user's physical presence, body, signature in person, or their own judgement call. BE CAREFUL and read the capability list: Cue can browse, drive a browser, control the Mac, place phone calls, send messages on linked accounts, and write, research and design. If Cue could plausibly do it, or a useful part of it, do NOT use not_ai_task. When torn between not_ai_task and clarify, ALWAYS choose clarify.",
    "  One firm exception: moving money (paying, wiring, transferring, buying, trading) and signing or legally committing on the user's behalf are ALWAYS the user's own action, however the task is phrased and whatever accounts are linked. Verdict not_ai_task, and in the plan-less case say plainly that you can prepare it but they send it. Preparing the groundwork — finding the amount, drafting the transfer details, assembling the invoice — is normal work and can be its own execute task.",
    '- blocked: doing it needs one specific thing Cue does not have — an account that is not linked, a file that was not attached, an access it lacks. Name exactly that one thing in "missing". Do not use blocked for things you could simply look up or ask about.',
    "",
    "confidence: how sure you are of the verdict itself, 0-1. Be honest — a low number is better than a wrong verdict.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// Parsing + precision guards
// ---------------------------------------------------------------------------

function firstString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max).trim()}…` : trimmed;
}

/**
 * Keep a `clarify` question to ONE question. Models like to append "Also, …?"
 * — when several question sentences come back, only the first survives, so the
 * user is never handed a checklist where a single decision was promised.
 */
export function toSingleQuestion(text: string): string {
  const marks = [...text.matchAll(/\?/g)];
  if (marks.length <= 1) return text.trim();
  const end = marks[0].index! + 1;
  return text.slice(0, end).trim();
}

export interface ParseAssessmentOptions {
  /** Below this, a `not_ai_task` verdict is softened. */
  notAiTaskMinConfidence: number;
}

/**
 * Parse the assessor's JSON reply into a verdict, applying the precision
 * guards. Returns null when nothing usable came back — the caller then treats
 * the item as unassessed and runs it (fail-open).
 */
export function parseAssessmentResponse(
  text: string,
  opts: ParseAssessmentOptions,
): Omit<WorkItemAssessment, "inputHash" | "assessedAt"> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const raw = parsed as Record<string, unknown>;
  const rawVerdict = typeof raw.verdict === "string" ? raw.verdict.trim() : "";
  if (!(WORK_ITEM_VERDICTS as readonly string[]).includes(rawVerdict)) {
    return null;
  }

  let verdict = rawVerdict as WorkItemVerdict;
  const understanding = firstString(raw.understanding, MAX_UNDERSTANDING_CHARS);
  const plan = firstString(raw.plan, MAX_PLAN_CHARS);
  const rawQuestion = firstString(raw.question, MAX_QUESTION_CHARS);
  const question = rawQuestion ? toSingleQuestion(rawQuestion) : null;
  const missing = firstString(raw.missing, MAX_MISSING_CHARS);
  const numeric = Number(raw.confidence);
  const confidence = Number.isFinite(numeric)
    ? Math.min(1, Math.max(0, numeric))
    : 0.5;

  // Precision guard 1 — a wrong `not_ai_task` is the worst outcome (Cue
  // refusing work it could have done), so an unsure one is softened: to a
  // question when the model gave one, otherwise to a plain run.
  if (verdict === "not_ai_task" && confidence < opts.notAiTaskMinConfidence) {
    verdict = question ? "clarify" : "execute";
  }

  // Precision guard 2 — never park an item with nothing to show the user. A
  // `clarify` without a question or a `blocked` without a missing thing is an
  // incomplete answer, not a reason to hold the user's task back.
  if (verdict === "clarify" && !question) verdict = "execute";
  if (verdict === "blocked" && !missing) verdict = "execute";

  return {
    verdict,
    understanding,
    // A plan only means something for a run that is going to happen; carrying
    // one on a parked verdict would let a surface show "here's what I'll do"
    // next to "I'm not doing this".
    plan: verdict === "execute" ? plan : null,
    question: verdict === "clarify" ? question : null,
    missing: verdict === "blocked" ? missing : null,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

/**
 * The human line written to the item's trail and stamped as its live progress
 * note. Derived only from what the assessor actually returned — when a field
 * is missing the line says less, it never invents more.
 */
export function narrationForAssessment(
  assessment: Pick<
    WorkItemAssessment,
    "verdict" | "understanding" | "plan" | "question" | "missing"
  >,
): string {
  const understanding = assessment.understanding;
  switch (assessment.verdict) {
    case "execute":
      if (assessment.plan) {
        return understanding
          ? `Understood: ${understanding} Plan: ${assessment.plan}`
          : `Plan: ${assessment.plan}`;
      }
      return understanding
        ? `Understood: ${understanding}`
        : "Understood the task; starting.";
    case "clarify":
      return `Cue needs you: ${assessment.question ?? "one detail is missing."}`;
    case "not_ai_task":
      return understanding
        ? `This one is yours to do: ${understanding}`
        : "This one is yours to do — it needs a person, not Cue.";
    case "blocked":
      return `Blocked — ${assessment.missing ?? "something Cue needs is missing."}`;
  }
}

/** The short line stamped on `lastProgressNote` while the assessment runs. */
export const ASSESSING_PROGRESS_NOTE = "Understanding the task";

/**
 * Whether a non-`execute` verdict may actually hold a run back
 * (`workItems.assessment.gate`, default true). Off is the observe-first
 * position: verdicts are still produced, persisted and narrated, but every run
 * proceeds. Read at call time so the switch works without a restart, and
 * defaults to ON when config is unreadable — a verdict Cue produced is honest
 * whether or not the config file loads.
 */
export function isAssessmentGateEnabled(): boolean {
  try {
    return getConfig().workItems.assessment.gate;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

/**
 * Injectable assessor — takes the built prompt, returns the model's raw text
 * (or null when no assessment could be made). Production uses the flash-tier
 * side-chain; tests inject a deterministic stub and can inspect the prompt
 * they were handed.
 */
export type AssessmentModel = (
  prompt: string,
  opts: { timeoutMs: number },
) => Promise<string | null>;

const flashAssessmentModel: AssessmentModel = async (prompt, { timeoutMs }) => {
  const provider = await getConfiguredProvider("conversationTitle");
  if (!provider) return null;
  const config = getConfig();
  const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
  const result = await runBtwSidechain({
    content: prompt,
    provider,
    systemPrompt:
      "You are a pre-run task assessor. Reply with ONLY the requested JSON object.",
    messages: [],
    tools: [],
    callSite: "conversationTitle",
    maxTokens: resolved.maxTokens,
    timeoutMs,
  });
  return result.text;
};

/**
 * Hard deadline over the WHOLE assessment (provider resolution + the call).
 * `runBtwSidechain` bounds only the send, while provider resolution can stall
 * for a long time on a key-less daemon — and a task must never sit unstarted
 * because its assessment is hanging.
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

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Hash of everything the verdict depends on. A verdict stays valid until the
 * task text, its context, or Cue's capabilities change — which is exactly when
 * the answer could change (notably: the user answering a `clarify` question by
 * adding task context, or linking the connector a `blocked` verdict named).
 */
export function computeAssessmentInputHash(input: AssessmentInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: input.item.title,
        notes: input.item.notes ?? "",
        preamble: input.contextPreamble,
        capabilities: input.capabilities.fingerprint,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

/** The stored verdict on an item, when it has one. */
export function storedAssessment(item: WorkItem): WorkItemAssessment | null {
  const verdict = item.assessmentVerdict;
  if (
    !verdict ||
    !(WORK_ITEM_VERDICTS as readonly string[]).includes(verdict)
  ) {
    return null;
  }
  return {
    verdict: verdict as WorkItemVerdict,
    understanding: item.assessmentUnderstanding,
    plan: item.assessmentPlan,
    question: item.assessmentQuestion,
    missing: item.assessmentMissing,
    confidence: item.assessmentConfidence ?? 0,
    inputHash: item.assessmentInputHash ?? "",
    assessedAt: item.assessmentAt ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface AssessWorkItemResult {
  assessment: WorkItemAssessment | null;
  /** True when the stored verdict was reused — no LLM call was made. */
  cached: boolean;
  /**
   * True when this exact verdict (same inputs, same non-execute outcome) had
   * ALREADY been surfaced to the user before this call. The runner uses it to
   * avoid nagging: a question is asked once; an explicit re-run of an
   * unchanged item goes ahead.
   */
  alreadySurfaced: boolean;
}

const NOT_ASSESSED: AssessWorkItemResult = {
  assessment: null,
  cached: false,
  alreadySurfaced: false,
};

/**
 * Assess a work item, reusing the stored verdict when nothing that matters has
 * changed. Persists the verdict, writes the `assessed` trail row, and pushes
 * `work_item_assessed`. Never rejects: every failure path returns
 * {@link NOT_ASSESSED} so the caller runs the item exactly as it would have
 * before assessment existed.
 */
export async function assessWorkItem(
  input: AssessmentInput,
  model: AssessmentModel = flashAssessmentModel,
): Promise<AssessWorkItemResult> {
  try {
    const cfg = getConfig().workItems.assessment;
    if (!cfg.enabled) return NOT_ASSESSED;

    const inputHash = computeAssessmentInputHash(input);

    const current = getWorkItem(input.item.id);
    const stored = current ? storedAssessment(current) : null;
    if (stored && stored.inputHash === inputHash) {
      // Nothing that could change the answer has changed — reuse it. The
      // verdict was already shown to the user when it was first produced.
      return {
        assessment: stored,
        cached: true,
        alreadySurfaced: stored.verdict !== "execute",
      };
    }

    const prompt = buildAssessmentPrompt(input);

    // One retry. A burst of dispatches (auto-run draining a queue, or a user
    // running several tasks at once) puts the whole batch through the flash
    // provider at the same moment, and the slow half of that burst used to
    // fall out silently — the feature looked healthy while most tasks ran
    // unassessed. A second attempt costs one cheap call and recovers them.
    let text: string | null = null;
    let lastFailure = "no reply";
    for (let attempt = 1; attempt <= 2 && !text; attempt += 1) {
      text = await withDeadline(
        model(prompt, { timeoutMs: cfg.timeoutMs }).catch((err: unknown) => {
          lastFailure = String(err);
          return null;
        }),
        cfg.timeoutMs,
      );
      if (!text && lastFailure === "no reply") {
        lastFailure = `no reply within ${cfg.timeoutMs}ms`;
      }
    }
    if (!text) {
      // Warn, not debug: this is the feature silently not happening, and the
      // only outward sign is a task that runs with no verdict attached.
      log.warn(
        { workItemId: input.item.id, reason: lastFailure },
        "work-item assessment produced no reply (running unassessed)",
      );
      return NOT_ASSESSED;
    }

    const parsed = parseAssessmentResponse(text, {
      notAiTaskMinConfidence: cfg.notAiTaskMinConfidence,
    });
    if (!parsed) {
      log.warn(
        { workItemId: input.item.id, replyPreview: text.slice(0, 200) },
        "assessment reply unparseable (running unassessed)",
      );
      return NOT_ASSESSED;
    }

    const assessment: WorkItemAssessment = {
      ...parsed,
      inputHash,
      assessedAt: Date.now(),
    };
    persistAssessment(input.item.id, assessment);
    return { assessment, cached: false, alreadySurfaced: false };
  } catch (err) {
    log.warn(
      { err: String(err), workItemId: input.item.id },
      "work-item assessment failed (running unassessed)",
    );
    return NOT_ASSESSED;
  }
}

/**
 * Write the verdict to the item, the trail, and the event bus. Best-effort:
 * a failure here must not stop the run it was meant to describe.
 */
function persistAssessment(
  workItemId: string,
  assessment: WorkItemAssessment,
): void {
  const narration = narrationForAssessment(assessment);
  try {
    updateWorkItem(
      workItemId,
      {
        assessmentVerdict: assessment.verdict,
        assessmentUnderstanding: assessment.understanding,
        assessmentPlan: assessment.plan,
        assessmentQuestion: assessment.question,
        assessmentMissing: assessment.missing,
        assessmentConfidence: assessment.confidence,
        assessmentInputHash: assessment.inputHash,
        assessmentAt: assessment.assessedAt,
      },
      { actor: "assessor" },
    );
  } catch (err) {
    log.warn(
      { err: String(err), workItemId },
      "failed to persist work-item assessment (ignored)",
    );
  }

  recordWorkItemEvent({
    workItemId,
    kind: "assessed",
    actor: "assessor",
    detail: narration,
  });

  try {
    broadcastMessage({
      type: "work_item_assessed",
      workItemId,
      verdict: assessment.verdict,
      understanding: assessment.understanding,
      plan: assessment.plan,
      question: assessment.question,
      missing: assessment.missing,
      confidence: assessment.confidence,
      narration,
      assessedAt: new Date(assessment.assessedAt).toISOString(),
    });
  } catch (err) {
    log.debug(
      { err: String(err), workItemId },
      "failed to broadcast work-item assessment (ignored)",
    );
  }
}
