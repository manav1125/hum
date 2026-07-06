/**
 * Cue HQ — nightly fleet sweep: health + metered usage.
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
 * Run nightly:   cron `0 3 * * *` → bun run src/fleet.ts
 */

import { getBalance, syncKeyLimitsToBalance, syncUsage } from "./credits.js";
import type { HqDb } from "./db.js";
import type { InstanceDriver } from "./providers/driver.js";

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
  const exhaustedCustomers = new Set<string>();

  for (const instance of live) {
    if (instance.driver !== driver.id) continue; // sweep per-driver
    result.checked += 1;
    const ok = await driver.health(instance.url);
    if (ok) {
      result.healthy += 1;
    } else {
      result.failed.push({ instanceId: instance.id, url: instance.url });
      db.recordEvent("fleet_health_failed", instance.customerId, {
        instanceId: instance.id,
        url: instance.url,
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

    // Exhaustion check — once per customer per sweep. Customers with no
    // ledger at all (never granted) are skipped rather than frozen at 0.
    if (exhaustedCustomers.has(instance.customerId)) continue;
    if (!db.hasCreditHistory(instance.customerId)) continue;
    if (getBalance(db, instance.customerId) > 0) continue;
    exhaustedCustomers.add(instance.customerId);
    result.exhausted.push(instance.customerId);
    db.recordEvent("credits_exhausted", instance.customerId, {
      instanceId: instance.id,
      balance: getBalance(db, instance.customerId),
    });
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
  const result = await sweepFleet(db, driver);
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
