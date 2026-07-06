/**
 * Cue HQ — provisioning core, shared by the admin route
 * (POST /admin/customers/:id/provision) and the auto-provision path that
 * runs when a subscription checkout completes (stripe.ts webhook →
 * scheduleAutoProvision → autoProvisionOnPayment).
 *
 * The flow (identical for both callers):
 *   generate secrets → mint the OpenRouter child key (limit = the plan's
 *   monthly COGS budget) → driver.provision (env includes
 *   OPENROUTER_API_KEY + CUE_MANAGED=1) → poll /healthz → one-time
 *   POST /v1/guardian/init (learns guardianPrincipalId) → instance `live`.
 *
 * Idempotency: a customer with any non-deleted instance is never
 * provisioned again — webhook retries and admin double-clicks no-op.
 */

import { sendEmail, welcomeEmail } from "./email.js";
import type { Customer, HqDb, Instance } from "./db.js";
import { provisionLlmKey } from "./openrouter.js";
import { creditsToCogsUsd, resolvePlan } from "./plans.js";
import type { InstanceDriver } from "./providers/driver.js";
import { waitForHealthy } from "./providers/driver.js";
import {
  buildInstanceEnv,
  buildMagicLink,
  generateInstanceSecrets,
  guardianInit,
  mintActorToken,
  type InstanceSecrets,
} from "./secrets.js";

export interface ProvisioningDeps {
  db: HqDb;
  driver: InstanceDriver;
  fetchImpl?: typeof fetch;
  /** Health-poll bounds (tests use tiny values). */
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "customer"
  );
}

