/**
 * Retro-run of the arrival relevance gate over work items that predate it.
 *
 * The gate filters at the arrival boundary, so it only ever sees NEW mail. The
 * items already sitting in the queued lane when it shipped were minted before
 * any predicate existed and will never be filtered — a hundred newsletters and
 * receipts that the owner has to look at forever. This module applies the same
 * gate to those rows, after the fact.
 *
 * The hard part is honesty about signals. A pre-gate `watcher_events.payload_json`
 * carries only `id, threadId, from, subject, date, snippet, labelIds` — the
 * header block the gate reads (`List-Unsubscribe`, `List-Id`, `Precedence`,
 * `Auto-Submitted`, `To:`/`Cc:` membership, thread participation) was added as
 * part of the gate work and simply is not there for these rows. That matters
 * because {@link buildArrivalSignals} renders an absent `toMe` as
 * `directToUser: false`, which is not "unknown" but a false assertion that the
 * owner was not a direct recipient — and `direct_human` is one of the four
 * safety-floor conditions. Reconstruct naively and the floor quietly loses a
 * leg.
 *
 * So each item is classified by what its payload actually still contains:
 *
 *   - `full`  — the header block survived (an item that arrived after the gate
 *     shipped but somehow was not gated). Decided by the real gate, unchanged.
 *   - `thin`  — headers absent. The model is NOT consulted by default, because
 *     judging a stranger's mail from a subject line is exactly the guess that
 *     wrongly files somebody's real message. Only a deterministic signal that
 *     genuinely survived in the row can file a thin item: Gmail's own category
 *     labels.
 *   - `unavailable` — the originating watcher event is gone, so there is
 *     nothing to reconstruct from. Always kept.
 *
 * The Gmail category labels are a real stored signal rather than an inference:
 * `CATEGORY_PROMOTIONS` / `SOCIAL` / `FORUMS` are Google's own bulk
 * classification, recorded at delivery. {@link BULK_GMAIL_CATEGORIES}
 * deliberately excludes `CATEGORY_UPDATES` — statements, receipts, delivery
 * notices and statutory reminders all live there, and one of the items in this
 * very backlog is a company annual-return deadline.
 *
 * Nothing is destroyed. A filed item is archived, not deleted, and its
 * `arrivals` row points back at it so `POST arrivals/:id/reverse` restores the
 * original row rather than minting a copy. The safety floor runs over every
 * proposal from every path, exactly as it does at the live boundary.
 *
 * Idempotent and resumable: the `arrivals` row is the marker. An item that
 * already has one is skipped, and rows are written per chunk, so an
 * interrupted run resumes without double-filing or minting duplicates.
 */

import { getLogger } from "../util/logger.js";
import { listWatcherEvents } from "../watcher/watcher-store.js";
import {
  listWorkItems,
  updateWorkItem,
  type WorkItem,
} from "../work-items/work-item-store.js";
import {
  applySafetyFloor,
  type ArrivalDecision,
  buildFloorContext,
  decideArrivals,
  decideOne,
  type FloorContext,
  MAX_JUDGE_BATCH,
} from "./arrival-gate.js";
import {
  type ArrivalPayload,
  type ArrivalSignals,
  buildArrivalSignals,
} from "./arrival-signals.js";
import {
  type ArrivalDecidedBy,
  type ArrivalDisposition,
  attachWorkItemToArrival,
  findArrivalByExternalId,
  recordArrival,
} from "./arrival-store.js";

const log = getLogger("arrival-retrofit");

/** The channel these items came in on. */
export const DEFAULT_RETRO_CHANNEL = "watcher:gmail";

/** Actor recorded on every write this tool makes. */
export const RETRO_ACTOR = "retro-arrival-gate";

/**
 * Gmail categories that are a delivery-time bulk classification by Google.
 *
 * `CATEGORY_UPDATES` is deliberately absent. It is where receipts, bank
 * statements, flight reminders and statutory notices land — filing on it would
 * hide exactly the mail the owner most needs.
 */
export const BULK_GMAIL_CATEGORIES: Record<string, string> = {
  CATEGORY_PROMOTIONS: "Gmail filed this under Promotions",
  CATEGORY_SOCIAL: "Gmail filed this under Social",
  CATEGORY_FORUMS: "Gmail filed this under Forums",
};

/**
 * Gmail's own "this mattered" marker. A retro-only floor condition: it is a
 * signal the provider recorded at delivery, and the live gate has no
 * equivalent only because live arrivals carry richer headers instead.
 */
const IMPORTANT_LABEL = "IMPORTANT";

