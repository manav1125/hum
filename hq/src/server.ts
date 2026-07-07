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
 *   POST /signin                { email } → always {ok} (magic-link email)
 *   GET  /auth                  ?token= → session cookie + 302 into the
 *                               customer's instance (fresh magic link),
 *                               falling back to /account
 *   POST /testflight            { email } → {ok} (idempotent interest event)
 *   GET  /downloads/cue-macos.dmg — DMG from HQ_DOWNLOADS_DIR (branded 404)
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
 *   POST /admin/catalog/ensure                  — idempotent Stripe catalog
 *   POST /admin/customers/:id/invite            { percentOff?, maxUses?, expiresDays? }
 *   POST /admin/customers/:id/provision         { providerEnv?, region?, plan?, image? }
 *   POST /admin/customers/:id/checkout          — Stripe checkout session URL
 *   POST /admin/customers/:id/magic-link
 *   POST /admin/customers/:id/topup             { credits?, topupId?, kind?, note? }
 *   GET  /admin/customers/:id/credits           — balance + ledger
 *   POST /admin/instances/:id/suspend
 *   POST /admin/instances/:id/resume
 *   POST /admin/instances/:id/destroy
 *   POST /admin/instances/:id/update       { image }
 *   POST /admin/fleet/update               { image, batchSize? }
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { adjustCredits, applyTopup, syncKeyLimitsToBalance } from "./credits.js";
import type { CreditEntry, Customer, CustomerPlan, HqDb, Instance } from "./db.js";
import { InvalidTransitionError } from "./db.js";
import { sendEmail, signinEmail } from "./email.js";
import {
  TOPUPS,
  isPlanId,
  isTopupId,
  publicCatalog,
  resolvePlan,
  type TopupId,
} from "./plans.js";
import { updateFleet } from "./fleet.js";
import type { InstanceDriver } from "./providers/driver.js";
import { UpdateNotSupportedError } from "./providers/driver.js";
import {
  autoProvisionOnPayment,
  mintMagicLinkForCustomer,
  provisionCustomer,
  publicSiteBase,
} from "./provisioning.js";
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
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

/** Normalize a top-up pack from the website ({pack} body) to a TopupId. */
function parseTopupPack(raw: unknown): TopupId | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "topup_1000" || s === "1000" || s === "small") return "topup_1000";
  if (s === "topup_5000" || s === "5000" || s === "large") return "topup_5000";
  return null;
}

