/**
 * Cue HQ — in-memory mock driver for tests and local development.
 *
 * Records every call so tests can assert the provisioning flow, and lets
 * tests script per-URL health responses.
 */

import type {
  InstanceDriver,
  InstanceSpec,
  ProvisionResult,
} from "./driver.js";

interface MockInstance {
  externalId: string;
  url: string;
  spec: InstanceSpec;
  state: "live" | "suspended" | "destroyed";
}

export class MockDriver implements InstanceDriver {
  readonly id = "mock";

  readonly instances = new Map<string, MockInstance>();
  readonly calls: { method: string; arg: string }[] = [];

  /** Health override per url; unknown urls are healthy iff provisioned+live. */
  healthByUrl = new Map<string, boolean>();

  private counter = 0;

  async provision(spec: InstanceSpec): Promise<ProvisionResult> {
    this.counter += 1;
    const externalId = `mock-${this.counter}`;
    const providerUrl = `http://${spec.name}.mock.local`;
    // Mirror the fly driver's custom-domain split: with HQ_INSTANCE_DOMAIN
    // set, the primary url is a fake branded hostname and the provider url
    // rides along as flyUrl — so provisioning tests cover both columns.
    const instanceDomain = (process.env.HQ_INSTANCE_DOMAIN ?? "").trim();
    const url = instanceDomain
      ? `https://${spec.name}.${instanceDomain}`
      : providerUrl;
    this.instances.set(externalId, { externalId, url, spec, state: "live" });
    this.calls.push({ method: "provision", arg: spec.name });
    return instanceDomain
      ? { externalId, url, flyUrl: providerUrl }
      : { externalId, url };
  }

  async suspend(externalId: string): Promise<void> {
    this.calls.push({ method: "suspend", arg: externalId });
    const inst = this.requireInstance(externalId);
    inst.state = "suspended";
  }

  async resume(externalId: string): Promise<void> {
    this.calls.push({ method: "resume", arg: externalId });
    const inst = this.requireInstance(externalId);
    inst.state = "live";
  }

  async update(externalId: string, image: string): Promise<void> {
    this.calls.push({ method: "update", arg: `${externalId} ${image}` });
    const inst = this.requireInstance(externalId);
    inst.spec = { ...inst.spec, image };
  }

  async destroy(externalId: string): Promise<void> {
    this.calls.push({ method: "destroy", arg: externalId });
    const inst = this.requireInstance(externalId);
    inst.state = "destroyed";
  }

  async health(url: string): Promise<boolean> {
    this.calls.push({ method: "health", arg: url });
    const override = this.healthByUrl.get(url);
    if (override !== undefined) return override;
    for (const inst of this.instances.values()) {
      if (inst.url === url) return inst.state === "live";
    }
    return false;
  }

  private requireInstance(externalId: string): MockInstance {
    const inst = this.instances.get(externalId);
    if (!inst) throw new Error(`mock-driver: unknown instance ${externalId}`);
    return inst;
  }
}
