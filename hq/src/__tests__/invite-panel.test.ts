/**
 * The operator invite panel: POST /admin/invites/send does the whole thing
 * per address (customer → allowlist → code → email), reports each address
 * separately, and never silently claims a send that didn't happen. Plus the
 * provisioning credit grant that stops an invited colleague from arriving
 * with an empty ledger.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { grantProvisioningCredits } from "../credits.js";
import { HqDb } from "../db.js";
import { inviteEmail } from "../email.js";
import { PLANS } from "../plans.js";
import { MockDriver } from "../providers/mock-driver.js";
import { createHandler, nameFromEmail, parseEmailList } from "../server.js";

const ADMIN = "test-admin-token";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HQ_SITE_DIR",
  "HQ_PUBLIC_SITE_URL",
  "HQ_PUBLIC_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "KLAVIYO_API_KEY",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HQ_SITE_DIR = "/nonexistent-site-dir";
  process.env.HQ_PUBLIC_SITE_URL = "https://justcue.ai";
  process.env.RESEND_API_KEY = "re_test";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

interface SentEmail {
  to: string[];
  subject: string;
  html: string;
}

/** Resend stand-in: records every send, and can reject chosen recipients. */
function setup(opts: { failFor?: string[] } = {}) {
  const db = new HqDb(":memory:");
  const sent: SentEmail[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.resend.com")) {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as SentEmail)
        : null;
      if (body && (opts.failFor ?? []).some((e) => body.to.includes(e))) {
        return new Response("blocked recipient", { status: 422 });
      }
      if (body) sent.push(body);
      return Response.json({ id: "email_1" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const handle = createHandler({
    db,
    driver: new MockDriver(),
    adminToken: ADMIN,
    fetchImpl,
  });
  const invite = (body: unknown) =>
    handle(
      new Request("http://hq.local/admin/invites/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN}`,
        },
        body: JSON.stringify(body),
      }),
    );
  return { db, handle, invite, sent };
}

interface ResultRow {
  email: string;
  ok: boolean;
  customerId?: string;
  customerCreated?: boolean;
  plan?: string;
  planChanged?: boolean;
  code?: string;
  allowlisted?: boolean;
  sent?: boolean;
  reason?: string;
}

describe("parsing the pasted blob", () => {
  test("commas, newlines, spaces and semicolons all separate", () => {
    expect(
      parseEmailList(
        "ana@example.com, ben@example.com\ncara@example.com dan@example.com;e@example.org",
      ),
    ).toEqual([
      "ana@example.com",
      "ben@example.com",
      "cara@example.com",
      "dan@example.com",
      "e@example.org",
    ]);
  });

  test("angle-bracket form, trailing punctuation and case are normalized", () => {
    expect(
      parseEmailList("Ana Ruiz <Ana@Example.COM>, ben@example.com."),
    ).toEqual(["ana@example.com", "ben@example.com"]);
  });

  test("duplicates collapse, order is kept, empties vanish", () => {
    expect(
      parseEmailList("  b@example.org,\n\n a@example.org , b@example.org ,, "),
    ).toEqual(["b@example.org", "a@example.org"]);
  });

  test("an array of addresses is accepted as-is", () => {
    expect(parseEmailList(["a@example.org", "b@example.org"])).toEqual([
      "a@example.org",
      "b@example.org",
    ]);
    expect(parseEmailList(undefined)).toEqual([]);
  });

  test("a name is a placeholder built from the local part", () => {
    expect(nameFromEmail("ana.ruiz@example.com")).toBe("Ana Ruiz");
    expect(nameFromEmail("ben_lee-ng@example.com")).toBe("Ben Lee Ng");
  });
});

describe("POST /admin/invites/send", () => {
  test("one call creates the customer, allowlists it, mints a code and sends", async () => {
    const { db, invite, sent } = setup();
    const res = await invite({
      emails: "Ana Ruiz <Ana.Ruiz@example.com>",
      plan: "operator",
      percentOff: 100,
      expiresDays: 7,
      note: "brinc colleague",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; results: ResultRow[] };
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(1);

    const row = body.results[0];
    expect(row).toMatchObject({
      email: "ana.ruiz@example.com",
      ok: true,
      customerCreated: true,
      plan: "operator",
      allowlisted: true,
      sent: true,
    });
    expect(row.code).toMatch(/^CUE-[A-Z2-9]{8}$/);

    // 1. the customer exists, on the chosen plan, as invited
    const customer = db.getCustomerByEmail("ana.ruiz@example.com")!;
    // The display name in the blob is debris; the name is derived from the
    // local part (and only the single-address form takes an explicit name).
    expect(customer.name).toBe("Ana Ruiz");
    expect(customer.plan).toBe("operator");
    expect(customer.status).toBe("invited");

    // 2. sign-in recognizes the address
    expect(db.isEmailInvited("ana.ruiz@example.com")).toBe(true);
    expect(db.listInviteEmails()[0].note).toBe("brinc colleague");

    // 3. the code is real, discounted, and bound to the customer
    const stored = db.getInvite(row.code!)!;
    expect(stored.customerId).toBe(customer.id);
    expect(stored.percentOff).toBe(100);
    expect(stored.expiresAt).toBeGreaterThan(Date.now());

    // 4. the email actually left, carrying the code and a real page
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["ana.ruiz@example.com"]);
    expect(sent[0].html).toContain(row.code!);
    expect(sent[0].html).toContain("https://justcue.ai/redeem");
    expect(db.listEvents(20).some((e) => e.kind === "invite_email_sent")).toBe(
      true,
    );
  });

  test("a bad address and a bounced send are reported per row, not as a batch verdict", async () => {
    const { db, invite, sent } = setup({ failFor: ["ben@example.com"] });
    const res = await invite({
      emails: "ana@example.com, not-an-email@, ben@example.com",
      plan: "assistant",
    });
    const body = (await res.json()) as { ok: boolean; results: ResultRow[] };

    // The batch verdict is false, but two of the three worked.
    expect(body.ok).toBe(false);
    expect(body.results.map((r) => [r.email, r.ok])).toEqual([
      ["ana@example.com", true],
      ["not-an-email@", false],
      ["ben@example.com", false],
    ]);

    // The invalid one never touched the database.
    expect(body.results[1].reason).toBe("invalid_email");
    expect(db.getCustomerByEmail("not-an-email@")).toBeNull();
    expect(db.isEmailInvited("not-an-email@")).toBe(false);

    // The bounced one keeps its code so the operator can hand it over.
    expect(body.results[2].sent).toBe(false);
    expect(body.results[2].reason).toContain("resend_error_422");
    expect(body.results[2].code).toMatch(/^CUE-/);
    expect(db.isEmailInvited("ben@example.com")).toBe(true);
    expect(
      db.listEvents(20).some((e) => e.kind === "invite_email_failed"),
    ).toBe(true);

    // Only the good one was actually delivered.
    expect(sent.map((s) => s.to[0])).toEqual(["ana@example.com"]);
  });

  test("log-only mode reports sent:false rather than claiming a delivery", async () => {
    delete process.env.RESEND_API_KEY;
    const { invite, sent } = setup();
    const res = await invite({ emails: "ana@example.com" });
    const body = (await res.json()) as { ok: boolean; results: ResultRow[] };
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].sent).toBe(false);
    expect(body.results[0].reason).toBe("email_not_configured");
    expect(sent).toHaveLength(0);
  });

  test("an existing customer is reused, not clobbered", async () => {
    const { db, invite } = setup();
    const existing = db.createCustomer({
      email: "ana@example.com",
      name: "Ana Ruiz-Fernandez",
      plan: "assistant",
    });

    const res = await invite({ emails: "ANA@example.com", plan: "operator" });
    const body = (await res.json()) as { results: ResultRow[] };
    expect(body.results[0]).toMatchObject({
      customerId: existing.id,
      customerCreated: false,
      planChanged: true,
      plan: "operator",
    });
    expect(db.listCustomers()).toHaveLength(1);
    // Their real name survives the invite; only the chosen plan moves.
    expect(db.getCustomer(existing.id)!.name).toBe("Ana Ruiz-Fernandez");
    expect(db.getCustomer(existing.id)!.status).toBe("invited");
  });

  test("a blob with no addresses in it is a 400, not an empty success", async () => {
    const { invite } = setup();
    const res = await invite({ emails: "  \n , ; " });
    expect(res.status).toBe(400);
  });

  test("the route is behind the admin token", async () => {
    const { handle } = setup();
    const res = await handle(
      new Request("http://hq.local/admin/invites/send", {
        method: "POST",
        body: JSON.stringify({ emails: "ana@example.com" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("the invite email", () => {
  test("carries the code and links a page that exists", () => {
    const m = inviteEmail({
      code: "CUE-ABC23456",
      redeemUrl: "https://justcue.ai/redeem",
      planName: "Chief of Staff",
      expiresAt: Date.UTC(2026, 8, 1),
    });
    expect(m.subject).toBe("Your Cue invite");
    expect(m.link).toBe("https://justcue.ai/redeem");
    expect(m.html).toContain("CUE-ABC23456");
    expect(m.html).toContain("Invite code");
    expect(m.html).toContain("Chief of Staff");
    expect(m.html).toContain("Set up your Cue");
    expect(m.html).toContain("September 1");
  });

  test("no expiry means no expiry sentence", () => {
    const m = inviteEmail({
      code: "CUE-ABC23456",
      redeemUrl: "https://justcue.ai/redeem",
      planName: "Operator",
      expiresAt: null,
    });
    expect(m.html).not.toContain("good until");
  });
});

describe("the provisioning credit grant", () => {
  function unbilled(db: HqDb) {
    return db.createCustomer({
      email: `c${Math.random()}@example.org`,
      name: "C",
      plan: "chief_of_staff",
      status: "invited",
    });
  }

  test("an invited colleague starts with their plan's credits", () => {
    const db = new HqDb(":memory:");
    const c = unbilled(db);
    expect(db.getCreditBalance(c.id)).toBe(0);

    const first = grantProvisioningCredits(db, {
      customerId: c.id,
      plan: c.plan,
    });
    expect(first.granted).toBe(true);
    expect(first.balance).toBe(PLANS.chief_of_staff.monthlyCredits);
    expect(db.getCreditBalance(c.id)).toBe(PLANS.chief_of_staff.monthlyCredits);
  });

  test("re-provisioning never grants twice", () => {
    const db = new HqDb(":memory:");
    const c = unbilled(db);
    grantProvisioningCredits(db, { customerId: c.id, plan: c.plan });

    const second = grantProvisioningCredits(db, {
      customerId: c.id,
      plan: c.plan,
    });
    expect(second.granted).toBe(false);
    expect(second.reason).toBe("already_granted");
    expect(second.entry).toBeNull();
    expect(db.getCreditBalance(c.id)).toBe(PLANS.chief_of_staff.monthlyCredits);
    expect(
      db.listCreditEntries(c.id).filter((e) => e.kind === "grant"),
    ).toHaveLength(1);
  });

  test("a customer already spending their grant is not topped back up", () => {
    const db = new HqDb(":memory:");
    const c = unbilled(db);
    grantProvisioningCredits(db, { customerId: c.id, plan: c.plan });
    db.appendCreditEntry({
      customerId: c.id,
      delta: -9000,
      kind: "usage_sync",
      note: "usage_sync i1",
    });

    expect(
      grantProvisioningCredits(db, { customerId: c.id, plan: c.plan }).granted,
    ).toBe(false);
    expect(db.getCreditBalance(c.id)).toBe(
      PLANS.chief_of_staff.monthlyCredits - 9000,
    );
  });

  test("invite → provision leaves a real balance, and only ever one grant", async () => {
    const db = new HqDb(":memory:");
    const handle = createHandler({
      db,
      driver: new MockDriver(),
      adminToken: ADMIN,
      healthTimeoutMs: 100,
      healthIntervalMs: 10,
      // Nothing outbound answers: guardian-init and Resend both fail, and
      // the grant must still land — it is not best-effort for the user.
      fetchImpl: (async () =>
        new Response("no", { status: 404 })) as unknown as typeof fetch,
    });
    const admin = (path: string, body: unknown = {}) =>
      handle(
        new Request(`http://hq.local${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ADMIN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );

    await admin("/admin/invites/send", {
      emails: "colleague@example.com",
      plan: "assistant",
    });
    const customer = db.getCustomerByEmail("colleague@example.com")!;
    expect(db.getCreditBalance(customer.id)).toBe(0);

    const provisioned = await admin(
      `/admin/customers/${customer.id}/provision`,
    );
    expect(provisioned.status).toBe(200);
    // The whole point: their first usage sync now debits a real balance
    // instead of writing the ledger's only entry and freezing the key.
    expect(db.getCreditBalance(customer.id)).toBe(
      PLANS.assistant.monthlyCredits,
    );

    // A second provision attempt (409 — they already have an instance)
    // must not fund them again.
    const again = await admin(`/admin/customers/${customer.id}/provision`);
    expect(again.status).toBe(409);
    expect(
      db.listCreditEntries(customer.id).filter((e) => e.kind === "grant"),
    ).toHaveLength(1);
  });

  test("a Stripe subscriber is granted by their invoices, not here", () => {
    const db = new HqDb(":memory:");
    const c = unbilled(db);
    db.upsertSubscription({
      customerId: c.id,
      stripeCustomerId: "cus_1",
      stripeSubId: "sub_1",
      status: "active",
      currentPeriodEnd: null,
      plan: "chief_of_staff",
    });

    const result = grantProvisioningCredits(db, {
      customerId: c.id,
      plan: c.plan,
    });
    expect(result.granted).toBe(false);
    expect(result.reason).toBe("billed_by_stripe");
    expect(db.getCreditBalance(c.id)).toBe(0);
  });
});
