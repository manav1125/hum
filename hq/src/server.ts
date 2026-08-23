/**
 * Cue HQ — HTTP server (Bun.serve, matching the daemon's serving style;
 * the repo has no Hono dependency, so routes are a plain match table).
 *
 * Public routes:
 *   GET  /healthz
 *   GET  /plans                 — JSON pricing catalog (marketing site)
 *   POST /waitlist              { email, name, plan? }
 *   POST /redeem                { code, email, name, plan? } → checkout URL
 *   POST /webhooks/stripe       (raw body + Stripe-Signature)
 *   GET  /welcome/status        ?session_id= → provisioning|ready|delayed|unknown
 *   POST /signin                { email } → {ok, status} — status is "sent"
 *                               (customer, link emailed), "invited_no_account"
 *                               (on the alpha allowlist, no instance yet), or
 *                               "invite_required" (honest private-alpha gate)
 *   GET  /auth                  ?token= → session cookie + 302 into the
 *                               customer's instance (fresh magic link),
 *                               falling back to /account
 *   POST /testflight            { email } → {ok} (idempotent interest event)
 *   GET  /downloads/cue-macos.dmg — 302 to the current GitHub release asset
 *   GET  /skills/{slug}         — public shareable skill page (share.ts:
 *                               static catalog/seed-source render, OG tags,
 *                               install CTA; zero customer data)
 *   GET  /slack/install         ?state= → 302 to Slack OAuth (channels/slack)
 *   GET  /slack/oauth/callback  ?code=&state= → store team→customer binding
 *   POST /slack/events          Slack Events API (signature-verified, deduped)
 *   POST /slack/commands        /cue status|new|help (signature-verified)
 *
 * Customer routes (signed session cookie, HQ_SESSION_SECRET):
 *   GET  /account/summary       — plan + credits + 30-day usage
 *   POST /account/topup         { pack } → Stripe checkout URL (Origin-checked)
 *   GET  /account/portal        → 302 to the Stripe billing portal
 *   GET  /account/open          → 302 to a fresh instance magic link
 *                               (no instance ⇒ /account?error=no_instance)
 *
 * Everything else on GET/HEAD falls through to the static marketing site
 * (site.ts: HQ_SITE_DIR, clean URLs — /pricing → pricing.html etc.).
 *
 * Admin routes (Bearer HQ_ADMIN_TOKEN, or ?token= for the browser page):
 *   GET  /admin                                 — HTML dashboard
 *   GET  /admin/status                          — readiness report (email/
 *                               Resend-domain probe, LLM key mode, connector
 *                               seeding, sizing defaults, sweep/backup state)
 *   POST /admin/invites/send                    { emails, plan?, percentOff?,
 *                               maxUses?, expiresDays?, note? } — per address:
 *                               find/create customer, allowlist, mint a code,
 *                               email it. Returns a per-address result row.
 *   GET/POST/DELETE /admin/invites/emails       — alpha signin allowlist
 *   POST /admin/catalog/ensure                  — idempotent Stripe catalog
 *   POST /admin/register-instance               { email, url, signingKey, guardianPrincipalId, name?, driver?, externalId?, flyUrl? }
 *   POST /admin/customers/:id/invite            { percentOff?, maxUses?, expiresDays? }
 *   POST /admin/customers/:id/provision         { providerEnv?, region?, plan?, image? }
 *   POST /admin/customers/:id/checkout          — Stripe checkout session URL
 *   POST /admin/customers/:id/magic-link
 *   POST /admin/customers/:id/topup             { credits?, topupId?, kind?, note? }
 *   GET  /admin/customers/:id/credits           — balance + ledger
 *   POST /admin/customers/:id/slack-install-link — signed "Add to Slack" URL
 *   POST /admin/customers/:id/slack-toggle      { enabled } — routing flag
 *   POST /admin/instances/:id/suspend
 *   POST /admin/instances/:id/resume
 *   POST /admin/instances/:id/destroy
 *   POST /admin/instances/:id/update       { image }
 *   POST /admin/fleet/update               { image, batchSize? }
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  isSlackOAuthConfigured,
  slackSigningSecret,
} from "./channels/slack/config.js";
import {
  handleSlackRequest,
  type SlackRouterDeps,
} from "./channels/slack/router.js";
import { mintInstallState } from "./channels/slack/verify.js";
import {
  adjustCredits,
  applyTopup,
  syncKeyLimitsToBalance,
} from "./credits.js";
import type {
  CreditEntry,
  Customer,
  CustomerPlan,
  HqDb,
  Instance,
} from "./db.js";
import { InvalidTransitionError } from "./db.js";
import {
  emailReadiness,
  inviteEmail,
  logEmailReadinessAtBoot,
  sendEmail,
  signinEmail,
} from "./email.js";
import { startDbBackupScheduler } from "./db-backup.js";
import { isOpenRouterConfigured } from "./openrouter.js";
import { trackEvent } from "./klaviyo.js";
import {
  PLANS,
  PLAN_IDS,
  TOPUPS,
  isPlanId,
  isTopupId,
  publicCatalog,
  resolvePlan,
  type TopupId,
} from "./plans.js";
import { startFleetSweepScheduler, updateFleet } from "./fleet.js";
import type { InstanceDriver } from "./providers/driver.js";
import { UpdateNotSupportedError } from "./providers/driver.js";
import {
  autoProvisionOnPayment,
  mintMagicLinkForCustomer,
  parseInstanceSecrets,
  provisionCustomer,
  publicSiteBase,
} from "./provisioning.js";
import {
  composioProjectsConfigured,
  deleteCustomerProject,
} from "./composio-projects.js";
import { referralSummary, validateReferralCode } from "./referrals.js";
import {
  getShareSkill,
  renderShareNotFoundPage,
  renderSkillSharePage,
} from "./share.js";
import {
  SIGNIN_TOKEN_TTL_MS,
  customerIdFromRequest,
  generateSigninToken,
  hashSigninToken,
  isSessionConfigured,
  mintSessionValue,
  originAllowed,
  sessionSetCookieHeader,
} from "./sessions.js";
import { canonicalHostRedirect, resolveSiteDir, serveSite } from "./site.js";
import {
  createBillingPortalSession,
  createCheckoutSession,
  createTopupCheckoutSession,
  ensureCatalog,
  handleStripeWebhook,
} from "./stripe.js";

export interface ServerDeps {
  db: HqDb;
  driver: InstanceDriver;
  adminToken?: string;
  /** Health-poll bounds for provisioning (tests use tiny values). */
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Slack channel (WS4) knobs: reply-poll bounds + the async-work scheduler
   * tests use to await event dispatches that are acked-then-processed.
   */
  slack?: Pick<
    SlackRouterDeps,
    "replyTimeoutMs" | "pollIntervalMs" | "schedule" | "nowMs"
  >;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// The mobile app's WebView runs at a native origin (capacitor://localhost on
// iOS, http(s)://localhost on Android) and fetches the app-facing sign-in
// endpoints cross-origin, so they need CORS. Scoped to the known app origins —
// not `*` — and only the sign-in surface; the rest of HQ stays same-origin.
const APP_ORIGINS = new Set([
  "capacitor://localhost",
  "ionic://localhost",
  "http://localhost",
  "https://localhost",
]);

/**
 * Customer instances are the OTHER app origin: `https://<name>.justcue.app`.
 * The instance SPA now carries the sign-in form itself rather than bouncing
 * the user to justcue.ai, so its POST to `/signin` is cross-origin and needs
 * the same allowance the mobile shell already has.
 *
 * Still not `*`: only https, only a single label under the instance domain,
 * and still only on the sign-in surface. The domain is read from
 * `HQ_INSTANCE_DOMAIN` (already the source of truth for the canonical-host
 * exemption) so a deployment that does not set it allows nothing extra.
 */
function isInstanceOrigin(origin: string): boolean {
  const domain = (process.env.HQ_INSTANCE_DOMAIN ?? "").trim().toLowerCase();
  if (!domain) return false;
  let host: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host.endsWith(`.${domain}`)) return false;
  const label = host.slice(0, -(domain.length + 1));
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);
}

function appCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!APP_ORIGINS.has(origin) && !isInstanceOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

