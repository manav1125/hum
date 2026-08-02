/**
 * Grouping — deciding when a newly arrived message is the SAME thing as
 * something the owner already has, and folding it in instead of adding a row.
 *
 * The measured problem: 104 queued items from one Gmail watcher, 15 of them
 * separate ZA Bank notifications, and two replies in one conversation landing
 * as two unrelated work items because the watcher recorded the message id and
 * never the thread id.
 *
 * Exactly two keys are used, and the narrowness is the design:
 *
 *   · **`thread:<providerThreadId>`** — the provider's own conversation id.
 *     Not a guess: Gmail and Graph both tell us which messages are one
 *     conversation, and we simply stopped throwing that away.
 *   · **`sender:<address>`** — an EXACT sender address, and only for senders
 *     that are structurally machine senders (`no-reply@`, `notifications@`,
 *     `alerts@` …). Fifteen alerts from one robot are one thing to look at.
 *
 * Deliberately refused in this pass:
 *
 *   · **Topic similarity across senders.** A wrongly merged pair of real
 *     obligations is a serious failure and fuzzy matching is exactly where
 *     those hide. Two messages about "the annual return" from two different
 *     organisations are two different annual returns until proven otherwise.
 *   · **Same-domain grouping.** The owner's HSBC mail arrives from three
 *     different sender addresses; collapsing on the domain would fix that one
 *     case and, on the next mailbox, collapse a colleague's personal note in
 *     with their company's billing robot. Exact sender is defensible; the
 *     domain is not.
 *   · **Subject-line matching.** "Re: Invoice" is not evidence.
 *
 * Every merge is reversible and visible: each folded message is a row in
 * `arrival_group_members` (the anchor included), so the count on a card is a
 * query over live rows, and {@link ungroupGroupMember} splits one back out
 * into its own work item without deleting anything. A merge that cannot be
 * undone is a deletion with extra steps.
 */

import { getConfig } from "../config/loader.js";
import { ArrivalComprehensionConfigSchema } from "../config/schemas/arrival-comprehension.js";
import { getLogger } from "../util/logger.js";
import {
  getWorkItem,
  updateWorkItem,
  type WorkItem,
} from "../work-items/work-item-store.js";
import {
  addGroupMember,
  type ArrivalGroupKind,
  type ArrivalGroupMember,
  countActiveMembers,
  findGroupAnchor,
  getGroupMember,
  listGroupMembers,
  markMemberDetached,
} from "./arrival-group-store.js";
import type { ArrivalSignals } from "./arrival-signals.js";
import { type Arrival, attachWorkItemToArrival } from "./arrival-store.js";
import { createWorkItemForArrival } from "./arrival-surface.js";

const log = getLogger("arrival-grouping");

/**
 * Local-parts and display-name fragments that mark a sender as a robot.
 *
 * Only used to decide whether SENDER grouping is allowed — never to file or
 * hide anything, which is the relevance gate's job. Being wrong here costs a
 * visible, reversible merge; being wrong in the gate costs somebody's mail.
 */
const MACHINE_SENDER_MARKERS = [
  "no-reply",
  "noreply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "notification",
  "notifications",
  "notify",
  "alerts",
  "alert",
  "automated",
  "auto-confirm",
  "mailer-daemon",
  "postmaster",
];

/**
 * A thread is a conversation the owner may return to for a long time, so its
 * group stays open for a month.
 */
const THREAD_GROUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A robot's notifications are only "the same thing" while they are recent.
 * Two weeks after the last one, the next alert is a fresh occurrence and
 * deserves its own row rather than being buried under a stale item.
 */
const SENDER_GROUP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** A work item that is still live enough to fold new messages into. */
const OPEN_STATUSES = new Set(["queued", "running", "awaiting_review"]);

/**
 * Read through the schema, not off the object: a config written before this
 * feature has no `comprehension` key at all, and the defaults are the honest
 * answer rather than an exception the caller has to interpret.
 */
function groupingEnabled(): boolean {
  try {
    return ArrivalComprehensionConfigSchema.parse(
      getConfig().watchers?.comprehension ?? {},
    ).grouping;
  } catch {
    // A config we cannot read must not start merging things on a guess.
    return false;
  }
}

