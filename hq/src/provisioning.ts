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
 *
 * Post-health hardening steps (2026-07-19 alpha-readiness audit, both
 * best-effort — they record loud audit events but never fail a healthy
 * provision):
 *   - Connector seeding (P0-2): writes /workspace/connectors.json
 *     ({composioApiKey, userId}) via driver.writeWorkspaceFile so the
 *     instance's "Connect Gmail" flow works out of the box.
 *
 *     ISOLATION (2026-08-04). The seeded key is now the customer's OWN
 *     Composio project key, minted by composio-projects.ts. Previously it
 *     was one PLATFORM key shared by the whole fleet, and `userId` was
 *     doing all the isolation work — but `user_id` is a partition label,
 *     not an auth boundary, so that key could list and proxy every
 *     tenant's connected accounts (verified: 176 accounts / 36 user_ids).
 *     A per-customer project makes the credential itself the boundary.
 *     If the mint fails we seed nothing rather than fall back — see
 *     resolveComposioSeed().
 *   - Budget defaults (P0-3): flips every seeded agent to
 *     hardStopEnabled=true with a weekly capCents sized to the plan
 *     (monthly COGS / 4), via the instance's PATCH /v1/agents/{id} API
 *     using the guardian-init access token. The assistant seeds agents
 *     with advisory-only budgets; managed instances get enforcement ON.
 *
 * Env contract (beyond secrets.ts / openrouter.ts):
 *   HQ_COMPOSIO_ORG_API_KEY     — Composio ORG-owner key. Set ⇒ every new
 *                                 instance gets its own Composio project
 *                                 and a key scoped to it. Never leaves HQ.
 *   HQ_COMPOSIO_API_KEY         — LEGACY shared platform key, used only
 *                                 when the org key is unset. Cross-tenant
 *                                 by construction; seeds are audited with
 *                                 scope=shared_org_key. Both unset ⇒ the
 *                                 connectors_seed_skipped event fires and
 *                                 Gmail connect stays "not configured".
 *   HQ_BUDGET_HARD_STOP_DEFAULT — "0" opts OUT of enforcing budgets on new
 *                                 instances (default is ON).
 *   HQ_AGENT_WEEKLY_CAP_CENTS   — per-agent weekly cap override in USD
 *                                 cents (default: plan monthly COGS / 4).
 */

