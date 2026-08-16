import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { McpServerConfigSchema } from "../config/schemas/mcp.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

// The real reload service would try to dial the fake MCP URLs this suite
// writes. Spread the real module so a future export can't silently vanish
// from the mock (a hand-listed factory broke a suite the day the loader
// gained an export).
const realReload = await import("../daemon/mcp-reload-service.js");
let reloadCalls = 0;
mock.module("../daemon/mcp-reload-service.js", () => ({
  ...realReload,
  reloadMcpServers: () => {
    reloadCalls += 1;
    return Promise.resolve({ success: true, serverCount: 0, toolCount: 0 });
  },
}));

const {
  provisionComposioMcpServers,
  bindServerUrlToOwnUser,
  readOwnComposioIdentity,
  getComposioMcpProvisionReport,
  resetComposioMcpProvisionForTest,
} = await import("./composio-mcp-provision.js");

const OWN_USER = "cust_own_11111111";
const FOREIGN_USER = "cust_owner_99999999";
const FOREIGN_SERVER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const FOREIGN_SESSION_ID = "trs_foreign_session";

let ws: string;
const prevEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  prevEnv[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "cue-mcp-provision-"));
  setEnv("VELLUM_WORKSPACE_DIR", ws);
  setEnv("VELLUM_DATA_DIR", ws);
  reloadCalls = 0;
  resetComposioMcpProvisionForTest();
  writeConfig({});
});

