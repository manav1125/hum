/**
 * Cue HQ — fleet operations: the nightly sweep (health + metered usage)
 * and the image-update roll (how weekly product updates ship).
 *
 * For every live instance (of the active driver):
 *   1. Probe its health endpoint; record an audit event on failure.
 *   2. syncUsage() — pull the instance's Guardrails usage rollup and debit
 *      credits for anything above the per-instance cursor (credits.ts).
 *   3. When the customer's balance is ≤ 0 (and they have credit history —
 *      never-granted customers are left alone), record a
 *      credits_exhausted event and FREEZE the OpenRouter child key: the
 *      limit is re-pointed at current spend (usage + zero headroom via
 *      syncKeyLimitsToBalance), so in-flight turns finish but nothing new
 *      burns money. Requires OPENROUTER_PROVISIONING_KEY; in shared-key
 *      mode the event still fires so a human can act.
 *
 * Run once:      bun run src/fleet.ts
 * Run scheduled: the server boot wires startFleetSweepScheduler() (P0-6 of
 *                the alpha-readiness audit — the sweep existed but nothing
 *                ever ran it), an in-process interval that also emails
 *                HQ_OPS_ALERT_EMAIL when instances fail their health probe
 *                or customers exhaust credits. `bun run src/fleet.ts` stays
 *                available for manual/cron runs.
 *
 * Scheduler env contract:
 *   HQ_FLEET_SWEEP_INTERVAL_MS      — cadence (default 21600000 = 6 h)
 *   HQ_FLEET_SWEEP_INITIAL_DELAY_MS — first run after boot (default 120000)
 *   HQ_FLEET_SWEEP_DISABLED         — "1"/"true" turns the scheduler off
 *   HQ_OPS_ALERT_EMAIL              — operator inbox for failure alerts
 *                                     (requires RESEND_API_KEY to deliver)
 */

import { getBalance, syncKeyLimitsToBalance, syncUsage } from "./credits.js";
import type { HqDb, Instance } from "./db.js";
import { opsAlertEmail, sendEmail } from "./email.js";
import { firstNameOf, trackEvent } from "./klaviyo.js";
import { resolvePlan } from "./plans.js";
import type { InstanceDriver } from "./providers/driver.js";
import { publicSiteBase } from "./provisioning.js";

/** Credits-low threshold: below this fraction of the plan's monthly grant. */
export const CREDITS_LOW_FRACTION = 0.15;

export interface SweepResult {
  checked: number;
  healthy: number;
  failed: { instanceId: string; url: string }[];
  /** Instances whose usage sync appended a debit. */
  usageSynced: number;
  /** Total credits debited across the sweep. */
  creditsUsed: number;
  /** Customers found at ≤ 0 balance (frozen when provisioning is live). */
  exhausted: string[];
}

