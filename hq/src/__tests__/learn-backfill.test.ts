/**
 * Learn backfill — retrofitting sidecars onto pre-Learn instances.
 *
 * Properties held here:
 *   1. Live instances without a learnAppName get a sidecar provisioned, the
 *      instance env patched (LEARN_UPSTREAM_URL + flag, using the RETURNED
 *      app name), and the row updated — making a rerun skip them.
 *   2. Non-live instances and instances that already have a sidecar are
 *      untouched.
 *   3. An env-patch failure tears the fresh sidecar back down and leaves the
 *      row null so a rerun retries cleanly.
 *   4. dryRun reports the pending set without touching anything.
 *   5. Feature env unset → refused outright.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { backfillLearnSidecars } from "../provisioning.js";
import { MockDriver } from "../providers/mock-driver.js";

const ENV_KEYS = ["HQ_LEARN_IMAGE_REF", "HQ_LEARN_GOOGLE_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** MockDriver + the two optional capabilities the backfill needs. */
class BackfillMockDriver extends MockDriver {
  sidecarSpecs: {
    appName: string;
    image: string;
    env: Record<string, string>;
  }[] = [];
  envPatches: { externalId: string; env: Record<string, string> }[] = [];
  destroyedSidecars: string[] = [];
  failEnvPatchFor: string | null = null;
  liveEnvByExternalId: Record<string, Record<string, string>> = {};

  async getEnv(externalId: string): Promise<Record<string, string>> {
    return this.liveEnvByExternalId[externalId] ?? {};
  }

  async provisionLearnSidecar(spec: {
    appName: string;
    image: string;
    env: Record<string, string>;
  }): Promise<{ appName: string }> {
    this.sidecarSpecs.push({
      appName: spec.appName,
      image: spec.image,
      env: spec.env,
    });
    // Collision suffix, so callers must use the RETURNED name.
    return { appName: `${spec.appName}-x1y2` };
  }

  async applyEnvPatch(
    externalId: string,
    env: Record<string, string>,
  ): Promise<void> {
    if (this.failEnvPatchFor === externalId) {
      throw new Error("machine restart never came back healthy (scripted)");
    }
    this.envPatches.push({ externalId, env });
  }

  async destroyLearnSidecar(appName: string): Promise<void> {
    this.destroyedSidecars.push(appName);
  }
}

function setup() {
  process.env.HQ_LEARN_IMAGE_REF = "registry.fly.io/cue-releases:learn-x";
  process.env.HQ_LEARN_GOOGLE_API_KEY = "g-key";
  const db = new HqDb(":memory:");
  const driver = new BackfillMockDriver();
  return { db, driver };
}

function makeInstance(
  db: HqDb,
  name: string,
  opts: { state?: "live" | "suspended"; learnAppName?: string | null } = {},
) {
  const customer = db.createCustomer({
    email: `${name}@example.com`,
    name,
  });
  const instance = db.createInstance({
    customerId: customer.id,
    driver: "mock",
    externalId: `mock-${name}`,
    url: `http://cue-${name}.mock.local`,
    state: opts.state ?? "live",
    learnAppName: opts.learnAppName ?? null,
  });
  return { customer, instance };
}

