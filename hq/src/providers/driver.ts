/**
 * Cue HQ — hosting-provider driver interface.
 *
 * The hosting provider is undecided (Render today; likely Hetzner/Fly
 * later), so every provider is an implementation of this interface and
 * the rest of HQ only ever talks to `InstanceDriver`.
 */

/** What HQ asks a provider to stand up for one customer. */
export interface InstanceSpec {
  customerId: string;
  /** Provider-visible service name, e.g. `cue-<customer-slug>`. */
  name: string;
  /**
   * Full env contract for the instance (see render.yaml at the repo root):
   * GUARDIAN_BOOTSTRAP_SECRET, ACTOR_TOKEN_SIGNING_KEY, OPENROUTER_API_KEY,
   * REPLICATE_API_TOKEN, GATEWAY_JWT, CES_SERVICE_TOKEN, ASSISTANT_API_KEY, …
   *
   * Optional bundled tool-API keys (web-research / web-scrape skills),
   * passed through from HQ's own env by buildInstanceEnv() when set:
   * CUE_TAVILY_API_KEY, CUE_FIRECRAWL_API_KEY, CUE_SERPER_API_KEY.
   * Unset = the corresponding tools report "not configured" on the instance.
   */
  env: Record<string, string>;
  /** Provider region hint (e.g. "singapore"). */
  region?: string;
  /** Provider plan/size hint (e.g. "standard"). */
  plan?: string;
  /** Container image to deploy, when the provider is image-based. */
  image?: string;
}

export interface ProvisionResult {
  /** Provider-side id (e.g. Render `srv-…`). */
  externalId: string;
  /**
   * Public base URL of the instance — the branded custom domain
   * (https://<app>.<HQ_INSTANCE_DOMAIN>) when the driver set one up,
   * otherwise the provider-native URL.
   */
  url: string;
  /**
   * Provider-native URL (e.g. https://<app>.fly.dev) kept as the
   * fallback/ops URL when `url` is a custom domain. Absent when no custom
   * domain was configured (url IS the provider URL).
   */
  flyUrl?: string;
}

export interface InstanceDriver {
  /** Stable driver id persisted on instance rows (e.g. "render", "mock"). */
  readonly id: string;

  /** Create the instance. Resolves once the provider accepted the create. */
  provision(spec: InstanceSpec): Promise<ProvisionResult>;

  /** Pause the instance (stops billing-heavy compute where supported). */
  suspend(externalId: string): Promise<void>;

  /** Resume a suspended instance. */
  resume(externalId: string): Promise<void>;

  /**
   * Roll a running instance to a new container image, preserving the rest
   * of its configuration exactly. Resolves once the instance is healthy on
   * the new image. No rollback in v1 — on failure the thrown error carries
   * the previous image ref so an operator can roll back by calling update
   * again with it. Providers that deploy some other way (Render deploys
   * from the blueprint) throw UpdateNotSupportedError.
   */
  update(externalId: string, image: string): Promise<void>;

  /** Permanently destroy the instance. */
  destroy(externalId: string): Promise<void>;

  /** True when the instance answers its health check. Never throws. */
  health(url: string): Promise<boolean>;
}

/** Thrown by drivers whose provider has no HQ-driven image-update path. */
export class UpdateNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateNotSupportedError";
  }
}

/**
 * Poll `driver.health(url)` until it returns true or the timeout elapses.
 * Returns true on first healthy response.
 */
export async function waitForHealthy(
  driver: InstanceDriver,
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  // Always probe at least once, even with a zero timeout (tests).
  do {
    if (await driver.health(url)) return true;
    if (Date.now() + intervalMs > deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (Date.now() < deadline);
  return false;
}
