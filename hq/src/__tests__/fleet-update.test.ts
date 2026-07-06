import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { updateFleet } from "../fleet.js";
import { UpdateNotSupportedError } from "../providers/driver.js";
import { MockDriver } from "../providers/mock-driver.js";
import { RenderDriver } from "../providers/render-driver.js";
import { createHandler } from "../server.js";

const ADMIN = "test-admin-token";
const V1 = "registry.fly.io/cue-releases:v1";
const V2 = "registry.fly.io/cue-releases:v2";

// Fleet updates and provisioning consult the env — isolate from the dev machine.
const ENV_KEYS = [
  "HQ_STAGING_INSTANCE_ID",
  "CUE_IMAGE_REF",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
];
const savedEnv: Record<string, string | undefined> = {};
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

/** Fake fetch answering guardian/init (only the provision test needs it). */
function fakeGuardianFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/guardian/init")) {
      return Response.json({
        guardianPrincipalId: "vellum-principal-test-123",
        accessToken: "aaa.bbb.ccc",
        accessTokenExpiresAt: Date.now() + 1000,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function setup(driver: MockDriver | RenderDriver = new MockDriver()) {
  const db = new HqDb(":memory:");
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

/**
 * Provision on the mock driver + persist the row. Sleeps 2ms so createdAt
 * is distinct — the fleet roll orders oldest-first.
 */
async function makeInstance(
  db: HqDb,
  driver: MockDriver,
  name: string,
  opts: {
    state?: "live" | "suspended" | "deleted";
    imageRef?: string | null;
  } = {},
) {
  const c = db.createCustomer({ email: `${name}@x.io`, name });
  const p = await driver.provision({ customerId: c.id, name, env: {} });
  const inst = db.createInstance({
    customerId: c.id,
    driver: "mock",
    externalId: p.externalId,
    url: p.url,
    imageRef: opts.imageRef !== undefined ? opts.imageRef : V1,
  });
  const state = opts.state ?? "live";
  if (state === "deleted") {
    db.transitionInstance(inst.id, "deleted");
  } else {
    db.transitionInstance(inst.id, "live");
    if (state === "suspended") db.transitionInstance(inst.id, "suspended");
  }
  await new Promise((r) => setTimeout(r, 2));
  return db.getInstance(inst.id)!;
}

describe("driver.update", () => {
  test("mock driver records the call and swaps the spec image", async () => {
    const driver = new MockDriver();
    const p = await driver.provision({ customerId: "c1", name: "up", env: {} });
    await driver.update(p.externalId, V2);
    expect(driver.calls).toContainEqual({
      method: "update",
      arg: `${p.externalId} ${V2}`,
    });
    expect(driver.instances.get(p.externalId)!.spec.image).toBe(V2);
  });

  test("mock driver rejects updates for unknown instances", async () => {
    const driver = new MockDriver();
    await expect(driver.update("mock-nope", V2)).rejects.toThrow(
      /unknown instance/,
    );
  });

  test("render driver throws the typed not-supported error", async () => {
    const render = new RenderDriver();
    await expect(render.update("srv-x", V2)).rejects.toBeInstanceOf(
      UpdateNotSupportedError,
    );
    await expect(render.update("srv-x", V2)).rejects.toThrow(
      /render\.yaml blueprint/,
    );
  });
});

describe("POST /admin/instances/:id/update", () => {
  test("rolls the instance, persists imageRef, records the event", async () => {
    const { db, driver, admin } = setup();
    const inst = await makeInstance(db, driver as MockDriver, "ada");
    expect(inst.imageRef).toBe(V1);

    const res = await admin(`/admin/instances/${inst.id}/update`, { image: V2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: { imageRef: string } };
    expect(body.instance.imageRef).toBe(V2);
    expect(db.getInstance(inst.id)!.imageRef).toBe(V2);
    expect((driver as MockDriver).calls).toContainEqual({
      method: "update",
      arg: `${inst.externalId} ${V2}`,
    });
    const event = db.findLatestEvent("instance_updated", inst.customerId)!;
    expect(JSON.parse(event.dataJson)).toEqual({
      instanceId: inst.id,
      image: V2,
      previousImage: V1,
    });
  });

  test("validates input: missing image 400, unknown instance 404, non-live 409", async () => {
    const { db, driver, admin } = setup();
    const suspended = await makeInstance(db, driver as MockDriver, "sus", {
      state: "suspended",
    });

    expect((await admin(`/admin/instances/${suspended.id}/update`)).status).toBe(400);
    expect(
      (await admin("/admin/instances/nope/update", { image: V2 })).status,
    ).toBe(404);
    const res = await admin(`/admin/instances/${suspended.id}/update`, {
      image: V2,
    });
    expect(res.status).toBe(409);
    expect(db.getInstance(suspended.id)!.imageRef).toBe(V1);
  });

  test("driver failure answers 502, leaves imageRef, records the failure", async () => {
    const { db, driver, admin } = setup();
    const mock = driver as MockDriver;
    const inst = await makeInstance(db, mock, "boom");
    mock.update = async () => {
      throw new Error("machine never started; previous image was v1");
    };

    const res = await admin(`/admin/instances/${inst.id}/update`, { image: V2 });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain(
      "previous image",
    );
    expect(db.getInstance(inst.id)!.imageRef).toBe(V1);
    expect(db.findLatestEvent("instance_update_failed", inst.customerId)).not.toBeNull();
  });

  test("unsupported drivers (render) answer 501", async () => {
    const { db, admin } = setup(new RenderDriver());
    const c = db.createCustomer({ email: "r@x.io", name: "R" });
    const inst = db.createInstance({
      customerId: c.id,
      driver: "render",
      externalId: "srv-r",
      url: "https://r.onrender.com",
    });
    db.transitionInstance(inst.id, "live");

    const res = await admin(`/admin/instances/${inst.id}/update`, { image: V2 });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toContain(
      "render.yaml blueprint",
    );
  });
});

describe("imageRef at provision", () => {
  test("provision records spec.image ?? CUE_IMAGE_REF on the instance row", async () => {
    process.env.CUE_IMAGE_REF = V1;
    const { db, admin } = setup();
    const c = db.createCustomer({ email: "p@x.io", name: "P" });

    const res = await admin(`/admin/customers/${c.id}/provision`);
    expect(res.status).toBe(200);
    expect(db.listInstancesByCustomer(c.id)[0].imageRef).toBe(V1);

    // Explicit body image wins over the env default.
    const c2 = db.createCustomer({ email: "p2@x.io", name: "P2" });
    const res2 = await admin(`/admin/customers/${c2.id}/provision`, {
      image: V2,
    });
    expect(res2.status).toBe(200);
    expect(db.listInstancesByCustomer(c2.id)[0].imageRef).toBe(V2);
  });
});

describe("POST /admin/fleet/update", () => {
  test("rolls live instances oldest-first in batches; skips suspended and already-current", async () => {
    const { db, driver, admin } = setup();
    const mock = driver as MockDriver;
    const a = await makeInstance(db, mock, "a");
    const b = await makeInstance(db, mock, "b");
    const sus = await makeInstance(db, mock, "sus", { state: "suspended" });
    const done = await makeInstance(db, mock, "done", { imageRef: V2 });
    const gone = await makeInstance(db, mock, "gone", { state: "deleted" });
    const c = await makeInstance(db, mock, "c");

    const res = await admin("/admin/fleet/update", { image: V2, batchSize: 2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      batchSize: number;
      updated: string[];
      skipped: { instanceId: string; reason: string }[];
      failed: unknown[];
      halted: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.halted).toBe(false);
    expect(body.updated).toEqual([a.id, b.id, c.id]);
    expect(body.skipped).toContainEqual({ instanceId: sus.id, reason: "suspended" });
    expect(body.skipped).toContainEqual({ instanceId: done.id, reason: "already_on_image" });
    expect(body.skipped.length).toBe(2); // deleted never appears at all
    expect(body.failed).toEqual([]);

    // Driver saw the roll oldest-first; deleted/suspended untouched.
    const rolled = mock.calls
      .filter((call) => call.method === "update")
      .map((call) => call.arg.split(" ")[0]);
    expect(rolled).toEqual([a.externalId, b.externalId, c.externalId]);
    for (const id of [a.id, b.id, c.id]) {
      expect(db.getInstance(id)!.imageRef).toBe(V2);
    }
    expect(db.getInstance(sus.id)!.imageRef).toBe(V1);
    expect(db.getInstance(gone.id)!.imageRef).toBe(V1);
    expect(db.listEvents(50).some((e) => e.kind === "fleet_update_completed")).toBe(true);
  });

  test("defaults batchSize to 3 and validates the body", async () => {
    const { admin } = setup();
    const res = await admin("/admin/fleet/update", { image: V2 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { batchSize: number }).batchSize).toBe(3);

    expect((await admin("/admin/fleet/update")).status).toBe(400);
    expect(
      (await admin("/admin/fleet/update", { image: V2, batchSize: 0 })).status,
    ).toBe(400);
  });

  test("halts the whole roll on the first failure", async () => {
    const { db, driver, admin } = setup();
    const mock = driver as MockDriver;
    const a = await makeInstance(db, mock, "a");
    const b = await makeInstance(db, mock, "bad");
    const c = await makeInstance(db, mock, "c");
    const realUpdate = mock.update.bind(mock);
    mock.update = async (externalId, image) => {
      if (externalId === b.externalId) throw new Error("healthz never passed");
      return realUpdate(externalId, image);
    };

    const res = await admin("/admin/fleet/update", { image: V2, batchSize: 1 });
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: boolean;
      updated: string[];
      failed: { instanceId: string; error: string }[];
      halted: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.halted).toBe(true);
    expect(body.updated).toEqual([a.id]);
    expect(body.failed).toEqual([
      { instanceId: b.id, error: "healthz never passed" },
    ]);

    // The instance after the failure was never attempted.
    const rolled = mock.calls
      .filter((call) => call.method === "update")
      .map((call) => call.arg.split(" ")[0]);
    expect(rolled).toEqual([a.externalId]);
    expect(db.getInstance(a.id)!.imageRef).toBe(V2);
    expect(db.getInstance(b.id)!.imageRef).toBe(V1);
    expect(db.getInstance(c.id)!.imageRef).toBe(V1);
    expect(db.listEvents(50).some((e) => e.kind === "fleet_update_halted")).toBe(true);
    expect(db.findLatestEvent("instance_update_failed", b.customerId)).not.toBeNull();
  });

  test("staging gate: refuses until staging runs the target image", async () => {
    const { db, driver, admin } = setup();
    const mock = driver as MockDriver;
    const staging = await makeInstance(db, mock, "staging");
    const prod = await makeInstance(db, mock, "prod");
    process.env.HQ_STAGING_INSTANCE_ID = staging.id;

    // Fleet refuses: staging is still on V1.
    const refused = await admin("/admin/fleet/update", { image: V2 });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      `roll staging first: POST /admin/instances/${staging.id}/update`,
    );
    expect(mock.calls.filter((c) => c.method === "update")).toEqual([]);

    // Roll staging, then the fleet passes through (staging skipped as current).
    expect(
      (await admin(`/admin/instances/${staging.id}/update`, { image: V2 })).status,
    ).toBe(200);
    const res = await admin("/admin/fleet/update", { image: V2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: string[];
      skipped: { instanceId: string; reason: string }[];
    };
    expect(body.updated).toEqual([prod.id]);
    expect(body.skipped).toContainEqual({
      instanceId: staging.id,
      reason: "already_on_image",
    });
    expect(db.getInstance(prod.id)!.imageRef).toBe(V2);
  });

  test("updateFleet refuses when the staging id points at no instance", async () => {
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const outcome = await updateFleet(db, driver, {
      image: V2,
      stagingInstanceId: "missing-instance",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("staging_not_rolled");
  });
});
