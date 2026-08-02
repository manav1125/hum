/**
 * The relevance gate — the decision that runs at the arrival → work-item
 * boundary, before anything becomes something the owner must look at.
 *
 * Three layers, in this order, and the order is the whole design:
 *
 *  1. **Deterministic header rules** (no model, no network). `List-Unsubscribe`
 *     / `List-Id` / `Precedence: bulk` are a near-perfect bulk-mail signal and
 *     `Auto-Submitted: auto-generated` marks machine mail (RFC 3834). These
 *     cases are not judgement calls, and an LLM is both slower and less
 *     predictable at them.
 *  2. **The safety floor.** Four conditions under which an arrival is surfaced
 *     no matter what layer 1 or layer 3 concluded — a known contact, a reply
 *     in a thread the owner is part of, a mention of an active mission or
 *     project, or a direct To: from a human. It is enforced in code at a
 *     single choke point AFTER every other layer has spoken (see
 *     {@link decideOne}), because a floor that lives only in a prompt is a
 *     suggestion.
 *  3. **The model**, for the genuinely ambiguous middle only — the mail with
 *     no bulk headers and no floor hit.
 *
 * Two invariants hold everywhere in here:
 *
 *   · **Fail OPEN.** Any failure — the judge throws, times out, returns
 *     nothing parseable, or is disabled — surfaces the item. An outage must
 *     never silently swallow somebody's mail.
 *   · **A false "filed" on a real message from a real person is far worse
 *     than letting a newsletter through.** Every uncertain case resolves
 *     toward surfacing.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { RelevanceGateConfigSchema } from "../config/schemas/watchers.js";
import { findCuratedContactByAddress } from "../contacts/contact-store.js";
import { listMissions } from "../missions/mission-store.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getLogger } from "../util/logger.js";
import { listProjects } from "../work-items/project-store.js";
import {
  isBulkSenderAddress,
  looksTransactional,
} from "./arrival-sender-shape.js";
import type { ArrivalSignals } from "./arrival-signals.js";
import type { ArrivalDecidedBy, ArrivalDisposition } from "./arrival-store.js";

const log = getLogger("arrival-gate");

/** At most this many ambiguous items go to the judge in one call. */
export const MAX_JUDGE_BATCH = 25;

/** The judge must not dawdle; a slow judge degrades to "surface it". */
const JUDGE_TIMEOUT_MS = 20_000;

/**
 * Hard deadline on the whole judging step (provider resolution + the call).
 * `runBtwSidechain` bounds only the send; provider resolution itself can stall
 * for minutes on a key-less daemon while platform auth times out, and intake
 * must always terminate.
 */
const JUDGE_DEADLINE_MS = 60_000;

/** Cap on how much of an item is quoted into the judge prompt. */
const JUDGE_SNIPPET_CHARS = 200;

/**
 * Project/mission titles shorter than this are ignored by the name-mention
 * floor. A two-letter project name matches half the English language, and a
 * floor that fires on everything surfaces everything.
 */
const MIN_NAME_MATCH_CHARS = 4;

export interface ArrivalDecision {
  disposition: ArrivalDisposition;
  /** The user-words sentence fragment. Always set — never a bare score. */
  reason: string;
  decidedBy: ArrivalDecidedBy;
  ruleId: string | null;
  confidence: number | null;
}

// ---------------------------------------------------------------------------
// Layer 1 — deterministic header rules
// ---------------------------------------------------------------------------

/** Ids of the deterministic file rules, for `arrivals.rule_id`. */
export type BulkRuleId = "list_mail" | "precedence_bulk" | "auto_submitted";

export interface BulkRuleHit {
  ruleId: BulkRuleId;
  reason: string;
}

/** Precedence values that mean "this was sent to a crowd". */
const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);

/** How the sender is named in a reason fragment. */
export function senderLabel(signals: ArrivalSignals): string {
  if (signals.senderName) return signals.senderName;
  if (signals.senderAddress) {
    const domain = signals.senderAddress.split("@")[1];
    if (domain) return domain;
    return signals.senderAddress;
  }
  return "an unknown sender";
}

/**
 * The deterministic bulk/automated-mail rules. Pure, no I/O, exported for
 * tests. Returns null for anything that is not header-provably bulk — being
 * narrow here is deliberate: the ambiguous middle belongs to the model, and
 * every rule added to this list is a case that can never be argued with.
 */
