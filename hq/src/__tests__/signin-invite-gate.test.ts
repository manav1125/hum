/**
 * P0-7 (alpha-readiness audit): the /signin private-alpha invite gate +
 * P0-1 email-honesty events, and the /admin/invites/emails + /admin/status
 * operator surfaces.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { createHandler } from "../server.js";

const ADMIN = "test-admin-token";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HQ_SESSION_SECRET",
  "HQ_SITE_DIR",
  "HQ_PUBLIC_SITE_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "HQ_ALPHA_ALLOWLIST",
  "HQ_OPS_ALERT_EMAIL",
  "HQ_COMPOSIO_API_KEY",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
  "HQ_FLY_VM_MEMORY_MB",
  "HQ_INSTANCE_DOMAIN",
];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HQ_SESSION_SECRET = "test-session-secret";
  process.env.HQ_SITE_DIR = "/nonexistent-site-dir";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function outboundMock(opts: { resendStatus?: number } = {}) {
  const resendCalls: { path: string; body: Record<string, unknown> | null }[] =
    [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.resend.com")) {
      resendCalls.push({
        path: new URL(url).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/domains")) {
        return Response.json({
          data: [{ name: "justcue.ai", status: "verified" }],
        });
      }
      // Simulate a provider outage when asked (B8).
      if (opts.resendStatus && opts.resendStatus >= 400) {
        return new Response("service unavailable", {
          status: opts.resendStatus,
        });
      }
      return Response.json({ id: "email_1" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, resendCalls };
}

function setup(opts: { resendStatus?: number } = {}) {
  const db = new HqDb(":memory:");
  const { fetchImpl, resendCalls } = outboundMock(opts);
  const handle = createHandler({
    db,
    driver: new MockDriver(),
    adminToken: ADMIN,
    fetchImpl,
  });
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    handle(
      new Request(`http://hq.local${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const adminHeaders = { Authorization: `Bearer ${ADMIN}` };
  return { db, handle, post, adminHeaders, resendCalls };
}

describe("signin invite gate (P0-7)", () => {
  test("unknown email gets an honest invite_required, never a fake 'sent'", async () => {
    const { db, post } = setup();
    const res = await post("/signin", { email: "stranger@example.com" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      status: string;
      message: string;
    };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("invite_required");
    expect(body.message).toContain("private alpha");
    expect(
      db.findLatestEventByKindData(
        "signin_unknown_email",
        "stranger@example.com",
      ),
    ).not.toBeNull();
    // No signin token was minted for a stranger.
    expect(db.findLatestEventByKindData("signin_email_sent", "")).toBeNull();
  });

  test("allowlisted email (db table) without an account gets invited_no_account", async () => {
    const { db, post } = setup();
    db.addInviteEmail("INVITED@example.com", "wave 1");
    const res = await post("/signin", { email: "invited@example.com" });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("invited_no_account");
    expect(
      db.findLatestEventByKindData(
        "signin_invited_no_account",
        "invited@example.com",
      ),
    ).not.toBeNull();
  });

  test("allowlisted email via HQ_ALPHA_ALLOWLIST CSV is recognized too", async () => {
    process.env.HQ_ALPHA_ALLOWLIST =
      "a@example.com, CSV@Example.com ,b@example.com";
    const { post } = setup();
    const res = await post("/signin", { email: "csv@example.com" });
    expect(((await res.json()) as { status: string }).status).toBe(
      "invited_no_account",
    );
  });

  test("known customer in log-only mode records signin_email_skipped_no_key — NOT sent (P0-1)", async () => {
    const { db, post } = setup(); // RESEND_API_KEY cleared by beforeEach
    const c = db.createCustomer({ email: "maya@example.com", name: "Maya" });
    const res = await post("/signin", { email: "maya@example.com" });
    // B8: log-only mode means NOTHING reached the user, so the response must
    // not say "sent" — this previously returned "sent" and the page told the
    // user to check an inbox that would stay empty.
    expect(((await res.json()) as { status: string }).status).toBe(
      "email_not_configured",
    );
    expect(
      db.findLatestEvent("signin_email_skipped_no_key", c.id),
    ).not.toBeNull();
    expect(db.findLatestEvent("signin_email_sent", c.id)).toBeNull();
  });

  test("known customer with Resend configured records signin_email_sent", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const { db, post, resendCalls } = setup();
    const c = db.createCustomer({ email: "maya@example.com", name: "Maya" });
    await post("/signin", { email: "maya@example.com" });
    expect(db.findLatestEvent("signin_email_sent", c.id)).not.toBeNull();
    expect(db.findLatestEvent("signin_email_skipped_no_key", c.id)).toBeNull();
    expect(resendCalls.filter((c2) => c2.path === "/emails").length).toBe(1);
  });

  // B8: the response used to be a hardcoded {ok:true,status:"sent"} regardless
  // of what sendEmail returned. The failure was written to the audit trail and
  // then contradicted in the response — so a Resend outage read as "Check your
  // inbox" to every user at once, with the only evidence in a table nobody
  // watches during a launch.
  test("a Resend outage is reported as a failure, not as 'sent'", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const { db, post } = setup({ resendStatus: 503 });
    const c = db.createCustomer({ email: "maya@example.com", name: "Maya" });

    const res = await post("/signin", { email: "maya@example.com" });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("send_failed");
    // The audit trail and the response must now agree.
    expect(db.findLatestEvent("signin_email_failed", c.id)).not.toBeNull();
    expect(db.findLatestEvent("signin_email_sent", c.id)).toBeNull();
  });
});

describe("/admin/invites/emails", () => {
  test("add (bulk), list, remove — admin-authed", async () => {
    const { db, handle, post, adminHeaders } = setup();

    // Unauthorized is rejected.
    const anon = await post("/admin/invites/emails", {
      emails: ["a@example.com"],
    });
    expect(anon.status).toBe(401);

    const add = await post(
      "/admin/invites/emails",
      {
        emails: ["A@example.com", "b@example.com", "not-an-email"],
        note: "wave 1",
      },
      adminHeaders,
    );
    expect(add.status).toBe(200);
    const added = (await add.json()) as { added: { email: string }[] };
    expect(added.added.map((e) => e.email).sort()).toEqual([
      "a@example.com",
      "b@example.com",
    ]);

    const list = await handle(
      new Request("http://hq.local/admin/invites/emails", {
        headers: adminHeaders,
      }),
    );
    const listed = (await list.json()) as { emails: { email: string }[] };
    expect(listed.emails.length).toBe(2);
    expect(db.isEmailInvited("a@example.com")).toBe(true);

    const del = await handle(
      new Request("http://hq.local/admin/invites/emails", {
        method: "DELETE",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@example.com" }),
      }),
    );
    expect(((await del.json()) as { removed: boolean }).removed).toBe(true);
    expect(db.isEmailInvited("a@example.com")).toBe(false);
  });
});

describe("/admin/status (P0-1 readiness / P0-6 observability)", () => {
  test("reports log-only email mode and unconfigured LLM keys honestly", async () => {
    const { handle, adminHeaders } = setup();
    const res = await handle(
      new Request("http://hq.local/admin/status", { headers: adminHeaders }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: { configured: boolean; mode: string; domainProbe?: unknown };
      llm: { mode: string };
      connectors: { composioKeyConfigured: boolean };
      instanceDefaults: { memoryMb: number };
    };
    expect(body.email.configured).toBe(false);
    expect(body.email.mode).toBe("log_only");
    expect(body.email.domainProbe).toBeUndefined(); // no key ⇒ no fabricated DNS state
    expect(body.llm.mode).toBe("none");
    expect(body.connectors.composioKeyConfigured).toBe(false);
    expect(body.instanceDefaults.memoryMb).toBe(2048); // P0-4 default
  });

  test("probes Resend domain status when configured", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.OPENROUTER_SHARED_KEY = "sk-shared";
    process.env.HQ_COMPOSIO_API_KEY = "ak_composio";
    const { handle, adminHeaders } = setup();
    const res = await handle(
      new Request("http://hq.local/admin/status", { headers: adminHeaders }),
    );
    const body = (await res.json()) as {
      email: {
        mode: string;
        fromDomain: string | null;
        domainProbe?: { ok: boolean; found?: boolean; status?: string | null };
      };
      llm: { mode: string };
      connectors: { composioKeyConfigured: boolean };
    };
    expect(body.email.mode).toBe("live");
    expect(body.email.fromDomain).toBe("justcue.ai");
    expect(body.email.domainProbe).toEqual({
      ok: true,
      found: true,
      status: "verified",
    });
    expect(body.llm.mode).toBe("shared_uncapped");
    expect(body.connectors.composioKeyConfigured).toBe(true);
  });
});
