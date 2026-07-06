import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import {
  buildInstanceEnv,
  buildMagicLink,
  generateInstanceSecrets,
  mintActorToken,
  verifyActorToken,
} from "../secrets.js";
import { createHandler } from "../server.js";

const ADMIN = "test-admin-token";

// Provisioning consults the OpenRouter env — isolate from the dev machine.
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENROUTER_PROVISIONING_KEY", "OPENROUTER_SHARED_KEY"];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Fake fetch that answers guardian/init like a live gateway would. */
function fakeGuardianFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/guardian/init")) {
      return Response.json({
        guardianPrincipalId: "vellum-principal-test-123",
        accessToken: "aaa.bbb.ccc",
        accessTokenExpiresAt: Date.now() + 1000,
        refreshToken: "r",
        refreshTokenExpiresAt: Date.now() + 1000,
        isNew: true,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function setup() {
  const db = new HqDb(":memory:");
  const driver = new MockDriver();
  const handle = createHandler({
    db,
    driver,
    adminToken: ADMIN,
    healthTimeoutMs: 100,
    healthIntervalMs: 10,
    fetchImpl: fakeGuardianFetch(),
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
  return { db, driver, handle, admin };
}

describe("secrets + token minting", () => {
  test("generated secrets satisfy the daemon env contract", () => {
    const secrets = generateInstanceSecrets();
    // resolveSigningKey() requires exactly 64 hex chars.
    expect(secrets.actorTokenSigningKey).toMatch(/^[0-9a-f]{64}$/);
    const env = buildInstanceEnv(secrets, { OPENROUTER_API_KEY: "sk-test" });
    expect(env.ACTOR_TOKEN_SIGNING_KEY).toBe(secrets.actorTokenSigningKey);
    expect(env.GUARDIAN_BOOTSTRAP_SECRET).toBe(secrets.guardianBootstrapSecret);
    expect(env.OPENROUTER_API_KEY).toBe("sk-test");
    expect(env.VELLUM_ASSISTANT_NAME).toBe("Cue");
    // Managed-mode flag (allowlisted in assistant safe-env.ts).
    expect(env.CUE_MANAGED).toBe("1");
  });

  test("minted actor token round-trips and carries daemon-compatible claims", () => {
    const secrets = generateInstanceSecrets();
    const token = mintActorToken({
      signingKeyHex: secrets.actorTokenSigningKey,
      guardianPrincipalId: "vellum-principal-abc",
    });
    const result = verifyActorToken(token, secrets.actorTokenSigningKey);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Mirrors gateway mintAccessToken() exactly:
    expect(result.claims.iss).toBe("vellum-auth");
    expect(result.claims.aud).toBe("vellum-gateway");
    expect(result.claims.sub).toBe("actor:Cue:vellum-principal-abc");
    expect(result.claims.scope_profile).toBe("actor_client_v1");
    expect(result.claims.policy_epoch).toBe(1);
    expect(result.claims.exp).toBeGreaterThan(Date.now() / 1000);
  });

  test("token signed with a different key is rejected", () => {
    const a = generateInstanceSecrets();
    const b = generateInstanceSecrets();
    const token = mintActorToken({
      signingKeyHex: a.actorTokenSigningKey,
      guardianPrincipalId: "p",
    });
    const result = verifyActorToken(token, b.actorTokenSigningKey);
    expect(result.ok).toBe(false);
  });

  test("magic link uses the SPA's ?cueToken= bootstrap param", () => {
    const link = buildMagicLink("https://cue-x.onrender.com/", "tok.en.x");
    expect(link).toBe("https://cue-x.onrender.com/assistant/?cueToken=tok.en.x");
  });
});

describe("provisioning flow (mock driver)", () => {
  test("waitlist → invite → provision → live, with guardian bootstrap", async () => {
    const { db, driver, handle, admin } = setup();

    // Public waitlist signup.
    const wl = await handle(
      new Request("http://hq.local/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ada@x.io", name: "Ada" }),
      }),
    );
    expect(wl.status).toBe(201);
    const { customerId } = (await wl.json()) as { customerId: string };

    // Invite flips waitlist → invited and mints a code.
    const inv = await admin(`/admin/customers/${customerId}/invite`, {
      percentOff: 30,
    });
    expect(inv.status).toBe(200);
    expect(db.getCustomer(customerId)?.status).toBe("invited");
    const { invite } = (await inv.json()) as { invite: { code: string } };
    expect(invite.code).toStartWith("CUE-");

    // Provision: secrets → driver.provision → health poll → guardian/init → live.
    const prov = await admin(`/admin/customers/${customerId}/provision`);
    expect(prov.status).toBe(200);
    const provBody = (await prov.json()) as {
      instance: { id: string; state: string; url: string };
    };
    expect(provBody.instance.state).toBe("live");
    expect(driver.calls.some((c) => c.method === "provision")).toBe(true);
    expect(driver.calls.some((c) => c.method === "health")).toBe(true);

    // Env contract reached the driver.
    const spec = [...driver.instances.values()][0].spec;
    expect(spec.env.ACTOR_TOKEN_SIGNING_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.env.GUARDIAN_BOOTSTRAP_SECRET.length).toBeGreaterThan(20);

    // Guardian bootstrap stored the principal id in secretsJson.
    const stored = db.getInstance(provBody.instance.id)!;
    const secrets = JSON.parse(stored.secretsJson) as {
      guardianPrincipalId?: string;
    };
    expect(secrets.guardianPrincipalId).toBe("vellum-principal-test-123");

    // Second provision is rejected (single-tenant: one instance).
    const dupe = await admin(`/admin/customers/${customerId}/provision`);
    expect(dupe.status).toBe(409);
  });

  test("provision mints a spend-capped child key and stores only its hash", async () => {
    process.env.OPENROUTER_PROVISIONING_KEY = "pk_test";
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    let keyCreateBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openrouter.ai") && init?.method === "POST") {
        keyCreateBody = JSON.parse(String(init.body));
        return Response.json({
          key: "sk-or-v1-child",
          data: { hash: "kh_prov", disabled: false, limit: 25, usage: 0 },
        });
      }
      if (url.endsWith("/v1/guardian/init")) {
        return Response.json({
          guardianPrincipalId: "vellum-principal-prov",
          accessToken: "a.b.c",
          accessTokenExpiresAt: Date.now() + 1000,
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const handle = createHandler({
      db,
      driver,
      adminToken: ADMIN,
      healthTimeoutMs: 100,
      healthIntervalMs: 10,
      fetchImpl,
    });

    const c = db.createCustomer({
      email: "managed@x.io",
      name: "Managed",
      plan: "chief_of_staff",
    });
    const res = await handle(
      new Request(`http://hq.local/admin/customers/${c.id}/provision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN}` },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    // Child key capped at the plan's COGS budget ($25 for 10000 credits).
    expect(keyCreateBody!.limit).toBe(25);

    const spec = [...driver.instances.values()][0].spec;
    expect(spec.env.OPENROUTER_API_KEY).toBe("sk-or-v1-child");
    expect(spec.env.CUE_MANAGED).toBe("1");

    const inst = db.listInstancesByCustomer(c.id)[0];
    expect(inst.openrouterKeyHash).toBe("kh_prov");
    // The runtime key itself is never persisted anywhere in the row.
    expect(JSON.stringify(inst)).not.toContain("sk-or-v1-child");
  });

  test("magic link mints a token verifiable with the instance signing key", async () => {
    const { db, admin } = setup();
    const c = db.createCustomer({ email: "m@x.io", name: "M" });
    const secrets = generateInstanceSecrets();
    secrets.guardianPrincipalId = "vellum-principal-m";
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: "mock-9",
      url: "http://m.mock.local",
      secretsJson: JSON.stringify(secrets),
      state: "provisioning",
    });
    db.transitionInstance(inst.id, "live");

    const res = await admin(`/admin/customers/${c.id}/magic-link`);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toStartWith("http://m.mock.local/assistant/?cueToken=");
    const token = decodeURIComponent(url.split("cueToken=")[1]);
    const verified = verifyActorToken(token, secrets.actorTokenSigningKey);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe("actor:Cue:vellum-principal-m");
    }
  });

  test("suspend and resume drive the provider and the state machine", async () => {
    const { db, driver, admin } = setup();
    const c = db.createCustomer({ email: "sr@x.io", name: "SR" });
    const provisioned = await driver.provision({
      customerId: c.id,
      name: "cue-sr",
      env: {},
    });
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: provisioned.externalId,
      url: provisioned.url,
      state: "provisioning",
    });
    db.transitionInstance(inst.id, "live");

    const sus = await admin(`/admin/instances/${inst.id}/suspend`);
    expect(sus.status).toBe(200);
    expect(db.getInstance(inst.id)?.state).toBe("suspended");
    expect(driver.calls.some((c2) => c2.method === "suspend")).toBe(true);

    const resu = await admin(`/admin/instances/${inst.id}/resume`);
    expect(resu.status).toBe(200);
    expect(db.getInstance(inst.id)?.state).toBe("live");
  });

  test("health-check timeout leaves the instance in provisioning", async () => {
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const handle = createHandler({
      db,
      driver,
      adminToken: ADMIN,
      healthTimeoutMs: 30,
      healthIntervalMs: 10,
      fetchImpl: fakeGuardianFetch(),
    });
    const c = db.createCustomer({ email: "hc@x.io", name: "HC" });
    // Force every probe to fail.
    driver.healthByUrl.set("http://cue-hc-" + c.id.slice(0, 8) + ".mock.local", false);
    // The service name embeds a slug — just fail all mock urls:
    driver.health = async () => false;

    const res = await handle(
      new Request(`http://hq.local/admin/customers/${c.id}/provision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN}` },
        body: "{}",
      }),
    );
    expect(res.status).toBe(502);
    const insts = db.listInstancesByCustomer(c.id);
    expect(insts.length).toBe(1);
    expect(insts[0].state).toBe("provisioning");
  });
});

describe("admin auth", () => {
  test("admin routes reject missing/wrong tokens", async () => {
    const { handle } = setup();
    const noAuth = await handle(
      new Request("http://hq.local/admin", { method: "GET" }),
    );
    expect(noAuth.status).toBe(401);
    const wrong = await handle(
      new Request("http://hq.local/admin", {
        headers: { Authorization: "Bearer nope" },
      }),
    );
    expect(wrong.status).toBe(401);
    const ok = await handle(
      new Request(`http://hq.local/admin?token=${ADMIN}`),
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Cue");
  });
});