import {
  composioProjectsConfigured,
  createCustomerProject,
} from "./composio-projects.js";
import { sendEmail, welcomeEmail } from "./email.js";
import type { Customer, HqDb, Instance } from "./db.js";
import { firstNameOf, trackEvent } from "./klaviyo.js";
import { provisionLlmKey } from "./openrouter.js";
import { creditsToCogsUsd, resolvePlan, type PlanSpec } from "./plans.js";
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
  // P0-3: a shared-key provision means this customer's spend has NO
  // provider-side cap — make that impossible to miss, per provision, both
  // in the log and in the audit trail.
  if (llmKey.mode === "shared") {
    console.error(
      `[hq/provisioning] ██ UNCAPPED LLM KEY ██ customer ${customer.id} (${customer.email}) ` +
        "is being provisioned with the SHARED OpenRouter key — no provider-side spend limit. " +
        "Set OPENROUTER_PROVISIONING_KEY on HQ to mint capped per-customer child keys.",
    );
    db.recordEvent("llm_key_shared_fallback", customer.id, {
      warning: "shared OpenRouter key — spend capped only by instance guardrails",
    });
  }

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
    // url is the branded custom domain when the driver set one up (magic
    // links + welcome status then use it); the provider-native URL rides
    // along as flyUrl — the ops/fallback URL for health checks.
    url: provisioned.url,
    flyUrl: provisioned.flyUrl ?? null,
    secretsJson: JSON.stringify(secrets),
    state: "provisioning",
    // Track what the instance runs so fleet image rolls know where each
    // machine stands (same default chain the fly driver resolves).
    imageRef: opts.image ?? process.env.CUE_IMAGE_REF ?? null,
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

  // P0-2: seed the Composio connector credentials onto the instance's
  // volume so "Connect Gmail" works from first boot. Best-effort with a
  // loud audit trail — a seed failure must not throw away a healthy
  // provision (the file can be re-seeded later via the driver).
  await seedConnectors(
    deps,
    customer,
    instance.id,
    provisioned.externalId,
    secrets,
  );

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

    // P0-3: flip budget enforcement ON for the seeded agent roster —
    // best-effort, using the fresh guardian access token.
    await applyDefaultBudgetsBestEffort(deps, customer, instance.id, {
      instanceUrl: provisioned.url,
      accessToken: init.accessToken,
      planSpec,
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

// ── connector seeding (P0-2) ─────────────────────────────────────────────

/** The exact shape assistant/src/oauth/composio-oauth.ts readCreds() parses. */
export function buildConnectorsJson(
  composioApiKey: string,
  userId: string,
): string {
  return JSON.stringify({ composioApiKey, userId });
}

/**
 * Resolve the Composio credential to seed for this customer.
 *
 * Preferred path: mint the customer their OWN Composio project and return
 * that project's key. The key is then structurally unable to see another
 * tenant's connected accounts, so isolation no longer depends on Cue
 * remembering to attach `user_ids=<own>` to every call.
 *
 * FAIL-CLOSED. If HQ is configured to mint per-customer projects but the
 * mint fails, we seed NOTHING and report it. Falling back to the shared
 * org-wide key would silently reinstate the cross-tenant credential this
 * change exists to remove — a connector that reports "not configured" is
 * a visible, recoverable degradation; a quietly over-scoped key is not.
 *
 * Legacy path: when HQ_COMPOSIO_ORG_API_KEY is unset we keep today's
 * behaviour (shared HQ_COMPOSIO_API_KEY) so existing deployments do not
 * break on upgrade — but the seed is audited as `shared_org_key` so the
 * remaining over-scoped instances are queryable rather than invisible.
 */
async function resolveComposioSeed(
  deps: ProvisioningDeps,
  customer: Customer,
  instanceId: string,
): Promise<
  | { ok: true; apiKey: string; projectId?: string; scope: string }
  | { ok: false; reason: string; error?: string }
> {
  const { db } = deps;

  if (composioProjectsConfigured()) {
    try {
      const project = await createCustomerProject(customer.id, {
        fetchImpl: deps.fetchImpl,
      });
      db.recordEvent("composio_project_created", customer.id, {
        instanceId,
        projectId: project.projectId,
      });
      return {
        ok: true,
        apiKey: project.apiKey,
        projectId: project.projectId,
        scope: "per_customer_project",
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(
        `[hq/provisioning] Composio project mint FAILED for ${customer.email}: ` +
          `${error} — seeding NOTHING (refusing to fall back to the org-wide key)`,
      );
      db.recordEvent("composio_project_create_failed", customer.id, {
        instanceId,
        error,
      });
      return { ok: false, reason: "project_mint_failed", error };
    }
  }

  const sharedKey = process.env.HQ_COMPOSIO_API_KEY?.trim();
  if (!sharedKey) {
    console.warn(
      `[hq/provisioning] no Composio key configured — connectors.json NOT seeded for ` +
        `${customer.email}; Gmail/Calendar connect will report "not configured"`,
    );
    return { ok: false, reason: "no_composio_key" };
  }
  console.warn(
    `[hq/provisioning] HQ_COMPOSIO_ORG_API_KEY unset — seeding the SHARED org-wide ` +
      `Composio key for ${customer.email}. This credential can list and proxy every ` +
      `tenant's connected accounts; set the org key to mint a per-customer project.`,
  );
  return { ok: true, apiKey: sharedKey, scope: "shared_org_key" };
}

async function seedConnectors(
  deps: ProvisioningDeps,
  customer: Customer,
  instanceId: string,
  externalId: string,
  secrets: InstanceSecrets,
): Promise<void> {
  const { db, driver } = deps;

  if (!driver.writeWorkspaceFile) {
    db.recordEvent("connectors_seed_skipped", customer.id, {
      instanceId,
      reason: `driver_${driver.id}_unsupported`,
    });
    return;
  }

  const seed = await resolveComposioSeed(deps, customer, instanceId);
  if (!seed.ok) {
    db.recordEvent("connectors_seed_skipped", customer.id, {
      instanceId,
      reason: seed.reason,
      ...(seed.error ? { error: seed.error } : {}),
    });
    return;
  }

  // Persist the project id BEFORE the workspace write. If the write dies
  // we still hold the pointer needed to delete/rotate the project, so a
  // mint can never orphan a live credential we can no longer reach.
  if (seed.projectId) {
    secrets.composioProjectId = seed.projectId;
    db.updateInstanceSecrets(instanceId, JSON.stringify(secrets));
  }

  try {
    await driver.writeWorkspaceFile(
      externalId,
      "connectors.json",
      buildConnectorsJson(seed.apiKey, customer.id),
    );
    db.recordEvent("connectors_seeded", customer.id, {
      instanceId,
      userId: customer.id,
      scope: seed.scope,
      ...(seed.projectId ? { projectId: seed.projectId } : {}),
    });
  } catch (err) {
    console.error(
      `[hq/provisioning] connectors.json seed FAILED for ${customer.email}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    db.recordEvent("connectors_seed_failed", customer.id, {
      instanceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── managed budget defaults (P0-3) ───────────────────────────────────────

/**
 * Per-agent weekly hard cap in USD cents: the plan's monthly COGS budget
 * spread over ~4 weeks (agents.cap_cents is measured over a 7-day window).
 * Overridable via HQ_AGENT_WEEKLY_CAP_CENTS. Never below $1 so a tiny plan
 * can't hard-stop instantly on rounding.
 */
export function defaultAgentWeeklyCapCents(planSpec: PlanSpec): number {
  const override = Number(process.env.HQ_AGENT_WEEKLY_CAP_CENTS ?? "");
  if (Number.isInteger(override) && override > 0) return override;
  return Math.max(
    100,
    Math.round((creditsToCogsUsd(planSpec.monthlyCredits) / 4) * 100),
  );
}

function budgetDefaultsDisabled(): boolean {
  return process.env.HQ_BUDGET_HARD_STOP_DEFAULT?.trim() === "0";
}

export type BudgetDefaultsOutcome =
  | { ok: true; updated: number; capCents: number }
  | { ok: false; reason: string };

/**
 * Enforce spend budgets on a fresh instance's agent roster: GET /v1/agents,
 * then PATCH each agent with { hardStopEnabled: true, capCents }. The
 * roster seeds during daemon boot, so an empty list is retried briefly.
 * The WS1 budget engine (assistant/src/guardrails/budget-enforcement.ts)
 * only hard-stops when BOTH hardStopEnabled=1 AND a cap is set — flipping
 * the flag alone would be a no-op, hence the sized cap.
 */
export async function applyDefaultBudgets(params: {
  instanceUrl: string;
  accessToken: string;
  planSpec: PlanSpec;
  fetchImpl?: typeof fetch;
  /** Roster-seed poll knobs (tests use tiny values). */
  listAttempts?: number;
  listRetryDelayMs?: number;
}): Promise<BudgetDefaultsOutcome> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const base = params.instanceUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${params.accessToken}`,
    "Content-Type": "application/json",
  };
  const capCents = defaultAgentWeeklyCapCents(params.planSpec);
  const attempts = params.listAttempts ?? 5;
  const retryDelayMs = params.listRetryDelayMs ?? 3_000;

  let agents: { id: string }[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/v1/agents`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return {
        ok: false,
        reason: `agents_list_fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!res.ok) {
      return { ok: false, reason: `agents_list_http_${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as {
      agents?: { id?: string }[];
    };
    agents = (body.agents ?? []).filter(
      (a): a is { id: string } => typeof a.id === "string" && a.id.length > 0,
    );
    if (agents.length > 0) break;
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  if (agents.length === 0) {
    return { ok: false, reason: "agent_roster_empty" };
  }

  let updated = 0;
  for (const agent of agents) {
    const res = await fetchImpl(
      `${base}/v1/agents/${encodeURIComponent(agent.id)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ hardStopEnabled: true, capCents }),
        signal: AbortSignal.timeout(30_000),
      },
    ).catch(() => null);
    if (res?.ok) updated += 1;
  }
  if (updated === 0) {
    return { ok: false, reason: "no_agent_accepted_budget_patch" };
  }
  return { ok: true, updated, capCents };
}

async function applyDefaultBudgetsBestEffort(
  deps: ProvisioningDeps,
  customer: Customer,
  instanceId: string,
  params: { instanceUrl: string; accessToken: string; planSpec: PlanSpec },
): Promise<void> {
  const { db } = deps;
  if (budgetDefaultsDisabled()) {
    db.recordEvent("budget_defaults_skipped", customer.id, {
      instanceId,
      reason: "HQ_BUDGET_HARD_STOP_DEFAULT=0",
    });
    return;
  }
  try {
    const outcome = await applyDefaultBudgets({
      ...params,
      fetchImpl: deps.fetchImpl ?? fetch,
    });
    if (outcome.ok) {
      db.recordEvent("budget_defaults_applied", customer.id, {
        instanceId,
        updated: outcome.updated,
        capCents: outcome.capCents,
      });
    } else {
      console.error(
        `[hq/provisioning] budget defaults FAILED for ${customer.email}: ${outcome.reason} — ` +
          "this instance's agents run with ADVISORY-ONLY budgets",
      );
      db.recordEvent("budget_defaults_failed", customer.id, {
        instanceId,
        reason: outcome.reason,
      });
    }
  } catch (err) {
    db.recordEvent("budget_defaults_failed", customer.id, {
      instanceId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── magic links ──────────────────────────────────────────────────────────

export type MagicLinkOutcome =
  | {
      ok: true;
      /** Full browser magic link: `<instanceUrl>/assistant/?cueToken=<jwt>`. */
      url: string;
      /**
       * The instance's SPA root and the actor token, split out for native
       * clients (the mobile app) that navigate the WebView onto the instance
       * and seed the session themselves rather than following the browser URL.
       */
      instanceUrl: string;
      cueToken: string;
      expiresInDays: number;
    }
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
    instanceUrl: instance.url.replace(/\/$/, ""),
    cueToken: token,
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
  // Marketing sync — fire-and-forget, never blocks provisioning.
  void trackEvent(
    db,
    {
      metric: "Cue Instance Ready",
      email: customer.email,
      firstName: firstNameOf(customer.name),
      profileProps: { plan: customer.plan },
      props: { instanceUrl: outcome.instance.url },
      uniqueId: `instance-ready:${outcome.instance.id}`,
      customerId,
    },
    fetchImpl,
  );

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
    // Honest audit trail (P0-1): "sent" ONLY when Resend actually accepted
    // it. Log-only mode (no RESEND_API_KEY) records a distinct event so
    // prod events can never again claim deliveries that never left the box.
    db.recordEvent(
      !result.ok
        ? "welcome_email_failed"
        : result.sent
          ? "welcome_email_sent"
          : "welcome_email_skipped_no_key",
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
