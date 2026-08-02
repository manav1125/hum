/**
 * Comprehension — turning an arrival into a TASK instead of a relabelled email.
 *
 * Measured on the owner's live instance: all 134 Gmail-sourced work items were
 * titled `Email from <Name> <addr>: <subject>`. The relevance gate decides
 * whether something is worth seeing; nothing decided what it WAS. So
 *
 *   Email from CIPA <info@cipa.co.bw>: 2026 Annual Return Due for Brinc
 *   Innovation Africa (First Reminder)
 *
 * becomes
 *
 *   Renew Brinc Innovation Africa's annual return
 *   due 2026-09-30 · asked by CIPA · from info@cipa.co.bw
 *
 * ## Never invent
 *
 * A hallucinated due date on a real obligation is far worse than no due date,
 * so every extracted fact must be QUOTED back by the model and that quote must
 * be found in the message text before the fact is accepted
 * ({@link isGroundedIn}). This is enforced in code, after the model answers —
 * the same reason the relevance gate enforces its safety floor at a code choke
 * point rather than in a prompt. A prompt that says "do not invent" is a
 * request; this is a check.
 *
 * ## Fails open in the useful direction
 *
 * If comprehension fails, times out, is disabled, or comes back weak, the
 * item keeps the title it already had. A worse title is a real cost — the
 * owner scans this list — so the bar to replace one is deliberately high, and
 * every non-replacement is recorded with a status and a plain-words reason
 * rather than being silently indistinguishable from success.
 *
 * ## Cost
 *
 * One batched flash-tier call per poll ({@link MAX_COMPREHEND_BATCH} items),
 * on the same `conversationTitle` call site the auto-filer and the gate use,
 * bounded by a hard deadline race. It must never wedge intake.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { ArrivalComprehensionConfigSchema } from "../config/schemas/arrival-comprehension.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getLogger } from "../util/logger.js";
import { getWorkItem, updateWorkItem } from "../work-items/work-item-store.js";
import {
  type ComprehensionStatus,
  recordComprehension,
} from "./comprehension-store.js";

const log = getLogger("arrival-comprehension");

/** At most this many arrivals are comprehended per batch (one LLM call). */
export const MAX_COMPREHEND_BATCH = 20;

/** The batched flash call must not dawdle. */
const COMPREHEND_TIMEOUT_MS = 20_000;

/**
 * Hard deadline on the whole step (provider resolution + the call).
 * `runBtwSidechain` bounds only the send; provider resolution alone can stall
 * for minutes on a key-less daemon. Intake must always terminate.
 */
const COMPREHEND_DEADLINE_MS = 45_000;

/** Cap on how much of a message is quoted into the prompt. */
const SNIPPET_CHARS = 400;

/** A rewritten title has to fit on a card. */
const MAX_TITLE_CHARS = 120;
const MIN_TITLE_CHARS = 4;

/** Cap on the one-line decision summary. */
const MAX_DECISION_CHARS = 160;

/**
 * Words a task title may not START with. Every one of them means the title is
 * still describing the ENVELOPE rather than the obligation — which is the
 * exact failure this feature exists to fix.
 */
const NON_TASK_TITLE_PREFIX =
  /^(email|e-mail|message|mail|notification|newsletter|reminder from|fwd|fw|re)\b/i;

/** How far in the past an extracted deadline may be before it is implausible. */
const MAX_PAST_DUE_MS = 365 * 24 * 60 * 60 * 1000;
/** …and how far into the future. */
const MAX_FUTURE_DUE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/** The slice of an arrival the extractor reads. */
export interface ComprehensionCandidate {
  workItemId: string;
  arrivalId: string | null;
  /** The title the item currently has (`Email from …`). */
  title: string;
  snippet: string | null;
  senderName: string | null;
  senderAddress: string | null;
}

/** One raw, unvalidated answer from the model. */
export interface RawComprehension {
  workItemId: string;
  /** The verb phrase naming what the owner must do. */
  task?: string | null;
  confidence?: number | null;
  /** ISO `YYYY-MM-DD`. */
  dueDate?: string | null;
  /** The literal words in the message the date was read from. */
  dueQuote?: string | null;
  amount?: string | null;
  /** The literal words in the message the amount was read from. */
  amountQuote?: string | null;
  askedBy?: string | null;
  decision?: string | null;
}

/** Injectable for deterministic tests; production uses the flash side-chain. */
export type ArrivalExtractor = (
  candidates: ComprehensionCandidate[],
) => Promise<RawComprehension[] | null>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * The exact text an item's extracted facts are checked against. The prompt
 * shows this and only this, so a quote that is not in here was not in anything
 * the model was given — it was invented.
 */
