/**
 * Cue HQ — credit accounting: monthly grants, top-ups, and metered usage
 * sync against live instances.
 *
 * All mutations are append-only credit_ledger entries (db.ts). Idempotency
 * is note-keyed:
 *   grants  — `grant <stripeSubId>@<periodStart>` (one per billing period,
 *             however many times Stripe retries invoice.paid), plus the
 *             one-off `grant provisioning:<customerId>` that funds an
 *             instance nobody is billing (grantProvisioningCredits)
 *   top-ups — `topup <ref>` (ref = checkout session id / manual uuid)
 *   usage   — a per-instance cumulative cursor (instances.usageSyncedCents):
 *             each sync only converts the delta above the cursor, so
 *             re-running a sync is a no-op.
 *
 * Usage source of truth: the instance's own Guardrails usage rollup —
 * GET <instanceUrl>/v1/assistants/self/guardrails?days=N (the daemon's
 * `guardrails` route proxied by the gateway under /v1/assistants/self/,
 * authed with an HQ-minted actor token). Its ledger.summary.totalCents is
 * the workspace-wide estimated LLM cost (COGS) over the window; credits
 * are charged at 4x that (plans.ts cogsCentsToCredits).
 */

import type { CreditEntry, HqDb, Instance } from "./db.js";
import {
  getKey,
  isOpenRouterConfigured,
  updateKeyLimit,
} from "./openrouter.js";
import { cogsCentsToCredits, creditsToCogsUsd, resolvePlan } from "./plans.js";
import { mintActorToken, type InstanceSecrets } from "./secrets.js";

// ── grants + top-ups ─────────────────────────────────────────────────────

export interface GrantResult {
  granted: boolean;
  entry: CreditEntry | null;
  balance: number;
}

/**
 * Grant a plan's monthly credits for one billing period. Idempotent on
 * (stripeSubId, periodStart) — Stripe webhook retries and replays no-op.
 */
export function grantMonthlyCredits(
  db: HqDb,
  params: {
    customerId: string;
    /** Stored plan value (legacy aliases resolve via plans.ts). */
    plan: string;
    stripeSubId: string;
    /** Billing period start (Stripe's epoch seconds). */
    periodStart: number;
  },
): GrantResult {
  const spec = resolvePlan(params.plan);
  const note = `grant ${params.stripeSubId}@${params.periodStart}`;
  const existing = db.findCreditEntryByNote("grant", note);
  if (existing) {
    return {
      granted: false,
      entry: existing,
      balance: db.getCreditBalance(params.customerId),
    };
  }
  const entry = db.appendCreditEntry({
    customerId: params.customerId,
    delta: spec.monthlyCredits,
    kind: "grant",
    note,
  });
  return { granted: true, entry, balance: entry.balanceAfter };
}

export type ProvisioningGrantResult = GrantResult & {
  /** Why nothing was granted, when granted:false. */
  reason?: "already_granted" | "billed_by_stripe";
};

/**
 * Fund a brand-new instance with its plan's monthly credits — the opening
 * balance for a customer nobody is billing.
 *
 * Until this existed, `grantMonthlyCredits` was only ever reached from the
 * `invoice.paid` webhook, so an invited colleague was provisioned with an
 * empty ledger: their first usage sync wrote the account's only entry, it
 * was a debit, and the negative balance froze their LLM key on day one.
 *
 * Two gates, both permanent:
 *   - a customer with a Stripe subscription is granted by their invoices,
 *     and adding a provisioning grant on top would be a double month;
 *   - a customer who has EVER been granted is left alone, so re-provisioning
 *     (a destroyed instance, a second machine) can never top anyone up.
 */
export function grantProvisioningCredits(
  db: HqDb,
  params: { customerId: string; plan: string },
): ProvisioningGrantResult {
  const balance = () => db.getCreditBalance(params.customerId);
  if (db.getSubscription(params.customerId)) {
    return {
      granted: false,
      entry: null,
      balance: balance(),
      reason: "billed_by_stripe",
    };
  }
  if (db.hasCreditGrant(params.customerId)) {
    return {
      granted: false,
      entry: null,
      balance: balance(),
      reason: "already_granted",
    };
  }
  const spec = resolvePlan(params.plan);
  const entry = db.appendCreditEntry({
    customerId: params.customerId,
    delta: spec.monthlyCredits,
    kind: "grant",
    note: `grant provisioning:${params.customerId}`,
  });
  return { granted: true, entry, balance: entry.balanceAfter };
}

export interface TopupResult {
  applied: boolean;
  entry: CreditEntry | null;
  balance: number;
}

/** Apply a credit top-up. Idempotent on `ref` (checkout session id etc.). */
export function applyTopup(
  db: HqDb,
  params: { customerId: string; credits: number; ref: string },
): TopupResult {
  if (!Number.isInteger(params.credits) || params.credits <= 0) {
    throw new Error(
      `Top-up credits must be a positive integer: ${params.credits}`,
    );
  }
  const note = `topup ${params.ref}`;
  const existing = db.findCreditEntryByNote("topup", note);
  if (existing) {
    return {
      applied: false,
      entry: existing,
      balance: db.getCreditBalance(params.customerId),
    };
  }
  const entry = db.appendCreditEntry({
    customerId: params.customerId,
    delta: params.credits,
    kind: "topup",
    note,
  });
  return { applied: true, entry, balance: entry.balanceAfter };
}

