/**
 * Cue HQ — Fly.io driver.
 *
 * Implements InstanceDriver against the Fly Machines API
 * (https://api.machines.dev/v1 — apps/volumes/machines) plus the GraphQL
 * API (https://api.fly.io/graphql) for the one operation REST doesn't
 * cover: public IP allocation. One customer = one Fly app containing one
 * machine (daemon + gateway co-located, mirroring render.yaml's `cue-app`)
 * with a persistent volume mounted at /workspace.
 *
 * Configuration (all via env — no keys in code):
 *   FLY_API_TOKEN      — org-scoped token; required to make any call
 *   FLY_ORG_SLUG       — org new apps are created in; required
 *   CUE_IMAGE_REF      — default image (e.g. registry.fly.io/cue-releases:v9ce28d3;
 *                        built via hq/scripts/fly-release.sh); per-provision
 *                        override via spec.image
 *   HQ_FLY_REGION         — default region (default "iad")
 *   HQ_FLY_VM_SIZE        — guest preset, e.g. "shared-cpu-1x" (default)
 *   HQ_FLY_VM_MEMORY_MB   — machine memory (default 1024)
 *   HQ_FLY_VOLUME_SIZE_GB — /workspace volume size (default 10, matching
 *                        render.yaml's disk block); spec.plan like "20gb"
 *                        overrides per-provision
 *
 * Custom instance domains (all three set ⇒ enabled; any unset ⇒ the whole
 * feature is skipped and behavior is byte-identical to before):
 *   HQ_INSTANCE_DOMAIN            — customer domain, e.g. "justcue.app";
 *                                   the subdomain label is the fly app name
 *                                   (globally unique already), so an app
 *                                   cue-ada-1234 serves at
 *                                   https://cue-ada-1234.justcue.app
 *   CLOUDFLARE_API_TOKEN          — zone-scoped token (DNS edit)
 *   CLOUDFLARE_ZONE_ID_INSTANCES  — the justcue.app zone id
 * After /healthz passes on the .fly.dev URL, provision() creates a
 * DNS-only CNAME on Cloudflare (proxied: false — Cloudflare's proxy breaks
 * Fly's TLS handshake for custom hostnames), requests an ACME cert via the
 * Machines API certificates resource (the old GraphQL addCertificate path;
 * fly.io/docs/networking/custom-domain-api now 301s to the REST resource),
 * and polls issuance briefly WITHOUT failing the provision — the hostname
 * is recorded optimistically and the .fly.dev URL rides along as flyUrl.
 * Any custom-domain failure falls back to the .fly.dev URL (never fails a
 * healthy provision). destroy() deletes the CNAME again (best-effort).
 *
 * Qdrant: intentionally NOT provisioned and QDRANT_URL is NOT set. The
 * daemon treats Qdrant as a non-blocking subsystem: without QDRANT_URL,
 * QdrantManager (assistant/src/memory/qdrant-manager.ts) self-spawns a
 * local qdrant binary — downloaded on first boot into getDataDir() =
 * /workspace/data, i.e. onto the persistent volume — and if that fails the
 * daemon retries 3x then continues with memory features disabled
 * (assistant/src/daemon/lifecycle.ts). One machine per customer is enough.
 *
 * Unlike the Render driver, provision() here is fully synchronous-to-ready:
 * it waits for the machine to reach `started` and for /healthz to answer,
 * and tears down everything it created if that never happens — Fly has no
 * "deploy in progress" state to lean on, so a half-created app would
 * otherwise leak (and bill) silently.
 */

import type {
  InstanceDriver,
  InstanceSpec,
  ProvisionResult,
} from "./driver.js";

/** Full machine config as returned by GET machine — round-tripped verbatim
 * on update (only `image` changes); everything else is opaque to HQ. */
interface FlyMachineConfig extends Record<string, unknown> {
  image?: string;
}

const FLY_MACHINES_API_BASE = "https://api.machines.dev/v1";
const FLY_GRAPHQL_URL = "https://api.fly.io/graphql";
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** How many times provision() peeks at cert issuance before moving on. */
const CERT_POLL_ATTEMPTS = 6;