/**
 * Payload keys that only exist on post-gate rows. Any one of them present
 * means the header block survived and the real gate can read this item.
 */
const HEADER_BLOCK_KEYS: readonly (keyof ArrivalPayload)[] = [
  "listUnsubscribe",
  "listId",
  "precedence",
  "autoSubmitted",
  "inReplyTo",
  "references",
  "toMe",
  "ccMe",
  "userParticipatedInThread",
];

/** How much of the original signal set a row still carries. */
export type ReconstructionQuality = "full" | "thin" | "unavailable";

/** What the retro run did to one work item. */
export type RetrofitAction =
  /** Moved out of the lane into a filed arrival; the item is archived. */
  | "filed"
  /** Left exactly where it was. */
  | "kept"
  /** Already has an arrivals row — a previous run handled it. */
  | "already_processed";

export interface RetrofitItemReport {
  workItemId: string;
  externalId: string | null;
  title: string;
  sender: string | null;
  action: RetrofitAction;
  disposition: ArrivalDisposition;
  /** In the owner's words, never a score. */
  reason: string;
  decidedBy: ArrivalDecidedBy;
  ruleId: string | null;
  confidence: number | null;
  reconstruction: ReconstructionQuality;
  /** Signals genuinely recovered from the stored payload. */
  signalsPresent: string[];
  /** Signals the gate normally reads that this row simply does not have. */
  signalsMissing: string[];
  /** The arrivals row written (null on a dry run). */
  arrivalId: string | null;
  /** Whether `POST arrivals/:id/reverse` can put this item back as it was. */
  reversible: boolean;
}

export interface RetrofitReport {
  channel: string;
  /** False on a dry run: every number below is what WOULD have happened. */
  applied: boolean;
  scanned: number;
  filed: number;
  kept: number;
  alreadyProcessed: number;
  /** Items whose originating watcher event no longer exists. */
  unreconstructable: number;
  items: RetrofitItemReport[];
}

export interface RetrofitOptions {
  /** Work-item `sourceType` to sweep. Defaults to `watcher:gmail`. */
  channel?: string;
  /** Write. Defaults to FALSE — a dry run is the safe default and the review gate. */
  apply?: boolean;
  /** Stop after this many candidate items. */
  limit?: number;
  /**
   * Let the flash judge rule on thin rows too. OFF by default: with no
   * headers the judge sees only a subject line and a sender, which is the
   * guess this tool exists to avoid. Opt in only after reading a dry run.
   */
  useModelOnThin?: boolean;
  /** Injectable for tests. */
  decide?: typeof decideArrivals;
  /** Injectable for tests. */
  floorContext?: FloorContext;
  /** Injectable for tests: how many watcher events to load. */
  eventScanLimit?: number;
}

/** How many watcher events to pull when indexing payloads by external id. */
const DEFAULT_EVENT_SCAN_LIMIT = 20_000;

function parsePayload(payloadJson: string): ArrivalPayload | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ArrivalPayload;
  } catch {
    return null;
  }
}

function labelsOf(payload: ArrivalPayload | null): string[] {
  const raw = (payload as { labelIds?: unknown } | null)?.labelIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((l): l is string => typeof l === "string");
}

/**
 * Which of the gate's inputs this row genuinely has, and which it does not.
 * Reported per item so a reviewer can see what the decision was made on
 * instead of taking the verdict on trust.
 */
export function describeReconstruction(payload: ArrivalPayload | null): {
  quality: ReconstructionQuality;
  present: string[];
  missing: string[];
} {
  if (!payload) {
    return {
      quality: "unavailable",
      present: [],
      missing: ["everything — the original watcher event is gone"],
    };
  }
  const present: string[] = [];
  const missing: string[] = [];
  if (payload.from) present.push("sender");
  else missing.push("sender");
  if (payload.subject) present.push("subject");
  if (payload.snippet) present.push("snippet");
  if (labelsOf(payload).length > 0) present.push("gmail labels");
  else missing.push("gmail labels");

  const hasHeaders = HEADER_BLOCK_KEYS.some((k) => payload[k] !== undefined);
  if (hasHeaders) {
    present.push("mail headers", "recipient position", "thread participation");
  } else {
    missing.push(
      "List-Unsubscribe / List-Id",
      "Precedence / Auto-Submitted",
      "whether the owner was a direct recipient",
      "whether the owner replied in this thread",
    );
  }
  return { quality: hasHeaders ? "full" : "thin", present, missing };
}