export interface GroupKey {
  kind: ArrivalGroupKind;
  key: string;
}

/** True when the sender address or display name is structurally a robot. */
export function looksLikeMachineSender(signals: ArrivalSignals): boolean {
  const address = signals.senderAddress ?? "";
  const localPart = address.split("@")[0] ?? "";
  const name = (signals.senderName ?? "").toLowerCase();
  return MACHINE_SENDER_MARKERS.some(
    (marker) => localPart.includes(marker) || name.includes(marker),
  );
}

/**
 * The ONE key an arrival groups by, or null when it groups by nothing.
 *
 * Pure and exported so the rule can be tested directly and so widening it is
 * impossible to do quietly. Precedence:
 *
 *  1. A machine sender that is not part of a conversation → `sender:`. Robots
 *     open a brand-new thread for every alert, so the thread id is unique per
 *     message and grouping on it would group nothing.
 *  2. Anything with a provider thread id → `thread:`.
 *  3. Otherwise nothing. No key is a perfectly good answer: an ungrouped
 *     arrival behaves exactly as it did before this feature existed.
 *
 * A message the owner is in conversation with (a reply, or a thread they have
 * sent into) NEVER groups by sender, whatever the address looks like — a
 * person replying from a `notifications@` alias is still a conversation.
 */
export function groupKeyFor(signals: ArrivalSignals): GroupKey | null {
  const inConversation =
    signals.isReply || signals.userParticipatedInThread === true;

  if (
    !inConversation &&
    signals.senderAddress &&
    looksLikeMachineSender(signals)
  ) {
    return { kind: "sender", key: `sender:${signals.senderAddress}` };
  }
  const threadId = signals.threadId?.trim();
  if (threadId) return { kind: "thread", key: `thread:${threadId}` };
  return null;
}

function maxAgeFor(kind: ArrivalGroupKind): number {
  return kind === "thread" ? THREAD_GROUP_MAX_AGE_MS : SENDER_GROUP_MAX_AGE_MS;
}

export interface GroupAttachment {
  /** The existing work item the message was folded into. */
  workItem: WorkItem;
  member: ArrivalGroupMember;
  /** Live messages in the group after this one, anchor included. */
  count: number;
  groupKind: ArrivalGroupKind;
}

/**
 * Fold an arrival into an existing group, or return null when it opens a new
 * one. Never throws: grouping is an optimisation of the owner's attention, and
 * a failure here must degrade to the pre-existing behaviour (its own work
 * item) rather than losing the arrival.
 *
 * A group is only joinable while its anchor work item is still OPEN. Once the
 * owner has finished (or archived, or cancelled) the item, the next message is
 * a new occurrence — folding it into something already dealt with would hide
 * it, which is exactly the failure this whole area exists to prevent.
 */
export function attachArrivalToGroup(
  arrival: Arrival,
  signals: ArrivalSignals,
  opts: { now?: number } = {},
): GroupAttachment | null {
  try {
    if (!groupingEnabled()) return null;
    const groupKey = groupKeyFor(signals);
    if (!groupKey) return null;

    const anchor = findGroupAnchor(arrival.channel, groupKey.key);
    if (!anchor) return null;

    const now = opts.now ?? Date.now();
    if (now - anchor.createdAt > maxAgeFor(groupKey.kind)) return null;

    const workItem = getWorkItem(anchor.workItemId);
    if (!workItem || !OPEN_STATUSES.has(workItem.status)) return null;

    const member = addGroupMember({
      workItemId: workItem.id,
      groupKey: groupKey.key,
      groupKind: groupKey.kind,
      channel: arrival.channel,
      arrivalId: arrival.id,
      externalId: arrival.externalId,
      title: arrival.title,
      snippet: arrival.snippet,
      senderAddress: arrival.senderAddress,
      isAnchor: false,
      receivedAt: arrival.createdAt,
    });

    // Provenance points at the item the owner will actually see. Splitting the
    // message back out later re-points it at the item it becomes.
    attachWorkItemToArrival(arrival.id, workItem.id);
    // A new message in a group is activity on that item: bump it so ranking
    // stops treating a live conversation as stale.
    updateWorkItem(workItem.id, {}, { actor: "arrival-grouping" });

    return {
      workItem,
      member,
      count: countActiveMembers(workItem.id),
      groupKind: groupKey.kind,
    };
  } catch (err) {
    log.warn(
      { err: String(err), arrivalId: arrival.id },
      "grouping failed (the arrival gets its own item)",
    );
    return null;
  }
}