function firstNameOf(customer: Customer): string {
  return customer.name.trim().split(/\s+/)[0] || customer.name;
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

      // ── public ────────────────────────────────────────────────────────
      if (method === "GET" && path === "/healthz") {
        return json({ ok: true, service: "cue-hq" });
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
        return handleSignin(req);
      }

      if (method === "GET" && path === "/auth") {
        return handleAuth(url);
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
            const status = result.reason === "stripe_not_configured" ? 503 : 502;
            return json({ error: result.reason }, status);
          }
          db.recordEvent("stripe_catalog_ensured", null, {
            entries: result.entries.length,
            created: result.entries.filter((e) => e.created).length,
          });
          return json({ ok: true, entries: result.entries });
        }

        const customerAction = path.match(
          /^\/admin\/customers\/([^/]+)\/(invite|provision|checkout|magic-link|topup|credits)$/,
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
      expiresAt:
        expiresDays > 0 ? Date.now() + expiresDays * 86_400_000 : null,
    });
    if (customer.status === "waitlist") {
      db.transitionCustomer(customer.id, "invited");
    }
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
        reason === "invite_unknown" ? 404
        : reason === "invite_expired" || reason === "invite_exhausted" ? 410
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

    const checkout = await createCheckoutSession(
      {
        customerId: customer.id,
        email: customer.email,
        plan,
        inviteCode: invite.code,
        percentOff: invite.percentOff,
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
      });
    }
    return json({
      ok: true,
      customerId: customer.id,
      plan,
      checkoutUrl: checkout.url,
    });
  }

  /**
   * Manual credit mutation: a top-up ({credits} or {topupId}, idempotent
   * per optional {ref}) or a signed adjustment ({kind:"adjustment", delta}).
   */
  async function handleTopup(customer: Customer, req: Request): Promise<Response> {
    const body = await readJsonBody(req);

    if (body.kind === "adjustment") {
      const delta = Number(body.delta ?? body.credits);
      if (!Number.isInteger(delta) || delta === 0) {
        return json({ error: "adjustment needs a non-zero integer delta" }, 400);
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
      return json({ error: "topup needs positive integer credits or a topupId" }, 400);
    }
    const ref =
      typeof body.ref === "string" && body.ref.trim()
        ? body.ref.trim()
        : `manual-${randomUUID()}`;
    const result = applyTopup(db, { customerId: customer.id, credits, ref });
    if (result.applied) {
      await syncKeyLimitsToBalance(db, customer.id, fetchImpl);
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
   * POST /signin { email } — always answers {ok:true} (never leaks whether
   * an account exists). Known customers get a one-time link by email.
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
        result.ok ? "signin_email_sent" : "signin_email_failed",
        customer.id,
        result.ok ? { sent: result.sent } : { reason: result.reason },
      );
    }
    return json({ ok: true });
  }

  /**
   * GET /auth?token= — consume the emailed one-time token, set the signed
   * session cookie, and land the user IN their Cue: a freshly minted
   * instance magic link when they have a live instance, /account otherwise.
   * Bad/expired tokens bounce to /signin.
   */
  async function handleAuth(url: URL): Promise<Response> {
    if (!isSessionConfigured()) {
      return json({ error: "signin not configured (HQ_SESSION_SECRET)" }, 503);
    }
    const raw = url.searchParams.get("token")?.trim() ?? "";
    const redirectTo = (target: string, extra?: Record<string, string>) =>
      new Response(null, {
        status: 302,
        headers: { Location: target, ...(extra ?? {}) },
      });
    if (!raw) return redirectTo("/signin");
    const consumed = db.consumeSigninToken(hashSigninToken(raw));
    if (!consumed) return redirectTo("/signin?error=link_expired");
    const customer = db.getCustomer(consumed.customerId);
    if (!customer) return redirectTo("/signin?error=link_expired");
    db.recordEvent("site_session_created", customer.id, {});
    const magic = await mintMagicLinkForCustomer({ db, fetchImpl }, customer);
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
    return json({ ok: true });
  }

  /**
   * GET /downloads/cue-macos.dmg — the macOS app image, served from
   * HQ_DOWNLOADS_DIR (default /data/downloads; the DMG is uploaded to the
   * volume out-of-band — see README). Missing file ⇒ a friendly branded 404.
   */
  function handleMacDownload(method: string): Response {
    const dir = process.env.HQ_DOWNLOADS_DIR ?? "/data/downloads";
    const filePath = join(dir, "cue-macos.dmg");
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return new Response(renderDownloadMissingPage(), {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const size = statSync(filePath).size;
    return new Response(method === "HEAD" ? null : Bun.file(filePath), {
      headers: {
        "Content-Type": "application/x-apple-diskimage",
        "Content-Length": String(size),
        "Content-Disposition": 'attachment; filename="cue-macos.dmg"',
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
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
        return new Response(null, { status: 302, headers: { Location: "/signin" } });
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
        return new Response(null, { status: 302, headers: { Location: "/signin" } });
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
          (e) => e.kind === "usage_sync" && e.ts >= start && e.ts < start + dayMs,
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
      return json({ ok: true, instance: redact(db.transitionInstance(instanceId, "suspended")) });
    }
    if (action === "resume") {
      await driver.resume(instance.externalId);
      return json({ ok: true, instance: redact(db.transitionInstance(instanceId, "live")) });
    }
    await driver.destroy(instance.externalId);
    return json({ ok: true, instance: redact(db.transitionInstance(instanceId, "deleted")) });
  }
}

// ---------------------------------------------------------------------------
// Branded 404 for /downloads when the DMG hasn't been uploaded yet.
// Matches the site's dark palette (#0F1620 / #3D6EE8) with system fonts —
// self-contained, no external assets.
// ---------------------------------------------------------------------------

function renderDownloadMissingPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Cue — download not ready</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center;
         justify-content:center; background:#0F1620; color:#E6ECF5;
         font:15px/1.6 -apple-system, "SF Pro Text", "Segoe UI", sans-serif; }
  .card { max-width:420px; padding:40px 32px; text-align:center; }
  .mark { width:44px; height:44px; border-radius:12px; background:#1A2230;
          border:1.5px solid rgba(255,255,255,.18); display:inline-flex;
          align-items:center; justify-content:center; position:relative;
          font-size:24px; font-weight:600; color:#fff; }
  .mark i { position:absolute; width:7px; height:7px; border-radius:50%;
            background:#3D6EE8; right:9px; bottom:11px; }
  h1 { font-size:22px; font-weight:600; letter-spacing:-.02em; margin:22px 0 0; }
  p { color:#AEB7C7; font-size:14px; margin:12px 0 0; }
  a { display:inline-block; margin-top:22px; background:#3D6EE8; color:#fff;
      text-decoration:none; border-radius:10px; padding:11px 20px;
      font-size:13.5px; font-weight:500; }
</style></head><body>
<div class="card">
  <span class="mark">C<i></i></span>
  <h1>This download isn't ready yet.</h1>
  <p>The Cue for Mac installer is being prepared. Check back shortly, or email hello@justcue.ai and we'll send it your way.</p>
  <a href="/account">Back to your account</a>
</div>
</body></html>`;
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
  const events = db.listEvents(30);

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
</style></head><body>
<h1><span class="accent">Cue</span> HQ</h1>
<p class="sub">${customers.length} customers · ${[...instancesByCustomer.values()].flat().filter((i) => i.state === "live").length} live instances</p>

<h2>Waitlist</h2>
<table><tr><th>Name</th><th>Email</th><th>Joined</th><th></th></tr>
${waitlistRows || '<tr><td colspan="4" class="empty">Nobody waiting.</td></tr>'}</table>

<h2>Customers &amp; instances <button onclick="act('/admin/catalog/ensure')" style="margin-left:8px">Ensure Stripe catalog</button></h2>
<table><tr><th>Customer</th><th>Plan</th><th>Credits</th><th>Billing</th><th>Instances</th><th>Actions</th></tr>
${customerRows || '<tr><td colspan="6" class="empty">No customers yet.</td></tr>'}</table>

<h2>Invites</h2>
<table><tr><th>Code</th><th>Discount</th><th>Uses</th><th>Expires</th></tr>
${inviteRows || '<tr><td colspan="4" class="empty">No invites minted.</td></tr>'}</table>

<h2>Recent events</h2>
<table><tr><th>When</th><th>Kind</th><th>Data</th></tr>
${eventRows || '<tr><td colspan="3" class="empty">Quiet so far.</td></tr>'}</table>

<div id="toast"></div>
<script>
  const token = new URLSearchParams(location.search).get("token") || "";
  async function act(path, payload) {
    toast("Working…");
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
      const body = await res.json();
      toast(JSON.stringify(body, null, 2));
      if (res.ok && !body.url) setTimeout(() => location.reload(), 1200);
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
}
