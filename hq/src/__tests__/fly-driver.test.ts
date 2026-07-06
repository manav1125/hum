import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { FlyDriver, parseGuestPreset } from "../providers/fly-driver.js";

const ENV_KEYS = [
  "FLY_API_TOKEN",
  "FLY_ORG_SLUG",
  "FLY_REGION",
  "FLY_VM_SIZE",
  "FLY_VM_MEMORY_MB",
  "FLY_VOLUME_SIZE_GB",
  "CUE_IMAGE_REF",
  "HQ_HEALTH_TIMEOUT_MS",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.FLY_API_TOKEN = "fly-test-token";
  process.env.FLY_ORG_SLUG = "cue-org";
  process.env.CUE_IMAGE_REF = "registry.fly.io/cue-releases:vtest";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** One recorded call against the fake Fly API. */
interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** The config GET machine returns — update() must round-trip it verbatim. */
const MACHINE_CONFIG = {
  image: "registry.fly.io/cue-releases:v1old",
  init: { cmd: ["/app/assistant/docker-cue-app-entrypoint.sh"] },
  env: { GATEWAY_PORT: "10000", ACTOR_TOKEN_SIGNING_KEY: "k".repeat(64) },
  guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
  services: [
    {
      protocol: "tcp",
      internal_port: 10000,
      ports: [
        { port: 80, handlers: ["http"], force_https: true },
        { port: 443, handlers: ["http", "tls"] },
      ],
    },
  ],
  mounts: [{ volume: "vol_test1", path: "/workspace" }],
  restart: { policy: "always" },
};

/**
 * Scriptable fetch covering the Machines API, GraphQL, and the instance's
 * /healthz. Routes are matched in order; unmatched requests 404 (so a test
 * fails loudly on an unexpected call).
 */
function fakeFlyFetch(opts: {
  /** Return a response override, or undefined to fall through to defaults. */
  route?: (method: string, url: string, body: unknown) => Response | undefined;
  healthy?: boolean;
}) {
  const calls: Call[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });

    const override = opts.route?.(method, url, body);
    if (override) return override;

    // ── defaults: a Fly API where everything succeeds ────────────────────
    if (url.endsWith("/healthz")) {
      return new Response(opts.healthy === false ? "no" : "ok", {
        status: opts.healthy === false ? 500 : 200,
      });
    }
    if (url === "https://api.fly.io/graphql") {
      return Response.json({ data: { allocateIpAddress: {} } });
    }
    if (method === "POST" && url.endsWith("/v1/apps")) {
      return Response.json({ id: "app-internal-id" }, { status: 201 });
    }
    if (method === "POST" && url.includes("/volumes")) {
      return Response.json({ id: "vol_test1", name: "workspace" });
    }
    if (method === "POST" && url.endsWith("/machines")) {
      return Response.json({ id: "mach1", instance_id: "inst1" });
    }
    if (method === "GET" && url.includes("/wait?state=")) {
      return Response.json({ ok: true });
    }
    if (method === "GET" && /\/machines\/mach1$/.test(url)) {
      return Response.json({
        id: "mach1",
        state: "started",
        config: structuredClone(MACHINE_CONFIG),
      });
    }
    if (method === "POST" && /\/machines\/mach1$/.test(url)) {
      return Response.json({ id: "mach1", state: "started" });
    }
    if (method === "GET" && url.endsWith("/machines")) {
      return Response.json([{ id: "mach1", state: "started" }]);
    }
    if (method === "GET" && url.endsWith("/volumes")) {
      return Response.json([{ id: "vol_test1" }]);
    }
    if (
      method === "POST" &&
      (url.endsWith("/stop") || url.endsWith("/start"))
    ) {
      return Response.json({ ok: true });
    }
    if (method === "DELETE") {
      return Response.json({ ok: true });
    }
    return new Response("unexpected call", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeDriver(fetchImpl: typeof fetch): FlyDriver {
  return new FlyDriver({
    fetchImpl,
    healthTimeoutMs: 100,
    healthIntervalMs: 10,
  });
}

const SPEC = {
  customerId: "c1",
  name: "cue-ada-abcd1234",
  env: { GATEWAY_PORT: "10000", ACTOR_TOKEN_SIGNING_KEY: "k".repeat(64) },
};

describe("guest preset parsing", () => {
  test("parses shared and performance presets", () => {
    expect(parseGuestPreset("shared-cpu-1x", 1024)).toEqual({
      cpu_kind: "shared",
      cpus: 1,
      memory_mb: 1024,
    });
    expect(parseGuestPreset("performance-2x", 4096)).toEqual({
      cpu_kind: "performance",
      cpus: 2,
      memory_mb: 4096,
    });
  });

  test("rejects garbage presets", () => {
    expect(() => parseGuestPreset("mega-cpu", 1024)).toThrow(/FLY_VM_SIZE/);
  });
});

describe("unconfigured mode", () => {
  test("configured is false and API ops reject without env", async () => {
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_ORG_SLUG;
    const { fetchImpl, calls } = fakeFlyFetch({});
    const driver = makeDriver(fetchImpl);
    expect(driver.configured).toBe(false);
    expect(driver.provision(SPEC)).rejects.toThrow(/not configured/);
    expect(driver.suspend("cue-x")).rejects.toThrow(/not configured/);
    expect(driver.destroy("cue-x")).rejects.toThrow(/not configured/);
    // No network traffic in unconfigured mode (health excepted — it takes
    // a full URL and carries no credentials, matching the Render driver).
    expect(calls.filter((c) => !c.url.endsWith("/healthz")).length).toBe(0);
  });

  test("provision without an image fails before any API call", async () => {
    delete process.env.CUE_IMAGE_REF;
    const { fetchImpl, calls } = fakeFlyFetch({});
    const driver = makeDriver(fetchImpl);
    expect(driver.provision(SPEC)).rejects.toThrow(/CUE_IMAGE_REF/);
    expect(calls.length).toBe(0);
  });
});

describe("provision happy path", () => {
  test("app → IPs → volume → machine → wait → healthz, in order", async () => {
    const { fetchImpl, calls } = fakeFlyFetch({});
    const driver = makeDriver(fetchImpl);

    const result = await driver.provision(SPEC);
    expect(result.externalId).toBe("cue-ada-abcd1234");
    expect(result.url).toBe("https://cue-ada-abcd1234.fly.dev");

    // Ordered call plan.
    const plan = calls.map((c) => `${c.method} ${c.url}`);
    expect(plan[0]).toBe("POST https://api.machines.dev/v1/apps");
    expect(plan[1]).toBe("POST https://api.fly.io/graphql");
    expect(plan[2]).toBe("POST https://api.fly.io/graphql");
    expect(plan[3]).toBe(
      "POST https://api.machines.dev/v1/apps/cue-ada-abcd1234/volumes",
    );
    expect(plan[4]).toBe(
      "POST https://api.machines.dev/v1/apps/cue-ada-abcd1234/machines",
    );
    expect(plan[5]).toContain("/machines/mach1/wait?state=started");
    expect(plan[6]).toBe("GET https://cue-ada-abcd1234.fly.dev/healthz");

    // App create carries the org.
    const appBody = calls[0].body as { app_name: string; org_slug: string };
    expect(appBody).toEqual({
      app_name: "cue-ada-abcd1234",
      org_slug: "cue-org",
    });

    // IP allocation: shared v4 then dedicated v6.
    const ipTypes = calls
      .slice(1, 3)
      .map(
        (c) =>
          (c.body as { variables: { input: { type: string } } }).variables
            .input.type,
      );
    expect(ipTypes).toEqual(["shared_v4", "v6"]);

    // Volume mirrors render.yaml's 10GB /workspace disk, default region iad.
    expect(calls[3].body).toEqual({
      name: "workspace",
      region: "iad",
      size_gb: 10,
    });

    // Machine config: image, full env, ingress → gateway :10000, mount,
    // restart policy, guest preset.
    const machineBody = calls[4].body as {
      region: string;
      config: {
        image: string;
        env: Record<string, string>;
        guest: { cpu_kind: string; cpus: number; memory_mb: number };
        services: {
          protocol: string;
          internal_port: number;
          ports: { port: number; handlers: string[]; force_https?: boolean }[];
        }[];
        mounts: { volume: string; path: string }[];
        restart: { policy: string };
      };
    };
    expect(machineBody.region).toBe("iad");
    expect(machineBody.config.image).toBe("registry.fly.io/cue-releases:vtest");
    expect(machineBody.config.env).toEqual(SPEC.env);
    // v1 intentionally sets no QDRANT_URL — the daemon self-spawns qdrant
    // onto the /workspace volume and degrades gracefully if it can't.
    expect(machineBody.config.env.QDRANT_URL).toBeUndefined();
    expect(machineBody.config.guest).toEqual({
      cpu_kind: "shared",
      cpus: 1,
      memory_mb: 1024,
    });
    expect(machineBody.config.services).toEqual([
      {
        protocol: "tcp",
        internal_port: 10000,
        ports: [
          { port: 80, handlers: ["http"], force_https: true },
          { port: 443, handlers: ["http", "tls"] },
        ],
      },
    ]);
    expect(machineBody.config.mounts).toEqual([
      { volume: "vol_test1", path: "/workspace" },
    ]);
    expect(machineBody.config.restart).toEqual({ policy: "always" });
  });

  test("region/size/volume overrides flow through", async () => {
    process.env.FLY_VM_SIZE = "performance-2x";
    process.env.FLY_VM_MEMORY_MB = "4096";
    const { fetchImpl, calls } = fakeFlyFetch({});
    const driver = makeDriver(fetchImpl);

    await driver.provision({
      ...SPEC,
      region: "sin",
      plan: "20gb",
      image: "registry.fly.io/cue-releases:v2",
    });

    const volumeBody = calls.find(
      (c) => c.method === "POST" && c.url.includes("/volumes"),
    )!.body as { region: string; size_gb: number };
    expect(volumeBody.region).toBe("sin");
    expect(volumeBody.size_gb).toBe(20);

    const machineBody = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/machines"),
    )!.body as {
      region: string;
      config: { image: string; guest: { cpu_kind: string; cpus: number } };
    };
    expect(machineBody.region).toBe("sin");
    expect(machineBody.config.image).toBe("registry.fly.io/cue-releases:v2");
    expect(machineBody.config.guest.cpu_kind).toBe("performance");
    expect(machineBody.config.guest.cpus).toBe(2);
  });
});

describe("app-name collision", () => {
  test("retries with a random suffix when the name is taken", async () => {
    let appCreates = 0;
    const { fetchImpl, calls } = fakeFlyFetch({
      route: (method, url) => {
        if (method === "POST" && url.endsWith("/v1/apps")) {
          appCreates += 1;
          if (appCreates === 1) {
            return Response.json(
              { error: "Validation failed: Name has already been taken" },
              { status: 422 },
            );
          }
        }
        return undefined;
      },
    });
    const driver = makeDriver(fetchImpl);

    const result = await driver.provision(SPEC);
    expect(appCreates).toBe(2);
    expect(result.externalId).toMatch(/^cue-ada-abcd1234-[a-z0-9]{4}$/);
    expect(result.url).toBe(`https://${result.externalId}.fly.dev`);
    // Downstream resources are created under the suffixed app.
    const volumeCall = calls.find(
      (c) => c.method === "POST" && c.url.includes("/volumes"),
    )!;
    expect(volumeCall.url).toContain(`/apps/${result.externalId}/volumes`);
  });

  test("non-collision app-create errors are not retried", async () => {
    let appCreates = 0;
    const { fetchImpl } = fakeFlyFetch({
      route: (method, url) => {
        if (method === "POST" && url.endsWith("/v1/apps")) {
          appCreates += 1;
          return new Response("internal error", { status: 500 });
        }
        return undefined;
      },
    });
    const driver = makeDriver(fetchImpl);
    expect(driver.provision(SPEC)).rejects.toThrow(/→ 500/);
    expect(appCreates).toBe(1);
  });
});

describe("health-timeout cleanup", () => {
  test("tears down machine, volume, and app when healthz never passes", async () => {
    const { fetchImpl, calls } = fakeFlyFetch({ healthy: false });
    const driver = makeDriver(fetchImpl);

    expect(driver.provision(SPEC)).rejects.toThrow(/not healthy/);
    // Give the rejected promise's cleanup a tick to finish recording.
    await new Promise((r) => setTimeout(r, 50));

    const deletes = calls
      .filter((c) => c.method === "DELETE")
      .map((c) => c.url.replace("https://api.machines.dev/v1", ""));
    expect(deletes).toEqual([
      "/apps/cue-ada-abcd1234/machines/mach1?force=true",
      "/apps/cue-ada-abcd1234/volumes/vol_test1",
      "/apps/cue-ada-abcd1234?force=true",
    ]);
  });

  test("machine that never starts also triggers cleanup", async () => {
    const { fetchImpl, calls } = fakeFlyFetch({
      route: (method, url) => {
        if (method === "GET" && url.includes("/wait?state=started")) {
          return new Response('{"error":"timeout"}', { status: 408 });
        }
        return undefined;
      },
    });
    const driver = makeDriver(fetchImpl);

    expect(driver.provision(SPEC)).rejects.toThrow(/never reached "started"/);
    await new Promise((r) => setTimeout(r, 50));

    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.url.includes("?force=true"),
      ),
    ).toBe(true);
  });
});