afterEach(() => {
  resetComposioMcpProvisionForTest();
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function writeConnectors(value: unknown): void {
  writeFileSync(join(ws, "connectors.json"), JSON.stringify(value));
}

function writeConfig(value: unknown): void {
  writeFileSync(join(ws, "config.json"), JSON.stringify(value, null, 2));
}

function readConfig(): {
  mcp?: { servers?: Record<string, { transport?: { url?: string } }> };
} {
  return JSON.parse(readFileSync(join(ws, "config.json"), "utf8")) as {
    mcp?: { servers?: Record<string, { transport?: { url?: string } }> };
  };
}

function ownIdentity(extra: Record<string, unknown> = {}): void {
  writeConnectors({
    composioApiKey: "ak_own_key_for_tests",
    userId: OWN_USER,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Fake Composio. Everything it serves is scoped to the key it is asked with,
// so "another tenant's project" is modelled the way the real API models it:
// the id simply is not there.
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** Ids visible under OUR key. Anything else 404s, as a foreign id would. */
  ownServerIds?: Record<string, { toolkits: string[]; mcpUrl?: string }>;
  ownSessions?: Record<string, { userId: string; url: string }>;
  /** Existing per-toolkit servers returned by the list endpoint. */
  listByToolkit?: Record<string, { id: string; mcp_url?: string }>;
  failToolkits?: Set<string>;
}

interface FakeCalls {
  paths: string[];
  createdSessionUserIds: string[];
  createdServerNames: string[];
}

function fakeComposio(opts: FakeOptions = {}): {
  fetchImpl: typeof fetch;
  calls: FakeCalls;
} {
  const calls: FakeCalls = {
    paths: [],
    createdSessionUserIds: [],
    createdServerNames: [],
  };
  let nextId = 0;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v3.1", "");
    calls.paths.push(`${init?.method ?? "GET"} ${path}${url.search}`);

    // GET /mcp/{id} — the ownership proof.
    const single = /^\/mcp\/([^/]+)$/.exec(path);
    if (single && (init?.method ?? "GET") === "GET") {
      const id = decodeURIComponent(single[1]!);
      const owned = opts.ownServerIds?.[id];
      if (!owned) return json({ error: { message: "not found" } }, 404);
      return json({
        id,
        toolkits: owned.toolkits,
        allowed_tools: ["A", "B", "C"],
        ...(owned.mcpUrl ? { mcp_url: owned.mcpUrl } : {}),
      });
    }

    if (path === "/mcp/servers" && (init?.method ?? "GET") === "GET") {
      const slug = url.searchParams.get("toolkits") ?? "";
      const hit = opts.listByToolkit?.[slug];
      return json({
        items: hit ? [{ ...hit, allowed_tools: ["A", "B"] }] : [],
      });
    }

    if (path === "/auth_configs") {
      const slug = url.searchParams.get("toolkit_slug") ?? "";
      if (opts.failToolkits?.has(slug)) return json({ items: [] });
      return json({ items: [{ id: `ac_${slug}` }] });
    }

    if (path === "/mcp/servers" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string };
      calls.createdServerNames.push(body.name);
      const id = `srv-new-${++nextId}`;
      return json(
        {
          id,
          mcp_url: `https://backend.composio.dev/v3/mcp/${id}`,
          allowed_tools: ["A", "B", "C", "D"],
        },
        201,
      );
    }

    const session = /^\/tool_router\/session\/([^/]+)$/.exec(path);
    if (session && (init?.method ?? "GET") === "GET") {
      const id = decodeURIComponent(session[1]!);
      const owned = opts.ownSessions?.[id];
      if (!owned) return json({ error: { message: "not found" } }, 404);
      return json({
        session_id: id,
        mcp: { type: "http", url: owned.url },
        config: { user_id: owned.userId },
        tool_router_tools: ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_EXECUTE_TOOL"],
      });
    }

    if (path === "/tool_router/session" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { user_id: string };
      calls.createdSessionUserIds.push(body.user_id);
      const id = `trs_new_${++nextId}`;
      return json({
        session_id: id,
        mcp: {
          type: "http",
          url: `https://backend.composio.dev/tool_router/${id}/mcp`,
        },
        tool_router_tools: ["COMPOSIO_SEARCH_TOOLS"],
      });
    }

    return json({ error: { message: `unhandled ${path}` } }, 500);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/** Every URL written into config, flattened for foreign-identity assertions. */
function configuredUrls(): string[] {
  const servers = readConfig().mcp?.servers ?? {};
  return Object.values(servers).map((s) => s.transport?.url ?? "");
}

// ---------------------------------------------------------------------------

describe("bindServerUrlToOwnUser", () => {
  test("replaces a foreign user_id with our own", () => {
    const out = bindServerUrlToOwnUser(
      `https://backend.composio.dev/v3/mcp/abc?user_id=${FOREIGN_USER}`,
      OWN_USER,
    );
    expect(new URL(out).searchParams.get("user_id")).toBe(OWN_USER);
    expect(out).not.toContain(FOREIGN_USER);
  });

  test("strips every identity-bearing parameter, not just user_id", () => {
    const out = bindServerUrlToOwnUser(
      `https://backend.composio.dev/v3/mcp/abc?connected_account_id=ca_${FOREIGN_USER}` +
        `&entity_id=${FOREIGN_USER}&keep=yes`,
      OWN_USER,
    );
    const params = new URL(out).searchParams;
    expect(params.get("connected_account_id")).toBeNull();
    expect(params.get("entity_id")).toBeNull();
    expect(params.get("keep")).toBe("yes");
    expect(params.get("user_id")).toBe(OWN_USER);
  });

  test("refuses to build a URL with no identity at all", () => {
    expect(() =>
      bindServerUrlToOwnUser("https://backend.composio.dev/v3/mcp/abc", "  "),
    ).toThrow();
  });
});

describe("readOwnComposioIdentity", () => {
  test("reads only this instance's own connectors.json", () => {
    ownIdentity();
    expect(readOwnComposioIdentity()?.userId).toBe(OWN_USER);
  });

  test("is null when the file is missing — no template, no default", () => {
    expect(readOwnComposioIdentity()).toBeNull();
  });
});

describe("provisioning a fresh tester instance", () => {
  test("stands up the tool router even with zero connected toolkits", async () => {
    ownIdentity();
    const { fetchImpl, calls } = fakeComposio();

    const report = await provisionComposioMcpServers([], { fetchImpl });

    expect(report.toolRouterReady).toBe(true);
    expect(report.serverCount).toBe(1);
    expect(report.failures).toEqual([]);
    expect(calls.createdSessionUserIds).toEqual([OWN_USER]);
    expect(readConfig().mcp?.servers?.composio).toBeDefined();
    expect(reloadCalls).toBe(1);
  });

  test("creates a per-toolkit server for each active toolkit", async () => {
    ownIdentity();
    const { fetchImpl } = fakeComposio();

    const report = await provisionComposioMcpServers(["gmail", "slack"], {
      fetchImpl,
    });

    expect(report.toolkits).toEqual(["gmail", "slack"]);
    expect(report.serverCount).toBe(3); // router + 2 toolkits
    const servers = readConfig().mcp?.servers ?? {};
    expect(Object.keys(servers).sort()).toEqual([
      "composio",
      "composio_gmail",
      "composio_slack",
    ]);
    for (const url of configuredUrls()) {
      if (url.includes("/v3/mcp/")) {
        expect(new URL(url).searchParams.get("user_id")).toBe(OWN_USER);
      }
    }
  });

  // These servers are stood up automatically, without the owner reviewing a
  // single tool, and they reach real third-party accounts. The MCP schema
  // therefore defaults `defaultRiskLevel` to the fail-closed end, and
  // provisioning must not quietly walk it back: a weaker level is inert only
  // while the owner's auto-approve threshold is at its own default, and turns
  // into blanket auto-approval the moment they raise it. Comparing against the
  // schema's own default (rather than the literal "high") keeps this test
  // honest if the schema's fail-closed choice ever moves.
  test("never provisions a server below the schema's fail-closed risk default", async () => {
    ownIdentity();
    const { fetchImpl } = fakeComposio();

    await provisionComposioMcpServers(["gmail", "slack"], { fetchImpl });

    const rank = { low: 0, medium: 1, high: 2 } as const;
    const schemaDefault = McpServerConfigSchema.parse({
      transport: { type: "streamable-http", url: "https://example.invalid" },
    }).defaultRiskLevel;

    const servers = readConfig().mcp?.servers ?? {};
    expect(Object.keys(servers).length).toBe(3); // router + 2 toolkits

    for (const [key, entry] of Object.entries(servers)) {
      const effective = McpServerConfigSchema.parse(entry).defaultRiskLevel;
      expect(`${key}:${rank[effective] >= rank[schemaDefault]}`).toBe(
        `${key}:true`,
      );
    }
  });

  test("leaves an existing entry's risk level alone — normalizing is migration 106's job", async () => {
    // The boundary this pins is deliberate, not an oversight. Provisioning
    // skips server keys that already exist, so it CANNOT clear a stale "low"
    // written before the fix — that is what workspace migration 106 is for.
    //
    // Do not "fix" this by normalizing here. Provisioning returns early when
    // Composio credentials are missing or lapsed, so it would miss exactly the
    // instances worth reaching; and unlike a once-only migration it runs
    // repeatedly, so it would overwrite a level the owner set deliberately
    // every time it ran.
    ownIdentity();
    const { fetchImpl } = fakeComposio();
    writeConfig({
      mcp: {
        servers: {
          composio_gmail: {
            transport: {
              type: "streamable-http",
              url: "https://existing.invalid",
            },
            enabled: true,
            maxTools: 20,
            defaultRiskLevel: "low",
          },
        },
      },
    });

    await provisionComposioMcpServers(["gmail"], { fetchImpl });

    const gmail = (readConfig().mcp?.servers ?? {}).composio_gmail as
      | { defaultRiskLevel?: string; transport?: { url?: string } }
      | undefined;
    // Untouched, url included — the whole entry was skipped, not rewritten.
    expect(gmail?.defaultRiskLevel).toBe("low");
    expect(gmail?.transport?.url).toBe("https://existing.invalid");
  });

  test("is idempotent — a second run adds nothing and does not reload", async () => {
    ownIdentity();
    const { fetchImpl } = fakeComposio();

    await provisionComposioMcpServers(["gmail"], { fetchImpl });
    const first = readConfig();
    reloadCalls = 0;

    const second = await provisionComposioMcpServers(["gmail"], { fetchImpl });

    expect(readConfig()).toEqual(first);
    expect(second.serverCount).toBe(2);
    expect(reloadCalls).toBe(0);
  });

  test("raises globalMaxTools to fit rather than truncating silently", async () => {
    ownIdentity();
    const { fetchImpl } = fakeComposio();
    writeConfig({ mcp: { servers: {}, globalMaxTools: 2 } });

    await provisionComposioMcpServers(["gmail"], { fetchImpl });

    const mcp = (readConfig() as { mcp?: { globalMaxTools?: number } }).mcp!;
    const servers = readConfig().mcp?.servers ?? {};
    const needed = Object.values(
      servers as Record<string, { maxTools?: number }>,
    ).reduce((sum, s) => sum + (s.maxTools ?? 0), 0);
    expect(mcp.globalMaxTools).toBeGreaterThanOrEqual(needed);
  });
});

// ---------------------------------------------------------------------------
// The isolation guarantee: try, by every route available, to make this
// instance derive a server that carries someone else's identity.
// ---------------------------------------------------------------------------

describe("a foreign identity cannot be derived into this instance", () => {
  test("a foreign user_id inside an inherited mcp_url is rewritten to ours", async () => {
    // The dangerous shortcut in file form: a catalog copied from a working
    // instance, whose URLs still point at that instance's user.
    ownIdentity({
      catalog: [
        {
          slug: "gmail",
          server_id: FOREIGN_SERVER_ID,
          mcp_url: `https://backend.composio.dev/v3/mcp/${FOREIGN_SERVER_ID}?user_id=${FOREIGN_USER}`,
        },
      ],
    });
    // Model the id as one our project CAN see, so the only thing standing
    // between the foreign user_id and config is the rewrite itself.
    const { fetchImpl } = fakeComposio({
      ownServerIds: {
        [FOREIGN_SERVER_ID]: {
          toolkits: ["gmail"],
          mcpUrl: `https://backend.composio.dev/v3/mcp/${FOREIGN_SERVER_ID}?user_id=${FOREIGN_USER}`,
        },
      },
    });

    await provisionComposioMcpServers(["gmail"], { fetchImpl });

    const urls = configuredUrls();
    expect(urls.join(" ")).not.toContain(FOREIGN_USER);
    const gmail =
      readConfig().mcp?.servers?.composio_gmail?.transport?.url ?? "";
    expect(new URL(gmail).searchParams.get("user_id")).toBe(OWN_USER);
  });

  test("a server id this project cannot see is discarded, not used", async () => {
    ownIdentity({
      catalog: [
        {
          slug: "gmail",
          server_id: FOREIGN_SERVER_ID,
          mcp_url: `https://backend.composio.dev/v3/mcp/${FOREIGN_SERVER_ID}`,
        },
      ],
    });
    // Not in ownServerIds → GET /mcp/{id} 404s, exactly as a different
    // project's id does under a per-customer key.
    const { fetchImpl } = fakeComposio();

    await provisionComposioMcpServers(["gmail"], { fetchImpl });

    const gmail =
      readConfig().mcp?.servers?.composio_gmail?.transport?.url ?? "";
    expect(gmail).not.toContain(FOREIGN_SERVER_ID);
    expect(gmail).toContain("/v3/mcp/srv-new-");
    expect(new URL(gmail).searchParams.get("user_id")).toBe(OWN_USER);
  });

  test("a proved server that serves a different toolkit is rejected", async () => {
    ownIdentity({
      catalog: [
        { slug: "gmail", server_id: FOREIGN_SERVER_ID, mcp_url: "https://x/y" },
      ],
    });
    const { fetchImpl } = fakeComposio({
      ownServerIds: { [FOREIGN_SERVER_ID]: { toolkits: ["slack"] } },
    });

    await provisionComposioMcpServers(["gmail"], { fetchImpl });

    const gmail =
      readConfig().mcp?.servers?.composio_gmail?.transport?.url ?? "";
    expect(gmail).not.toContain(FOREIGN_SERVER_ID);
  });

  test("an inherited tool-router session belonging to someone else is discarded", async () => {
    ownIdentity({ toolRouter: { sessionId: FOREIGN_SESSION_ID } });
    const { fetchImpl, calls } = fakeComposio({
      ownSessions: {
        // Visible under our key, but Composio says it is the OWNER's session.
        [FOREIGN_SESSION_ID]: {
          userId: FOREIGN_USER,
          url: `https://backend.composio.dev/tool_router/${FOREIGN_SESSION_ID}/mcp`,
        },
      },
    });

    const report = await provisionComposioMcpServers([], { fetchImpl });

    const router = readConfig().mcp?.servers?.composio?.transport?.url ?? "";
    expect(router).not.toContain(FOREIGN_SESSION_ID);
    expect(calls.createdSessionUserIds).toEqual([OWN_USER]);
    expect(report.toolRouterSessionId).not.toBe(FOREIGN_SESSION_ID);
  });

  test("our own tool-router session IS reused", async () => {
    const mine = "trs_mine";
    ownIdentity({ toolRouter: { sessionId: mine } });
    const { fetchImpl, calls } = fakeComposio({
      ownSessions: {
        [mine]: {
          userId: OWN_USER,
          url: `https://backend.composio.dev/tool_router/${mine}/mcp`,
        },
      },
    });

    await provisionComposioMcpServers([], { fetchImpl });

    expect(calls.createdSessionUserIds).toEqual([]);
    expect(readConfig().mcp?.servers?.composio?.transport?.url).toContain(mine);
  });

  test("with no credentials of its own it provisions nothing at all", async () => {
    // A copied config.json is inert on an instance with no identity: there is
    // no argument and no fallback through which one could arrive.
    const { fetchImpl, calls } = fakeComposio();

    const report = await provisionComposioMcpServers(["gmail"], { fetchImpl });

    expect(report.blocked).toBe("no_composio_credentials");
    expect(report.serverCount).toBe(0);
    expect(calls.paths).toEqual([]);
    expect(readConfig().mcp?.servers ?? {}).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Fail open, never fail silent.
// ---------------------------------------------------------------------------

describe("the report never overstates what happened", () => {
  test("a toolkit that cannot be provisioned is recorded, and the rest proceed", async () => {
    ownIdentity();
    const { fetchImpl } = fakeComposio({ failToolkits: new Set(["slack"]) });

    const report = await provisionComposioMcpServers(["gmail", "slack"], {
      fetchImpl,
    });

    expect(report.toolkits).toEqual(["gmail"]);
    expect(report.failures.map((f) => f.target)).toEqual(["composio_slack"]);
    expect(report.failures[0]!.error).toContain("no auth config");
    // Fail OPEN: gmail still got its server.
    expect(readConfig().mcp?.servers?.composio_gmail).toBeDefined();
  });

  test("zero servers is reported as zero, never as ready", async () => {
    const report = await provisionComposioMcpServers([], {
      fetchImpl: fakeComposio().fetchImpl,
    });

    expect(report.serverCount).toBe(0);
    expect(report.toolRouterReady).toBe(false);
    expect(report.blocked).toBeTruthy();
  });

  test("the report is durable, so a later reader sees the same truth", async () => {
    ownIdentity();
    const { fetchImpl } = fakeComposio();
    await provisionComposioMcpServers(["gmail"], { fetchImpl });

    resetComposioMcpProvisionForTest();
    const persisted = getComposioMcpProvisionReport();

    expect(persisted?.serverCount).toBe(2);
    expect(persisted?.toolkits).toEqual(["gmail"]);
  });

  test("no report at all reads as unknown, not as healthy", () => {
    expect(getComposioMcpProvisionReport()).toBeNull();
  });
});