/**
 * Record the message that OPENED a group, so later messages have something to
 * find and so "what was combined" includes the first one.
 *
 * Best-effort: a work item without an anchor row simply never grows a group.
 */
export function recordGroupAnchor(
  arrival: Arrival,
  signals: ArrivalSignals,
  workItemId: string,
): ArrivalGroupMember | null {
  try {
    if (!groupingEnabled()) return null;
    const groupKey = groupKeyFor(signals);
    if (!groupKey) return null;
    return addGroupMember({
      workItemId,
      groupKey: groupKey.key,
      groupKind: groupKey.kind,
      channel: arrival.channel,
      arrivalId: arrival.id,
      externalId: arrival.externalId,
      title: arrival.title,
      snippet: arrival.snippet,
      senderAddress: arrival.senderAddress,
      isAnchor: true,
      receivedAt: arrival.createdAt,
    });
  } catch (err) {
    log.warn(
      { err: String(err), arrivalId: arrival.id, workItemId },
      "could not record a group anchor (the item just never groups)",
    );
    return null;
  }
}

export interface GroupSummary {
  workItemId: string;
  /** Live messages folded in, anchor included. 1 = not really a group. */
  count: number;
  groupKind: ArrivalGroupKind | null;
  groupKey: string | null;
  /** Every message ever folded in, splits included, oldest first. */
  members: ArrivalGroupMember[];
}

/** What was combined into this work item — the read behind the UI's list. */
export function getGroupSummary(workItemId: string): GroupSummary {
  const members = listGroupMembers(workItemId);
  const anchor = members.find((m) => m.isAnchor === 1) ?? members[0];
  return {
    workItemId,
    count: members.filter((m) => m.detachedAt == null).length,
    groupKind: anchor?.groupKind ?? null,
    groupKey: anchor?.groupKey ?? null,
    members,
  };
}

export type UngroupResult =
  | { status: "ungrouped"; workItem: WorkItem; member: ArrivalGroupMember }
  | { status: "not_found" }
  | { status: "already_detached"; member: ArrivalGroupMember }
  | { status: "is_anchor"; member: ArrivalGroupMember }
  | { status: "arrival_missing"; member: ArrivalGroupMember };

/**
 * Split one folded message back out into its own work item.
 *
 * The item it becomes is minted through {@link createWorkItemForArrival} — the
 * same function the gate and the reversal path use — so a message the owner
 * un-grouped is indistinguishable from one that never got grouped. Nothing is
 * deleted: the member row keeps its history and gains the id of the item it
 * became.
 *
 * The anchor cannot be split out, because the anchor IS the work item; there
 * is nothing to separate it from. Ungrouping every OTHER member leaves the
 * anchor alone with a count of 1, which is the same end state.
 */
export function ungroupGroupMember(
  memberId: string,
  args: { getArrival: (id: string) => Arrival | undefined; actor?: string },
): UngroupResult {
  const member = getGroupMember(memberId);
  if (!member) return { status: "not_found" };
  if (member.detachedAt != null) {
    return { status: "already_detached", member };
  }
  if (member.isAnchor === 1) return { status: "is_anchor", member };

  const arrival = args.getArrival(member.arrivalId);
  if (!arrival) return { status: "arrival_missing", member };

  const workItem = createWorkItemForArrival(arrival, {
    notes: `Split out of a grouped item · originally combined by ${member.groupKind}`,
    actor: args.actor ?? "user",
  });
  const updated = markMemberDetached(
    memberId,
    workItem.id,
    args.actor ?? "user",
  );
  return { status: "ungrouped", workItem, member: updated ?? member };
}
