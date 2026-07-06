/**
 * Cue HQ — nightly fleet health sweep (skeleton).
 *
 * Iterates every live instance, probes its health endpoint through the
 * driver, and records an audit event on failure. Wire a real smoke suite
 * (assistant/qa/prod-smoke.ts driven with a per-instance actor token)
 * later; this establishes the loop + the event trail.
 *
 * Run once:      bun run src/fleet.ts
 * Run nightly:   cron `0 3 * * *` → bun run src/fleet.ts
 */

import type { HqDb } from "./db.js";
import type { InstanceDriver } from "./providers/driver.js";

export interface SweepResult {
  checked: number;
  healthy: number;
  failed: { instanceId: string; url: string }[];
}

export async function sweepFleet(
  db: HqDb,
  driver: InstanceDriver,
): Promise<SweepResult> {
  const live = db.listInstancesByState("live");
  const result: SweepResult = { checked: 0, healthy: 0, failed: [] };

  for (const instance of live) {
    if (instance.driver !== driver.id) continue; // sweep per-driver
    result.checked += 1;
    const ok = await driver.health(instance.url);
    if (ok) {
      result.healthy += 1;
      continue;
    }
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

  db.recordEvent("fleet_sweep_completed", null, {
    checked: result.checked,
    healthy: result.healthy,
    failed: result.failed.length,
  });
  return result;
}

if (import.meta.main) {
  const [{ HqDb }, { MockDriver }, { RenderDriver }] = await Promise.all([
    import("./db.js"),
    import("./providers/mock-driver.js"),
    import("./providers/render-driver.js"),
  ]);
  const db = new HqDb();
  const render = new RenderDriver();
  const driver =
    process.env.HQ_DRIVER === "render" && render.configured
      ? render
      : new MockDriver();
  const result = await sweepFleet(db, driver);
  console.log(
    `Fleet sweep: ${result.healthy}/${result.checked} healthy` +
      (result.failed.length
        ? `; FAILED: ${result.failed.map((f) => f.url).join(", ")}`
        : ""),
  );
  db.close();
  process.exit(result.failed.length > 0 ? 1 : 0);
}
