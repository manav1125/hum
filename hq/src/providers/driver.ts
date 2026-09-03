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

  /**
   * OPTIONAL: the container image the instance is running RIGHT NOW, as the
   * provider reports it — not the `imageRef` HQ recorded when it provisioned
   * or rolled it. The two diverge exactly when someone moves a machine
   * outside HQ (a manual `flyctl machine update`), which is the case the
   * sweep's drift check exists to catch, so it must read live provider state.
   * Drivers with no image concept omit it; callers must treat its absence as
   * "unknown", never as agreement.
   */
  currentImage?(externalId: string): Promise<string | null>;

  /** True when the instance answers its health check. Never throws. */
  health(url: string): Promise<boolean>;

  /**
   * OPTIONAL: write a small file into the instance's persistent workspace
   * (e.g. /workspace/connectors.json — the Composio credential seed, P0-2).
   * `relPath` is a bare filename relative to the workspace root. Drivers
   * without a remote-exec surface simply omit this; callers must treat its
   * absence as "seeding unsupported" and record that, not throw.
   */
  writeWorkspaceFile?(
    externalId: string,
    relPath: string,
    contents: string,
  ): Promise<void>;

  /**
   * OPTIONAL: provision a private Learn sidecar app for a customer (the Cue
   * Learn classroom service the instance's gateway proxies at /learn). No
   * public exposure — the sidecar is reachable only over the provider's
   * private network. Returns the final app name (which may differ from the
   * requested one on a name collision). Drivers without a second-app concept
   * omit it; callers must treat absence as "unsupported" and record that.
   */
  provisionLearnSidecar?(spec: {
    appName: string;
    image: string;
    env: Record<string, string>;
    region?: string;
  }): Promise<{ appName: string }>;

  /**
   * OPTIONAL: merge env vars into a running instance's machine config
   * (restarts the machine). Used by the Learn backfill.
   */
  applyEnvPatch?(externalId: string, env: Record<string, string>): Promise<void>;

  /**
   * OPTIONAL: the instance's CURRENT machine env as the provider reports it.
   * The Learn backfill uses it to detect hand-wired instances (env already
   * carries LEARN_UPSTREAM_URL) and adopt their sidecar instead of
   * provisioning a duplicate and repointing them at an empty one.
   */
  getEnv?(externalId: string): Promise<Record<string, string>>;

  /** OPTIONAL: permanently destroy a Learn sidecar app. Pairs with the above. */
  destroyLearnSidecar?(appName: string): Promise<void>;
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