/**
 * The retro-only deterministic layer, for rows whose headers are gone.
 *
 * Only signals that are actually recorded on the row may file it. A Gmail
 * category is such a signal; a model's read of a subject line is not.
 * Returns null when nothing on the row justifies filing — which is the common
 * case, and the correct one.
 */
export function proposeFromStoredLabels(
  payload: ArrivalPayload | null,
): ArrivalDecision | null {
  const labels = labelsOf(payload);
  if (labels.length === 0) return null;
  // Gmail's own importance marker outranks its category. If Google thought
  // this mattered to the owner, the retro run does not overrule it.
  if (labels.includes(IMPORTANT_LABEL)) return null;
  for (const label of labels) {
    const reason = BULK_GMAIL_CATEGORIES[label];
    if (reason) {
      return {
        disposition: "filed",
        reason,
        decidedBy: "rule",
        ruleId: "list_mail",
        confidence: null,
      };
    }
  }
  return null;
}

/**
 * Local-parts that only ever belong to a machine sending to a crowd.
 *
 * This is a claim about the ADDRESS, not about the content — which is the only
 * reason it is allowed on a thin row. `noreply@` is not a judgement that the
 * message is unimportant; it is an observation that the sender has structurally
 * refused a reply, and a correspondent who cannot be answered is not
 * correspondence. That property survived in the stored `from`, so it can be
 * read retroactively without inventing anything.
 *
 * Deliberately NOT included: `support@`, `hello@`, `team@`, `billing@`,
 * `admin@`, `accounts@`. Every one of those is routinely a human, or a robot
 * whose message needs an answer — an approval request, an expiring token, an
 * invoice. Those are exactly the items the owner needs surfaced, and the eight
 * identical promos this rule exists to clear are not worth one missed invoice.
 */
const BULK_LOCAL_PARTS = [
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "newsletter",
  "newsletters",
  "news",
  "promotions",
  "promo",
  "campaigns",
  "campaign",
  "marketing",
  "mailer",
  "mailing",
  "notification",
  "notifications",
  "buzz",
  "digest",
  "updates",
  "bounce",
] as const;

/**
 * True when the address is structurally a bulk sender.
 *
 * Matches the local part exactly, or as a `-`/`.`/`_`-delimited token within
 * it, so `news-noreply@` and `en_flight_noreply@` both hit while `newsome@`
 * (a surname) does not. Substring matching would
 * catch the surname, and filing a person's mail because their name contains
 * "news" is precisely the failure this whole system is built to avoid.
 */
export function isBulkSenderAddress(address: string | null): boolean {
  if (!address) return false;
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const local = address.slice(0, at).toLowerCase();
  const tokens = local.split(/[-._+]/).filter(Boolean);
  return BULK_LOCAL_PARTS.some((p) => local === p || tokens.includes(p));
}

/**
 * The retro-only sender-shape rule.
 *
 * Retro-only on purpose: at the live boundary the real headers are present, and
 * `List-Unsubscribe` / `Precedence` / `Auto-Submitted` are strictly better
 * evidence than an address pattern. This exists because those headers were
 * never captured for mail that arrived before the gate, and the alternative for
 * the owner is reading eight identical promos by hand.
 */
export function proposeFromSenderShape(
  signals: ArrivalSignals | null,
): ArrivalDecision | null {
  if (!signals || !isBulkSenderAddress(signals.senderAddress)) return null;
  return {
    disposition: "filed",
    reason: `bulk mail from ${signals.senderName ?? signals.senderAddress ?? "an automated sender"}`,
    decidedBy: "rule",
    ruleId: "bulk_sender_address",
    confidence: null,
  };
}

/** The verdict for a row nothing could justify filing. */
function keepDecision(reason: string): ArrivalDecision {
  return {
    disposition: "surfaced",
    reason,
    decidedBy: "fallback",
    ruleId: null,
    confidence: null,
  };
}

