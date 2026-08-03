/**
 * The volume valve's rules — how loud is one piece of work?
 *
 * Everything in this file is pure, synchronous and model-free. That is not a
 * style preference, it is the fail-open guarantee: there is no call to time
 * out, no provider to be unconfigured, no budget to exceed. The valve cannot
 * have an outage, so an outage cannot make somebody's work disappear.
 *
 * ## The one rule that governs every other rule
 *
 * **Only positive evidence may lower an item.** A structural fact about a
 * sender's address, or the owner themselves saying "not relevant" — those are
 * judgements about the item, and they may quiet it. Absence of information
 * never is. Specifically:
 *
 *   · The valve throwing → {@link BAND_URGENT}. Not "everything", not silence.
 *   · The gate having failed to judge (`decidedBy: 'fallback'`) →
 *     {@link BAND_NEEDS_YOU}, and it can never be demoted below that. The gate
 *     already fails open; the valve must not quietly undo it downstream.
 *   · No band row at all → {@link BAND_URGENT}, decided by the reader, not
 *     here (see `valve-filter.ts`). Being unknown is the loudest state.
 *
 * This codebase has emptied a task list once by getting that backwards, and
 * the arrival gate's own header comment already says it in the mail dialect.
 * The valve is downstream of the gate and inherits the obligation intact.
 *
 * ## Bands vs. stops
 *
 * The band says how loud the item is. The stop says how loud the owner wants
 * things to be before they are interrupted. They are compared, never merged —
 * see {@link bandPassesStop}. Nothing is filtered out of the database at any
 * point; a quieter band means "not on HQ right now", and the item remains in
 * Work, queryable, counted, and one stop-change away from visible.
 */

import {
  isBulkSenderAddress,
  looksTransactional,
} from "../arrivals/arrival-sender-shape.js";
import type { Arrival } from "../arrivals/arrival-store.js";
import type { WorkItem } from "../work-items/work-item-store.js";

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export const BAND_URGENT = "urgent";
export const BAND_NEEDS_YOU = "needs_you";
export const BAND_EVERYTHING = "everything";

/** How loudly one item asks for the owner. */
export type ValveBand =
  | typeof BAND_URGENT
  | typeof BAND_NEEDS_YOU
  | typeof BAND_EVERYTHING;

export const VALVE_BANDS: readonly ValveBand[] = [
  BAND_URGENT,
  BAND_NEEDS_YOU,
  BAND_EVERYTHING,
];

/** Where the owner has set the valve. Design's three stops, verbatim. */
export type ValveStop = "everything" | "needs_you" | "only_urgent";

export const VALVE_STOPS: readonly ValveStop[] = [
  "everything",
  "needs_you",
  "only_urgent",
];

/**
 * The default stop.
 *
 * "Needs you" rather than "everything", because the shipped behaviour today —
 * 131 items standing in the queue — is the problem being fixed, and a default
 * that preserves it ships a control nobody turns. It is safe to default here
 * only because demotion requires positive evidence and nothing is deleted:
 * the worst case of a wrong band is one extra tap on a number, not a lost
 * message.
 */
export const DEFAULT_STOP: ValveStop = "needs_you";

export function isValveBand(value: unknown): value is ValveBand {
  return (
    typeof value === "string" &&
    (VALVE_BANDS as readonly string[]).includes(value)
  );
}

export function isValveStop(value: unknown): value is ValveStop {
  return (
    typeof value === "string" &&
    (VALVE_STOPS as readonly string[]).includes(value)
  );
}

/** Loudness rank. Higher is louder. */
function bandRank(band: ValveBand): number {
  switch (band) {
    case BAND_URGENT:
      return 2;
    case BAND_NEEDS_YOU:
      return 1;
    default:
      return 0;
  }
}

/** The minimum loudness a stop lets through. */
function stopFloor(stop: ValveStop): number {
  switch (stop) {
    case "only_urgent":
      return 2;
    case "needs_you":
      return 1;
    default:
      return 0;
  }
}