export function applyBulkRules(signals: ArrivalSignals): BulkRuleHit | null {
  if (!signals.isMessageShaped) return null;
  const who = senderLabel(signals);

  if (signals.hasListHeaders) {
    return { ruleId: "list_mail", reason: `newsletter from ${who}` };
  }
  if (signals.precedence && BULK_PRECEDENCE.has(signals.precedence)) {
    return { ruleId: "precedence_bulk", reason: `bulk mail from ${who}` };
  }
  if (signals.autoSubmitted) {
    return {
      ruleId: "auto_submitted",
      reason: `automated notification from ${who}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 2 — the safety floor
// ---------------------------------------------------------------------------

export type FloorRuleId =
  | "known_contact"
  | "thread_participant"
  | "named_work"
  | "direct_human";

export interface FloorHit {
  ruleId: FloorRuleId;
  reason: string;
}

/** A mission or project the owner is actively working on. */
export interface NamedWork {
  kind: "mission" | "project";
  name: string;
}

/**
 * Everything the floor needs that is not on the signals themselves. Injected
 * rather than looked up inline so the floor stays a pure function — the one
 * piece of this file that must be trivially testable and trivially auditable.
 */
export interface FloorContext {
  /** Resolve an email address to a contact's display name, or null. */
  lookupContact: (address: string) => string | null;
  /** Active missions and projects, by name. */
  namedWork: NamedWork[];
}

/**
 * Case-insensitive whole-word-ish containment. Hand-rolled rather than regex
 * so a project literally named "C++ (v2)" cannot blow up the matcher.
 */
export function mentionsName(haystack: string, name: string): boolean {
  if (name.length < MIN_NAME_MATCH_CHARS) return false;
  const hay = haystack.toLowerCase();
  const needle = name.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : hay[at - 1];
    const after = hay[at + needle.length] ?? "";
    const isWordChar = (c: string) => c !== "" && /[a-z0-9]/.test(c);
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

/**
 * The safety floor: four conditions under which an arrival MUST surface,
 * whatever any rule or model concluded.
 *
 * Pure and exported so it can be tested directly and so breaking it is
 * impossible to do quietly — a mutation to any branch here fails a test.
 */
export function applySafetyFloor(
  signals: ArrivalSignals,
  ctx: FloorContext,
): FloorHit | null {
  // 1. A message from somebody the owner has deliberately saved as a contact.
  //
  //    This comment used to say contacts are curated rather than harvested
  //    from inbound mail. That stopped being true the moment correspondence
  //    provisioning shipped, and it closed a LOOP: mail mints a contact, the
  //    contact satisfies this floor, the floor surfaces the mail, and the
  //    surfacing is then read back as evidence the sender is a person. It had
  //    already fired once. Self-reinforcing evidence is not evidence.
  //
  //    So the lookup now requires a channel the owner actually stood behind —
  //    verified, invited or explicitly added. An auto-provisioned channel is
  //    `unverified`, and being harvested is not the same as being known.
  if (signals.senderAddress) {
    const contactName = ctx.lookupContact(signals.senderAddress);
    if (contactName) {
      return {
        ruleId: "known_contact",
        reason: `from ${contactName}, who is in your contacts`,
      };
    }
  }

  // 2. A reply in a thread the owner themselves participated in. Note the
  //    strict `=== true`: `undefined` means the provider could not determine
  //    participation, which is not evidence of absence and must not be read
  //    as one — but it also is not grounds to fire the floor.
  if (signals.userParticipatedInThread === true) {
    return {
      ruleId: "thread_participant",
      reason: "a reply in a thread you're part of",
    };
  }

  // 3. Anything naming an active mission or project.
  const haystack = `${signals.title} ${signals.snippet}`;
  for (const work of ctx.namedWork) {
    if (mentionsName(haystack, work.name)) {
      return {
        ruleId: "named_work",
        reason: `mentions your ${work.kind} "${work.name}"`,
      };
    }
  }

  // 4. A direct To: from a human. "Human" here means: not carrying any of the
  //    bulk/automated headers — mailing lists and machine mail routinely put
  //    the owner on the To: line, so the direct-recipient signal only counts
  //    once those are ruled out.
  //
  //    Headers alone were not enough. Measured on the owner's live instance,
  //    SIX of eight consecutive decisions surfaced on `direct_human`, including
  //    a bank's marketing promo: it sends from `notification@` with no
  //    List-Unsubscribe, no Precedence and no Auto-Submitted, addresses the
  //    owner directly, and carries a display name. Every header test said
  //    "not bulk" and the floor dutifully surfaced it. This one leg was the
  //    dominant reason the lane stayed full after filtering shipped.
  //
  //    So the sender's ADDRESS counts as evidence too: a robot addressing you
  //    directly is still a robot, and `notification@` is a structural fact
  //    rather than a judgement about the message.
  //
  //    The transactional carve-out is what keeps this safe. Approvals, expiring
  //    credentials, payment failures and security notices arrive from exactly
  //    these addresses — that is what they are FOR — so an automated sender
  //    with something to act on still counts as direct-to-a-human and still
  //    gets the floor. Only automated senders with nothing to act on lose it.
  const automatedSender =
    isBulkSenderAddress(signals.senderAddress) &&
    !looksTransactional(signals.title) &&
    !looksTransactional(signals.snippet);
  const looksBulk =
    signals.hasListHeaders ||
    (signals.precedence != null && BULK_PRECEDENCE.has(signals.precedence)) ||
    signals.autoSubmitted != null ||
    automatedSender;
  if (signals.directToUser && !looksBulk) {
    return {
      ruleId: "direct_human",
      reason: "you're a direct recipient and it's from a person",
    };
  }

  return null;
}

/** Build the floor's context once per batch (two queries, not two per item). */
export function buildFloorContext(): FloorContext {
  const namedWork: NamedWork[] = [];
  try {
    for (const mission of listMissions({ status: "active" })) {
      namedWork.push({ kind: "mission", name: mission.title });
    }
  } catch (err) {
    // A floor input we cannot read must not take the gate down with it; the
    // remaining floor rules still apply.
    log.warn({ err: String(err) }, "could not read missions for the floor");
  }
  try {
    for (const project of listProjects({ status: "active" })) {
      namedWork.push({ kind: "project", name: project.title });
    }
  } catch (err) {
    log.warn({ err: String(err) }, "could not read projects for the floor");
  }

  return {
    lookupContact: (address) => {
      try {
        const contact = findCuratedContactByAddress("email", address);
        return contact?.displayName ?? null;
      } catch (err) {
        // A contacts-table failure must NOT quietly demote a real person's
        // mail into the filed pile. Log and treat the lookup as unknown; the
        // remaining floor rules and the model still run, and every path from
        // here biases toward surfacing.
        log.warn({ err: String(err) }, "contact lookup failed for the floor");
        return null;
      }
    },
    namedWork,
  };
}

// ---------------------------------------------------------------------------
// Layer 3 — the model, for the ambiguous middle
// ---------------------------------------------------------------------------

export interface JudgeVerdict {
  externalId: string;
  /** true = the owner needs to see it. */
  keep: boolean;
  /** A short sentence fragment in the owner's words. */
  reason: string;
  confidence: number;
}

/** Injectable for deterministic tests; production uses the flash side-chain. */
export type ArrivalJudge = (
  items: ArrivalSignals[],
) => Promise<JudgeVerdict[] | null>;

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Exported for tests. */
export function buildJudgePrompt(items: ArrivalSignals[]): string {
  const lines = items.map((item) => {
    const who = item.senderName
      ? `${item.senderName} <${item.senderAddress ?? "?"}>`
      : (item.senderAddress ?? "unknown sender");
    const to = item.directToUser
      ? "direct to you"
      : item.ccToUser
        ? "you are cc'd"
        : "not addressed to you directly";
    return [
      `  - id: ${item.externalId}`,
      `    from: ${who} (${to})`,
      `    subject: ${clip(item.title, JUDGE_SNIPPET_CHARS)}`,
      `    preview: ${clip(item.snippet, JUDGE_SNIPPET_CHARS)}`,
    ].join("\n");
  });
  return [
    "You are the owner's chief of staff, deciding which of today's messages",
    "actually need their attention.",
    "",
    "FILE (they do not need to see it): marketing, newsletters, digests,",
    "receipts and order confirmations, social and app notifications, automated",
    "build/deploy/CI mail, calendar spam, cold outreach, and anything sent to",
    "a crowd rather than to them.",
    "",
    "KEEP (they need to see it): anything a real person wrote to them, work",
    "that names them or asks them something, deadlines, money or legal matters",
    "needing a decision, and anything about their own projects.",
    "",
    "When you are not sure, KEEP it. Wrongly hiding one real message from a",
    "real person costs far more than letting ten newsletters through.",
    "",
    `Messages:\n${lines.join("\n")}`,
    "",
    "Reply with ONLY a JSON array, no prose, one entry per message:",
    '[{"id": "<id>", "keep": true|false, "reason": "<short fragment>", "confidence": <0-1>}]',
    "reason is a plain sentence fragment in the owner's words — \"newsletter",
    'from Stripe", "automated build notification", "Jane asking about the',
    'contract". Never a category code, never a score. Only use the ids listed',
    "above.",
  ].join("\n");
}

/** Exported for tests. Defensive: unknown ids dropped, confidence clamped. */
export function parseJudgeResponse(
  text: string,
  validIds: ReadonlySet<string>,
): JudgeVerdict[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const verdicts: JudgeVerdict[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, keep, reason, confidence } = entry as {
      id?: unknown;
      keep?: unknown;
      reason?: unknown;
      confidence?: unknown;
    };
    if (typeof id !== "string" || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const numeric = Number(confidence);
    verdicts.push({
      externalId: id,
      // Anything that is not literally `false` is read as "keep". A malformed
      // verdict must not be the thing that hides somebody's mail.
      keep: keep !== false,
      reason:
        typeof reason === "string" && reason.trim()
          ? clip(reason, 140)
          : "Cue judged this one without giving a reason",
      confidence: Number.isFinite(numeric)
        ? Math.min(1, Math.max(0, numeric))
        : 0,
    });
  }
  return verdicts;
}

async function judgeWithFlashLlm(
  items: ArrivalSignals[],
): Promise<JudgeVerdict[] | null> {
  const provider = await getConfiguredProvider("conversationTitle");
  if (!provider) return null;
  const config = getConfig();
  const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
  const result = await runBtwSidechain({
    content: buildJudgePrompt(items),
    provider,
    systemPrompt:
      "You are a relevance classifier for a chief of staff. Reply with ONLY the requested JSON array.",
    messages: [],
    tools: [],
    callSite: "conversationTitle",
    maxTokens: resolved.maxTokens,
    timeoutMs: JUDGE_TIMEOUT_MS,
  });
  return parseJudgeResponse(
    result.text,
    new Set(items.map((i) => i.externalId)),
  );
}

/**
 * Race the judge against {@link JUDGE_DEADLINE_MS} and swallow every failure
 * into `null`. `null` is the fail-open signal: the caller surfaces the item.
 */
async function judgeSafely(
  items: ArrivalSignals[],
  judge: ArrivalJudge,
): Promise<JudgeVerdict[] | null> {
  try {
    return await Promise.race([
      judge(items).catch((err) => {
        log.warn({ err: String(err) }, "arrival judge failed (surfacing all)");
        return null;
      }),
      new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), JUDGE_DEADLINE_MS);
        if (typeof t === "object") t.unref?.();
      }),
    ]);
  } catch (err) {
    log.warn({ err: String(err) }, "arrival judge threw (surfacing all)");
    return null;
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Combine one item's layers into a final decision.
 *
 * This is the single choke point where the safety floor is enforced. Both the
 * rule path and the model path pass through the same final `if`, so there is
 * exactly one place that can decide to file something — and exactly one place
 * that has to be right. Exported for tests, including the mutation check that
 * breaking the known-contact guard fails a test.
 */
export function decideOne(
  proposed: ArrivalDecision,
  floor: FloorHit | null,
): ArrivalDecision {
  if (proposed.disposition === "filed" && floor) {
    return {
      disposition: "surfaced",
      reason: floor.reason,
      decidedBy: "floor",
      ruleId: floor.ruleId,
      confidence: null,
    };
  }
  return proposed;
}

export interface DecideArrivalsOptions {
  /** Injectable judge for deterministic tests. */
  judge?: ArrivalJudge;
  /** Injectable floor context for deterministic tests. */
  floorContext?: FloorContext;
}

/**
 * Decide a batch of arrivals. Never rejects: every failure path resolves to
 * "surfaced". Returns one decision per input, keyed by `externalId`.
 */
export async function decideArrivals(
  signals: ArrivalSignals[],
  opts: DecideArrivalsOptions = {},
): Promise<Map<string, ArrivalDecision>> {
  const decisions = new Map<string, ArrivalDecision>();
  if (signals.length === 0) return decisions;

  // Read through the schema rather than off the object. A config that predates
  // this feature has no `relevanceGate` key at all, and reading `.enabled` off
  // undefined would throw — which the caller catches and turns into "surface
  // everything". That is the safe direction, but it would be reported as a gate
  // failure rather than as the ordinary defaults, which is a confusing thing to
  // find in a log. Parsing gives the same answer for the honest reason.
  const gateConfig = RelevanceGateConfigSchema.parse(
    getConfig().watchers?.relevanceGate ?? {},
  );
  if (!gateConfig.enabled) {
    // The rollback position: record everything, filter nothing. Identical
    // owner-visible behaviour to the pre-gate daemon.
    for (const item of signals) {
      decisions.set(item.externalId, {
        disposition: "surfaced",
        reason: "the relevance filter is switched off",
        decidedBy: "fallback",
        ruleId: null,
        confidence: null,
      });
    }
    return decisions;
  }

  const floorCtx = opts.floorContext ?? buildFloorContext();
  const floors = new Map<string, FloorHit | null>();
  const proposals = new Map<string, ArrivalDecision>();
  const ambiguous: ArrivalSignals[] = [];

  for (const item of signals) {
    const floor = applySafetyFloor(item, floorCtx);
    floors.set(item.externalId, floor);

    const rule = applyBulkRules(item);
    if (rule) {
      proposals.set(item.externalId, {
        disposition: "filed",
        reason: rule.reason,
        decidedBy: "rule",
        ruleId: rule.ruleId,
        confidence: null,
      });
      continue;
    }
    if (floor) {
      // Already protected — spending a model call to be told what the floor
      // will override anyway is pure cost.
      proposals.set(item.externalId, {
        disposition: "surfaced",
        reason: floor.reason,
        decidedBy: "rule",
        ruleId: floor.ruleId,
        confidence: null,
      });
      continue;
    }
    if (!item.isMessageShaped) {
      // Not mail. This filter is about mail; a calendar or price watcher's
      // hits pass through untouched rather than being guessed at.
      proposals.set(item.externalId, {
        disposition: "surfaced",
        reason: "not a message — Cue does not filter this kind of arrival",
        decidedBy: "fallback",
        ruleId: null,
        confidence: null,
      });
      continue;
    }
    ambiguous.push(item);
  }

  if (ambiguous.length > 0 && gateConfig.useModel) {
    const batch = ambiguous.slice(0, MAX_JUDGE_BATCH);
    const overflow = ambiguous.slice(MAX_JUDGE_BATCH);
    for (const item of overflow) {
      proposals.set(item.externalId, {
        disposition: "surfaced",
        reason: "more mail arrived at once than Cue could judge — kept for you",
        decidedBy: "fallback",
        ruleId: null,
        confidence: null,
      });
    }

    const verdicts = await judgeSafely(batch, opts.judge ?? judgeWithFlashLlm);
    const byId = new Map((verdicts ?? []).map((v) => [v.externalId, v]));
    for (const item of batch) {
      const verdict = byId.get(item.externalId);
      if (!verdict) {
        // No judge, no verdict, or a verdict that skipped this item — fail
        // OPEN. An outage must never swallow somebody's mail.
        proposals.set(item.externalId, {
          disposition: "surfaced",
          reason: "Cue could not judge this one, so it kept it for you",
          decidedBy: "fallback",
          ruleId: null,
          confidence: null,
        });
        continue;
      }
      proposals.set(item.externalId, {
        disposition: verdict.keep ? "surfaced" : "filed",
        reason: verdict.reason,
        decidedBy: "model",
        ruleId: null,
        confidence: verdict.confidence,
      });
    }
  } else {
    for (const item of ambiguous) {
      proposals.set(item.externalId, {
        disposition: "surfaced",
        reason: "Cue only filters obvious bulk mail right now — kept for you",
        decidedBy: "fallback",
        ruleId: null,
        confidence: null,
      });
    }
  }

  // THE choke point. Every proposal — rule, model, fallback — passes through
  // the floor one final time. Requirement: the floor is enforced in code
  // after the model answers, not merely requested in the prompt.
  for (const item of signals) {
    const proposed = proposals.get(item.externalId);
    if (!proposed) continue;
    decisions.set(
      item.externalId,
      decideOne(proposed, floors.get(item.externalId) ?? null),
    );
  }
  return decisions;
}