export async function sweepFleet(
  db: HqDb,
  driver: InstanceDriver,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SweepResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const live = db.listInstancesByState("live");
  const result: SweepResult = {
    checked: 0,
    healthy: 0,
    failed: [],
    usageSynced: 0,
    creditsUsed: 0,
    exhausted: [],
  };
  const checkedCustomers = new Set<string>();

  for (const instance of live) {
    if (instance.driver !== driver.id) continue; // sweep per-driver
    result.checked += 1;
    // Probe the branded URL first; a custom-domain instance whose DNS/cert
    // is mid-issuance (or broken) still counts healthy via its provider
    // fallback URL (flyUrl) — the machine itself is what we're sweeping.
    let ok = await driver.health(instance.url);
    if (!ok && instance.flyUrl && instance.flyUrl !== instance.url) {
      ok = await driver.health(instance.flyUrl);
    }
    if (ok) {
      result.healthy += 1;
    } else {
      result.failed.push({ instanceId: instance.id, url: instance.url });
      db.recordEvent("fleet_health_failed", instance.customerId, {
        instanceId: instance.id,
        url: instance.url,
        flyUrl: instance.flyUrl,
        driver: instance.driver,
      });
      // TODO: escalate — retry with backoff, then notify (the Cue prod
      // instance's work-item queue is the natural sink, mirroring how
      // qa/prod-smoke.ts files "QA smoke" work items on failure).
    }

    // Metered usage — independent of the health probe (a proxy hiccup on
    // /healthz shouldn't skip billing).
    const usage = await syncUsage(db, instance, { fetchImpl });
    if (!usage.ok) {
      db.recordEvent("usage_sync_failed", instance.customerId, {
        instanceId: instance.id,
        reason: usage.reason,
      });
      continue;
    }
    if (usage.creditsUsed > 0) {
      result.usageSynced += 1;
      result.creditsUsed += usage.creditsUsed;
    }

    // Balance checks — once per customer per sweep. Customers with no
    // ledger at all (never granted) are skipped rather than frozen at 0.
    if (checkedCustomers.has(instance.customerId)) continue;
    checkedCustomers.add(instance.customerId);
    if (!db.hasCreditHistory(instance.customerId)) continue;
    const balance = getBalance(db, instance.customerId);
    const customer = db.getCustomer(instance.customerId);

    if (balance > 0) {
      // Low-balance crossing: below 15% of the plan's monthly grant, once
      // per billing cycle (the latest grant entry IS the cycle — its note
      // is `grant <subId>@<periodStart>`, unique per period). The local
      // credits_low event carries the same key so re-sweeps single-fire;
      // Klaviyo's unique_id dedupes any retries beyond that.
      if (!customer) continue;
      const grant = db
        .listCreditEntries(instance.customerId, 1000)
        .find((e) => e.kind === "grant");
      if (!grant) continue; // no cycle to key on (never granted a period)
      const threshold =
        resolvePlan(customer.plan).monthlyCredits * CREDITS_LOW_FRACTION;
      if (balance >= threshold) continue;
      const uniqueId = `credits-low:${customer.id}:${grant.note}`;
      if (db.findLatestEventByKindData("credits_low", JSON.stringify(uniqueId))) {
        continue; // already fired this cycle
      }
      db.recordEvent("credits_low", customer.id, {
        uniqueId,
        balance,
        threshold,
      });
      void trackEvent(
        db,
        {
          metric: "Cue Credits Low",
          email: customer.email,
          firstName: firstNameOf(customer.name),
          profileProps: { plan: customer.plan, credit_balance: balance },
          props: { balance, threshold },
          uniqueId,
          customerId: customer.id,
        },
        fetchImpl,
      );
      continue;
    }

    result.exhausted.push(instance.customerId);
    db.recordEvent("credits_exhausted", instance.customerId, {
      instanceId: instance.id,
      balance,
    });
    if (customer) {
      const grant = db
        .listCreditEntries(instance.customerId, 1000)
        .find((e) => e.kind === "grant");
      void trackEvent(
        db,
        {
          metric: "Cue Credits Exhausted",
          email: customer.email,
          firstName: firstNameOf(customer.name),
          profileProps: { plan: customer.plan, credit_balance: balance },
          props: { balance },
          // Period-keyed so nightly re-sweeps of a still-exhausted
          // customer dedupe on Klaviyo's side.
          uniqueId: `credits-exhausted:${customer.id}:${grant?.note ?? "no-grant"}`,
          customerId: customer.id,
        },
        fetchImpl,
      );
    }
    // Freeze: with balance ≤ 0 the headroom is zero, so the child-key
    // limit lands exactly on current spend. No-op without a provisioning
    // key (shared-key mode has no per-customer limit to move).
    await syncKeyLimitsToBalance(db, instance.customerId, fetchImpl);
  }

  db.recordEvent("fleet_sweep_completed", null, {
    checked: result.checked,
    healthy: result.healthy,
    failed: result.failed.length,
    usageSynced: result.usageSynced,
    creditsUsed: result.creditsUsed,
    exhausted: result.exhausted.length,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Scheduled sweep + operator alerting (P0-6)
// ---------------------------------------------------------------------------

/**
 * One scheduled sweep run: sweepFleet + an ops email when something needs a
 * human (health-probe failures or exhausted customers). Alerting is
 * best-effort — a Resend hiccup records `ops_alert_failed` and never throws.
 */
export async function sweepAndAlert(
  db: HqDb,
  driver: InstanceDriver,
  opts: { fetchImpl?: typeof fetch; alertEmail?: string } = {},
): Promise<SweepResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const result = await sweepFleet(db, driver, { fetchImpl });

  const needsHuman = result.failed.length > 0 || result.exhausted.length > 0;
  const alertEmail = opts.alertEmail ?? process.env.HQ_OPS_ALERT_EMAIL?.trim();
  if (needsHuman && alertEmail) {
    const detailLines = [
      ...result.failed.map((f) => `DOWN ${f.url} (instance ${f.instanceId})`),
      ...result.exhausted.map((c) => `EXHAUSTED customer ${c}`),
    ];
    const sent = await sendEmail(
      alertEmail,
      opsAlertEmail({
        subject: `Fleet sweep: ${result.failed.length} down, ${result.exhausted.length} exhausted`,
        summary:
          `${result.healthy}/${result.checked} instances healthy; ` +
          `${result.creditsUsed} credits metered this sweep.`,
        detailLines,
        statusUrl: `${publicSiteBase()}/admin`,
      }),
      fetchImpl,
    );
    db.recordEvent(
      sent.ok && sent.sent ? "ops_alert_sent" : "ops_alert_failed",
      null,
      sent.ok
        ? { sent: sent.sent, failed: result.failed.length, exhausted: result.exhausted.length }
        : { reason: sent.reason },
    );
  } else if (needsHuman) {
    console.error(
      `[hq/fleet] sweep found problems (${result.failed.length} down, ` +
        `${result.exhausted.length} exhausted) but HQ_OPS_ALERT_EMAIL is unset — nobody was alerted`,
    );
  }
  return result;
}

function isSweepDisabled(): boolean {
  const raw = process.env.HQ_FLEET_SWEEP_DISABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Boot wiring: run sweepAndAlert on an interval (default 6 h, first run
 * shortly after boot). In-process on purpose — HQ is a single always-on
 * machine and the sweep is idempotent, so a missed tick during a deploy
 * just runs on the next one.
 */
export function startFleetSweepScheduler(
  db: HqDb,
  driver: InstanceDriver,
  opts: {
    fetchImpl?: typeof fetch;
    intervalMs?: number;
    initialDelayMs?: number;
  } = {},
): { stop: () => void } {
  if (isSweepDisabled()) {
    console.warn("[hq/fleet] HQ_FLEET_SWEEP_DISABLED — scheduled sweeps are OFF");
    return { stop: () => {} };
  }
  const intervalMs =
    opts.intervalMs ??
    Number(process.env.HQ_FLEET_SWEEP_INTERVAL_MS ?? 6 * 60 * 60_000);
  const initialDelayMs =
    opts.initialDelayMs ??
    Number(process.env.HQ_FLEET_SWEEP_INITIAL_DELAY_MS ?? 2 * 60_000);

  let interval: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    void sweepAndAlert(db, driver, { fetchImpl: opts.fetchImpl }).catch((err) => {
      db.recordEvent("fleet_sweep_crashed", null, {
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[hq/fleet] scheduled sweep crashed: ${err}`);
    });
  };
  const initial = setTimeout(() => {
    tick();
    interval = setInterval(tick, intervalMs);
    if (typeof interval.unref === "function") interval.unref();
  }, initialDelayMs);
  if (typeof initial.unref === "function") initial.unref();
  console.info(
    `[hq/fleet] sweep scheduled: first in ${Math.round(initialDelayMs / 1000)}s, then every ${Math.round(intervalMs / 60000)}min`,
  );
  return {
    stop: () => {
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    },
  };
}

// ---------------------------------------------------------------------------
// Fleet image update (staged rollout)
// ---------------------------------------------------------------------------

export interface FleetUpdateResult {
  image: string;
  batchSize: number;
  /** Instance ids rolled to the new image, in roll order. */
  updated: string[];
  skipped: { instanceId: string; reason: "suspended" | "already_on_image" }[];
  failed: { instanceId: string; error: string }[];
  /** True when a failure stopped the roll before every target was updated. */
  halted: boolean;
}

export type FleetUpdateOutcome =
  | { ok: true; result: FleetUpdateResult }
  | { ok: false; reason: "staging_not_rolled"; message: string };

/**
 * Roll every live instance of the active driver to a new image, oldest
 * first, in sequential batches (batchSize machines update concurrently,
 * then the next batch). Suspended/deleted instances never roll, and
 * instances already on the target image are skipped — so re-running a
 * halted roll resumes where it stopped. The first failed batch halts the
 * whole roll (`fleet_update_halted` event); nothing after it is touched.
 *
 * Staged rollout: when HQ_STAGING_INSTANCE_ID (or opts.stagingInstanceId)
 * names a staging instance, the roll refuses to start until that instance
 * already runs the target image — ship staging first, fleet follows.
 */
export async function updateFleet(
  db: HqDb,
  driver: InstanceDriver,
  opts: { image: string; batchSize?: number; stagingInstanceId?: string },
): Promise<FleetUpdateOutcome> {
  const { image } = opts;
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 3));
  const stagingId =
    opts.stagingInstanceId ?? process.env.HQ_STAGING_INSTANCE_ID ?? "";
  if (stagingId) {
    const staging = db.getInstance(stagingId);
    if (!staging || staging.imageRef !== image) {
      return {
        ok: false,
        reason: "staging_not_rolled",
        message: `roll staging first: POST /admin/instances/${stagingId}/update`,
      };
    }
  }

  const result: FleetUpdateResult = {
    image,
    batchSize,
    updated: [],
    skipped: [],
    failed: [],
    halted: false,
  };

  const targets = db
    .listInstances()
    .filter((i) => i.driver === driver.id && i.state !== "deleted")
    .sort((a, b) => a.createdAt - b.createdAt)
    .filter((i) => {
      const reason =
        i.state === "suspended"
          ? ("suspended" as const)
          : i.imageRef === image
            ? ("already_on_image" as const)
            : null;
      if (reason) result.skipped.push({ instanceId: i.id, reason });
      return reason === null;
    });

  for (let at = 0; at < targets.length; at += batchSize) {
    const batch = targets.slice(at, at + batchSize);
    const outcomes = await Promise.allSettled(
      batch.map((i) => driver.update(i.externalId, image)),
    );
    outcomes.forEach((outcome, idx) => {
      const instance: Instance = batch[idx];
      if (outcome.status === "fulfilled") {
        db.setInstanceImageRef(instance.id, image);
        db.recordEvent("instance_updated", instance.customerId, {
          instanceId: instance.id,
          image,
          previousImage: instance.imageRef,
        });
        result.updated.push(instance.id);
      } else {
        const error =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        db.recordEvent("instance_update_failed", instance.customerId, {
          instanceId: instance.id,
          image,
          previousImage: instance.imageRef,
          error,
        });
        result.failed.push({ instanceId: instance.id, error });
      }
    });
    if (result.failed.length > 0) {
      result.halted = true;
      db.recordEvent("fleet_update_halted", null, {
        image,
        updated: result.updated.length,
        remaining: targets.length - at - batch.length,
        failed: result.failed,
      });
      break;
    }
  }

  if (!result.halted) {
    db.recordEvent("fleet_update_completed", null, {
      image,
      updated: result.updated.length,
      skipped: result.skipped.length,
    });
  }
  return { ok: true, result };
}

if (import.meta.main) {
  const [{ HqDb }, { MockDriver }, { RenderDriver }, { FlyDriver }] =
    await Promise.all([
      import("./db.js"),
      import("./providers/mock-driver.js"),
      import("./providers/render-driver.js"),
      import("./providers/fly-driver.js"),
    ]);
  const db = new HqDb();
  const render = new RenderDriver();
  const fly = new FlyDriver();
  const driver =
    process.env.HQ_DRIVER === "fly" && fly.configured
      ? fly
      : process.env.HQ_DRIVER === "render" && render.configured
        ? render
        : new MockDriver();
  const result = await sweepAndAlert(db, driver);
  console.log(
    `Fleet sweep: ${result.healthy}/${result.checked} healthy, ` +
      `${result.creditsUsed} credits metered` +
      (result.exhausted.length
        ? `; EXHAUSTED: ${result.exhausted.join(", ")}`
        : "") +
      (result.failed.length
        ? `; FAILED: ${result.failed.map((f) => f.url).join(", ")}`
        : ""),
  );
  db.close();
  process.exit(result.failed.length > 0 ? 1 : 0);
}
