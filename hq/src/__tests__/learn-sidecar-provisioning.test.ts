/**
 * Learn sidecar provisioning (per-customer Cue Learn app).
 *
 * Properties held here:
 *   1. With the feature env set and a sidecar-capable driver, provisioning
 *      creates the sidecar FIRST and threads its final app name into the
 *      instance env (LEARN_UPSTREAM_URL + the learn-app flag) and onto the
 *      instance row.
 *   2. A sidecar failure is best-effort: the instance still provisions,
 *      without Learn env, with a loud audit event.
 *   3. With the env unset, nothing sidecar-related happens at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { learnSidecarConfig } from "../learn-sidecar.js";
import { provisionCustomer } from "../provisioning.js";
import { MockDriver } from "../providers/mock-driver.js";
import type { InstanceSpec } from "../providers/driver.js";

const ENV_KEYS = [
  "HQ_LEARN_IMAGE_REF",
  "HQ_LEARN_GOOGLE_API_KEY",
  "HQ_LEARN_ELEVENLABS_API_KEY",
  "HQ_LEARN_TAVILY_API_KEY",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
  "HQ_INSTANCE_DOMAIN",
];
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

/** MockDriver + sidecar capability, capturing specs and optionally failing. */
class SidecarMockDriver extends MockDriver {
  sidecarSpecs: {
    appName: string;
    image: string;
    env: Record<string, string>;
  }[] = [];
  failSidecar = false;
  lastInstanceSpec: InstanceSpec | null = null;

  override async provision(spec: InstanceSpec) {
    this.lastInstanceSpec = spec;
    return super.provision(spec);
  }

  async provisionLearnSidecar(spec: {
    appName: string;
    image: string;
    env: Record<string, string>;
  }): Promise<{ appName: string }> {
    if (this.failSidecar) throw new Error("no capacity for sidecar");
    this.sidecarSpecs.push(spec);
    // Simulate the fly driver's collision suffix so callers must use the
    // RETURNED name, not the requested one.
    return { appName: `${spec.appName}-x1y2` };
  }

  async destroyLearnSidecar(): Promise<void> {}
}

function setup() {
  const db = new HqDb(":memory:");
  const driver = new SidecarMockDriver();
  const fetchImpl = (async () =>
    new Response("{}", { status: 200 })) as unknown as typeof fetch;
  return {
    db,
    driver,
    deps: { db, driver, fetchImpl, healthTimeoutMs: 100, healthIntervalMs: 10 },
  };
}

describe("learnSidecarConfig", () => {
  test("null unless image AND google key are both set", () => {
    expect(learnSidecarConfig()).toBeNull();
    process.env.HQ_LEARN_IMAGE_REF = "registry.fly.io/cue-releases:learn-x";
    expect(learnSidecarConfig()).toBeNull();
    process.env.HQ_LEARN_GOOGLE_API_KEY = "g-key";
    const cfg = learnSidecarConfig()!;
    expect(cfg.image).toBe("registry.fly.io/cue-releases:learn-x");
    // One Google key powers LLM + image + video.
    expect(cfg.env.GOOGLE_API_KEY).toBe("g-key");
    expect(cfg.env.IMAGE_NANO_BANANA_API_KEY).toBe("g-key");
    expect(cfg.env.VIDEO_VEO_API_KEY).toBe("g-key");
    expect(cfg.env.HOSTNAME).toBe("::");
  });
});

describe("provisioning with a Learn sidecar", () => {
  test("threads the sidecar's FINAL app name into instance env and row", async () => {
    process.env.HQ_LEARN_IMAGE_REF = "registry.fly.io/cue-releases:learn-x";
    process.env.HQ_LEARN_GOOGLE_API_KEY = "g-key";
    const { db, driver, deps } = setup();
    const customer = db.createCustomer({
      email: "ada@example.com",
      name: "Ada",
    });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.existing)
      throw new Error("expected fresh provision");

    expect(driver.sidecarSpecs).toHaveLength(1);
    const finalName = `${driver.sidecarSpecs[0].appName}-x1y2`;
    const env = driver.lastInstanceSpec!.env;
    expect(env.LEARN_UPSTREAM_URL).toBe(`http://${finalName}.internal:3000`);
    expect(env.VELLUM_FLAG_LEARN_APP).toBe("true");
    expect(outcome.instance.learnAppName).toBe(finalName);
    expect(
      db.findLatestEvent("learn_sidecar_provisioned", customer.id),
    ).toBeTruthy();
  });

  test("a sidecar failure never blocks the instance", async () => {
    process.env.HQ_LEARN_IMAGE_REF = "registry.fly.io/cue-releases:learn-x";
    process.env.HQ_LEARN_GOOGLE_API_KEY = "g-key";
    const { db, driver, deps } = setup();
    driver.failSidecar = true;
    const customer = db.createCustomer({ email: "bo@example.com", name: "Bo" });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.existing)
      throw new Error("expected fresh provision");
    expect(outcome.instance.learnAppName).toBeNull();
    const env = driver.lastInstanceSpec!.env;
    expect(env.LEARN_UPSTREAM_URL).toBeUndefined();
    expect(env.VELLUM_FLAG_LEARN_APP).toBeUndefined();
    expect(db.findLatestEvent("learn_sidecar_failed", customer.id)).toBeTruthy();
  });

  test("feature env unset → no sidecar calls, no Learn env", async () => {
    const { db, driver, deps } = setup();
    const customer = db.createCustomer({ email: "cy@example.com", name: "Cy" });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);
    expect(driver.sidecarSpecs).toHaveLength(0);
    expect(driver.lastInstanceSpec!.env.LEARN_UPSTREAM_URL).toBeUndefined();
  });
});