export function parseInstanceSecrets(instance: Instance): InstanceSecrets | null {
  try {
    const parsed = JSON.parse(instance.secretsJson) as InstanceSecrets;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ── provisioning ─────────────────────────────────────────────────────────

export type ProvisionOutcome =
  | { ok: true; instance: Instance; existing: false }
  | { ok: true; instance: Instance; existing: true }
  | { ok: false; status: number; error: string; instance?: Instance };

/**
 * Provision one instance for a customer. `opts` mirrors the admin route's
 * body (providerEnv / region / plan / image overrides).
 */
export async function provisionCustomer(
  deps: ProvisioningDeps,
  customer: Customer,
  opts: {
    providerEnv?: Record<string, string>;
    region?: string;
    plan?: string;
    image?: string;
  } = {},
): Promise<ProvisionOutcome> {
  const { db, driver } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const existing = db
    .listInstancesByCustomer(customer.id)
    .filter((i) => i.state !== "deleted");
  if (existing.length > 0) {
    return { ok: true, instance: existing[0], existing: true };
  }

  const secrets = generateInstanceSecrets();
  const providerEnv = opts.providerEnv ?? {};

  // Managed LLM: mint a spend-capped OpenRouter child key sized to the
  // plan's monthly credits. Only the hash is persisted; providerEnv can
  // still override OPENROUTER_API_KEY explicitly.
  const planSpec = resolvePlan(customer.plan);
  const llmKey = await provisionLlmKey(
    `cue-${slugify(customer.name)}-${customer.id.slice(0, 8)}`,
    creditsToCogsUsd(planSpec.monthlyCredits),
    fetchImpl,
  );
  if (!llmKey.ok) {
    return {
      ok: false,
      status: 502,
      error: `llm key provisioning failed: ${llmKey.reason}`,
    };
  }
  db.recordEvent("llm_key_provisioned", customer.id, {
    mode: llmKey.mode,
    limitUsd:
      llmKey.mode === "provisioned"
        ? creditsToCogsUsd(planSpec.monthlyCredits)
        : null,
  });

  const provisioned = await driver.provision({
    customerId: customer.id,
    name: `cue-${slugify(customer.name)}-${customer.id.slice(0, 8)}`,
    env: buildInstanceEnv(secrets, {
      ...(llmKey.apiKey ? { OPENROUTER_API_KEY: llmKey.apiKey } : {}),
      ...providerEnv,
    }),
    region: opts.region,
    plan: opts.plan,
    image: opts.image,
  });

  const instance = db.createInstance({
    customerId: customer.id,
    driver: driver.id,
    externalId: provisioned.externalId,
    url: provisioned.url,
    secretsJson: JSON.stringify(secrets),
    state: "provisioning",
  });
  if (llmKey.keyHash) {
    db.setInstanceOpenrouterKeyHash(instance.id, llmKey.keyHash);
  }

  const healthy = await waitForHealthy(driver, provisioned.url, {
    timeoutMs:
      deps.healthTimeoutMs ??
      Number(process.env.HQ_HEALTH_TIMEOUT_MS ?? 5 * 60_000),
    intervalMs: deps.healthIntervalMs ?? 5_000,
  });
  if (!healthy) {
    db.recordEvent("instance_health_timeout", customer.id, {
      instanceId: instance.id,
      url: provisioned.url,
    });
    return {
      ok: false,
      status: 502,
      error: "instance did not become healthy",
      instance,
    };
  }

  // One-time guardian bootstrap: creates the guardian principal and gives
  // us its id, so magic links can be minted offline from now on.
  // Best-effort — a failure leaves the instance live but unlinked.
  try {
    const init = await guardianInit(
      provisioned.url,
      secrets.guardianBootstrapSecret,
      fetchImpl,
    );
    secrets.guardianPrincipalId = init.guardianPrincipalId;
    db.updateInstanceSecrets(instance.id, JSON.stringify(secrets));
    db.recordEvent("guardian_bootstrapped", customer.id, {
      instanceId: instance.id,
      guardianPrincipalId: init.guardianPrincipalId,
    });
  } catch (err) {
    db.recordEvent("guardian_bootstrap_failed", customer.id, {
      instanceId: instance.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const live = db.transitionInstance(instance.id, "live");
  return { ok: true, instance: live, existing: false };
}

// ── magic links ──────────────────────────────────────────────────────────

export type MagicLinkOutcome =
  | { ok: true; url: string; expiresInDays: number }
  | { ok: false; status: number; error: string; detail?: string; instructions?: string };

/**
 * Mint a 30-day magic link for a customer's live/suspended instance
 * (learning the guardian principal on the fly when provisioning didn't).
 */
export async function mintMagicLinkForCustomer(
  deps: Pick<ProvisioningDeps, "db" | "fetchImpl">,
  customer: Customer,
): Promise<MagicLinkOutcome> {
  const { db } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const instance = db
    .listInstancesByCustomer(customer.id)
    .find((i) => i.state === "live" || i.state === "suspended");
  if (!instance) {
    return { ok: false, status: 404, error: "customer has no instance" };
  }
  const secrets = parseInstanceSecrets(instance);
  if (!secrets?.actorTokenSigningKey) {
    return { ok: false, status: 500, error: "instance has no stored signing key" };
  }

  // Learn the guardian principal if provisioning didn't (e.g. the
  // bootstrap secret is still unconsumed on a manually-created instance).
  if (!secrets.guardianPrincipalId) {
    try {
      const init = await guardianInit(
        instance.url,
        secrets.guardianBootstrapSecret,
        fetchImpl,
      );
      secrets.guardianPrincipalId = init.guardianPrincipalId;
      db.updateInstanceSecrets(instance.id, JSON.stringify(secrets));
    } catch (err) {
      // Cannot mint a token bound to an unknown principal: the gateway
      // verifies the signature fail-open, but the daemon resolves the
      // actor's trust class from the guardian binding — a made-up
      // principal id would be rejected as unknown. Hand back instructions
      // instead.
      return {
        ok: false,
        status: 409,
        error: "guardian principal unknown and guardian/init failed",
        detail: err instanceof Error ? err.message : String(err),
        instructions:
          "Run POST " +
          instance.url +
          "/v1/guardian/init with header x-bootstrap-secret and body " +
          '{"platform":"web","deviceId":"<any>"} to mint the first token, ' +
          "then store guardianPrincipalId in this instance's secretsJson.",
      };
    }
  }

  const token = mintActorToken({
    signingKeyHex: secrets.actorTokenSigningKey,
    guardianPrincipalId: secrets.guardianPrincipalId,
  });
  db.recordEvent("magic_link_minted", customer.id, {
    instanceId: instance.id,
  });
  // The SPA consumes ?cueToken= on boot (bootstrapCueSelfHost in
  // apps/web/src/lib/self-hosted/cue-self-host.ts) — this IS the
  // supported URL bootstrap path; there is no #selfHostToken fragment.
  return {
    ok: true,
    url: buildMagicLink(instance.url, token),
    expiresInDays: 30,
  };
}

// ── auto-provision on payment ────────────────────────────────────────────

/** Customer-facing base URL (mirrors stripe.ts publicRedirectBase). */
export function publicSiteBase(): string {
  return (
    process.env.HQ_PUBLIC_SITE_URL ??
    process.env.HQ_PUBLIC_URL ??
    `http://localhost:${process.env.HQ_PORT ?? 8790}`
  ).replace(/\/$/, "");
}

/**
 * Fired (async, unawaited by the webhook) after a subscription checkout
 * completes: provision the instance and send the designed welcome email
 * with the magic link. Idempotent — retries and replays no-op once the
 * customer has an instance.
 */
export async function autoProvisionOnPayment(
  deps: ProvisioningDeps,
  customerId: string,
): Promise<
  | { ok: true; provisioned: boolean; instance?: Instance }
  | { ok: false; error: string }
> {
  const { db } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const customer = db.getCustomer(customerId);
  if (!customer) return { ok: false, error: "unknown customer" };

  const outcome = await provisionCustomer(deps, customer);
  if (!outcome.ok) {
    db.recordEvent("auto_provision_failed", customerId, {
      error: outcome.error,
      instanceId: outcome.instance?.id ?? null,
    });
    return { ok: false, error: outcome.error };
  }
  if (outcome.existing) {
    return { ok: true, provisioned: false, instance: outcome.instance };
  }
  db.recordEvent("auto_provision_completed", customerId, {
    instanceId: outcome.instance.id,
  });

  // Welcome email (best-effort; the /welcome page also surfaces the link).
  const magic = await mintMagicLinkForCustomer({ db, fetchImpl }, customer);
  if (magic.ok) {
    const firstName = customer.name.trim().split(/\s+/)[0] || customer.name;
    const result = await sendEmail(
      customer.email,
      welcomeEmail({
        firstName,
        magicLink: magic.url,
        signinUrl: `${publicSiteBase()}/signin`,
      }),
      fetchImpl,
    );
    db.recordEvent(
      result.ok ? "welcome_email_sent" : "welcome_email_failed",
      customerId,
      result.ok ? { sent: result.sent } : { reason: result.reason },
    );
  } else {
    db.recordEvent("welcome_email_failed", customerId, {
      reason: magic.error,
    });
  }
  return { ok: true, provisioned: true, instance: outcome.instance };
}
