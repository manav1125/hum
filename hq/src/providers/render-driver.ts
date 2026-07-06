/**
 * Cue HQ — Render driver.
 *
 * Implements InstanceDriver against the Render REST API
 * (https://api-docs.render.com/reference). Creates an image-backed web
 * service mirroring the `cue-app` service in the repo-root render.yaml
 * (single-tenant: daemon + gateway co-located, one persistent disk).
 *
 * Configuration (all via env — no keys in code):
 *   RENDER_API_KEY    — required to make any call
 *   RENDER_OWNER_ID   — the Render owner/team id (`tea-…`/`usr-…`) new
 *                       services are created under
 *   HQ_RENDER_IMAGE   — default container image for new instances (can be
 *                       overridden per-provision via spec.image)
 *   HQ_RENDER_REGION  — default region (default "singapore", matching prod)
 *   HQ_RENDER_PLAN    — default plan (default "standard", matching prod)
 *
 * NOTE: the reference prod service (srv-d8pb70s8aovs73edureg) was created
 * from the render.yaml blueprint. The API cannot instantiate a blueprint
 * directly, so this driver creates the equivalent image-backed service.
 * Qdrant is not provisioned per-instance yet (TODO: either bake a shared
 * Qdrant URL into the env contract or add a second pserv create call).
 */

import type {
  InstanceDriver,
  InstanceSpec,
  ProvisionResult,
} from "./driver.js";
import { UpdateNotSupportedError } from "./driver.js";

const RENDER_API_BASE = "https://api.render.com/v1";

interface RenderServiceResponse {
  id: string;
  serviceDetails?: { url?: string };
  // POST /services responds with { service: {...} } — normalized below.
  service?: RenderServiceResponse;
}

export class RenderDriver implements InstanceDriver {
  readonly id = "render";

  private readonly apiKey: string;
  private readonly ownerId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { fetchImpl?: typeof fetch } = {}) {
    this.apiKey = process.env.RENDER_API_KEY ?? "";
    this.ownerId = process.env.RENDER_OWNER_ID ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.apiKey.length > 0 && this.ownerId.length > 0;
  }

  private async api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!this.configured) {
      throw new Error(
        "render-driver not configured: set RENDER_API_KEY and RENDER_OWNER_ID",
      );
    }
    const res = await this.fetchImpl(`${RENDER_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Render API ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`,
      );
    }
    if (res.status === 204) return undefined;
    return res.json().catch(() => undefined);
  }

  async provision(spec: InstanceSpec): Promise<ProvisionResult> {
    const image = spec.image ?? process.env.HQ_RENDER_IMAGE;
    if (!image) {
      throw new Error(
        "render-driver: no image — set HQ_RENDER_IMAGE or pass spec.image",
      );
    }

    const body = {
      type: "web_service",
      name: spec.name,
      ownerId: this.ownerId,
      image: { imagePath: image, ownerId: this.ownerId },
      envVars: Object.entries(spec.env).map(([key, value]) => ({
        key,
        value,
      })),
      serviceDetails: {
        env: "image",
        region: spec.region ?? process.env.HQ_RENDER_REGION ?? "singapore",
        plan: spec.plan ?? process.env.HQ_RENDER_PLAN ?? "standard",
        healthCheckPath: "/healthz",
        numInstances: 1, // single-tenant: pinned to one instance
        disk: { name: "workspace", mountPath: "/workspace", sizeGB: 10 },
      },
    };

    const raw = (await this.api(
      "POST",
      "/services",
      body,
    )) as RenderServiceResponse;
    const svc = raw.service ?? raw;
    const externalId = svc.id;
    if (!externalId) {
      throw new Error("Render API create returned no service id");
    }
    const url =
      svc.serviceDetails?.url ?? `https://${spec.name}.onrender.com`;
    return { externalId, url };
  }

  async suspend(externalId: string): Promise<void> {
    await this.api("POST", `/services/${externalId}/suspend`);
  }

  async resume(externalId: string): Promise<void> {
    await this.api("POST", `/services/${externalId}/resume`);
  }

  /** Render is not our fleet-update path — deploys come from render.yaml. */
  async update(_externalId: string, _image: string): Promise<void> {
    throw new UpdateNotSupportedError(
      "render-driver: image updates are not supported — Render services " +
        "deploy from the render.yaml blueprint, not HQ's fleet path. " +
        "Trigger a deploy from the Render dashboard/blueprint instead.",
    );
  }

  async destroy(externalId: string): Promise<void> {
    await this.api("DELETE", `/services/${externalId}`);
  }

  /** GET <url>/healthz — the gateway's health endpoint. Never throws. */
  async health(url: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${url.replace(/\/$/, "")}/healthz`, {
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
