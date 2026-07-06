/**
 * Cue HQ — HTTP server (Bun.serve, matching the daemon's serving style;
 * the repo has no Hono dependency, so routes are a plain match table).
 *
 * Public routes:
 *   GET  /healthz
 *   POST /waitlist              { email, name, plan? }
 *   POST /webhooks/stripe       (raw body + Stripe-Signature)
 *
 * Admin routes (Bearer HQ_ADMIN_TOKEN, or ?token= for the browser page):
 *   GET  /admin                                 — HTML dashboard
 *   POST /admin/customers/:id/invite            { percentOff?, maxUses?, expiresDays? }
 *   POST /admin/customers/:id/provision         { providerEnv?, region?, plan?, image? }
 *   POST /admin/customers/:id/checkout          — Stripe checkout session URL
 *   POST /admin/customers/:id/magic-link
 *   POST /admin/instances/:id/suspend
 *   POST /admin/instances/:id/resume
 *   POST /admin/instances/:id/destroy
 */

import type { Customer, HqDb, Instance } from "./db.js";
import { InvalidTransitionError } from "./db.js";
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
import { createCheckoutSession, handleStripeWebhook } from "./stripe.js";

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

function parseSecrets(instance: Instance): InstanceSecrets | null {
  try {
    const parsed = JSON.parse(instance.secretsJson) as InstanceSecrets;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "customer"
  );
}

// ---------------------------------------------------------------------------
// Request handler (exported for tests)
// ---------------------------------------------------------------------------

export function createHandler(
  deps: ServerDeps,
): (req: Request) => Promise<Response> {
  const adminToken = deps.adminToken ?? process.env.HQ_ADMIN_TOKEN ?? "";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { db, driver } = deps;

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    try {
      // ── public ────────────────────────────────────────────────────────
      if (method === "GET" && path === "/healthz") {
        return json({ ok: true, service: "cue-hq" });
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
        const plan = body.plan === "founding_byo" ? "founding_byo" : "founding";
        const customer = db.createCustomer({ email, name, plan });
        db.recordEvent("waitlist_joined", customer.id, { email });
        return json({ ok: true, customerId: customer.id }, 201);
      }

      if (method === "POST" && path === "/webhooks/stripe") {
        const rawBody = await req.text();
        const outcome = await handleStripeWebhook(
          { db, driver },
          rawBody,
          req.headers.get("stripe-signature"),
        );
        return json(outcome.body, outcome.status);
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

        const customerAction = path.match(
          /^\/admin\/customers\/([^/]+)\/(invite|provision|checkout|magic-link)$/,
        );
        if (method === "POST" && customerAction) {
          const [, customerId, action] = customerAction;
          const customer = db.getCustomer(customerId);
          if (!customer) return json({ error: "unknown customer" }, 404);

          if (action === "invite") return handleInvite(customer, req);
          if (action === "provision") return handleProvision(customer, req);
          if (action === "checkout") return handleCheckout(customer);
          return handleMagicLink(customer);
        }

        const instanceAction = path.match(
          /^\/admin\/instances\/([^/]+)\/(suspend|resume|destroy)$/,
        );
        if (method === "POST" && instanceAction) {
          const [, instanceId, action] = instanceAction;
          return handleInstanceAction(instanceId, action);
        }

        return json({ error: "not found" }, 404);
      }

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
    const existing = db
      .listInstancesByCustomer(customer.id)
      .filter((i) => i.state !== "deleted");
    if (existing.length > 0) {
      return json(
        { error: "customer already has an instance", instance: redact(existing[0]) },
        409,
      );
    }

    const body = await readJsonBody(req);
    const secrets = generateInstanceSecrets();
    const providerEnv =
      body.providerEnv && typeof body.providerEnv === "object"
        ? (body.providerEnv as Record<string, string>)
        : {};

    const provisioned = await driver.provision({
      customerId: customer.id,
      name: `cue-${slugify(customer.name)}-${customer.id.slice(0, 8)}`,
      env: buildInstanceEnv(secrets, providerEnv),
      region: typeof body.region === "string" ? body.region : undefined,
      plan: typeof body.plan === "string" ? body.plan : undefined,
      image: typeof body.image === "string" ? body.image : undefined,
    });

    const instance = db.createInstance({
      customerId: customer.id,
      driver: driver.id,
      externalId: provisioned.externalId,
      url: provisioned.url,
      secretsJson: JSON.stringify(secrets),
      state: "provisioning",
    });

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
      return json(
        { ok: false, instance: redact(instance), error: "instance did not become healthy" },
        502,
      );
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
    return json({ ok: true, instance: redact(live) });
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

  async function handleMagicLink(customer: Customer): Promise<Response> {
    const instance = db
      .listInstancesByCustomer(customer.id)
      .find((i) => i.state === "live" || i.state === "suspended");
    if (!instance) {
      return json({ error: "customer has no instance" }, 404);
    }
    const secrets = parseSecrets(instance);
    if (!secrets?.actorTokenSigningKey) {
      return json({ error: "instance has no stored signing key" }, 500);
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
        return json(
          {
            error: "guardian principal unknown and guardian/init failed",
            detail: err instanceof Error ? err.message : String(err),
            instructions:
              "Run POST " +
              instance.url +
              "/v1/guardian/init with header x-bootstrap-secret and body " +
              '{"platform":"web","deviceId":"<any>"} to mint the first token, ' +
              "then store guardianPrincipalId in this instance's secretsJson.",
          },
          409,
        );
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
    return json({
      ok: true,
      url: buildMagicLink(instance.url, token),
      expiresInDays: 30,
    });
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
      return `<tr>
        <td>${esc(c.name)}<br><span class="dim">${esc(c.email)}</span></td>
        <td>${statusPill(c.status)}<br><span class="dim">${esc(c.plan)}</span></td>
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

<h2>Customers &amp; instances</h2>
<table><tr><th>Customer</th><th>Status</th><th>Billing</th><th>Instances</th><th>Actions</th></tr>
${customerRows || '<tr><td colspan="5" class="empty">No customers yet.</td></tr>'}</table>

<h2>Invites</h2>
<table><tr><th>Code</th><th>Discount</th><th>Uses</th><th>Expires</th></tr>
${inviteRows || '<tr><td colspan="4" class="empty">No invites minted.</td></tr>'}</table>

<h2>Recent events</h2>
<table><tr><th>When</th><th>Kind</th><th>Data</th></tr>
${eventRows || '<tr><td colspan="3" class="empty">Quiet so far.</td></tr>'}</table>

<div id="toast"></div>
<script>
  const token = new URLSearchParams(location.search).get("token") || "";
  async function act(path) {
    toast("Working…");
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await res.json();
      toast(JSON.stringify(body, null, 2));
      if (res.ok && !body.url) setTimeout(() => location.reload(), 1200);
    } catch (err) { toast(String(err)); }
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
  const [{ HqDb }, { MockDriver }, { RenderDriver }] = await Promise.all([
    import("./db.js"),
    import("./providers/mock-driver.js"),
    import("./providers/render-driver.js"),
  ]);
  const db = new HqDb();
  const render = new RenderDriver();
  const driver: InstanceDriver =
    process.env.HQ_DRIVER === "render" && render.configured
      ? render
      : new MockDriver();
  const server = startServer({ db, driver });
  console.log(
    `Cue HQ listening on ${server.url} (driver: ${driver.id}, stripe: ${
      process.env.STRIPE_SECRET_KEY ? "configured" : "not configured"
    })`,
  );
}