describe("suspend / resume / destroy", () => {
  test("suspend stops and resume starts every machine in the app", async () => {
    const { fetchImpl, calls } = fakeFlyFetch({});
    const driver = makeDriver(fetchImpl);

    await driver.suspend("cue-ada-abcd1234");
    expect(
      calls.some(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/apps/cue-ada-abcd1234/machines/mach1/stop"),
      ),
    ).toBe(true);

    await driver.resume("cue-ada-abcd1234");
    expect(
      calls.some(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/apps/cue-ada-abcd1234/machines/mach1/start"),
      ),
    ).toBe(true);
  });

  test("destroy deletes machines, volumes, then the app (force)", async () => {
    const { fetchImpl, calls } = fakeFlyFetch({});
    const driver = makeDriver(fetchImpl);

    await driver.destroy("cue-ada-abcd1234");
    const deletes = calls
      .filter((c) => c.method === "DELETE")
      .map((c) => c.url.replace("https://api.machines.dev/v1", ""));
    expect(deletes).toEqual([
      "/apps/cue-ada-abcd1234/machines/mach1?force=true",
      "/apps/cue-ada-abcd1234/volumes/vol_test1",
      "/apps/cue-ada-abcd1234?force=true",
    ]);
  });

  test("destroy is idempotent: 404s are tolerated", async () => {
    const { fetchImpl } = fakeFlyFetch({
      route: (method) =>
        method === "DELETE" || method === "GET"
          ? new Response("not found", { status: 404 })
          : undefined,
    });
    const driver = makeDriver(fetchImpl);
    // Listing fails (404) and the app delete 404s — still resolves.
    await driver.destroy("cue-already-gone");
  });
});