describe("backfillLearnSidecars", () => {
  test("provisions, patches env with the RETURNED name, records the row", async () => {
    const { db, driver } = setup();
    const { customer, instance } = makeInstance(db, "ada");

    const outcome = await backfillLearnSidecars({ db, driver });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.results).toEqual([
      {
        instanceId: instance.id,
        customerId: customer.id,
        status: "provisioned",
        appName: driver.sidecarSpecs[0].appName + "-x1y2",
      },
    ]);
    const finalName = `${driver.sidecarSpecs[0].appName}-x1y2`;
    expect(driver.envPatches).toHaveLength(1);
    const patch = driver.envPatches[0];
    expect(patch.externalId).toBe(instance.externalId);
    expect(patch.env.LEARN_UPSTREAM_URL).toBe(
      `http://${finalName}.internal:3000`,
    );
    expect(patch.env.VELLUM_FLAG_LEARN_APP).toBe("true");
    // The instance-side secret must be the very one the sidecar enforces.
    expect(patch.env.LEARN_UPSTREAM_SECRET).toMatch(/^[0-9a-f]{48}$/);
    expect(driver.sidecarSpecs[0].env.OPENMAIC_ACCESS_SECRET).toBe(
      patch.env.LEARN_UPSTREAM_SECRET,
    );
    expect(driver.sidecarSpecs[0].env.OPENMAIC_FIXED_OWNER_ID).toBe(
      "cue-owner",
    );
    expect(db.getInstance(instance.id)!.learnAppName).toBe(finalName);
    expect(
      db.findLatestEvent("learn_sidecar_provisioned", customer.id),
    ).toBeTruthy();

    // Idempotent: a rerun finds nothing pending.
    const again = await backfillLearnSidecars({ db, driver });
    if (!again.ok) throw new Error(again.error);
    expect(again.results).toHaveLength(0);
    expect(driver.sidecarSpecs).toHaveLength(1);
  });

  test("adopts a hand-wired sidecar instead of provisioning a duplicate", async () => {
    const { db, driver } = setup();
    const { customer, instance } = makeInstance(db, "manav");
    driver.liveEnvByExternalId[instance.externalId] = {
      LEARN_UPSTREAM_URL: "http://cue-learn-manav.internal:3000",
      VELLUM_FLAG_LEARN_APP: "true",
    };

    const outcome = await backfillLearnSidecars({ db, driver });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.results).toEqual([
      {
        instanceId: instance.id,
        customerId: customer.id,
        status: "adopted",
        appName: "cue-learn-manav",
      },
    ]);
    expect(driver.sidecarSpecs).toHaveLength(0);
    expect(driver.envPatches).toHaveLength(0);
    expect(db.getInstance(instance.id)!.learnAppName).toBe("cue-learn-manav");
    expect(
      db.findLatestEvent("learn_sidecar_adopted", customer.id),
    ).toBeTruthy();
  });

  test("an unparseable existing upstream fails loudly, never overwrites", async () => {
    const { db, driver } = setup();
    const { instance } = makeInstance(db, "odd");
    driver.liveEnvByExternalId[instance.externalId] = {
      LEARN_UPSTREAM_URL: "https://some-external-host.example.com/learn",
    };

    const outcome = await backfillLearnSidecars({ db, driver });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.results[0].status).toBe("failed");
    expect(driver.sidecarSpecs).toHaveLength(0);
    expect(driver.envPatches).toHaveLength(0);
    expect(db.getInstance(instance.id)!.learnAppName).toBeNull();
  });

  test("skips non-live instances and ones that already have a sidecar", async () => {
    const { db, driver } = setup();
    makeInstance(db, "bo", { state: "suspended" });
    makeInstance(db, "cy", { learnAppName: "cue-learn-cy-existing" });

    const outcome = await backfillLearnSidecars({ db, driver });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.results).toHaveLength(0);
    expect(driver.sidecarSpecs).toHaveLength(0);
  });

  test("env-patch failure tears the sidecar down and leaves the row null", async () => {
    const { db, driver } = setup();
    const { customer, instance } = makeInstance(db, "di");
    driver.failEnvPatchFor = instance.externalId;

    const outcome = await backfillLearnSidecars({ db, driver });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.results[0].status).toBe("failed");
    expect(driver.destroyedSidecars).toHaveLength(1);
    expect(db.getInstance(instance.id)!.learnAppName).toBeNull();
    expect(
      db.findLatestEvent("learn_backfill_env_patch_failed", customer.id),
    ).toBeTruthy();
  });

  test("dryRun reports the pending set without touching anything", async () => {
    const { db, driver } = setup();
    const { instance } = makeInstance(db, "ed");

    const outcome = await backfillLearnSidecars(
      { db, driver },
      { dryRun: true },
    );
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.results[0]).toMatchObject({
      instanceId: instance.id,
      status: "dry-run",
    });
    expect(driver.sidecarSpecs).toHaveLength(0);
    expect(db.getInstance(instance.id)!.learnAppName).toBeNull();
  });

  test("refused when Learn is not enabled on HQ", async () => {
    const db = new HqDb(":memory:");
    const driver = new BackfillMockDriver();
    const outcome = await backfillLearnSidecars({ db, driver });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.status).toBe(409);
  });

  test("refused when the driver cannot provision sidecars", async () => {
    const { db } = setup();
    const driver = new MockDriver();
    const outcome = await backfillLearnSidecars({ db, driver });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.status).toBe(501);
  });
});