interface CustomDomainConfig {
  /** e.g. "justcue.app" */
  domain: string;
  cfToken: string;
  cfZoneId: string;
}

/**
 * The custom-domain env triple, or null when any part is missing (feature
 * off — current .fly.dev behavior unchanged).
 */
export function customDomainConfig(): CustomDomainConfig | null {
  const domain = (process.env.HQ_INSTANCE_DOMAIN ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  const cfToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const cfZoneId = process.env.CLOUDFLARE_ZONE_ID_INSTANCES ?? "";
  if (!domain || !cfToken || !cfZoneId) return null;
  return { domain, cfToken, cfZoneId };
}

interface FlyMachine {
  id: string;
  state?: string;
}

interface FlyVolume {
  id: string;
}

/** Parse "shared-cpu-1x" / "performance-2x" into a Machines guest block. */
export function parseGuestPreset(
  preset: string,
  memoryMb: number,
): { cpu_kind: string; cpus: number; memory_mb: number } {
  const match = preset.match(/^(shared|performance)-(?:cpu-)?(\d+)x$/i);
  if (!match) {
    throw new Error(
      `fly-driver: unrecognized HQ_FLY_VM_SIZE "${preset}" — expected e.g. shared-cpu-1x or performance-2x`,
    );
  }
  return {
    cpu_kind: match[1].toLowerCase(),
    cpus: Number(match[2]),
    memory_mb: memoryMb,
  };
}

/** Volume size: spec.plan like "20gb" wins, then HQ_FLY_VOLUME_SIZE_GB, then 10. */
function volumeSizeGb(spec: InstanceSpec): number {
  const fromPlan = spec.plan?.match(/^(\d+)\s*gb$/i);
  if (fromPlan) return Number(fromPlan[1]);
  const fromEnv = Number(process.env.HQ_FLY_VOLUME_SIZE_GB ?? "");
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 10;
}

export class FlyDriver implements InstanceDriver {
  readonly id = "fly";

  private readonly apiToken: string;
  private readonly orgSlug: string;
  private readonly fetchImpl: typeof fetch;
  private readonly healthTimeoutMs: number;
  private readonly healthIntervalMs: number;

  constructor(
    opts: {
      fetchImpl?: typeof fetch;
      /** Provision health-poll budget (tests use tiny values). */
      healthTimeoutMs?: number;
      healthIntervalMs?: number;
    } = {},
  ) {
    this.apiToken = process.env.FLY_API_TOKEN ?? "";
    this.orgSlug = process.env.FLY_ORG_SLUG ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.healthTimeoutMs =
      opts.healthTimeoutMs ??
      Number(process.env.HQ_HEALTH_TIMEOUT_MS ?? 5 * 60_000);
    this.healthIntervalMs = opts.healthIntervalMs ?? 5_000;
  }

  get configured(): boolean {
    return this.apiToken.length > 0 && this.orgSlug.length > 0;
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────

  private requireConfigured(): void {
    if (!this.configured) {
      throw new Error(
        "fly-driver not configured: set FLY_API_TOKEN and FLY_ORG_SLUG",
      );
    }
  }

  private async api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    this.requireConfigured();
    const res = await this.fetchImpl(`${FLY_MACHINES_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Fly API ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`,
      );
    }
    if (res.status === 204) return undefined;
    return res.json().catch(() => undefined);
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    this.requireConfigured();
    const res = await this.fetchImpl(FLY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Fly GraphQL → ${res.status}: ${text.slice(0, 500)}`,
      );
    }
    const payload = (await res.json()) as {
      data?: unknown;
      errors?: { message?: string }[];
    };
    if (payload.errors?.length) {
      throw new Error(
        `Fly GraphQL error: ${payload.errors
          .map((e) => e.message ?? "unknown")
          .join("; ")
          .slice(0, 500)}`,
      );
    }
    return payload.data;
  }

  // ── provision ────────────────────────────────────────────────────────────

  async provision(spec: InstanceSpec): Promise<ProvisionResult> {
    const image = spec.image ?? process.env.CUE_IMAGE_REF;
    if (!image) {
      throw new Error(
        "fly-driver: no image — set CUE_IMAGE_REF (see hq/scripts/fly-release.sh) or pass spec.image",
      );
    }
    const region = spec.region ?? process.env.HQ_FLY_REGION ?? "iad";
    const guest = parseGuestPreset(
      process.env.HQ_FLY_VM_SIZE ?? "shared-cpu-1x",
      Number(process.env.HQ_FLY_VM_MEMORY_MB ?? 1024),
    );

    const appName = await this.createAppWithUniqueName(spec.name);
    const url = `https://${appName}.fly.dev`;

    // Everything after app-create tears the app down on failure so a
    // half-provisioned customer never leaks machines/volumes/IPs.
    try {
      await this.allocatePublicIps(appName);

      const volume = (await this.api("POST", `/apps/${appName}/volumes`, {
        name: "workspace",
        region,
        size_gb: volumeSizeGb(spec),
      })) as FlyVolume;
      if (!volume?.id) {
        throw new Error("Fly volume create returned no id");
      }

      const machine = (await this.api("POST", `/apps/${appName}/machines`, {
        region,
        config: {
          image,
          // The image's default CMD is the standalone daemon
          // (docker-entrypoint.sh); the combined daemon+gateway entrypoint is
          // what render.yaml runs via `dockerCommand` — mirror that here, or
          // nothing listens on the public port and health never passes.
          init: { cmd: ["/app/assistant/docker-cue-app-entrypoint.sh"] },
          env: spec.env,
          guest,
          // Public ingress: Fly's edge proxies 80/443 → the gateway on its
          // in-container GATEWAY_PORT (10000, per the render.yaml contract).
          services: [
            {
              protocol: "tcp",
              internal_port: 10000,
              ports: [
                { port: 80, handlers: ["http"], force_https: true },
                { port: 443, handlers: ["http", "tls"] },
              ],
            },
          ],
          mounts: [{ volume: volume.id, path: "/workspace" }],
          restart: { policy: "always" },
        },
      })) as FlyMachine;
      if (!machine?.id) {
        throw new Error("Fly machine create returned no id");
      }

      await this.waitForMachineState(appName, machine.id, "started");

      if (!(await this.pollHealthy(url))) {
        throw new Error(
          `fly-driver: ${url}/healthz not healthy within ${this.healthTimeoutMs}ms`,
        );
      }
    } catch (err) {
      await this.teardown(appName).catch(() => {});
      throw err;
    }

    // Custom instance domain — strictly after health passed on .fly.dev.
    // Never fails a healthy provision: any Cloudflare/cert hiccup falls
    // back to the .fly.dev URL (and a destroy cleans up a stray CNAME).
    try {
      const hostname = await this.provisionCustomDomain(appName);
      if (hostname) {
        return { externalId: appName, url: `https://${hostname}`, flyUrl: url };
      }
    } catch (err) {
      console.warn(
        `[fly-driver] custom domain for ${appName} failed — serving ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { externalId: appName, url };
  }

  /**
   * Point <app>.<HQ_INSTANCE_DOMAIN> at <app>.fly.dev and get it a cert.
   * Returns the custom hostname, or null when the feature env is unset.
   *
   *  a. Cloudflare CNAME, DNS-only (`proxied: false` is load-bearing —
   *     Cloudflare's proxy terminates TLS itself and breaks Fly's ACME
   *     validation + TLS handshake for the hostname).
   *  b. ACME cert via the Machines API certificates resource.
   *  c. Brief issuance poll; slow issuance does NOT fail anything — the
   *     hostname is recorded optimistically and Fly finishes in background.
   */
  private async provisionCustomDomain(appName: string): Promise<string | null> {
    const cfg = customDomainConfig();
    if (!cfg) return null;
    const hostname = `${appName}.${cfg.domain}`;

    await this.cloudflare(cfg, "POST", `/zones/${cfg.cfZoneId}/dns_records`, {
      type: "CNAME",
      name: hostname,
      content: `${appName}.fly.dev`,
      proxied: false,
      ttl: 1, // 1 = automatic
      comment: `cue-hq instance ${appName}`,
    });

    await this.api("POST", `/apps/${appName}/certificates/acme`, { hostname });

    for (let attempt = 0; attempt < CERT_POLL_ATTEMPTS; attempt++) {
      const cert = (await this.api(
        "GET",
        `/apps/${appName}/certificates/${hostname}`,
      ).catch(() => undefined)) as { configured?: boolean } | undefined;
      if (cert?.configured) break;
      if (attempt < CERT_POLL_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, this.healthIntervalMs));
      }
    }
    return hostname;
  }

  /** Cloudflare API v4 plumbing (checks the envelope's `success` flag). */
  private async cloudflare(
    cfg: CustomDomainConfig,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.cfToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await res.json().catch(() => null)) as {
      success?: boolean;
      errors?: { message?: string }[];
      result?: unknown;
    } | null;
    if (!res.ok || !payload?.success) {
      const detail =
        payload?.errors?.map((e) => e.message ?? "unknown").join("; ") ??
        `HTTP ${res.status}`;
      throw new Error(
        `Cloudflare ${method} ${path} failed: ${detail.slice(0, 500)}`,
      );
    }
    return payload.result;
  }

  /**
   * Fly app names are globally unique. Try the requested name first; on a
   * name-taken rejection retry with a short random suffix.
   */
  private async createAppWithUniqueName(baseName: string): Promise<string> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const name =
        attempt === 0
          ? baseName
          : `${baseName}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        await this.api("POST", "/apps", {
          app_name: name,
          org_slug: this.orgSlug,
        });
        return name;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // "already been taken" is Fly's name-collision message (422).
        if (!/taken|already exists/i.test(lastError.message)) throw lastError;
      }
    }
    throw new Error(
      `fly-driver: could not find a free app name for ${baseName}: ${lastError?.message}`,
    );
  }

  /**
   * Allocate a shared IPv4 + dedicated IPv6. The Machines API has no IP
   * endpoint (flyctl only auto-allocates during `fly deploy`), so this is
   * the GraphQL mutation flyctl's `fly ips allocate-v4 --shared` /
   * `fly ips allocate-v6` use (superfly/fly-go resource_ip_addresses.go).
   */
  private async allocatePublicIps(appName: string): Promise<void> {
    await this.graphql(
      `mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) { app { sharedIpAddress } }
      }`,
      { input: { appId: appName, type: "shared_v4" } },
    );
    await this.graphql(
      `mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) { ipAddress { id address } }
      }`,
      { input: { appId: appName, type: "v6" } },
    );
  }

  /** Block until the machine reports the target state (Fly long-polls 60s). */
  private async waitForMachineState(
    appName: string,
    machineId: string,
    state: "started" | "stopped",
    attempts = 3,
  ): Promise<void> {
    let lastError: Error | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.api(
          "GET",
          `/apps/${appName}/machines/${machineId}/wait?state=${state}&timeout=60`,
        );
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw new Error(
      `fly-driver: machine ${machineId} never reached "${state}": ${lastError?.message}`,
    );
  }

  private async pollHealthy(url: string): Promise<boolean> {
    const deadline = Date.now() + this.healthTimeoutMs;
    do {
      if (await this.health(url)) return true;
      if (Date.now() + this.healthIntervalMs > deadline) break;
      await new Promise((r) => setTimeout(r, this.healthIntervalMs));
    } while (Date.now() < deadline);
    return false;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  private async listMachines(appName: string): Promise<FlyMachine[]> {
    const machines = (await this.api(
      "GET",
      `/apps/${appName}/machines`,
    )) as FlyMachine[] | undefined;
    return Array.isArray(machines) ? machines : [];
  }

  async suspend(externalId: string): Promise<void> {
    for (const machine of await this.listMachines(externalId)) {
      await this.api(
        "POST",
        `/apps/${externalId}/machines/${machine.id}/stop`,
      );
    }
  }

  async resume(externalId: string): Promise<void> {
    for (const machine of await this.listMachines(externalId)) {
      await this.api(
        "POST",
        `/apps/${externalId}/machines/${machine.id}/start`,
      );
    }
  }

  /**
   * Roll every machine in the app to a new image. Each machine's current
   * config is fetched first and POSTed back with ONLY the image swapped —
   * env/services/mounts/init/guest ride along byte-for-byte. After every
   * machine reports `started`, the app's public /healthz is polled; on
   * timeout this throws with the previous image ref in the message so an
   * operator can roll back by calling update again with it (no automatic
   * rollback in v1).
   */
  async update(externalId: string, image: string): Promise<void> {
    const machines = await this.listMachines(externalId);
    if (machines.length === 0) {
      throw new Error(
        `fly-driver: app ${externalId} has no machines to update`,
      );
    }
    // externalId IS the app name; the public URL is derived the same way
    // provision() built it.
    const url = `https://${externalId}.fly.dev`;
    let previousImage = "unknown";
    for (const machine of machines) {
      const current = (await this.api(
        "GET",
        `/apps/${externalId}/machines/${machine.id}`,
      )) as { config?: FlyMachineConfig } | undefined;
      if (!current?.config) {
        throw new Error(
          `fly-driver: machine ${machine.id} returned no config to update`,
        );
      }
      previousImage = current.config.image ?? previousImage;
      await this.api("POST", `/apps/${externalId}/machines/${machine.id}`, {
        config: { ...current.config, image },
      });
      await this.waitForMachineState(externalId, machine.id, "started");
    }
    if (!(await this.pollHealthy(url))) {
      throw new Error(
        `fly-driver: ${url}/healthz not healthy within ${this.healthTimeoutMs}ms ` +
          `after update to ${image}; previous image was ${previousImage} — ` +
          `roll back by calling update again with it`,
      );
    }
  }

  async destroy(externalId: string): Promise<void> {
    // Best-effort DNS cleanup first (never blocks the teardown); the Fly
    // certificate needs no separate delete — it dies with the app.
    try {
      await this.removeCustomDomainRecord(externalId);
    } catch (err) {
      console.warn(
        `[fly-driver] DNS cleanup for ${externalId} failed (record may linger): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await this.teardown(externalId);
  }

  /** Delete the instance's Cloudflare CNAME (list by name → delete by id). */
  private async removeCustomDomainRecord(appName: string): Promise<void> {
    const cfg = customDomainConfig();
    if (!cfg) return;
    const hostname = `${appName}.${cfg.domain}`;
    const records = (await this.cloudflare(
      cfg,
      "GET",
      `/zones/${cfg.cfZoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    )) as { id?: string }[] | undefined;
    for (const record of Array.isArray(records) ? records : []) {
      if (!record?.id) continue;
      await this.cloudflare(
        cfg,
        "DELETE",
        `/zones/${cfg.cfZoneId}/dns_records/${record.id}`,
      );
    }
  }

  /**
   * Delete machines → volumes → app, tolerating 404s so the sequence is
   * idempotent and safe to run against a half-provisioned app. The final
   * app delete uses ?force=true (stops anything still running); machines
   * and volumes are still deleted explicitly first because the docs don't
   * guarantee app deletion cascades to volumes.
   */
  private async teardown(appName: string): Promise<void> {
    const ignore404 = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/→ 404/.test(msg)) throw err;
      }
    };

    let machines: FlyMachine[] = [];
    try {
      machines = await this.listMachines(appName);
    } catch {
      // App may not exist (or was never fully created) — fall through to
      // the app delete, which is itself 404-tolerant.
    }
    for (const machine of machines) {
      await ignore404(
        this.api(
          "DELETE",
          `/apps/${appName}/machines/${machine.id}?force=true`,
        ),
      );
    }

    let volumes: FlyVolume[] = [];
    try {
      const listed = (await this.api(
        "GET",
        `/apps/${appName}/volumes`,
      )) as FlyVolume[] | undefined;
      volumes = Array.isArray(listed) ? listed : [];
    } catch {
      // Same tolerance as machines.
    }
    for (const volume of volumes) {
      await ignore404(
        this.api("DELETE", `/apps/${appName}/volumes/${volume.id}`),
      );
    }

    await ignore404(this.api("DELETE", `/apps/${appName}?force=true`));
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