/**
 * Does an item at this band interrupt at this stop?
 *
 * The entire read-time behaviour of the valve is this one comparison. It is
 * total (every band answers at every stop), monotone (raising the stop can
 * only ever hide more, never reveal), and it has no failure mode — which is
 * why the expensive, fallible part of the work happens once at banding time
 * and this part happens on every read.
 */
export function bandPassesStop(band: ValveBand, stop: ValveStop): boolean {
  return bandRank(band) >= stopFloor(stop);
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Every rule the valve can fire, as a closed union.
 *
 * A closed union rather than a free string so that
 * {@link VALVE_RULE_IDS} is exhaustive by construction, and the health route
 * can report `neverFired` — the rules that exist in code and have never once
 * fired in production. The last safety floor in this codebase ran on one of
 * its four legs for weeks because nothing ever asked that question.
 */
export type ValveRuleId =
  // urgent
  | "valve_error"
  | "owner_reversed"
  | "awaiting_you"
  | "due_now"
  | "known_person"
  | "mission_boosted"
  // needs you
  | "gate_unsure"
  | "named_work"
  | "calendar_action"
  | "model_keep"
  | "direct_person"
  | "self_captured"
  // everything
  | "learned_down"
  | "automated_sender"
  | "cue_is_holding"
  | "already_seen"
  | "sender_stream";

export const VALVE_RULE_IDS: readonly ValveRuleId[] = [
  "valve_error",
  "owner_reversed",
  "awaiting_you",
  "due_now",
  "known_person",
  "mission_boosted",
  "gate_unsure",
  "named_work",
  "calendar_action",
  "model_keep",
  "direct_person",
  "self_captured",
  "learned_down",
  "automated_sender",
  "cue_is_holding",
  "already_seen",
  "sender_stream",
];

/** The band each rule assigns. Exported so the health route can group by it. */
export const RULE_BANDS: Readonly<Record<ValveRuleId, ValveBand>> = {
  valve_error: BAND_URGENT,
  owner_reversed: BAND_URGENT,
  awaiting_you: BAND_URGENT,
  due_now: BAND_URGENT,
  known_person: BAND_URGENT,
  mission_boosted: BAND_URGENT,
  gate_unsure: BAND_NEEDS_YOU,
  named_work: BAND_NEEDS_YOU,
  calendar_action: BAND_NEEDS_YOU,
  model_keep: BAND_NEEDS_YOU,
  direct_person: BAND_NEEDS_YOU,
  self_captured: BAND_NEEDS_YOU,
  learned_down: BAND_EVERYTHING,
  automated_sender: BAND_EVERYTHING,
  cue_is_holding: BAND_EVERYTHING,
  already_seen: BAND_EVERYTHING,
  sender_stream: BAND_EVERYTHING,
};

export type ValveBandedBy = "rule" | "learned" | "fallback";

export interface BandVerdict {
  band: ValveBand;
  ruleId: ValveRuleId;
  /** The owner's words. Never a code, never a score. */
  reason: string;
  bandedBy: ValveBandedBy;
}

/**
 * Everything the banding needs that is not on the item or its arrival.
 * Injected rather than looked up inline so the rules stay a pure function —
 * the one part of the valve that must be trivially testable and trivially
 * auditable, exactly as the arrival gate's safety floor is.
 */
export interface BandContext {
  /** Epoch ms. Injectable so `due_now` is testable without wall-clock races. */
  now: number;
  /**
   * Has the owner taught the valve that this sender does not need them?
   * Returns false for unknown senders — an absence of teaching is never
   * evidence, and this predicate is the ONLY route by which the owner's
   * behaviour can quiet something.
   */
  isLearnedDown: (senderKey: string) => boolean;
  /**
   * The PROJECT ids belonging to missions the owner has bumped to
   * "Everything" while they are live.
   *
   * Project ids rather than mission ids because that is the join a work item
   * actually carries: `work_items.project_id` is the only link to a mission,
   * via `listMissionProjects`. Resolving the hop here — in the caller, once
   * per batch — keeps this function pure and stops the rule from silently
   * never firing because it compared a mission id to a project id.
   */
  boostedProjectIds: ReadonlySet<string>;
}

/** Anything due inside this window is urgent regardless of everything else. */
export const DUE_SOON_MS = 24 * 60 * 60 * 1000;

/**
 * How long an item that has already interrupted the owner keeps interrupting.
 *
 * Design's "already-seen drift surfaces once, then rests". It rests rather
 * than vanishes: the item stays in Work at `everything`, and any change to it
 * re-bands it, so resting is a statement about this presentation of this
 * version of the item and nothing more.
 */
export const REST_AFTER_MS = 12 * 60 * 60 * 1000;

/** Gate rule ids that mean a real, deliberately-known human. */
const KNOWN_PERSON_GATE_RULES = new Set([
  "known_contact",
  "thread_participant",
]);

/** Gate rule ids that mean the calendar needs an answer. */
const CALENDAR_GATE_RULES = new Set([
  "calendar_conflict",
  "calendar_invite_needs_answer",
]);

/**
 * Is this work item one where Cue is blocked ON THE OWNER?
 *
 * Not "is it important" — "does it literally cannot proceed without a human".
 * These are the only items that are urgent by virtue of their own state.
 */
function awaitsTheOwner(item: WorkItem): boolean {
  if (item.status === "awaiting_review") return true;
  const approval = item.approvalStatus;
  return approval != null && approval !== "none" && approval !== "approved";
}

/**
 * Is Cue holding this one for itself?
 *
 * An item Cue may run unattended, that is queued or running and is not blocked
 * on the owner, is Cue's problem rather than theirs — design's "its own holding
 * queue (→ Work)". `parked` explicitly means the opposite (it will NOT run
 * without a human), so a parked item is never holding.
 */
function cueIsHolding(item: WorkItem): boolean {
  if (awaitsTheOwner(item)) return false;
  if (item.status === "running") return true;
  return item.status === "queued" && item.autoRunEligibility === "eligible";
}

/**
 * The rules that must be re-asked on every read, because they are about the
 * item's CURRENT state rather than about what arrived.
 *
 * A band is stamped once, at intake. Three of the urgent rules would go stale
 * the moment they mattered most if they were left at that: an item becomes
 * `awaiting_review` hours after it was banded, a deadline crosses into
 * tomorrow overnight, a mission gets bumped while it is live. An item that
 * started life quiet and has since become the thing Cue is blocked on must
 * not stay quiet because of a decision taken before it was.
 *
 * So these are evaluated live and take the MAXIMUM against the stamped band —
 * never the minimum. The live floor can only ever make an item louder. It
 * cannot be the reason something disappears, which is why it is safe to run
 * it on every read without a fallback path of its own.
 *
 * Costs nothing: no I/O, no allocation beyond the verdict, just fields
 * already loaded on the row.
 */
export function liveFloor(
  item: WorkItem,
  ctx: Pick<BandContext, "now" | "boostedProjectIds">,
): BandVerdict | null {
  if (awaitsTheOwner(item)) {
    return {
      band: BAND_URGENT,
      ruleId: "awaiting_you",
      reason: "Cue is waiting on you before it can go further",
      bandedBy: "rule",
    };
  }
  if (item.dueAt != null && item.dueAt - ctx.now <= DUE_SOON_MS) {
    return {
      band: BAND_URGENT,
      ruleId: "due_now",
      reason: "this is due within a day",
      bandedBy: "rule",
    };
  }
  if (item.projectId != null && ctx.boostedProjectIds.has(item.projectId)) {
    return {
      band: BAND_URGENT,
      ruleId: "mission_boosted",
      reason: "you turned this mission all the way up",
      bandedBy: "rule",
    };
  }
  return null;
}

/**
 * Band one item. Pure, total, and never throws for a caller-supplied reason —
 * the `valve_error` rule exists for the caller to stamp when something around
 * this function fails, not for this function to reach.
 *
 * The order of the checks IS the policy, so it is written as one flat sequence
 * rather than a scoring loop: the first rule that fires wins, urgent rules are
 * asked first, and demotion rules are asked last and only of items nothing
 * louder claimed. Reading top to bottom tells you exactly what beats what.
 */
export function bandItem(
  item: WorkItem,
  arrival: Arrival | null,
  ctx: BandContext,
): BandVerdict {
  const senderKey = arrival?.senderAddress ?? null;

  // ---- urgent -------------------------------------------------------------

  // The owner reached into the filed pile and said "this mattered". That is
  // the single strongest signal in the system and it is checked first: no
  // later rule may quiet something they went and dug out by hand. The gate
  // deliberately preserves the original verdict on a reversed row, so every
  // demotion rule below would otherwise still see the reasons it was filed.
  if (arrival?.reversedAt != null) {
    return {
      band: BAND_URGENT,
      ruleId: "owner_reversed",
      reason: "you said this one mattered",
      bandedBy: "learned",
    };
  }

  // Cue cannot move without them; the deadline is inside a day; the mission
  // is turned all the way up. All three are about the item's state right now
  // rather than about what arrived, so they live in {@link liveFloor} and are
  // re-asked on every read — stamping them here as well means a freshly-minted
  // item is already correct without waiting for the first read to fix it.
  const floor = liveFloor(item, ctx);
  if (floor) return floor;

  // Somebody the owner deliberately saved, or a thread they are in. The gate
  // already established this; the valve reads its verdict rather than
  // re-deriving it, so there is exactly one definition of "a known person" in
  // the daemon and it lives in the gate.
  if (
    arrival &&
    (arrival.decidedBy === "floor" ||
      (arrival.ruleId != null && KNOWN_PERSON_GATE_RULES.has(arrival.ruleId)))
  ) {
    return {
      band: BAND_URGENT,
      ruleId: "known_person",
      reason: arrival.reason ?? "this is from someone you know",
      bandedBy: "rule",
    };
  }

  // ---- needs you ----------------------------------------------------------

  // THE FAIL-OPEN CLAUSE, and it is placed here deliberately — above every
  // demotion rule below, so no later branch can reach an item the gate admits
  // it could not judge.
  //
  // `decidedBy: 'fallback'` means the judge errored, timed out, was switched
  // off, or was never asked. On production this was 156 arrivals against five
  // usable verdicts. Those are not items Cue decided were quiet; they are
  // items Cue did not decide about, and the only honest presentation of "I do
  // not know" is to show it to the owner. It is never demoted, not by a
  // learned sender, not by an automated address, not by having been seen.
  if (arrival?.decidedBy === "fallback") {
    return {
      band: BAND_NEEDS_YOU,
      ruleId: "gate_unsure",
      reason: "Cue could not judge this one, so it kept it for you",
      bandedBy: "fallback",
    };
  }

  if (arrival?.ruleId === "named_work") {
    return {
      band: BAND_NEEDS_YOU,
      ruleId: "named_work",
      reason: arrival.reason ?? "this names something you're working on",
      bandedBy: "rule",
    };
  }

  if (arrival?.ruleId != null && CALENDAR_GATE_RULES.has(arrival.ruleId)) {
    return {
      band: BAND_NEEDS_YOU,
      ruleId: "calendar_action",
      reason: arrival.reason ?? "your calendar needs an answer",
      bandedBy: "rule",
    };
  }

  // ---- demotions: positive evidence only ----------------------------------
  //
  // Everything from here down can quiet an item, so every one of these
  // branches must rest on something Cue can point at: a thing the owner did,
  // or a structural fact about the item. None of them may fire on missing
  // information.

  // The owner told us. Repeatedly, and more often than they contradicted
  // themselves — see `isLearnedDown`. This is the rule that makes the holding
  // count shrink on its own.
  if (senderKey && ctx.isLearnedDown(senderKey)) {
    return {
      band: BAND_EVERYTHING,
      ruleId: "learned_down",
      reason: "you've told Cue this sender doesn't need you",
      bandedBy: "learned",
    };
  }

  // The over-firing leg, measured: 68 of one production day's 93 surfaced
  // arrivals were `direct_human` — HSBC, Uber, Temu, a bank's marketing promo.
  // The gate keeps them because a robot addressing you directly still clears
  // its floor, and that is the right call for a gate whose job is to not lose
  // mail. It is the wrong call for a lane. `looksTransactional` is what keeps
  // this safe: an automated sender with something to ACT on (an approval, an
  // expiring credential, a payment failure) is not demoted.
  if (
    arrival &&
    isBulkSenderAddress(arrival.senderAddress) &&
    !looksTransactional(arrival.title) &&
    !looksTransactional(arrival.snippet ?? "")
  ) {
    return {
      band: BAND_EVERYTHING,
      ruleId: "automated_sender",
      reason: "this is an automated sender with nothing to action",
      bandedBy: "rule",
    };
  }

  if (cueIsHolding(item)) {
    return {
      band: BAND_EVERYTHING,
      ruleId: "cue_is_holding",
      reason: "Cue is handling this one — nothing needed from you",
      bandedBy: "rule",
    };
  }

  // ---- back up to needs you -----------------------------------------------

  if (arrival?.decidedBy === "model" && arrival.disposition === "surfaced") {
    return {
      band: BAND_NEEDS_YOU,
      ruleId: "model_keep",
      reason: arrival.reason ?? "Cue judged that you need to see this",
      bandedBy: "rule",
    };
  }

  if (arrival?.ruleId === "direct_human") {
    return {
      band: BAND_NEEDS_YOU,
      ruleId: "direct_person",
      reason: arrival.reason ?? "a person wrote to you directly",
      bandedBy: "rule",
    };
  }

  // No arrival at all: the owner captured this themselves, from chat, voice,
  // quick-add or MCP. There is nothing to judge and nobody to blame it on —
  // they asked for it, so it needs them. Never demoted.
  return {
    band: BAND_NEEDS_YOU,
    ruleId: "self_captured",
    reason: "you added this yourself",
    bandedBy: "rule",
  };
}

/**
 * Domains whose whole purpose is machine mail, matched as a label.
 *
 * `isBulkSenderAddress` reads the LOCAL part, which is the right test for a
 * `noreply` local part. It cannot see an address whose local part is a bank's
 * product code and whose domain merely BEGINS with a `notification.` label —
 * and measured on production that one address shape accounted for 24 of a
 * single day's 94 keeps, across four senders at one bank.
 *
 * Kept here rather than added to `arrival-sender-shape.ts` deliberately: that
 * module is shared with the gate, where the same test would change what gets
 * FILED. The valve may decide something does not need to interrupt; it has no
 * business changing what the gate keeps.
 */
const BULK_DOMAIN_LABELS = new Set([
  "notification",
  "notifications",
  "notify",
  "mail",
  "email",
  "mailer",
  "news",
  "newsletter",
  "market",
  "marketing",
  "campaign",
  "campaigns",
  "alerts",
  "info",
  "updates",
  "t",
  "m",
]);

/**
 * Is this address structurally a machine, by local part OR by domain label?
 *
 * A statement about the ADDRESS only. It says nothing about whether the
 * message matters — which is why, on its own, it is never enough to quiet
 * anything. It is used only to decide whether a REPEAT from the same address
 * is a stream (see {@link collapseSenderStreams}).
 */
export function isMachineAddress(address: string | null): boolean {
  if (!address) return false;
  if (isBulkSenderAddress(address)) return true;
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const labels = address
    .slice(at + 1)
    .toLowerCase()
    .split(".");
  // The registrable name and TLD are skipped: `mail.approveit.today` is a
  // stream, `approveit.today` is a correspondent, and "today" is a TLD.
  return labels
    .slice(0, Math.max(0, labels.length - 2))
    .some((label) => BULK_DOMAIN_LABELS.has(label));
}

/** One item's identity for the stream collapse. */
export interface StreamCandidate {
  itemId: string;
  senderKey: string | null;
  band: ValveBand;
  ruleId: string;
  /** Newest first is decided by this; higher wins. */
  occurredAt: number;
}

/**
 * Which of a batch's items are the second-and-later message from one machine.
 *
 * The measured shape of this account is not a hundred different things asking
 * for attention — it is nine messages from HSBC, seven from Uber, seven from
 * HSBC Business, four from an approvals robot. Those are four streams, not
 * twenty-seven interruptions, and collapsing them is the one big reduction
 * available that requires NO judgement about content whatsoever.
 *
 * The rules that keep it safe:
 *
 *   · **The newest from every sender always shows.** No address is ever
 *     silenced; a stream is thinned, never cut. Whatever HSBC sent most
 *     recently is on HQ.
 *   · **Only machine addresses collapse.** A person who writes three times
 *     gets three items, because three emails from a person is three things
 *     they want.
 *   · **Urgent never collapses**, so an approval, a deadline or a mission
 *     boost is not thinned by volume from the same source.
 *   · **`gate_unsure` never collapses**, for the same reason it is exempt
 *     from every other demotion: Cue does not get to thin a pile it never
 *     understood.
 *
 * Returns the ids to hold. Pure — the caller does the moving.
 */
export function collapseSenderStreams(
  candidates: StreamCandidate[],
): Map<string, string> {
  const bySender = new Map<string, StreamCandidate[]>();
  for (const c of candidates) {
    if (c.band === BAND_URGENT) continue;
    if (c.ruleId === "gate_unsure") continue;
    if (!c.senderKey || !isMachineAddress(c.senderKey)) continue;
    const list = bySender.get(c.senderKey);
    if (list) list.push(c);
    else bySender.set(c.senderKey, [c]);
  }

  const held = new Map<string, string>();
  for (const [sender, list] of bySender) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.occurredAt - a.occurredAt);
    const domain = sender.slice(sender.lastIndexOf("@") + 1);
    for (const c of list.slice(1)) {
      held.set(
        c.itemId,
        `one of ${list.length} from ${domain} — the newest is on your board`,
      );
    }
  }
  return held;
}

/**
 * The band an already-banded item should carry once it has been seen.
 *
 * Applied at read time rather than stamped, so that "rested" is always
 * recomputed from `surfacedAt` and can never outlive the reason for it. An
 * item that changes is re-banded from scratch and starts interrupting again.
 *
 * Urgent items never rest. Something Cue is blocked on, or that is due today,
 * does not become less true for having been looked at once.
 */
export function applyRest(
  verdict: BandVerdict,
  surfacedAt: number | null,
  now: number,
): BandVerdict {
  if (verdict.band === BAND_URGENT) return verdict;
  if (surfacedAt == null) return verdict;
  if (now - surfacedAt < REST_AFTER_MS) return verdict;
  // `gate_unsure` is exempt for the same reason it is exempt from demotion:
  // showing an item Cue could not judge once and then hiding it is how an
  // unjudged item becomes an invisible one.
  if (verdict.ruleId === "gate_unsure") return verdict;
  return {
    band: BAND_EVERYTHING,
    ruleId: "already_seen",
    reason: "you've seen this one — it's resting in Work",
    bandedBy: "rule",
  };
}
