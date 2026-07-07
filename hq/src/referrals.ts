/**
 * Cue HQ — referral program (WS6 growth loops).
 *
 * Flow:
 *   1. Every customer gets a shareable `REF-XXXXXXXX` code, minted lazily
 *      (ensureReferralCode) — surfaced on /account/summary.
 *   2. The referee's checkout carries the code as Stripe metadata (both the
 *      session AND subscription_data, so invoice events see it regardless
 *      of webhook delivery order). Validation happens at checkout creation:
 *      unknown or self-referral codes are dropped, never block checkout.
 *   3. checkout.session.completed records a PENDING redemption row.
 *   4. The referee's FIRST paid invoice (invoice.paid) resolves the row
 *      exactly once: the referrer earns REFERRAL_AWARD_CREDITS through the
 *      existing top-up ledger path (applyTopup — note-keyed, so a webhook
 *      replay can never double-grant), capped at REFERRAL_EARN_CAP_CREDITS
 *      total per referrer.
 *
 * Idempotency is layered: the redemption row only resolves from 'pending'
 * (atomic transaction), and the ledger entry itself dedupes on
 * `topup referral <redemptionId>` — either layer alone survives a replay.
 */

import { applyTopup } from "./credits.js";
import type { HqDb, ReferralRedemption } from "./db.js";

// ── config constants (env-overridable) ───────────────────────────────────

/** Credits the referrer earns per converted referee. */
export const DEFAULT_REFERRAL_AWARD_CREDITS = 1000;
/** Lifetime cap on referral credits earnable per customer. */
export const DEFAULT_REFERRAL_EARN_CAP_CREDITS = 10_000;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

export function referralAwardCredits(): number {
  return positiveIntEnv(
    "HQ_REFERRAL_AWARD_CREDITS",
    DEFAULT_REFERRAL_AWARD_CREDITS,
  );
}

export function referralEarnCapCredits(): number {
  return positiveIntEnv(
    "HQ_REFERRAL_EARN_CAP_CREDITS",
    DEFAULT_REFERRAL_EARN_CAP_CREDITS,
  );
}

// ── validation ───────────────────────────────────────────────────────────

export type ReferralValidation =
  | { ok: true; code: string; referrerCustomerId: string }
  | { ok: false; reason: "referral_unknown" | "referral_self" };

/**
 * Validate a referral code for a (prospective) referee. Self-referral is
 * rejected; the check is case-insensitive (codes store uppercase).
 */
export function validateReferralCode(
  db: HqDb,
  code: string,
  refereeCustomerId?: string,
): ReferralValidation {
  const referral = db.getReferralCode(code);
  if (!referral) return { ok: false, reason: "referral_unknown" };
  if (refereeCustomerId && referral.customerId === refereeCustomerId) {
    return { ok: false, reason: "referral_self" };
  }
  return {
    ok: true,
    code: referral.code,
    referrerCustomerId: referral.customerId,
  };
}

// ── redemption recording (checkout completed) ────────────────────────────

/**
 * Record a pending redemption for a referee. Re-validates (the metadata
 * round-trips through Stripe, so trust nothing) and no-ops on invalid,
 * self-referral, or already-referred referees. Returns the redemption row
 * that now binds the referee, or null when none does.
 */
export function recordReferralRedemption(
  db: HqDb,
  params: { code: string; refereeCustomerId: string },
): ReferralRedemption | null {
  const existing = db.getReferralRedemptionByReferee(params.refereeCustomerId);
  if (existing) return existing; // first touch wins
  const validation = validateReferralCode(
    db,
    params.code,
    params.refereeCustomerId,
  );
  if (!validation.ok) {
    db.recordEvent("referral_code_rejected", params.refereeCustomerId, {
      code: params.code,
      reason: validation.reason,
    });
    return null;
  }
  return db.createReferralRedemption({
    code: validation.code,
    refereeCustomerId: params.refereeCustomerId,
  });
}

// ── award (referee's first paid invoice) ─────────────────────────────────