/** Manual admin adjustment (signed delta, not idempotent by design). */
export function adjustCredits(
  db: HqDb,
  params: { customerId: string; delta: number; note: string },
): CreditEntry {
  return db.appendCreditEntry({
    customerId: params.customerId,
    delta: params.delta,
    kind: "adjustment",
    note: params.note,
  });
}

export function getBalance(db: HqDb, customerId: string): number {
  return db.getCreditBalance(customerId);
}

// ── usage sync (instance → ledger) ───────────────────────────────────────

export type UsageSyncResult =
  | {
      ok: true;
      /** Credits debited by this sync (0 when nothing new was reported). */
      creditsUsed: number;
      /** Cumulative reported COGS cents after this sync (the new cursor). */
      reportedCents: number;
      balance: number;
    }
  | { ok: false; reason: string };

function parseInstanceSecrets(instance: Instance): InstanceSecrets | null {
  try {
    const parsed = JSON.parse(instance.secretsJson) as InstanceSecrets;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Pull the instance's cumulative Guardrails usage rollup and convert the
 * unsynced remainder into a usage_sync ledger entry. Window = the whole
 * instance lifetime, so totalCents is a monotonic cumulative counter and
 * the per-instance cursor makes the sync idempotent.
 */
export async function syncUsage(
  db: HqDb,
  instance: Instance,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<UsageSyncResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();

  const secrets = parseInstanceSecrets(instance);
  if (!secrets?.actorTokenSigningKey || !secrets.guardianPrincipalId) {
    return { ok: false, reason: "instance_missing_secrets" };
  }
  const token = mintActorToken({
    signingKeyHex: secrets.actorTokenSigningKey,
    guardianPrincipalId: secrets.guardianPrincipalId,
    ttlSeconds: 10 * 60, // short-lived: one sync pass
  });

  // Whole-lifetime window so the rollup total is cumulative vs the cursor.
  const days = Math.max(1, Math.ceil((now - instance.createdAt) / 86_400_000));
  let res: Response;
  try {
    res = await fetchImpl(
      `${instance.url.replace(/\/$/, "")}/v1/assistants/self/guardrails?days=${days}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (err) {
    return {
      ok: false,
      reason: `usage_fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    return { ok: false, reason: `usage_http_${res.status}` };
  }
  const body = (await res.json().catch(() => null)) as {
    ledger?: { summary?: { totalCents?: number } };
  } | null;
  const totalCents = body?.ledger?.summary?.totalCents;
  if (typeof totalCents !== "number" || !Number.isFinite(totalCents)) {
    return { ok: false, reason: "usage_unexpected_body" };
  }

  const cursor = instance.usageSyncedCents;
  const deltaCents = Math.round(totalCents) - cursor;
  if (deltaCents <= 0) {
    // Nothing new (or the instance pruned history — never re-charge).
    return {
      ok: true,
      creditsUsed: 0,
      reportedCents: cursor,
      balance: db.getCreditBalance(instance.customerId),
    };
  }

  const credits = cogsCentsToCredits(deltaCents);
  const entry = db.appendCreditEntry({
    customerId: instance.customerId,
    delta: -credits,
    kind: "usage_sync",
    note: `usage_sync ${instance.id} ${cursor}c→${cursor + deltaCents}c`,
  });
  db.setInstanceUsageSyncedCents(instance.id, cursor + deltaCents);
  return {
    ok: true,
    creditsUsed: credits,
    reportedCents: cursor + deltaCents,
    balance: entry.balanceAfter,
  };
}

// ── child-key limit maintenance ──────────────────────────────────────────

/**
 * Re-point every provisioned child key of a customer at the current credit
 * balance: new limit = spend-so-far + COGS headroom for the remaining
 * balance. Called after grants and top-ups; with balance ≤ 0 this freezes
 * the key at what's already spent (never cuts a turn mid-flight). No-op
 * (updated: 0) when the provisioning key isn't configured — the shared-key
 * fallback has no per-customer limit to move.
 */
export async function syncKeyLimitsToBalance(
  db: HqDb,
  customerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ updated: number }> {
  if (!isOpenRouterConfigured()) return { updated: 0 };
  const balance = Math.max(0, db.getCreditBalance(customerId));
  const headroomUsd = creditsToCogsUsd(balance);

  let updated = 0;
  for (const instance of db.listInstancesByCustomer(customerId)) {
    if (instance.state === "deleted" || !instance.openrouterKeyHash) continue;
    const current = await getKey(instance.openrouterKeyHash, fetchImpl);
    if (!current.ok) {
      db.recordEvent("openrouter_key_error", customerId, {
        instanceId: instance.id,
        op: "get",
        reason: current.reason,
      });
      continue;
    }
    const limitUsd = Math.round((current.info.usage + headroomUsd) * 100) / 100;
    const result = await updateKeyLimit(
      instance.openrouterKeyHash,
      limitUsd,
      fetchImpl,
    );
    if (!result.ok) {
      db.recordEvent("openrouter_key_error", customerId, {
        instanceId: instance.id,
        op: "update_limit",
        reason: result.reason,
      });
      continue;
    }
    updated += 1;
    db.recordEvent("openrouter_key_limit_set", customerId, {
      instanceId: instance.id,
      limitUsd,
      spentUsd: current.info.usage,
      balanceCredits: balance,
    });
  }
  return { updated };
}