export function sourceTextFor(candidate: ComprehensionCandidate): string {
  return `${candidate.title}\n${candidate.snippet ?? ""}`;
}

/** Exported for tests; production callers go through {@link comprehendArrivals}. */
export function buildComprehensionPrompt(
  candidates: ComprehensionCandidate[],
): string {
  const blocks = candidates.map((c) => {
    const who = c.senderName
      ? `${c.senderName} <${c.senderAddress ?? "?"}>`
      : (c.senderAddress ?? "unknown sender");
    return [
      `  - id: ${c.workItemId}`,
      `    from: ${who}`,
      `    subject: ${clip(c.title, SNIPPET_CHARS)}`,
      `    body: ${clip(c.snippet ?? "", SNIPPET_CHARS)}`,
    ].join("\n");
  });
  return [
    "You are the owner's chief of staff. Each message below arrived in their",
    "inbox and is currently sitting on their task list under its email subject",
    "line, which tells them nothing about what they have to DO.",
    "",
    "For each message, write the task.",
    "",
    'RULES for "task":',
    "  · A verb phrase naming the action the owner must take, in their words.",
    '    "Renew Brinc Innovation Africa\'s annual return", "Pay the ZA Bank',
    '    card statement", "Reply to Jane about the lease".',
    '  · NEVER start with "Email from", "Message", "Notification" or the',
    "    subject line verbatim. If all you can do is restate the subject, say",
    "    so with a low confidence instead.",
    `  · Under ${MAX_TITLE_CHARS} characters.`,
    "",
    "RULES for the extracted facts — this part matters more than the title:",
    "  · Only report a fact that is ACTUALLY IN the message text above.",
    "  · For every fact, quote the exact words you read it from. A fact whose",
    "    quote is not in the message will be discarded.",
    "  · If there is no deadline, use null. Do NOT guess one, do NOT use",
    "    today, do NOT infer one from urgency. A wrong due date on a real",
    "    obligation is worse than no due date at all.",
    "  · dueDate must be an ISO date (YYYY-MM-DD) resolved from the message.",
    "",
    `Messages:\n${blocks.join("\n")}`,
    "",
    "Reply with ONLY a JSON array, no prose, one entry per message:",
    '[{"id": "<id>", "task": "<verb phrase>", "confidence": <0-1>,',
    ' "dueDate": "<YYYY-MM-DD or null>", "dueQuote": "<exact words or null>",',
    ' "amount": "<as written or null>", "amountQuote": "<exact words or null>",',
    ' "askedBy": "<who is asking, or null>",',
    ' "decision": "<the one decision wanted, or null>"}]',
    "confidence is how sure you are that the task is what the owner must do.",
    "Only use the ids listed above.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing + grounding
// ---------------------------------------------------------------------------

/**
 * Loose containment used for grounding checks: case- and punctuation-
 * insensitive, whitespace-collapsed. Loose enough that "30 September, 2026"
 * matches "30 September 2026"; strict enough that a date the model made up is
 * not in the message and gets thrown away.
 */
function normalizeForGrounding(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Minimum useful quote length — anything shorter is trivially "grounded". */
const MIN_QUOTE_CHARS = 3;

/**
 * Is `quote` actually present in `source`?
 *
 * THE never-invent check. Removing it, or making it return `true`
 * unconditionally, must fail a test — see `arrival-comprehension.test.ts`,
 * which feeds the extractor a due date whose quote is nowhere in the message
 * and asserts the work item ends up with no deadline.
 */
export function isGroundedIn(
  source: string,
  quote: string | null | undefined,
): boolean {
  if (!quote) return false;
  const needle = normalizeForGrounding(quote);
  if (needle.length < MIN_QUOTE_CHARS) return false;
  return normalizeForGrounding(source).includes(needle);
}

/**
 * Turn an ISO `YYYY-MM-DD` into an epoch-ms deadline, or null.
 *
 * End of that day in UTC rather than midnight, so "due 30 September" is not
 * already overdue the moment it is extracted. Dates outside a plausible window
 * are rejected outright: a 1970 or 2190 deadline is a parsing artefact, and a
 * confident artefact is the thing we are most trying to avoid.
 */
export function parseDueDate(
  raw: string | null | undefined,
  now: number,
): number | null {
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const at = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  // Round-trip guard: Date.UTC happily accepts 2026-02-31 and rolls it over.
  const back = new Date(at);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  if (at < now - MAX_PAST_DUE_MS) return null;
  if (at > now + MAX_FUTURE_DUE_MS) return null;
  return at;
}

/**
 * Is this a real task title, or is it still describing the envelope?
 * Exported for tests.
 */
export function isUsableTaskTitle(
  candidateTitle: string,
  originalTitle: string,
): boolean {
  const title = candidateTitle.replace(/\s+/g, " ").trim();
  if (title.length < MIN_TITLE_CHARS || title.length > MAX_TITLE_CHARS) {
    return false;
  }
  if (NON_TASK_TITLE_PREFIX.test(title)) return false;
  if (
    normalizeForGrounding(title) === normalizeForGrounding(originalTitle) ||
    normalizeForGrounding(originalTitle).includes(normalizeForGrounding(title))
  ) {
    // Restating the subject line is not comprehension.
    return false;
  }
  return true;
}

/**
 * Parse the model's JSON-array reply into raw, still-unvalidated answers.
 * Defensive: entries for unknown ids are dropped, duplicates ignored.
 * Returns null when nothing parseable is present.
 */
export function parseComprehensionResponse(
  text: string,
  validIds: ReadonlySet<string>,
): RawComprehension[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: RawComprehension[] = [];
  const seen = new Set<string>();
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = str(e.id);
    if (!id || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const numeric = Number(e.confidence);
    out.push({
      workItemId: id,
      task: str(e.task),
      confidence: Number.isFinite(numeric)
        ? Math.min(1, Math.max(0, numeric))
        : 0,
      dueDate: str(e.dueDate),
      dueQuote: str(e.dueQuote),
      amount: str(e.amount),
      amountQuote: str(e.amountQuote),
      askedBy: str(e.askedBy),
      decision: str(e.decision),
    });
  }
  return out;
}

export interface ValidatedComprehension {
  status: ComprehensionStatus;
  actionTitle: string | null;
  dueAt: number | null;
  dueQuote: string | null;
  amountText: string | null;
  askedBy: string | null;
  decisionNeeded: string | null;
  confidence: number | null;
  note: string | null;
}

/**
 * Apply every never-invent and is-this-actually-better rule to one raw answer.
 *
 * Pure, exported, and the single place a fact can be accepted — so widening
 * what Cue is willing to believe is one diff, in one function, with tests
 * pointing at it.
 */
export function validateComprehension(
  candidate: ComprehensionCandidate,
  raw: RawComprehension | undefined,
  opts: { now: number; confidenceThreshold: number },
): ValidatedComprehension {
  const empty = {
    actionTitle: null,
    dueAt: null,
    dueQuote: null,
    amountText: null,
    askedBy: null,
    decisionNeeded: null,
  };
  if (!raw) {
    return {
      ...empty,
      status: "failed",
      confidence: null,
      note: "Cue could not read this one, so it kept the subject line",
    };
  }

  const confidence = raw.confidence ?? 0;
  if (confidence < opts.confidenceThreshold) {
    return {
      ...empty,
      status: "low_confidence",
      confidence,
      note: "Cue was not sure enough what this asks for, so it kept the subject line",
    };
  }

  const source = sourceTextFor(candidate);
  const title = raw.task?.replace(/\s+/g, " ").trim() ?? "";
  if (!title || !isUsableTaskTitle(title, candidate.title)) {
    return {
      ...empty,
      status: "low_confidence",
      confidence,
      note: title
        ? "Cue could only restate the subject line, so it left the title alone"
        : "Cue did not name an action, so it kept the subject line",
    };
  }

  // Every fact below is accepted ONLY when its quote is in the message. An
  // unquoted or unfindable fact is dropped in silence-free fashion: it simply
  // stays null, which reads as "the message did not say".
  const dueAt = isGroundedIn(source, raw.dueQuote)
    ? parseDueDate(raw.dueDate, opts.now)
    : null;
  const amountText = isGroundedIn(source, raw.amountQuote) ? raw.amount : null;
  // "Who is asking" is legitimately the sender, so the sender's own name and
  // address count as source for this one field.
  const askedBySource = `${source} ${candidate.senderName ?? ""} ${candidate.senderAddress ?? ""}`;
  const askedBy = isGroundedIn(askedBySource, raw.askedBy) ? raw.askedBy : null;

  return {
    status: "comprehended",
    actionTitle: title,
    dueAt,
    dueQuote: dueAt != null ? (raw.dueQuote ?? null) : null,
    amountText: amountText ?? null,
    askedBy: askedBy ?? null,
    // The decision line is a synthesis rather than a quote, so it rides the
    // overall confidence instead of a grounding check — and it is clipped so
    // it can never grow into unbounded prose on a card.
    decisionNeeded: raw.decision
      ? clip(raw.decision, MAX_DECISION_CHARS)
      : null,
    confidence,
    note: null,
  };
}

// ---------------------------------------------------------------------------
// The flash-tier extractor
// ---------------------------------------------------------------------------

async function extractWithFlashLlm(
  candidates: ComprehensionCandidate[],
): Promise<RawComprehension[] | null> {
  try {
    const provider = await getConfiguredProvider("conversationTitle");
    if (!provider) return null;
    const config = getConfig();
    const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
    const result = await runBtwSidechain({
      content: buildComprehensionPrompt(candidates),
      provider,
      systemPrompt:
        "You turn inbox messages into tasks. Reply with ONLY the requested JSON array. Never invent a fact that is not in the message.",
      messages: [],
      tools: [],
      callSite: "conversationTitle",
      maxTokens: resolved.maxTokens,
      timeoutMs: COMPREHEND_TIMEOUT_MS,
    });
    return parseComprehensionResponse(
      result.text,
      new Set(candidates.map((c) => c.workItemId)),
    );
  } catch (err) {
    log.debug({ err: String(err) }, "comprehension extraction failed");
    return null;
  }
}

/**
 * Race the extractor against {@link COMPREHEND_DEADLINE_MS}. On deadline the
 * caller sees the same `null` a failure produces — every item keeps its title.
 * The abandoned promise holds no locks and writes nothing.
 */
async function raceDeadline(
  work: Promise<RawComprehension[] | null>,
): Promise<RawComprehension[] | null> {
  return Promise.race([
    work.catch((err) => {
      log.warn({ err: String(err) }, "comprehension extractor threw");
      return null;
    }),
    new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), COMPREHEND_DEADLINE_MS);
      if (typeof t === "object") t.unref?.();
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export interface ComprehensionHealth {
  /** Epoch ms of the last batch that had candidates. */
  lastBatchAt: number | null;
  lastBatchCandidates: number;
  lastBatchComprehended: number;
  /**
   * Consecutive batches that had work to do and produced NOTHING. The number
   * that stops a silent no-op reading as success: the auto-file sweep filed
   * nothing for twelve hours and the only symptom was the owner staring at 103
   * unfiled items.
   */
  consecutiveUnproductiveBatches: number;
  totalBatches: number;
  totalComprehended: number;
}

const health: ComprehensionHealth = {
  lastBatchAt: null,
  lastBatchCandidates: 0,
  lastBatchComprehended: 0,
  consecutiveUnproductiveBatches: 0,
  totalBatches: 0,
  totalComprehended: 0,
};

/** After this many barren batches in a row, say so at warn level. */
export const UNPRODUCTIVE_BATCH_WARN_AT = 3;

export function getComprehensionHealth(): ComprehensionHealth {
  return { ...health };
}

/** Test-only: forget the streak so files do not leak state into each other. */
export function resetComprehensionHealth(): void {
  health.lastBatchAt = null;
  health.lastBatchCandidates = 0;
  health.lastBatchComprehended = 0;
  health.consecutiveUnproductiveBatches = 0;
  health.totalBatches = 0;
  health.totalComprehended = 0;
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

export interface ComprehensionBatchResult {
  /** Candidates sent to the extractor this batch (post-cap). */
  candidates: number;
  /** Items whose title now says what the owner must do. */
  comprehended: number;
  /** Items the extractor answered on, but not well enough to use. */
  lowConfidence: number;
  /** Items with no usable answer at all. */
  failed: number;
  /** Items over the batch cap, or comprehension switched off. */
  skipped: number;
  /** Deadlines genuinely found in the messages (never defaulted). */
  deadlinesExtracted: number;
}

function emptyBatchResult(): ComprehensionBatchResult {
  return {
    candidates: 0,
    comprehended: 0,
    lowConfidence: 0,
    failed: 0,
    skipped: 0,
    deadlinesExtracted: 0,
  };
}

export interface ComprehendArrivalsOptions {
  /** Injectable extractor for deterministic tests. */
  extractor?: ArrivalExtractor;
  /** Injectable clock, so date bounds are testable. */
  now?: number;
}

/**
 * Comprehend a batch of freshly surfaced arrivals.
 *
 * Never rejects and never leaves an item worse off: the title is only replaced
 * when a real verb phrase cleared every check, and every other outcome is a
 * persisted row explaining itself. Returns per-batch counts for the caller to
 * log alongside the rest of the poll.
 */
export async function comprehendArrivals(
  candidates: ComprehensionCandidate[],
  opts: ComprehendArrivalsOptions = {},
): Promise<ComprehensionBatchResult> {
  const result = emptyBatchResult();
  if (candidates.length === 0) return result;

  const cfg = ArrivalComprehensionConfigSchema.parse(
    getConfig().watchers?.comprehension ?? {},
  );
  if (!cfg.enabled) {
    result.skipped = candidates.length;
    for (const candidate of candidates) {
      recordComprehension({
        workItemId: candidate.workItemId,
        arrivalId: candidate.arrivalId,
        status: "skipped",
        originalTitle: candidate.title,
        note: "comprehension is switched off",
      });
    }
    return result;
  }

  const batch = candidates.slice(0, MAX_COMPREHEND_BATCH);
  const overflow = candidates.slice(MAX_COMPREHEND_BATCH);
  for (const candidate of overflow) {
    // Over the cap is not a failure to hide — it is a recorded "not looked at
    // yet", so an inbox that consistently overflows is visible as one.
    recordComprehension({
      workItemId: candidate.workItemId,
      arrivalId: candidate.arrivalId,
      status: "skipped",
      originalTitle: candidate.title,
      note: "more arrived at once than Cue reads in one pass",
    });
    result.skipped++;
  }

  result.candidates = batch.length;
  const now = opts.now ?? Date.now();
  const raw = await raceDeadline(
    (opts.extractor ?? extractWithFlashLlm)(batch),
  );
  const byId = new Map((raw ?? []).map((r) => [r.workItemId, r]));

  for (const candidate of batch) {
    try {
      const validated = validateComprehension(
        candidate,
        byId.get(candidate.workItemId),
        {
          now,
          confidenceThreshold: cfg.confidenceThreshold,
        },
      );

      if (validated.status === "comprehended") {
        // Re-read before writing: the owner may have renamed or finished the
        // item while the call was in flight, and their decision wins.
        const fresh = getWorkItem(candidate.workItemId);
        if (!fresh || fresh.title !== candidate.title) {
          recordComprehension({
            workItemId: candidate.workItemId,
            arrivalId: candidate.arrivalId,
            status: "skipped",
            originalTitle: candidate.title,
            confidence: validated.confidence,
            note: "the item changed while Cue was reading it, so it was left alone",
          });
          result.skipped++;
          continue;
        }
        updateWorkItem(
          candidate.workItemId,
          {
            title: validated.actionTitle!,
            // A deadline is only ever SET, never cleared: the absence of an
            // extracted date says nothing about a date the owner set by hand.
            ...(validated.dueAt != null ? { dueAt: validated.dueAt } : {}),
          },
          { actor: "arrival-comprehension" },
        );
        result.comprehended++;
        if (validated.dueAt != null) result.deadlinesExtracted++;
      } else if (validated.status === "low_confidence") {
        result.lowConfidence++;
      } else if (validated.status === "failed") {
        result.failed++;
      } else {
        result.skipped++;
      }

      recordComprehension({
        workItemId: candidate.workItemId,
        arrivalId: candidate.arrivalId,
        status: validated.status,
        originalTitle: candidate.title,
        actionTitle: validated.actionTitle,
        dueAt: validated.dueAt,
        dueQuote: validated.dueQuote,
        amountText: validated.amountText,
        askedBy: validated.askedBy,
        decisionNeeded: validated.decisionNeeded,
        confidence: validated.confidence,
        note: validated.note,
      });
    } catch (err) {
      result.failed++;
      log.warn(
        { err: String(err), workItemId: candidate.workItemId },
        "comprehending one item failed (its title is unchanged)",
      );
    }
  }

  recordBatchHealth(result);
  return result;
}

function recordBatchHealth(result: ComprehensionBatchResult): void {
  health.totalBatches++;
  health.totalComprehended += result.comprehended;
  health.lastBatchAt = Date.now();
  health.lastBatchCandidates = result.candidates;
  health.lastBatchComprehended = result.comprehended;

  if (result.candidates > 0 && result.comprehended === 0) {
    health.consecutiveUnproductiveBatches++;
  } else if (result.comprehended > 0) {
    health.consecutiveUnproductiveBatches = 0;
  }

  if (health.consecutiveUnproductiveBatches >= UNPRODUCTIVE_BATCH_WARN_AT) {
    // The whole point: a pass that comprehends nothing, repeatedly, says so.
    log.warn(
      {
        ...result,
        consecutiveUnproductiveBatches: health.consecutiveUnproductiveBatches,
      },
      "arrival comprehension has produced nothing for several batches in a row",
    );
  } else if (result.candidates > 0) {
    log.info({ ...result }, "arrival comprehension batch finished");
  }
}