describe("update", () => {
  const NEW_IMAGE = "registry.fly.io/cue-releases:v2new";

  test("list → get config → post with image swapped → wait → healthz", async () => {
    const { fetchImpl, calls } = fakeFlyFetch({});
    const driver = makeDriver(fetchImpl);

    await driver.update("cue-ada-abcd1234", NEW_IMAGE);

    const plan = calls.map((c) => `${c.method} ${c.url}`);
    expect(plan[0]).toBe(
      "GET https://api.machines.dev/v1/apps/cue-ada-abcd1234/machines",
    );
    expect(plan[1]).toBe(
      "GET https://api.machines.dev/v1/apps/cue-ada-abcd1234/machines/mach1",
    );
    expect(plan[2]).toBe(
      "POST https://api.machines.dev/v1/apps/cue-ada-abcd1234/machines/mach1",
    );
    expect(plan[3]).toContain("/machines/mach1/wait?state=started");
    expect(plan[4]).toBe("GET https://cue-ada-abcd1234.fly.dev/healthz");

    // ONLY the image changed — env/services/mounts/init/guest/restart are
    // the machine's existing config, byte-for-byte.
    const body = calls[2].body as { config: typeof MACHINE_CONFIG };
    expect(body).toEqual({
      config: { ...structuredClone(MACHINE_CONFIG), image: NEW_IMAGE },
    });
    expect(body.config.env).toEqual(MACHINE_CONFIG.env);
    expect(body.config.services).toEqual(MACHINE_CONFIG.services);
    expect(body.config.mounts).toEqual(MACHINE_CONFIG.mounts);
    expect(body.config.init).toEqual(MACHINE_CONFIG.init);
    expect(body.config.guest).toEqual(MACHINE_CONFIG.guest);
  });

  test("unhealthy after update throws with the previous image ref", async () => {
    const { fetchImpl } = fakeFlyFetch({ healthy: false });
    const driver = makeDriver(fetchImpl);

    await expect(
      driver.update("cue-ada-abcd1234", NEW_IMAGE),
    ).rejects.toThrow(
      /previous image was registry\.fly\.io\/cue-releases:v1old/,
    );
    // The operator's rollback path is spelled out.
    await expect(
      driver.update("cue-ada-abcd1234", NEW_IMAGE),
    ).rejects.toThrow(/roll back by calling update again/);
  });

  test("an app with no machines rejects rather than reporting success", async () => {
    const { fetchImpl } = fakeFlyFetch({
      route: (method, url) =>
        method === "GET" && url.endsWith("/machines")
          ? Response.json([])
          : undefined,
    });
    const driver = makeDriver(fetchImpl);
    await expect(driver.update("cue-empty", NEW_IMAGE)).rejects.toThrow(
      /no machines/,
    );
  });
});

describe("health", () => {
  test("true on 200, false on 500, false on network error — never throws", async () => {
    const ok = makeDriver(fakeFlyFetch({}).fetchImpl);
    expect(await ok.health("https://x.fly.dev")).toBe(true);
    expect(await ok.health("https://x.fly.dev/")).toBe(true);

    const bad = makeDriver(fakeFlyFetch({ healthy: false }).fetchImpl);
    expect(await bad.health("https://x.fly.dev")).toBe(false);

    const boom = makeDriver((async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    expect(await boom.health("https://x.fly.dev")).toBe(false);
  });
});