interface Candidate {
  item: WorkItem;
  externalId: string;
  payload: ArrivalPayload | null;
  signals: ArrivalSignals | null;
  reconstruction: ReturnType<typeof describeReconstruction>;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * Apply the gate to the pre-gate backlog.
 *
 * Dry by default. Never throws on a single bad row — one unreadable payload
 * degrades to "kept", the same direction every failure in the live gate takes.
 */
export async function retrofitArrivalGate(
  opts: RetrofitOptions = {},
): Promise<RetrofitReport> {
  const channel = opts.channel ?? DEFAULT_RETRO_CHANNEL;
  const apply = opts.apply === true;
  const decide = opts.decide ?? decideArrivals;
  const floorContext = opts.floorContext ?? buildFloorContext();

  const report: RetrofitReport = {
    channel,
    applied: apply,
    scanned: 0,
    filed: 0,
    kept: 0,
    alreadyProcessed: 0,
    unreconstructable: 0,
    items: [],
  };

  // Only the queued lane, only items the gate never saw. `arrivalId == null`
  // is the structural marker: an item that came through the gate already has
  // one, so it can never be re-decided here.
  let pending = listWorkItems({ status: "queued" }).filter(
    (i) =>
      i.sourceType === channel && i.sourceId != null && i.arrivalId == null,
  );
  pending.sort((a, b) => a.createdAt - b.createdAt);
  if (opts.limit != null) pending = pending.slice(0, opts.limit);
  if (pending.length === 0) return report;

  // Recover the original payloads. One pass, indexed by external id.
  const payloadByExternalId = new Map<string, string>();
  try {
    for (const event of listWatcherEvents({
      limit: opts.eventScanLimit ?? DEFAULT_EVENT_SCAN_LIMIT,
    })) {
      if (!payloadByExternalId.has(event.externalId)) {
        payloadByExternalId.set(event.externalId, event.payloadJson);
      }
    }
  } catch (err) {
    // Without payloads nothing can be reconstructed, and reconstructing
    // nothing must mean keeping everything — never filing on no evidence.
    log.warn(
      { err: String(err) },
      "retro gate: could not read watcher events; every item will be kept",
    );
  }

  const candidates: Candidate[] = [];
  for (const item of pending) {
    const externalId = item.sourceId as string;
    const payloadJson = payloadByExternalId.get(externalId) ?? null;
    const payload = payloadJson ? parsePayload(payloadJson) : null;
    const reconstruction = describeReconstruction(payload);
    let signals: ArrivalSignals | null = null;
    if (payloadJson) {
      try {
        signals = buildArrivalSignals({
          channel,
          externalId,
          title: item.title,
          summary: item.notes ?? item.context ?? "",
          payloadJson,
        });
      } catch (err) {
        log.warn(
          { err: String(err), workItemId: item.id },
          "retro gate: could not rebuild signals; keeping this item",
        );
      }
    }
    candidates.push({ item, externalId, payload, signals, reconstruction });
    report.scanned++;
    if (reconstruction.quality === "unavailable") report.unreconstructable++;
  }

  // Full-signal rows go to the real gate, batched under its own judge cap so
  // the overflow branch ("more mail than Cue could judge") never fires.
  const gated = candidates.filter(
    (c) =>
      c.signals != null &&
      (c.reconstruction.quality === "full" ||
        (opts.useModelOnThin && c.reconstruction.quality === "thin")),
  );
  const decisions = new Map<string, ArrivalDecision>();
  for (const batch of chunk(gated, MAX_JUDGE_BATCH)) {
    try {
      const batchDecisions = await decide(
        batch.map((c) => c.signals as ArrivalSignals),
        { floorContext },
      );
      for (const [id, decision] of batchDecisions) decisions.set(id, decision);
    } catch (err) {
      // decideArrivals does not reject, but a caller-injected one might.
      // Fail open: no decision means the item is kept.
      log.warn(
        { err: String(err) },
        "retro gate: a decision batch failed; those items will be kept",
      );
    }
  }

  for (const candidate of candidates) {
    const { item, externalId, payload, signals, reconstruction } = candidate;

    // Idempotency. The arrivals row is the marker, and there is a unique
    // index on (channel, external_id) behind it.
    const existing = findArrivalByExternalId(channel, externalId);
    if (existing) {
      report.alreadyProcessed++;
      report.items.push({
        workItemId: item.id,
        externalId,
        title: item.title,
        sender: signals?.senderAddress ?? null,
        action: "already_processed",
        disposition: existing.disposition,
        reason: existing.reason ?? "already decided by an earlier run",
        decidedBy: existing.decidedBy,
        ruleId: existing.ruleId,
        confidence: existing.confidence,
        reconstruction: reconstruction.quality,
        signalsPresent: reconstruction.present,
        signalsMissing: reconstruction.missing,
        arrivalId: existing.id,
        reversible: existing.disposition === "filed",
      });
      continue;
    }

    let decision: ArrivalDecision;
    if (!signals) {
      decision = keepDecision(
        "Cue no longer has the original message to judge — kept for you",
      );
    } else if (decisions.has(externalId)) {
      decision = decisions.get(externalId) as ArrivalDecision;
    } else {
      // Thin row: only a signal actually stored on it may file it, and the
      // safety floor still gets the last word.
      // Gmail's own category first — it is Google's judgement, not ours, and
      // it is the stronger of the two. The sender shape is the fallback for
      // mail Gmail never categorised, and it reads the address rather than the
      // message, which is why it is safe on a row whose headers are gone.
      const proposed =
        proposeFromStoredLabels(payload) ??
        proposeFromSenderShape(signals) ??
        keepDecision(
          "Cue could not tell from what it still has about this message — kept for you",
        );
      let floor = null;
      try {
        floor = applySafetyFloor(signals, floorContext);
      } catch (err) {
        // An unreadable floor input must never let something through.
        log.warn(
          { err: String(err), workItemId: item.id },
          "retro gate: safety floor unreadable; keeping this item",
        );
        floor = { ruleId: "known_contact" as const, reason: "kept to be safe" };
      }
      decision = decideOne(proposed, floor);
    }

    const willFile = decision.disposition === "filed";
    let arrivalId: string | null = null;

    if (apply) {
      try {
        const arrival = recordArrival({
          channel,
          externalId,
          title: item.title,
          senderAddress: signals?.senderAddress ?? null,
          senderName: signals?.senderName ?? null,
          snippet: signals?.snippet ?? null,
          sourceContext: item.sourceContext ?? null,
          disposition: decision.disposition,
          reason: decision.reason,
          decidedBy: decision.decidedBy,
          ruleId: decision.ruleId,
          confidence: decision.confidence,
        });
        arrivalId = arrival.id;
        // Both dispositions point back at the work item. For a kept item that
        // is provenance; for a filed one it is what makes the reversal exact
        // — the reverse route restores THIS row rather than minting a copy.
        attachWorkItemToArrival(arrival.id, item.id);
        if (willFile) {
          // Archived, never deleted. The row, its notes and its history all
          // survive, and reversal puts it straight back in the lane.
          updateWorkItem(
            item.id,
            { status: "archived" },
            { actor: RETRO_ACTOR },
          );
        }
      } catch (err) {
        // A write failure must leave the item exactly where it was.
        log.warn(
          { err: String(err), workItemId: item.id },
          "retro gate: could not record this decision; item left in the lane",
        );
        report.kept++;
        report.items.push({
          workItemId: item.id,
          externalId,
          title: item.title,
          sender: signals?.senderAddress ?? null,
          action: "kept",
          disposition: "surfaced",
          reason: "Cue could not record a decision for this one — kept for you",
          decidedBy: "fallback",
          ruleId: null,
          confidence: null,
          reconstruction: reconstruction.quality,
          signalsPresent: reconstruction.present,
          signalsMissing: reconstruction.missing,
          arrivalId: null,
          reversible: false,
        });
        continue;
      }
    }

    if (willFile) report.filed++;
    else report.kept++;
    report.items.push({
      workItemId: item.id,
      externalId,
      title: item.title,
      sender: signals?.senderAddress ?? null,
      action: willFile ? "filed" : "kept",
      disposition: decision.disposition,
      reason: decision.reason,
      decidedBy: decision.decidedBy,
      ruleId: decision.ruleId,
      confidence: decision.confidence,
      reconstruction: reconstruction.quality,
      signalsPresent: reconstruction.present,
      signalsMissing: reconstruction.missing,
      arrivalId,
      reversible: willFile,
    });
  }

  return report;
}

/** Render a report a human can read line by line, filings first. */
export function formatRetrofitReport(report: RetrofitReport): string {
  const lines: string[] = [];
  lines.push(
    report.applied
      ? `Retro relevance gate — APPLIED to ${report.channel}`
      : `Retro relevance gate — DRY RUN over ${report.channel} (nothing was written)`,
  );
  lines.push(
    `${report.scanned} scanned · ${report.filed} filed · ${report.kept} kept · ` +
      `${report.alreadyProcessed} already decided · ${report.unreconstructable} unreconstructable`,
  );

  const filed = report.items.filter((i) => i.action === "filed");
  if (filed.length > 0) {
    lines.push("", `Filed (${filed.length}) — each one reversible:`);
    for (const i of filed) {
      lines.push(`  · ${i.title}`);
      lines.push(
        `      ${i.reason} [${i.decidedBy}${i.ruleId ? `/${i.ruleId}` : ""}, signals: ${i.reconstruction}]`,
      );
    }
  }

  const kept = report.items.filter((i) => i.action === "kept");
  if (kept.length > 0) {
    lines.push("", `Kept (${kept.length}):`);
    for (const i of kept) {
      lines.push(`  · ${i.title}`);
      lines.push(`      ${i.reason}`);
    }
  }
  return lines.join("\n");
}