export type ReferralAwardResult =
  | {
      awarded: true;
      credits: number;
      referrerCustomerId: string;
      redemptionId: string;
    }
  | {
      awarded: false;
      reason:
        | "no_redemption"
        | "already_resolved"
        | "referrer_missing"
        | "capped";
    };

/**
 * Resolve the referee's redemption on their first paid invoice.
 *
 * Idempotent by construction: only a 'pending' row resolves (atomic), and
 * the credit grant dedupes on `topup referral <redemptionId>` — firing the
 * same invoice.paid twice awards exactly once. `referralCode` (from the
 * invoice's subscription metadata) is a fallback creator for the pending
 * row, covering invoice.paid arriving before checkout.session.completed.
 */
export function awardReferralOnPaidInvoice(
  db: HqDb,
  params: {
    refereeCustomerId: string;
    invoiceId: string | null;
    /** Referral code from invoice subscription metadata (ordering fallback). */
    referralCode?: string;
  },
): ReferralAwardResult {
  let redemption = db.getReferralRedemptionByReferee(params.refereeCustomerId);
  if (!redemption && params.referralCode) {
    redemption = recordReferralRedemption(db, {
      code: params.referralCode,
      refereeCustomerId: params.refereeCustomerId,
    });
  }
  if (!redemption) return { awarded: false, reason: "no_redemption" };
  if (redemption.status !== "pending") {
    return { awarded: false, reason: "already_resolved" };
  }

  const referral = db.getReferralCode(redemption.code);
  const referrer = referral ? db.getCustomer(referral.customerId) : null;
  if (!referral || !referrer) {
    return { awarded: false, reason: "referrer_missing" };
  }

  // Cap: lifetime earnings per referrer across all their redemptions.
  const earned = db.sumReferralCreditsAwarded(referral.code);
  const credits = Math.min(
    referralAwardCredits(),
    Math.max(0, referralEarnCapCredits() - earned),
  );
  if (credits <= 0) {
    db.resolveReferralRedemption(redemption.id, {
      status: "capped",
      creditsAwarded: 0,
      invoiceId: params.invoiceId,
    });
    db.recordEvent("referral_award_capped", referrer.id, {
      code: referral.code,
      refereeCustomerId: params.refereeCustomerId,
      earned,
    });
    return { awarded: false, reason: "capped" };
  }

  // Resolve first (atomic pending→awarded gate), then grant through the
  // note-keyed top-up path — the second idempotency belt.
  const resolved = db.resolveReferralRedemption(redemption.id, {
    status: "awarded",
    creditsAwarded: credits,
    invoiceId: params.invoiceId,
  });
  if (!resolved) return { awarded: false, reason: "already_resolved" };
  const topup = applyTopup(db, {
    customerId: referrer.id,
    credits,
    ref: `referral ${redemption.id}`,
  });
  db.recordEvent("referral_awarded", referrer.id, {
    code: referral.code,
    refereeCustomerId: params.refereeCustomerId,
    credits,
    invoiceId: params.invoiceId,
    applied: topup.applied,
  });
  return {
    awarded: true,
    credits,
    referrerCustomerId: referrer.id,
    redemptionId: redemption.id,
  };
}

// ── account-summary shape ────────────────────────────────────────────────

/** Referral block for /account/summary (mints the code on first view). */
export function referralSummary(
  db: HqDb,
  customerId: string,
  siteBase: string,
): {
  code: string;
  shareUrl: string;
  awardPerReferral: number;
  capCredits: number;
  earnedCredits: number;
  convertedCount: number;
} {
  const referral = db.ensureReferralCode(customerId);
  const redemptions = db.listReferralRedemptionsByCode(referral.code);
  return {
    code: referral.code,
    shareUrl: `${siteBase}/redeem?ref=${encodeURIComponent(referral.code)}`,
    awardPerReferral: referralAwardCredits(),
    capCredits: referralEarnCapCredits(),
    earnedCredits: db.sumReferralCreditsAwarded(referral.code),
    convertedCount: redemptions.filter((r) => r.status === "awarded").length,
  };
}