/** Add app-origin CORS headers to a response when the caller is the app. */
function withAppCors(req: Request, res: Response): Response {
  const cors = appCorsHeaders(req);
  if (Object.keys(cors).length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function isAdminAuthorized(req: Request, adminToken: string): boolean {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    if (header.slice(7).trim() === adminToken) return true;
  }
  // Browser convenience for the dashboard page + its buttons.
  const url = new URL(req.url);
  return url.searchParams.get("token") === adminToken;
}

/** Never send secretsJson (signing key + bootstrap secret) over the wire. */
function redact(instance: Instance): Omit<Instance, "secretsJson"> {
  const { secretsJson: _secretsJson, ...rest } = instance;
  return rest;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

/** Parse a plan from a request body (legacy aliases + tier ids). */
function parsePlan(raw: unknown, fallback: CustomerPlan): CustomerPlan {
  if (isPlanId(raw)) return raw;
  if (raw === "founding" || raw === "founding_byo") return raw;
  return fallback;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Pull addresses out of whatever the operator pasted into the invite box —
 * commas, newlines, spaces, semicolons, `Name <a@b.io>`, trailing full
 * stops. Order preserved, duplicates dropped.
 *
 * Only tokens containing "@" survive: the bare words in "Ana Ruiz
 * <ana@example.com>" are name debris, not typos, and reporting them back as
 * failures would bury the real ones. A token that HAS an "@" and is still
 * malformed does come back — as an invalid_email row the operator can see.
 */
export function parseEmailList(raw: unknown): string[] {
  const source = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string").join("\n")
    : typeof raw === "string"
      ? raw
      : "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of source.split(/[\s,;]+/)) {
    const email = token
      .trim()
      .toLowerCase()
      .replace(/^[<("']+/, "")
      .replace(/[>)"',.;:]+$/, "");
    if (!email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** "ana.ruiz@example.com" → "Ana Ruiz" — a placeholder name, not a claim. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ") || email;
}

/** Normalize a top-up pack from the website ({pack} body) to a TopupId. */
function parseTopupPack(raw: unknown): TopupId | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "topup_1000" || s === "1000" || s === "small") return "topup_1000";
  if (s === "topup_5000" || s === "5000" || s === "large") return "topup_5000";
  return null;
}

function firstNameOf(customer: Customer): string {
  return customer.name.trim().split(/\s+/)[0] || customer.name;
}

/** One address's outcome from POST /admin/invites/send. */
export interface InviteSendResult {
  email: string;
  /** Everything asked for happened — including the email leaving the box. */
  ok: boolean;
  customerId?: string;
  /** True when this call created the customer row (vs. finding it). */
  customerCreated?: boolean;
  plan?: CustomerPlan;
  /** An existing customer was moved onto the selected plan. */
  planChanged?: boolean;
  code?: string;
  allowlisted?: boolean;
  /** Resend actually accepted it. False in log-only mode. */
  sent?: boolean;
  reason?: string;
}

/** How long after checkout we keep saying "provisioning" before "delayed". */
const WELCOME_DELAYED_AFTER_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Request handler (exported for tests)
// ---------------------------------------------------------------------------

export function createHandler(
  deps: ServerDeps,
): (req: Request) => Promise<Response> {
  const adminToken = deps.adminToken ?? process.env.HQ_ADMIN_TOKEN ?? "";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { db, driver } = deps;
  const siteDir = resolveSiteDir();

  const provisioningDeps = {
    db,
    driver,
    fetchImpl,
    healthTimeoutMs: deps.healthTimeoutMs,
    healthIntervalMs: deps.healthIntervalMs,
  };

  const slackDeps: SlackRouterDeps = {
    db,
    fetchImpl,
    ...(deps.slack ?? {}),
  };

  // Fire-and-forget auto-provision after a paid subscription checkout.
  // Kept on the handler so tests can await the tail via deps.fetchImpl mocks;
  // failures are recorded as auto_provision_failed events, never thrown.
  const scheduleAutoProvision = (customerId: string): void => {
    void autoProvisionOnPayment(provisioningDeps, customerId).catch((err) => {
      db.recordEvent("auto_provision_failed", customerId, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  // Light rate limit for the polled welcome-status route: one request per
  // session_id per second (the page polls every 5s).
  const welcomeLastSeen = new Map<string, number>();

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    try {
      // ── canonical host (HQ_CANONICAL_HOST; no-op when unset) ──────────
      // GET/HEAD on a non-canonical host (justcue.io, www, *.fly.dev) 301
      // to the canonical origin; POSTs (Stripe webhook!), /healthz probes,
      // and instance-domain hosts are exempt — see site.ts.
      const redirect = canonicalHostRedirect(req, url, path);
      if (redirect) return redirect;

      // CORS preflight for the app's cross-origin sign-in fetches.
      if (method === "OPTIONS") {
        const cors = appCorsHeaders(req);
        if (Object.keys(cors).length > 0) {
          return new Response(null, { status: 204, headers: cors });
        }
      }

      // ── public ────────────────────────────────────────────────────────
      if (method === "GET" && path === "/healthz") {
        return json({ ok: true, service: "cue-hq" });
      }

      // Apple universal links: the Cue app claims the sign-in link so tapping
      // `justcue.ai/auth?token=…` on a phone opens the app (which then resolves
      // the token via ?native=1) instead of Safari. One stable domain covers
      // every owner's instance — the instance identity rides inside the token,
      // not the link host, so associated-domains needs only this one entry.
      // App ID default is the shipping Cue iOS app; override via HQ_IOS_APP_ID.
      if (
        method === "GET" &&
        path === "/.well-known/apple-app-site-association"
      ) {
        const appId =
          process.env.HQ_IOS_APP_ID ?? "XU8BLQACGU.com.ventureverse.cue";
        return new Response(
          JSON.stringify({
            applinks: {
              details: [
                {
                  appIDs: [appId],
                  components: [
                    {
                      "/": "/auth*",
                      comment: "sign-in magic link opens the app",
                    },
                    { "/": "/m/*", comment: "short sign-in links" },
                  ],
                },
              ],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      if (method === "GET" && path === "/plans") {
        return json(publicCatalog());
      }

      if (method === "POST" && path === "/waitlist") {
        const body = await readJsonBody(req);
        const email = typeof body.email === "string" ? body.email.trim() : "";
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!email || !email.includes("@") || !name) {
          return json({ error: "email and name are required" }, 400);
        }
        const existing = db.getCustomerByEmail(email);
        if (existing) {
          return json({ ok: true, customerId: existing.id, existing: true });
        }
        const plan = parsePlan(body.plan, "founding");
        const customer = db.createCustomer({ email, name, plan });
        db.recordEvent("waitlist_joined", customer.id, { email });
        // Marketing sync — fire-and-forget, never blocks the response.
        void trackEvent(
          db,
          {
            metric: "Cue Waitlist Joined",
            email: customer.email,
            firstName: firstNameOf(customer),
            profileProps: { plan: customer.plan },
            props: { plan: customer.plan },
            uniqueId: `waitlist:${customer.id}`,
            customerId: customer.id,
          },
          fetchImpl,
        );
        return json({ ok: true, customerId: customer.id }, 201);
      }

      if (method === "POST" && path === "/redeem") {
        return handleRedeem(req);
      }

      if (method === "POST" && path === "/webhooks/stripe") {
        const rawBody = await req.text();
        const outcome = await handleStripeWebhook(
          { db, driver, fetchImpl, scheduleAutoProvision },
          rawBody,
          req.headers.get("stripe-signature"),
        );
        return json(outcome.body, outcome.status);
      }

      if (method === "GET" && path === "/welcome/status") {
        return handleWelcomeStatus(url);
      }

      if (method === "POST" && path === "/signin") {
        return withAppCors(req, await handleSignin(req));
      }

      if (method === "GET" && path === "/auth") {
        return withAppCors(req, await handleAuth(req, url));
      }

      if (method === "POST" && path === "/testflight") {
        return handleTestflight(req);
      }

      if (
        (method === "GET" || method === "HEAD") &&
        path === "/downloads/cue-macos.dmg"
      ) {
        return handleMacDownload(method);
      }

      // ── Slack channel (WS4) — install/OAuth/events/commands ───────────
      // Signature-verified inside; 503 in "not configured" mode; returns
      // null for /slack/* subpaths it doesn't own (falls through to 404).
      if (path.startsWith("/slack/")) {
        const handled = await handleSlackRequest(
          slackDeps,
          req,
          url,
          path,
          method,
        );
        if (handled) return handled;
      }

      // Shareable skill pages: /skills/{slug} only (single segment) — the
      // /skills index page itself stays a static site file, and deeper
      // paths fall through to static serving untouched.
      if (method === "GET" || method === "HEAD") {
        const shareMatch = path.match(/^\/skills\/([^/]+)$/);
        if (shareMatch) {
          return handleSkillSharePage(
            decodeURIComponent(shareMatch[1]),
            method,
          );
        }
      }

      // ── customer (session-cookie) routes ──────────────────────────────
      if (
        path === "/account/summary" ||
        path === "/account/topup" ||
        path === "/account/portal" ||
        path === "/account/open"
      ) {
        return handleAccount(req, path, method);
      }

      // ── admin ─────────────────────────────────────────────────────────
      if (path === "/admin" || path.startsWith("/admin/")) {
        if (!adminToken) {
          return json({ error: "HQ_ADMIN_TOKEN not configured" }, 503);
        }
        if (!isAdminAuthorized(req, adminToken)) {
          return json({ error: "unauthorized" }, 401);
        }

        if (method === "GET" && path === "/admin") {
          return new Response(renderAdminPage(db), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        if (method === "POST" && path === "/admin/catalog/ensure") {
          const result = await ensureCatalog(fetchImpl);
          if (!result.ok) {
            const status =
              result.reason === "stripe_not_configured" ? 503 : 502;
            return json({ error: result.reason }, status);
          }
          db.recordEvent("stripe_catalog_ensured", null, {
            entries: result.entries.length,
            created: result.entries.filter((e) => e.created).length,
          });
          return json({ ok: true, entries: result.entries });
        }

        if (method === "POST" && path === "/admin/register-instance") {
          return handleRegisterInstance(req);
        }

        if (method === "GET" && path === "/admin/status") {
          return handleAdminStatus(url);
        }

        // The invite panel: one call per pasted blob of addresses.
        if (method === "POST" && path === "/admin/invites/send") {
          return handleInviteSend(req);
        }

        // Alpha invite allowlist (P0-7): the emails /signin recognizes
        // before they have a customer row.
        if (path === "/admin/invites/emails") {
          if (method === "GET") {
            return json({ ok: true, emails: db.listInviteEmails() });
          }
          if (method === "POST") return handleInviteEmailsAdd(req);
          if (method === "DELETE") return handleInviteEmailsRemove(req);
          return json({ error: "not found" }, 404);
        }

        const customerAction = path.match(
          /^\/admin\/customers\/([^/]+)\/(invite|provision|checkout|magic-link|topup|credits|slack-install-link|slack-toggle)$/,
        );
        if (customerAction) {
          const [, customerId, action] = customerAction;
          const customer = db.getCustomer(customerId);
          if (!customer) return json({ error: "unknown customer" }, 404);

          if (method === "GET" && action === "credits") {
            return json({
              ok: true,
              balance: db.getCreditBalance(customer.id),
              ledger: db.listCreditEntries(customer.id),
            });
          }
          if (method !== "POST") return json({ error: "not found" }, 404);
          if (action === "invite") return handleInvite(customer, req);
          if (action === "provision") return handleProvision(customer, req);
          if (action === "checkout") return handleCheckout(customer);
          if (action === "topup") return handleTopup(customer, req);
          if (action === "magic-link") return handleMagicLink(customer);
          if (action === "slack-install-link") {
            return handleSlackInstallLink(customer);
          }
          if (action === "slack-toggle") {
            return handleSlackToggle(customer, req);
          }
          return json({ error: "not found" }, 404);
        }

        const instanceAction = path.match(
          /^\/admin\/instances\/([^/]+)\/(suspend|resume|destroy|update)$/,
        );
        if (method === "POST" && instanceAction) {
          const [, instanceId, action] = instanceAction;
          if (action === "update") return handleInstanceUpdate(instanceId, req);
          return handleInstanceAction(instanceId, action);
        }

        if (method === "POST" && path === "/admin/fleet/update") {
          return handleFleetUpdate(req);
        }

        return json({ error: "not found" }, 404);
      }

      // ── static marketing/commerce site (clean URLs) ───────────────────
      // API routes above always win; anything else on GET/HEAD is a page.
      const page = await serveSite(siteDir, req, path);
      if (page) return page;

      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return json({ error: err.message }, 409);
      }
      return json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  };

  // ── admin action implementations ──────────────────────────────────────

  async function handleInvite(
    customer: Customer,
    req: Request,
  ): Promise<Response> {
    const body = await readJsonBody(req);
    const expiresDays = Number(body.expiresDays ?? 14);
    const invite = db.createInvite({
      customerId: customer.id,
      percentOff: Number(body.percentOff ?? 0),
      maxUses: Number(body.maxUses ?? 1),
      expiresAt: expiresDays > 0 ? Date.now() + expiresDays * 86_400_000 : null,
    });
    if (customer.status === "waitlist") {
      db.transitionCustomer(customer.id, "invited");
    }
    void trackEvent(
      db,
      {
        metric: "Cue Invited",
        email: customer.email,
        firstName: firstNameOf(customer),
        profileProps: { plan: customer.plan },
        props: { code: invite.code, percentOff: invite.percentOff },
        uniqueId: `invite:${invite.code}`,
        customerId: customer.id,
      },
      fetchImpl,
    );
    return json({ ok: true, invite });
  }

  async function handleProvision(
    customer: Customer,
    req: Request,
  ): Promise<Response> {
    const body = await readJsonBody(req);
    const outcome = await provisionCustomer(provisioningDeps, customer, {
      providerEnv:
        body.providerEnv && typeof body.providerEnv === "object"
          ? (body.providerEnv as Record<string, string>)
          : {},
      region: typeof body.region === "string" ? body.region : undefined,
      plan: typeof body.plan === "string" ? body.plan : undefined,
      image: typeof body.image === "string" ? body.image : undefined,
    });
    if (!outcome.ok) {
      return json(
        {
          ok: false,
          error: outcome.error,
          ...(outcome.instance ? { instance: redact(outcome.instance) } : {}),
        },
        outcome.status,
      );
    }
    if (outcome.existing) {
      // Preserve the admin route's historical contract: provisioning an
      // already-provisioned customer is a 409, with the instance attached.
      return json(
        {
          error: "customer already has an instance",
          instance: redact(outcome.instance),
        },
        409,
      );
    }
    return json({ ok: true, instance: redact(outcome.instance) });
  }

  async function handleCheckout(customer: Customer): Promise<Response> {
    const result = await createCheckoutSession(
      { customerId: customer.id, email: customer.email, plan: customer.plan },
      fetchImpl,
    );
    if (!result.ok) {
      const status = result.reason === "stripe_not_configured" ? 503 : 502;
      return json({ error: result.reason }, status);
    }
    db.recordEvent("checkout_session_created", customer.id, {
      sessionId: result.sessionId,
    });
    return json({ ok: true, url: result.url });
  }

  /**
   * Public invite redemption: validate + consume the code, find/create the
   * customer, and hand back a checkout URL for the chosen plan (with the
   * invite's discount attached as a Stripe promotion code). In Stripe
   * "not configured" mode the customer is still created and the response
   * says why there's no URL — the flow is testable end-to-end without keys.
   */
  async function handleRedeem(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!code || !email || !email.includes("@") || !name) {
      return json({ error: "code, email and name are required" }, 400);
    }

    let invite;
    try {
      invite = db.redeemInvite(code);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const status =
        reason === "invite_unknown"
          ? 404
          : reason === "invite_expired" || reason === "invite_exhausted"
            ? 410
            : 500;
      return json({ error: reason }, status);
    }

    // Plan preference: explicit body.plan → the invited customer's plan →
    // chief_of_staff (what the founding aliases resolve to).
    const linked = invite.customerId ? db.getCustomer(invite.customerId) : null;
    const plan = parsePlan(body.plan, linked?.plan ?? "chief_of_staff");

    let customer = db.getCustomerByEmail(email);
    if (!customer) {
      customer = db.createCustomer({ email, name, plan, status: "invited" });
    } else {
      if (customer.status === "waitlist") {
        customer = db.transitionCustomer(customer.id, "invited");
      }
      if (customer.plan !== plan) {
        customer = db.setCustomerPlan(customer.id, plan);
      }
    }
    db.recordEvent("redeem_completed", customer.id, {
      code: invite.code,
      plan,
    });

    // Optional referral code (friend's REF-XXXXXXXX): validated here —
    // unknown/self-referral codes are dropped (never block checkout) — and
    // carried on the checkout as Stripe metadata; the webhook awards the
    // referrer on this customer's first paid invoice.
    let referralCode: string | undefined;
    if (typeof body.referralCode === "string" && body.referralCode.trim()) {
      const validation = validateReferralCode(
        db,
        body.referralCode,
        customer.id,
      );
      if (validation.ok) {
        referralCode = validation.code;
      } else {
        db.recordEvent("referral_code_rejected", customer.id, {
          code: body.referralCode.trim(),
          reason: validation.reason,
        });
      }
    }

    const checkout = await createCheckoutSession(
      {
        customerId: customer.id,
        email: customer.email,
        plan,
        inviteCode: invite.code,
        percentOff: invite.percentOff,
        referralCode,
      },
      fetchImpl,
    );
    if (!checkout.ok) {
      // The redemption itself succeeded — report the checkout gap honestly.
      return json({
        ok: true,
        customerId: customer.id,
        plan,
        checkoutUrl: null,
        reason: checkout.reason,
        referralApplied: !!referralCode,
      });
    }
    void trackEvent(
      db,
      {
        metric: "Cue Checkout Started",
        email: customer.email,
        firstName: firstNameOf(customer),
        profileProps: { plan },
        props: { plan, code: invite.code },
        uniqueId: `checkout-started:${checkout.sessionId}`,
        customerId: customer.id,
      },
      fetchImpl,
    );
    return json({
      ok: true,
      customerId: customer.id,
      plan,
      checkoutUrl: checkout.url,
      referralApplied: !!referralCode,
    });
  }

  /**
   * Manual credit mutation: a top-up ({credits} or {topupId}, idempotent
   * per optional {ref}) or a signed adjustment ({kind:"adjustment", delta}).
   */
  async function handleTopup(
    customer: Customer,
    req: Request,
  ): Promise<Response> {
    const body = await readJsonBody(req);

    if (body.kind === "adjustment") {
      const delta = Number(body.delta ?? body.credits);
      if (!Number.isInteger(delta) || delta === 0) {
        return json(
          { error: "adjustment needs a non-zero integer delta" },
          400,
        );
      }
      const entry = adjustCredits(db, {
        customerId: customer.id,
        delta,
        note:
          typeof body.note === "string" && body.note.trim()
            ? body.note.trim()
            : "manual adjustment",
      });
      await syncKeyLimitsToBalance(db, customer.id, fetchImpl);
      return json({ ok: true, entry, balance: entry.balanceAfter });
    }

    const credits = isTopupId(body.topupId)
      ? TOPUPS[body.topupId].credits
      : Number(body.credits);
    if (!Number.isInteger(credits) || credits <= 0) {
      return json(
        { error: "topup needs positive integer credits or a topupId" },
        400,
      );
    }
    const ref =
      typeof body.ref === "string" && body.ref.trim()
        ? body.ref.trim()
        : `manual-${randomUUID()}`;
    const result = applyTopup(db, { customerId: customer.id, credits, ref });
    if (result.applied) {
      await syncKeyLimitsToBalance(db, customer.id, fetchImpl);
      void trackEvent(
        db,
        {
          metric: "Cue Topped Up",
          email: customer.email,
          firstName: firstNameOf(customer),
          profileProps: { plan: customer.plan, credit_balance: result.balance },
          props: { credits },
          uniqueId: `topup:${ref}`,
          customerId: customer.id,
        },
        fetchImpl,
      );
    }
    return json({
      ok: true,
      applied: result.applied,
      balance: result.balance,
    });
  }

  async function handleMagicLink(customer: Customer): Promise<Response> {
    const outcome = await mintMagicLinkForCustomer({ db, fetchImpl }, customer);
    if (!outcome.ok) {
      const { status, ...body } = outcome;
      return json(body, status);
    }
    return json(outcome);
  }

  /**
   * POST /admin/register-instance — enroll an EXISTING instance (one HQ did not
   * provision itself — a manually-created Fly machine or a bare self-host) into
   * the registry so its owner can use the email magic-link sign-in
   * (POST /signin → GET /auth → mintMagicLinkForCustomer). HQ mints tokens the
   * instance accepts OFFLINE, so it needs the instance's own
   * ACTOR_TOKEN_SIGNING_KEY (64-hex) plus a known guardianPrincipalId (so it
   * never has to hit the instance's one-time /v1/guardian/init, which is
   * already consumed on a live instance). Body:
   *   { email, url, signingKey, guardianPrincipalId,
   *     name?, driver?="fly", externalId?, flyUrl?, guardianBootstrapSecret? }
   * Idempotent on the customer (reused by email); refuses to attach a second
   * live/suspended instance to a customer that already has one.
   */
  async function handleRegisterInstance(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const email = str(body.email).toLowerCase();
    const url = str(body.url).replace(/\/$/, "");
    const signingKey = str(body.signingKey);
    const guardianPrincipalId = str(body.guardianPrincipalId);
    const name = str(body.name) || email.split("@")[0];
    const driver = str(body.driver) || "fly";
    const externalId = str(body.externalId) || url;
    const flyUrl = str(body.flyUrl) || null;

    if (!email.includes("@")) return json({ error: "email is required" }, 400);
    if (!/^https?:\/\//.test(url)) {
      return json({ error: "url must be an absolute http(s) URL" }, 400);
    }
    if (!/^[0-9a-f]{64}$/i.test(signingKey)) {
      return json(
        {
          error:
            "signingKey must be 64 hex chars (the instance's ACTOR_TOKEN_SIGNING_KEY)",
        },
        400,
      );
    }
    if (!guardianPrincipalId) {
      return json({ error: "guardianPrincipalId is required" }, 400);
    }

    const customer =
      db.getCustomerByEmail(email) ??
      db.createCustomer({ email, name, status: "active" });

    const existing = db
      .listInstancesByCustomer(customer.id)
      .find((i) => i.state === "live" || i.state === "suspended");
    if (existing) {
      return json(
        {
          error: "customer already has a live/suspended instance",
          customerId: customer.id,
          instanceId: existing.id,
        },
        409,
      );
    }

    const secretsJson = JSON.stringify({
      actorTokenSigningKey: signingKey,
      guardianPrincipalId,
      // Present but unused: the instance's guardian is already bootstrapped, so
      // mintMagicLinkForCustomer skips guardian/init because the principal id
      // above is already known.
      guardianBootstrapSecret: str(body.guardianBootstrapSecret),
    });
    const instance = db.createInstance({
      customerId: customer.id,
      driver,
      externalId,
      url,
      flyUrl,
      secretsJson,
      state: "live",
    });
    db.recordEvent("instance_registered", customer.id, {
      instanceId: instance.id,
      url: instance.url,
    });
    return json({
      ok: true,
      customerId: customer.id,
      instanceId: instance.id,
      url: instance.url,
      state: instance.state,
    });
  }

  /**
   * POST /admin/invites/emails { emails: string[] } (or { email }, note?) —
   * add signin-allowlist entries. Idempotent per email.
   */
  /**
   * POST /admin/invites/send
   *   { emails, plan?, percentOff?, maxUses?, expiresDays?, note?, name? }
   *
   * The whole invite, per address, in one call: find-or-create the customer
   * on the chosen plan, put them on the sign-in allowlist, mint a code, and
   * actually email it. Before this, each of those four was a separate button
   * (or, for the allowlist, no button at all) and the email was nobody's job
   * — /admin/customers/:id/invite minted a code and returned it as JSON for
   * the operator to copy out by hand.
   *
   * Never all-or-nothing: every address gets its own result row, because a
   * batch of ten where the eighth bounces must not look like ten failures or,
   * worse, ten successes. `ok` means everything asked for happened; a code
   * that was minted but not delivered still comes back so it can be passed on
   * by hand.
   *
   * Existing customers are found, not overwritten: their name is left alone.
   * The plan IS applied (it is the operator's explicit choice in the panel)
   * and any change is reported in the row.
   */
  async function handleInviteSend(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    const emails = parseEmailList(body.emails ?? body.email);
    if (emails.length === 0) {
      return json({ error: "no email addresses found" }, 400);
    }
    const plan = parsePlan(body.plan, "chief_of_staff");
    const planName = resolvePlan(plan).name;
    const percentOff = Math.min(
      100,
      Math.max(0, Math.round(Number(body.percentOff ?? 0)) || 0),
    );
    const maxUses = Math.max(1, Math.round(Number(body.maxUses ?? 1)) || 1);
    const expiresDays = Number(body.expiresDays ?? 14);
    const expiresAt =
      Number.isFinite(expiresDays) && expiresDays > 0
        ? Date.now() + expiresDays * 86_400_000
        : null;
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const givenName =
      typeof body.name === "string" && emails.length === 1
        ? body.name.trim()
        : "";
    const redeemUrl = `${publicSiteBase()}/redeem`;

    const results: InviteSendResult[] = [];
    for (const email of emails) {
      if (!EMAIL_SHAPE.test(email)) {
        results.push({ email, ok: false, reason: "invalid_email" });
        continue;
      }
      try {
        results.push(
          await inviteOne(email, {
            plan,
            planName,
            percentOff,
            maxUses,
            expiresAt,
            note,
            givenName,
            redeemUrl,
          }),
        );
      } catch (err) {
        results.push({
          email,
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    db.recordEvent("admin_invites_sent", null, {
      requested: results.length,
      ok: results.filter((r) => r.ok).length,
      plan,
    });
    return json({ ok: results.every((r) => r.ok), results });
  }

  async function inviteOne(
    email: string,
    opts: {
      plan: CustomerPlan;
      planName: string;
      percentOff: number;
      maxUses: number;
      expiresAt: number | null;
      note: string;
      givenName: string;
      redeemUrl: string;
    },
  ): Promise<InviteSendResult> {
    let customer = db.getCustomerByEmail(email);
    const created = !customer;
    const previousPlan = customer?.plan ?? null;
    if (!customer) {
      customer = db.createCustomer({
        email,
        name: opts.givenName || nameFromEmail(email),
        plan: opts.plan,
        status: "invited",
      });
    } else {
      if (customer.status === "waitlist" || customer.status === "churned") {
        customer = db.transitionCustomer(customer.id, "invited");
      }
      if (customer.plan !== opts.plan) {
        customer = db.setCustomerPlan(customer.id, opts.plan);
      }
    }
    const planChanged = previousPlan !== null && previousPlan !== customer.plan;

    db.addInviteEmail(email, opts.note || `invited ${opts.planName}`);

    const invite = db.createInvite({
      customerId: customer.id,
      percentOff: opts.percentOff,
      maxUses: opts.maxUses,
      expiresAt: opts.expiresAt,
    });

    const send = await sendEmail(
      email,
      inviteEmail({
        code: invite.code,
        redeemUrl: opts.redeemUrl,
        planName: opts.planName,
        expiresAt: opts.expiresAt,
      }),
      fetchImpl,
    );
    // P0-1 honesty: only a Resend-accepted send is recorded as sent.
    db.recordEvent(
      !send.ok
        ? "invite_email_failed"
        : send.sent
          ? "invite_email_sent"
          : "invite_email_skipped_no_key",
      customer.id,
      send.ok
        ? { code: invite.code, sent: send.sent }
        : { code: invite.code, reason: send.reason },
    );
    void trackEvent(
      db,
      {
        metric: "Cue Invited",
        email: customer.email,
        firstName: firstNameOf(customer),
        profileProps: { plan: customer.plan },
        props: { code: invite.code, percentOff: invite.percentOff },
        uniqueId: `invite:${invite.code}`,
        customerId: customer.id,
      },
      fetchImpl,
    );

    return {
      email,
      // A minted-but-undelivered code is not a completed invite.
      ok: send.ok,
      customerId: customer.id,
      customerCreated: created,
      plan: customer.plan,
      ...(planChanged ? { planChanged: true } : {}),
      code: invite.code,
      allowlisted: true,
      sent: send.ok ? send.sent : false,
      ...(send.ok
        ? send.sent
          ? {}
          : { reason: send.reason }
        : { reason: send.reason }),
    };
  }

  async function handleInviteEmailsAdd(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const raw = Array.isArray(body.emails)
      ? body.emails
      : typeof body.email === "string"
        ? [body.email]
        : [];
    const emails = raw
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@"));
    if (emails.length === 0) {
      return json({ error: "emails (array) or email is required" }, 400);
    }
    const added = emails.map((e) => db.addInviteEmail(e, note));
    return json({ ok: true, added });
  }

  /** DELETE /admin/invites/emails { email } — remove an allowlist entry. */
  async function handleInviteEmailsRemove(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email.includes("@")) return json({ error: "email is required" }, 400);
    return json({ ok: true, removed: db.removeInviteEmail(email) });
  }

  /**
   * GET /admin/status[?probe=0] — operator readiness report (P0-1/P0-6).
   * Reports what IS, never what should be: email mode + a live Resend
   * domain-status probe (skip with probe=0), LLM key mode, connector-seed
   * readiness, instance sizing defaults, allowlist size, the image new
   * instances are provisioned with (+ any fleet drift from it), and the
   * latest fleet-sweep / hq.db-backup audit events.
   */
  async function handleAdminStatus(url: URL): Promise<Response> {
    const probe = url.searchParams.get("probe") !== "0";
    const email = await emailReadiness({ probe, fetchImpl });
    const lastSweep = db.findLatestEventByKindData("fleet_sweep_completed", "");
    const lastBackupOk = db.findLatestEventByKindData(
      "db_backup_completed",
      "",
    );
    const lastBackupFail = db.findLatestEventByKindData("db_backup_failed", "");
    const sharedKeyPresent = !!process.env.OPENROUTER_SHARED_KEY;
    const lastSweepData = lastSweep
      ? (JSON.parse(lastSweep.dataJson) as {
          imageDrift?: { instanceId: string; running: string; expected: string }[];
        })
      : null;
    return json({
      ok: true,
      service: "cue-hq",
      now: Date.now(),
      driver: {
        id: driver.id,
        configured: (driver as { configured?: boolean }).configured ?? true,
      },
      email,
      llm: {
        provisioningKeyConfigured: isOpenRouterConfigured(),
        sharedKeyPresent,
        mode: isOpenRouterConfigured()
          ? "per_customer_capped"
          : sharedKeyPresent
            ? "shared_uncapped"
            : "none",
      },
      connectors: {
        composioKeyConfigured:
          composioProjectsConfigured() ||
          !!process.env.HQ_COMPOSIO_API_KEY?.trim(),
        // "per_customer_project" = each instance gets its own Composio
        // project key. "shared_org_key" = the legacy fleet-wide credential
        // that can list/proxy every tenant's connected accounts.
        composioIsolation: composioProjectsConfigured()
          ? "per_customer_project"
          : process.env.HQ_COMPOSIO_API_KEY?.trim()
            ? "shared_org_key"
            : "none",
      },
      instanceDefaults: {
        memoryMb: Number(process.env.HQ_FLY_VM_MEMORY_MB ?? 2048),
        instanceDomain: process.env.HQ_INSTANCE_DOMAIN?.trim() || null,
      },
      // The image EVERY new customer instance is provisioned with, plus
      // whether the live fleet actually agrees with it. `drifted` comes from
      // the last fleet sweep (measuring it needs a provider call per
      // instance, so this endpoint reports rather than re-probes); null means
      // no sweep has run yet — unknown, not "no drift".
      image: {
        configured: process.env.CUE_IMAGE_REF?.trim() || null,
        drifted: lastSweepData?.imageDrift ?? null,
        checkedAt: lastSweep?.ts ?? null,
      },
      invites: { allowlisted: db.listInviteEmails().length },
      fleetSweep: {
        disabled: ["1", "true"].includes(
          process.env.HQ_FLEET_SWEEP_DISABLED?.trim().toLowerCase() ?? "",
        ),
        opsAlertEmailConfigured: !!process.env.HQ_OPS_ALERT_EMAIL?.trim(),
        lastCompletedAt: lastSweep?.ts ?? null,
        lastResult: lastSweepData,
      },
      backups: {
        disabled: ["1", "true"].includes(
          process.env.HQ_DB_BACKUP_DISABLED?.trim().toLowerCase() ?? "",
        ),
        lastCompletedAt: lastBackupOk?.ts ?? null,
        lastFailedAt: lastBackupFail?.ts ?? null,
      },
    });
  }

  /**
   * Mint the customer's "Add to Slack" link: /slack/install with an
   * HMAC-signed state that the OAuth callback resolves back to this
   * customer. 503 while the Slack app credentials aren't configured.
   */
  function handleSlackInstallLink(customer: Customer): Response {
    if (!isSlackOAuthConfigured()) {
      return json({ error: "slack not configured" }, 503);
    }
    const state = mintInstallState(customer.id, slackSigningSecret());
    return json({
      ok: true,
      url: `${publicSiteBase()}/slack/install?state=${encodeURIComponent(state)}`,
    });
  }

  /** Flip the per-customer Slack routing flag ({enabled: boolean}). */
  async function handleSlackToggle(
    customer: Customer,
    req: Request,
  ): Promise<Response> {
    const body = await readJsonBody(req);
    if (typeof body.enabled !== "boolean") {
      return json({ error: "enabled must be a boolean" }, 400);
    }
    const updated = db.setCustomerSlackEnabled(customer.id, body.enabled);
    return json({ ok: true, slackEnabled: updated.slackEnabled === 1 });
  }

  // ── website flow implementations ──────────────────────────────────────

  /**
   * GET /welcome/status?session_id= — the /welcome page polls this every
   * 5s after Stripe redirects back. States:
   *   unknown      — session id we've never seen
   *   provisioning — paid, instance still coming up (< 10 min)
   *   ready        — instance live; magicLink minted fresh per response
   *   delayed      — provisioning failed or exceeded 10 min
   */
  async function handleWelcomeStatus(url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("session_id")?.trim() ?? "";
    if (!sessionId) return json({ state: "unknown" }, 400);

    const now = Date.now();
    const last = welcomeLastSeen.get(sessionId) ?? 0;
    if (now - last < 1_000) {
      return json({ error: "rate_limited" }, 429);
    }
    welcomeLastSeen.set(sessionId, now);
    if (welcomeLastSeen.size > 10_000) welcomeLastSeen.clear(); // bounded

    const customer = db.getCustomerByCheckoutSession(sessionId);
    if (!customer) return json({ state: "unknown" });

    const identity = {
      firstName: firstNameOf(customer),
      email: customer.email,
    };
    const instances = db
      .listInstancesByCustomer(customer.id)
      .filter((i) => i.state !== "deleted");
    const live = instances.find(
      (i) => i.state === "live" || i.state === "suspended",
    );
    if (live) {
      const magic = await mintMagicLinkForCustomer({ db, fetchImpl }, customer);
      if (magic.ok) {
        return json({ state: "ready", magicLink: magic.url, ...identity });
      }
      // Live but unlinkable (guardian init failing) — treat as delayed;
      // support gets them their link.
      return json({ state: "delayed", ...identity });
    }

    const failed = db.findLatestEvent("auto_provision_failed", customer.id);
    const startedAt = customer.checkoutSessionAt ?? customer.createdAt;
    if (failed || now - startedAt > WELCOME_DELAYED_AFTER_MS) {
      return json({ state: "delayed", ...identity });
    }
    return json({ state: "provisioning", ...identity });
  }

  /**
   * POST /signin { email } — the private-alpha invite gate (P0-7).
   *
   * Known customers get a one-time link by email (status:"sent"). Emails on
   * the invite allowlist (invite_emails table or HQ_ALPHA_ALLOWLIST CSV)
   * without a customer row yet get status:"invited_no_account". Everyone
   * else gets an HONEST status:"invite_required" — the old behavior
   * (unconditional {ok:true}) showed strangers "check your email" while
   * nothing was ever going to arrive.
   *
   * DELIBERATE trade-off: this leaks whether an email is recognized. For a
   * private alpha, honest UX beats enumeration resistance; revisit at GA.
   *
   * Email audit honesty (P0-1): `signin_email_sent` is recorded ONLY when
   * Resend actually accepted the send; log-only mode (RESEND_API_KEY unset)
   * records `signin_email_skipped_no_key`.
   */
  async function handleSignin(req: Request): Promise<Response> {
    if (!isSessionConfigured()) {
      return json({ error: "signin not configured (HQ_SESSION_SECRET)" }, 503);
    }
    const body = await readJsonBody(req);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email || !email.includes("@")) {
      return json({ error: "email is required" }, 400);
    }
    const customer = db.getCustomerByEmail(email);
    if (customer) {
      const raw = generateSigninToken();
      db.createSigninToken({
        customerId: customer.id,
        tokenHash: hashSigninToken(raw),
        ttlMs: SIGNIN_TOKEN_TTL_MS,
      });
      db.purgeExpiredSigninTokens();
      const link = `${publicSiteBase()}/auth?token=${raw}`;
      const result = await sendEmail(
        customer.email,
        signinEmail({ signinLink: link }),
        fetchImpl,
      );
      db.recordEvent(
        !result.ok
          ? "signin_email_failed"
          : result.sent
            ? "signin_email_sent"
            : "signin_email_skipped_no_key",
        customer.id,
        result.ok ? { sent: result.sent } : { reason: result.reason },
      );
      // Report what actually happened. This used to return
      // `{ok:true,status:"sent"}` unconditionally — the failure was recorded in
      // the audit trail and then contradicted in the response, so a Resend
      // outage read as "Check your inbox" to every user at once and the only
      // evidence was in a table nobody watches during a launch.
      if (!result.ok) {
        return json(
          {
            ok: false,
            status: "send_failed",
            error: "Could not send the email",
          },
          502,
        );
      }
      if (!result.sent) {
        // Log-only mode (no RESEND_API_KEY). Nothing reached the user, so
        // saying "check your inbox" would be the same lie in a different hat.
        return json({ ok: true, status: "email_not_configured" });
      }
      return json({ ok: true, status: "sent" });
    }
    if (isEmailAllowlisted(email)) {
      db.recordEvent("signin_invited_no_account", null, { email });
      return json({
        ok: true,
        status: "invited_no_account",
        message:
          "You're on the alpha list, but your Cue isn't set up yet — use the invite link from your welcome email, or contact hello@justcue.ai.",
      });
    }
    db.recordEvent("signin_unknown_email", null, { email });
    return json({
      ok: true,
      status: "invite_required",
      message:
        "Cue is in private alpha — request an invite at hello@justcue.ai.",
    });
  }

  /** Allowlist check: invite_emails table OR the HQ_ALPHA_ALLOWLIST env CSV. */
  function isEmailAllowlisted(email: string): boolean {
    if (db.isEmailInvited(email)) return true;
    const csv = process.env.HQ_ALPHA_ALLOWLIST ?? "";
    if (!csv.trim()) return false;
    const normalized = email.trim().toLowerCase();
    return csv
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
      .includes(normalized);
  }

  /**
   * GET /auth?token= — consume the emailed one-time token, set the signed
   * session cookie, and land the user IN their Cue: a freshly minted
   * instance magic link when they have a live instance, /account otherwise.
   * Bad/expired tokens bounce to /signin.
   */
  /**
   * The iOS app's custom URL scheme (`BUNDLE_URL_SCHEME` in
   * `apps/ios/App/App/Config/App.xcconfig`). Overridable for the dev/staging
   * targets, which register their own suffixed scheme.
   */
  function iosAppScheme(): string {
    return process.env.HQ_IOS_APP_SCHEME ?? "vellum-assistant";
  }

  /** Minimal attribute escape — the values here are URLs we built ourselves. */
  function escapeHtmlAttr(v: string): string {
    return v
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  /** iPhone/iPad — the only platform that gets the custom-scheme hand-off. */
  function isIosUserAgent(req: Request): boolean {
    return /iPhone|iPad|iPod/i.test(req.headers.get("user-agent") ?? "");
  }

  /**
   * The sign-in hand-off page. Fires the app scheme immediately (works when
   * the page is the top-level document) and keeps a real button for the
   * in-app browsers that only follow a scheme on a user gesture. The token is
   * still unspent when this renders — the app resolves it via
   * `/auth?native=1&token=…`, which is what consumes it.
   */
  function iosHandoffPage(rawToken: string): string {
    const deepLink = `${iosAppScheme()}://auth?token=${encodeURIComponent(rawToken)}`;
    const webLink = `/auth?browser=1&token=${encodeURIComponent(rawToken)}`;
    const j = (v: string) => JSON.stringify(v);
    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening Cue…</title></head>
<body style="margin:0;background:#E7EAEF;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px">
<div style="max-width:360px;width:100%;background:#fff;border:1px solid #E1E5EC;border-radius:14px;padding:32px 28px;text-align:center">
  <div style="font-size:20px;font-weight:600;letter-spacing:-.4px;color:#101828">Opening Cue…</div>
  <p style="font-size:15px;line-height:1.6;color:#43505F;margin:12px 0 0">If the app doesn't come forward, tap below.</p>
  <a id="app" href="${escapeHtmlAttr(deepLink)}" style="display:block;text-align:center;background:#3D6EE8;color:#fff;border-radius:11px;padding:14px;font-size:15px;font-weight:600;text-decoration:none;margin-top:22px">Open in Cue</a>
  <a href="${escapeHtmlAttr(webLink)}" style="display:inline-block;font-size:13px;color:#8D99A5;margin-top:16px;text-decoration:none">Continue in the browser</a>
</div>
<script>window.location.replace(${j(deepLink)});</script>
</body></html>`;
  }

  async function handleAuth(req: Request, url: URL): Promise<Response> {
    if (!isSessionConfigured()) {
      return json({ error: "signin not configured (HQ_SESSION_SECRET)" }, 503);
    }
    // Native mode: the mobile app opens the universal link (applinks:justcue.ai)
    // and resolves the token to JSON instead of following the browser 302. It
    // then navigates its WebView onto the instance and seeds the session — so
    // it needs the instance URL + token as data, and NO site session cookie
    // (the site session is a browser concern). Errors answer JSON too so the
    // app can show a real message instead of loading a redirect it can't read.
    const native =
      url.searchParams.get("native") === "1" ||
      (req.headers.get("accept") ?? "").includes("application/json");
    const raw = url.searchParams.get("token")?.trim() ?? "";
    const redirectTo = (target: string, extra?: Record<string, string>) =>
      new Response(null, {
        status: 302,
        headers: { Location: target, ...(extra ?? {}) },
      });
    const fail = (error: string) =>
      native
        ? json({ ok: false, error }, 400)
        : redirectTo(`/signin?error=${error}`);
    if (!raw)
      return native
        ? json({ ok: false, error: "missing_token" }, 400)
        : redirectTo("/signin");
    // iOS hand-off (P0 2026-08-23): the universal link only opens the app when
    // the tap happens somewhere iOS resolves applinks — Apple Mail does, but
    // Gmail/Outlook/Slack open their own in-app browser (SFSafariViewController),
    // which never consults the AASA, and once a user has picked "open in
    // browser" for justcue.ai iOS remembers it forever. Both cases dead-ended
    // in Safari with no way back to the app. So on iPhone/iPad we serve an
    // interstitial that hands the token to the app over its custom URL scheme
    // (`vellum-assistant://auth?token=…`, which the shell's appUrlOpen handler
    // already accepts) before the token is spent. Custom schemes work from
    // in-app browsers where universal links do not. `?browser=1` is the escape
    // hatch back to the plain web session, and non-iOS is untouched.
    if (!native && isIosUserAgent(req) && url.searchParams.get("browser") !== "1") {
      return new Response(iosHandoffPage(raw), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    const consumed = db.consumeSigninToken(hashSigninToken(raw));
    if (!consumed) return fail("link_expired");
    const customer = db.getCustomer(consumed.customerId);
    if (!customer) return fail("link_expired");
    // Record the UA on the browser path too. When the iOS hand-off does not
    // fire, the only question worth answering is "what did the tap actually
    // look like to us" — a client whose UA has no iPhone in it (a link
    // scanner, a desktop, a rewriting mail app) is invisible otherwise, and
    // the 2026-08-23 report cost a round trip for exactly that reason.
    db.recordEvent("site_session_created", customer.id, {
      native,
      ...(native ? {} : { ua: (req.headers.get("user-agent") ?? "").slice(0, 180) }),
    });
    const magic = await mintMagicLinkForCustomer({ db, fetchImpl }, customer);
    if (native) {
      if (!magic.ok) return json({ ok: false, error: "no_instance" }, 409);
      return json({
        ok: true,
        instanceUrl: magic.instanceUrl,
        cueToken: magic.cueToken,
        name: firstNameOf(customer),
        expiresInDays: magic.expiresInDays,
      });
    }
    return redirectTo(magic.ok ? magic.url : "/account", {
      "Set-Cookie": sessionSetCookieHeader(mintSessionValue(customer.id), {
        secure: publicSiteBase().startsWith("https://"),
      }),
    });
  }

  /**
   * POST /testflight { email } — record iOS TestFlight interest. Idempotent
   * per email (repeat submissions answer ok without a second event); works
   * for signed-in customers and strangers alike.
   */
  async function handleTestflight(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || !email.includes("@")) {
      return json({ error: "email is required" }, 400);
    }
    const fragment = `"email":${JSON.stringify(email)}`;
    if (db.findLatestEventByKindData("testflight_interest", fragment)) {
      return json({ ok: true, existing: true });
    }
    const customer = db.getCustomerByEmail(email);
    db.recordEvent("testflight_interest", customer?.id ?? null, { email });
    void trackEvent(
      db,
      {
        metric: "Cue TestFlight Interest",
        email,
        ...(customer ? { firstName: firstNameOf(customer) } : {}),
        uniqueId: `testflight:${email}`,
        customerId: customer?.id ?? null,
      },
      fetchImpl,
    );
    return json({ ok: true });
  }

  /**
   * GET /downloads/cue-macos.dmg — redirects to the current release on GitHub.
   *
   * This used to serve a DMG copied onto the volume out-of-band, which drifted:
   * the volume still held 0.0.1 long after newer builds shipped, so everyone
   * downloading from the site got a stale app. GitHub Releases is where the
   * app's own auto-updater reads from, so pointing the download at the same
   * place leaves exactly one artifact per version and nothing to keep in sync.
   *
   * `MAC_RELEASE` is the only thing to bump when cutting a desktop release;
   * the public /downloads/cue-macos.dmg URL never changes.
   *
   * HQ_MAC_DOWNLOAD_URL overrides the target entirely if distribution ever
   * moves off GitHub.
   */
  function handleMacDownload(_method: string): Response {
    const MAC_RELEASE = "v1.0.0";
    const target =
      process.env.HQ_MAC_DOWNLOAD_URL ??
      `https://github.com/manav1125/cue-releases/releases/download/${MAC_RELEASE}/Cue-${MAC_RELEASE.slice(
        1,
      )}-arm64.dmg`;
    return new Response(null, {
      status: 302,
      headers: { Location: target, "Cache-Control": "no-cache" },
    });
  }

  /**
   * GET /skills/{slug} — public shareable skill page. Pure static render
   * (share.ts reads the catalog file + seed-source constants only): no db
   * access, no cookies, no customer or instance data on this path.
   */
  function handleSkillSharePage(slug: string, method: string): Response {
    const skill = getShareSkill(slug);
    if (!skill) {
      return new Response(
        method === "HEAD" ? null : renderShareNotFoundPage(),
        {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }
    const html = renderSkillSharePage(skill, publicSiteBase());
    return new Response(method === "HEAD" ? null : html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  /** Cookie-authed /account/* routes. */
  async function handleAccount(
    req: Request,
    path: string,
    method: string,
  ): Promise<Response> {
    const customerId = customerIdFromRequest(req);
    const customer = customerId ? db.getCustomer(customerId) : null;

    if (path === "/account/open" && method === "GET") {
      // Link-driven: the account header's "Open Cue" button. Mint a fresh
      // instance magic link; quiet fallback when there's nothing to open.
      if (!customer) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/signin" },
        });
      }
      const magic = await mintMagicLinkForCustomer({ db, fetchImpl }, customer);
      return new Response(null, {
        status: 302,
        headers: {
          Location: magic.ok ? magic.url : "/account?error=no_instance",
        },
      });
    }

    if (path === "/account/portal" && method === "GET") {
      // Link-driven route: redirect rather than JSON on every outcome.
      if (!customer) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/signin" },
        });
      }
      const sub = db.getSubscription(customer.id);
      if (!sub?.stripeCustomerId) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/account?portal=unavailable" },
        });
      }
      const portal = await createBillingPortalSession(
        {
          stripeCustomerId: sub.stripeCustomerId,
          returnUrl: `${publicSiteBase()}/account`,
        },
        fetchImpl,
      );
      return new Response(null, {
        status: 302,
        headers: {
          Location: portal.ok ? portal.url : "/account?portal=unavailable",
        },
      });
    }

    if (!customer) return json({ error: "unauthorized" }, 401);

    if (path === "/account/summary" && method === "GET") {
      return json(buildAccountSummary(customer));
    }

    if (path === "/account/topup" && method === "POST") {
      if (!originAllowed(req)) return json({ error: "bad origin" }, 403);
      const body = await readJsonBody(req);
      const topupId = parseTopupPack(body.pack ?? body.topupId);
      if (!topupId) {
        return json({ error: "pack must be topup_1000 or topup_5000" }, 400);
      }
      const checkout = await createTopupCheckoutSession(
        {
          customerId: customer.id,
          email: customer.email,
          topupId,
          successPath: "/account?topup=success",
          cancelPath: "/account",
        },
        fetchImpl,
      );
      if (!checkout.ok) {
        // Mirror /redeem's honest degradation when Stripe isn't configured.
        return json({ ok: true, checkoutUrl: null, reason: checkout.reason });
      }
      db.recordEvent("topup_checkout_created", customer.id, {
        topupId,
        sessionId: checkout.sessionId,
      });
      return json({ ok: true, checkoutUrl: checkout.url });
    }

    return json({ error: "not found" }, 404);
  }

  /** Shape served to the /account page (commerce.js renders this). */
  function buildAccountSummary(customer: Customer): Record<string, unknown> {
    const spec = resolvePlan(customer.plan);
    const sub = db.getSubscription(customer.id);
    const balance = db.getCreditBalance(customer.id);
    const ledger = db.listCreditEntries(customer.id, 1000);

    // Cycle window: since the latest monthly grant (or customer creation).
    const latestGrant = ledger.find((e: CreditEntry) => e.kind === "grant");
    const cycleStart = latestGrant?.ts ?? customer.createdAt;
    const grantedThisCycle = latestGrant?.delta ?? 0;
    const usedThisCycle = ledger
      .filter((e) => e.kind === "usage_sync" && e.ts >= cycleStart)
      .reduce((sum, e) => sum + Math.max(0, -e.delta), 0);

    // Daily usage totals, last 30 days (usage_sync only). Top activities
    // are not derivable from the ledger (cursor-style notes) — omitted;
    // commerce.js handles the absence.
    const dayMs = 86_400_000;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const days: { date: string; credits: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const start = today.getTime() - i * dayMs;
      const credits = ledger
        .filter(
          (e) =>
            e.kind === "usage_sync" && e.ts >= start && e.ts < start + dayMs,
        )
        .reduce((sum, e) => sum + Math.max(0, -e.delta), 0);
      days.push({ date: new Date(start).toISOString().slice(0, 10), credits });
    }

    const instance = db
      .listInstancesByCustomer(customer.id)
      .find((i) => i.state === "live");

    return {
      ok: true,
      email: customer.email,
      name: customer.name,
      plan: {
        id: spec.id,
        name: spec.name,
        priceUsd: spec.priceUsd,
        monthlyCredits: spec.monthlyCredits,
      },
      subscriptionStatus: sub?.status ?? null,
      renewalDate: sub?.currentPeriodEnd
        ? new Date(sub.currentPeriodEnd).toISOString()
        : null,
      credits: {
        balance,
        grantedThisCycle,
        usedThisCycle,
        refreshDate: sub?.currentPeriodEnd
          ? new Date(sub.currentPeriodEnd).toISOString()
          : null,
      },
      usage: { days },
      instanceUrl: instance?.url ?? null,
      // Growth loop: the customer's shareable referral code (minted lazily
      // on first view) + earnings against the lifetime cap.
      referral: referralSummary(db, customer.id, publicSiteBase()),
    };
  }

  /**
   * Roll one instance to a new image (driver.update). On success the
   * instance's imageRef advances; on failure the event (and 502 body)
   * carries the driver's error, which includes the previous image ref —
   * no automatic rollback in v1, roll back by updating to that ref.
   */
  async function handleInstanceUpdate(
    instanceId: string,
    req: Request,
  ): Promise<Response> {
    const instance = db.getInstance(instanceId);
    if (!instance) return json({ error: "unknown instance" }, 404);
    const body = await readJsonBody(req);
    const image = typeof body.image === "string" ? body.image.trim() : "";
    if (!image) return json({ error: "image is required" }, 400);
    if (instance.state !== "live") {
      return json(
        { error: `instance is ${instance.state} — only live instances update` },
        409,
      );
    }
    try {
      await driver.update(instance.externalId, image);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.recordEvent("instance_update_failed", instance.customerId, {
        instanceId,
        image,
        previousImage: instance.imageRef,
        error: message,
      });
      return json(
        { error: message },
        err instanceof UpdateNotSupportedError ? 501 : 502,
      );
    }
    db.setInstanceImageRef(instanceId, image);
    db.recordEvent("instance_updated", instance.customerId, {
      instanceId,
      image,
      previousImage: instance.imageRef,
    });
    return json({ ok: true, instance: redact(db.getInstance(instanceId)!) });
  }

  /**
   * Roll the whole fleet (live instances of the active driver) to a new
   * image in sequential batches. Refused (409) until the designated
   * staging instance — HQ_STAGING_INSTANCE_ID, when set — already runs
   * the target image. A halted roll answers 502 with what happened.
   */
  async function handleFleetUpdate(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    const image = typeof body.image === "string" ? body.image.trim() : "";
    if (!image) return json({ error: "image is required" }, 400);
    const batchSize = Number(body.batchSize ?? 3);
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      return json({ error: "batchSize must be a positive integer" }, 400);
    }
    const outcome = await updateFleet(db, driver, { image, batchSize });
    if (!outcome.ok) return json({ error: outcome.message }, 409);
    return json(
      { ok: !outcome.result.halted, ...outcome.result },
      outcome.result.halted ? 502 : 200,
    );
  }

  async function handleInstanceAction(
    instanceId: string,
    action: string,
  ): Promise<Response> {
    const instance = db.getInstance(instanceId);
    if (!instance) return json({ error: "unknown instance" }, 404);

    if (action === "suspend") {
      await driver.suspend(instance.externalId);
      return json({
        ok: true,
        instance: redact(db.transitionInstance(instanceId, "suspended")),
      });
    }
    if (action === "resume") {
      await driver.resume(instance.externalId);
      return json({
        ok: true,
        instance: redact(db.transitionInstance(instanceId, "live")),
      });
    }
    await driver.destroy(instance.externalId);
    await revokeComposioProject(instance);
    return json({
      ok: true,
      instance: redact(db.transitionInstance(instanceId, "deleted")),
    });
  }

  /**
   * Tear down the customer's Composio project when their instance is
   * destroyed. Deleting the container does not by itself invalidate the
   * project key that was seeded into it, nor the upstream OAuth grants
   * Cue holds on the customer's behalf — this does both (Composio revokes
   * the connected accounts' upstream credentials via `revoke_on_delete`).
   *
   * Best-effort by design: teardown of the machine has already succeeded
   * by the time we get here, and refusing to mark the instance deleted
   * because Composio was unreachable would strand it in a live state. The
   * failure is recorded loudly so an orphaned project is queryable rather
   * than silent.
   */
  async function revokeComposioProject(instance: Instance): Promise<void> {
    const projectId = parseInstanceSecrets(instance)?.composioProjectId;
    if (!projectId) return; // legacy shared-key instance — nothing of its own
    try {
      await deleteCustomerProject(projectId);
      db.recordEvent("composio_project_deleted", instance.customerId, {
        instanceId: instance.id,
        projectId,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(
        `[hq] Composio project ${projectId} delete FAILED for instance ` +
          `${instance.id}: ${error} — the key stays live until it is removed`,
      );
      db.recordEvent("composio_project_delete_failed", instance.customerId, {
        instanceId: instance.id,
        projectId,
        error,
      });
    }
  }
}


// ---------------------------------------------------------------------------
// Admin dashboard — one server-rendered page, inline CSS, dark.
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Escape a value for use inside a single-quoted JS string that itself sits
 * in a double-quoted HTML attribute (`onclick="f('…')"`). Attribute values
 * are HTML-decoded BEFORE the JS is parsed, so `esc()` alone is not enough:
 * an apostrophe — legal in an email local part — would close the string.
 */
function jsAttrString(s: string): string {
  return esc(s.replaceAll("\\", "\\\\").replaceAll("'", "\\'"));
}

function statusPill(status: string): string {
  const colors: Record<string, string> = {
    waitlist: "#8b8fa3",
    invited: "#c9a227",
    active: "#3fb27f",
    live: "#3fb27f",
    suspended: "#d98032",
    provisioning: "#5a9bd4",
    churned: "#b3524d",
    deleted: "#6b6f81",
  };
  const c = colors[status] ?? "#8b8fa3";
  return `<span class="pill" style="color:${c};border-color:${c}55;background:${c}18">${esc(status)}</span>`;
}

function renderAdminPage(db: HqDb): string {
  const customers = db.listCustomers();
  const instancesByCustomer = new Map<string, Instance[]>();
  for (const c of customers) {
    instancesByCustomer.set(c.id, db.listInstancesByCustomer(c.id));
  }
  const invites = db.listInvites();
  const allowlist = db.listInviteEmails();
  const events = db.listEvents(30);

  const planOptions = PLAN_IDS.map(
    (id) =>
      `<option value="${id}"${id === "chief_of_staff" ? " selected" : ""}>${esc(PLANS[id].name)} · ${PLANS[id].monthlyCredits.toLocaleString()} cr</option>`,
  ).join("");

  const allowlistRows = allowlist
    .map(
      (a) => `<tr>
        <td class="mono">${esc(a.email)}</td>
        <td class="dim">${esc(a.note)}</td>
        <td class="dim">${new Date(a.createdAt).toLocaleDateString()}</td>
        <td><button onclick="allowRemove('${jsAttrString(a.email)}')">Remove</button></td>
      </tr>`,
    )
    .join("");

  const waitlistRows = customers
    .filter((c) => c.status === "waitlist")
    .map(
      (c) => `<tr>
        <td>${esc(c.name)}</td><td class="dim">${esc(c.email)}</td>
        <td class="dim">${new Date(c.createdAt).toLocaleDateString()}</td>
        <td><button onclick="act('/admin/customers/${c.id}/invite')">Invite</button></td>
      </tr>`,
    )
    .join("");

  const customerRows = customers
    .map((c) => {
      const insts = instancesByCustomer.get(c.id) ?? [];
      const sub = db.getSubscription(c.id);
      const instHtml = insts.length
        ? insts
            .map(
              (i) => `<div class="inst">
                ${statusPill(i.state)}
                <a class="dim" href="${esc(i.url)}" target="_blank">${esc(i.url)}</a>
                <span class="dim mono">${esc(i.driver)}/${esc(i.externalId)}</span>
                <span class="dim mono" title="image">${esc(i.imageRef ?? "image unknown")}</span>
                ${
                  i.state === "live"
                    ? `<button onclick="act('/admin/instances/${i.id}/suspend')">Suspend</button>`
                    : i.state === "suspended"
                      ? `<button onclick="act('/admin/instances/${i.id}/resume')">Resume</button>`
                      : ""
                }
              </div>`,
            )
            .join("")
        : '<span class="dim">no instance</span>';
      const balance = db.getCreditBalance(c.id);
      return `<tr>
        <td>${esc(c.name)}<br><span class="dim">${esc(c.email)}</span></td>
        <td>${statusPill(c.status)}<br><span class="dim">${esc(c.plan)}</span></td>
        <td>${balance.toLocaleString()} cr<br>
          <button onclick="act('/admin/customers/${c.id}/topup', {credits: 1000})">+1000</button>
          <button onclick="adjust('${c.id}')">Adjust…</button>
        </td>
        <td class="dim">${sub ? esc(sub.status) : "—"}</td>
        <td>${instHtml}</td>
        <td class="actions">
          <button onclick="act('/admin/customers/${c.id}/invite')">Invite</button>
          <button onclick="act('/admin/customers/${c.id}/provision')">Provision</button>
          <button onclick="act('/admin/customers/${c.id}/magic-link')">Magic link</button>
        </td>
      </tr>`;
    })
    .join("");

  const inviteRows = invites
    .map(
      (i) => `<tr>
        <td class="mono">${esc(i.code)}</td>
        <td class="dim">${i.percentOff}%</td>
        <td class="dim">${i.uses}/${i.maxUses}</td>
        <td class="dim">${i.expiresAt ? new Date(i.expiresAt).toLocaleDateString() : "never"}</td>
      </tr>`,
    )
    .join("");

  const eventRows = events
    .map(
      (e) => `<tr>
        <td class="dim mono">${new Date(e.ts).toLocaleString()}</td>
        <td>${esc(e.kind)}</td>
        <td class="dim mono">${esc(e.dataJson.slice(0, 120))}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cue HQ</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px; background:#0c0d12; color:#e8e9ee;
         font:14px/1.5 -apple-system, "SF Pro Text", "Segoe UI", sans-serif; }
  h1 { font-size:20px; font-weight:600; letter-spacing:.2px; margin:0 0 4px; }
  h1 .accent { color:#c9a227; }
  h2 { font-size:12px; font-weight:600; text-transform:uppercase;
       letter-spacing:1.2px; color:#8b8fa3; margin:32px 0 10px; }
  .sub { color:#8b8fa3; margin:0 0 8px; }
  table { width:100%; border-collapse:collapse; background:#12141c;
          border:1px solid #1f2230; border-radius:10px; overflow:hidden; }
  th { text-align:left; font-size:11px; text-transform:uppercase;
       letter-spacing:.8px; color:#6b6f81; padding:10px 14px;
       border-bottom:1px solid #1f2230; }
  td { padding:10px 14px; border-bottom:1px solid #171a26; vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  .dim { color:#8b8fa3; }
  .mono { font-family:"SF Mono", ui-monospace, monospace; font-size:12px; }
  .pill { display:inline-block; padding:1px 9px; border-radius:999px;
          border:1px solid; font-size:11px; font-weight:600; }
  button { background:#1c2030; color:#e8e9ee; border:1px solid #2a2f45;
           border-radius:7px; padding:5px 12px; font-size:12px; cursor:pointer;
           margin:2px 4px 2px 0; }
  button:hover { background:#262b40; border-color:#3a4160; }
  .inst { margin:2px 0; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  #toast { position:fixed; bottom:24px; right:24px; max-width:480px;
           background:#1c2030; border:1px solid #3a4160; border-radius:10px;
           padding:12px 16px; display:none; white-space:pre-wrap;
           word-break:break-all; font-size:12px; }
  a { color:#7fa7d9; text-decoration:none; }
  .empty { color:#6b6f81; padding:14px; }
  .panel { background:#12141c; border:1px solid #1f2230; border-radius:10px;
           padding:14px; margin-top:8px; }
  .panel textarea, .panel input, .panel select {
           background:#0c0d12; color:#e8e9ee; border:1px solid #2a2f45;
           border-radius:7px; padding:8px 10px; font:inherit; font-size:13px; }
  .panel textarea { width:100%; resize:vertical; font-family:"SF Mono", ui-monospace, monospace; }
  .controls { display:flex; gap:12px; align-items:center; flex-wrap:wrap;
              margin-top:10px; }
  .controls label { color:#8b8fa3; font-size:12px; display:flex; gap:6px;
                    align-items:center; }
  #inv-results { margin-top:12px; }
  #inv-results table { margin-top:0; }
  .ok { color:#3fb27f; } .bad { color:#b3524d; }
</style></head><body>
<h1><span class="accent">Cue</span> HQ</h1>
<p class="sub">${customers.length} customers · ${[...instancesByCustomer.values()].flat().filter((i) => i.state === "live").length} live instances</p>

<h2>Invite people</h2>
<div class="panel">
  <textarea id="inv-emails" rows="3" placeholder="ana@example.com, ben@example.com&#10;cara@example.com"></textarea>
  <div class="controls">
    <label>Plan <select id="inv-plan">${planOptions}</select></label>
    <label>% off <input id="inv-off" type="number" min="0" max="100" value="0" style="width:64px"></label>
    <label>Expires (days) <input id="inv-days" type="number" min="0" value="14" style="width:64px"></label>
    <label>Note <input id="inv-note" type="text" placeholder="optional" style="width:150px"></label>
    <button id="inv-go" onclick="sendInvites()">Invite</button>
  </div>
  <p class="dim" style="margin:10px 0 0;font-size:12px">Creates the customer, allowlists the address for sign-in, mints a code, and emails it. Existing customers are reused.</p>
  <div id="inv-results"></div>
</div>

<h2>Waitlist</h2>
<table><tr><th>Name</th><th>Email</th><th>Joined</th><th></th></tr>
${waitlistRows || '<tr><td colspan="4" class="empty">Nobody waiting.</td></tr>'}</table>

<h2>Customers &amp; instances <button onclick="act('/admin/catalog/ensure')" style="margin-left:8px">Ensure Stripe catalog</button></h2>
<table><tr><th>Customer</th><th>Plan</th><th>Credits</th><th>Billing</th><th>Instances</th><th>Actions</th></tr>
${customerRows || '<tr><td colspan="6" class="empty">No customers yet.</td></tr>'}</table>

<h2>Invites</h2>
<table><tr><th>Code</th><th>Discount</th><th>Uses</th><th>Expires</th></tr>
${inviteRows || '<tr><td colspan="4" class="empty">No invites minted.</td></tr>'}</table>

<h2>Sign-in allowlist</h2>
<p class="sub" style="font-size:12px">Addresses <code>/signin</code> recognizes before they have an account.</p>
<table><tr><th>Email</th><th>Note</th><th>Added</th><th></th></tr>
${allowlistRows || '<tr><td colspan="4" class="empty">Nobody allowlisted.</td></tr>'}</table>
<div class="panel">
  <div class="controls">
    <input id="allow-email" type="email" placeholder="someone@example.com" style="width:220px">
    <input id="allow-note" type="text" placeholder="note (optional)" style="width:180px">
    <button onclick="allowAdd()">Add to allowlist</button>
  </div>
</div>

<h2>Recent events</h2>
<table><tr><th>When</th><th>Kind</th><th>Data</th></tr>
${eventRows || '<tr><td colspan="3" class="empty">Quiet so far.</td></tr>'}</table>

<div id="toast"></div>
<script>
  const token = new URLSearchParams(location.search).get("token") || "";
  async function api(path, method, payload) {
    const res = await fetch(path, {
      method: method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    return { res: res, body: await res.json() };
  }
  async function act(path, payload) {
    toast("Working…");
    try {
      const out = await api(path, "POST", payload);
      toast(JSON.stringify(out.body, null, 2));
      if (out.res.ok && !out.body.url) setTimeout(() => location.reload(), 1200);
    } catch (err) { toast(String(err)); }
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  async function sendInvites() {
    const emails = document.getElementById("inv-emails").value;
    if (!emails.trim()) return toast("Paste at least one email address.");
    const btn = document.getElementById("inv-go");
    btn.disabled = true; btn.textContent = "Inviting…";
    try {
      const out = await api("/admin/invites/send", "POST", {
        emails: emails,
        plan: document.getElementById("inv-plan").value,
        percentOff: Number(document.getElementById("inv-off").value || 0),
        expiresDays: Number(document.getElementById("inv-days").value || 0),
        note: document.getElementById("inv-note").value,
      });
      renderInviteResults(out.body);
    } catch (err) { toast(String(err)); }
    btn.disabled = false; btn.textContent = "Invite";
  }
  function renderInviteResults(body) {
    const el = document.getElementById("inv-results");
    if (!body || !body.results) {
      el.innerHTML = '<p class="bad">' + esc(body && body.error || "No result.") + "</p>";
      return;
    }
    let rows = "";
    for (const r of body.results) {
      const state = r.ok
        ? (r.sent ? '<span class="ok">invited · emailed</span>'
                  : '<span class="ok">invited</span>')
        : '<span class="bad">failed</span>';
      const why = r.reason ? '<span class="dim"> · ' + esc(r.reason) + "</span>" : "";
      rows += "<tr><td>" + esc(r.email) + "</td><td>" + state + why
        + '</td><td class="mono">' + esc(r.code || "—") + "</td>"
        + '<td class="dim">' + esc(r.plan || "—")
        + (r.customerCreated ? " · new" : "")
        + (r.planChanged ? " · plan changed" : "") + "</td></tr>";
    }
    el.innerHTML = "<table><tr><th>Email</th><th>Result</th><th>Code</th>"
      + "<th>Plan</th></tr>" + rows + "</table>";
    setTimeout(() => location.reload(), 6000);
  }
  function allowAdd() {
    const email = document.getElementById("allow-email").value.trim();
    if (!email) return toast("Need an email address.");
    act("/admin/invites/emails", { email: email, note: document.getElementById("allow-note").value });
  }
  async function allowRemove(email) {
    toast("Working…");
    try {
      const out = await api("/admin/invites/emails", "DELETE", { email: email });
      toast(JSON.stringify(out.body, null, 2));
      if (out.res.ok) setTimeout(() => location.reload(), 800);
    } catch (err) { toast(String(err)); }
  }
  function adjust(customerId) {
    const raw = prompt("Credit adjustment (signed integer, e.g. -500):");
    if (!raw) return;
    const delta = parseInt(raw, 10);
    if (!Number.isInteger(delta) || delta === 0) return toast("Need a non-zero integer.");
    const note = prompt("Note for the ledger:") || "manual adjustment";
    act("/admin/customers/" + customerId + "/topup", { kind: "adjustment", delta, note });
  }
  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg; el.style.display = "block";
    clearTimeout(el._t); el._t = setTimeout(() => el.style.display = "none", 12000);
  }
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Boot (bun run src/server.ts)
// ---------------------------------------------------------------------------

export function startServer(deps: ServerDeps & { port?: number }) {
  const handler = createHandler(deps);
  return Bun.serve({
    port: deps.port ?? Number(process.env.HQ_PORT ?? 8790),
    fetch: handler,
  });
}

if (import.meta.main) {
  const [{ HqDb }, { MockDriver }, { RenderDriver }, { FlyDriver }] =
    await Promise.all([
      import("./db.js"),
      import("./providers/mock-driver.js"),
      import("./providers/render-driver.js"),
      import("./providers/fly-driver.js"),
    ]);
  const db = new HqDb();
  const render = new RenderDriver();
  const fly = new FlyDriver();
  const driver: InstanceDriver =
    process.env.HQ_DRIVER === "fly" && fly.configured
      ? fly
      : process.env.HQ_DRIVER === "render" && render.configured
        ? render
        : new MockDriver();
  const server = startServer({ db, driver });
  console.log(
    `Cue HQ listening on ${server.url} (driver: ${driver.id}, stripe: ${
      process.env.STRIPE_SECRET_KEY ? "configured" : "not configured"
    })`,
  );
  // Alpha-readiness boot wiring (2026-07-19 audit):
  //   P0-1 — scream when email is in log-only mode (no RESEND_API_KEY);
  //   P0-6 — actually run the fleet sweep that existed but was never
  //          scheduled (health probes + usage debits + credit freezes,
  //          with ops-email alerting via HQ_OPS_ALERT_EMAIL);
  //   P0-5 — WAL-checkpoint + timestamped, rotated hq.db snapshots.
  logEmailReadinessAtBoot();
  startFleetSweepScheduler(db, driver);
  startDbBackupScheduler(db);
}
