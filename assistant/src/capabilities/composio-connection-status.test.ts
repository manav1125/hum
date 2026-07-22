import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

const {
  recordActiveComposioToolkits,
  getComposioConnectionStatus,
  composioToolkitStatus,
  kickComposioStatusRefresh,
  resetComposioConnectionStatusForTest,
  STATUS_REFRESH_TTL_MS,
} = await import("./composio-connection-status.js");

let ws: string;
let prevWs: string | undefined;

beforeEach(() => {
  prevWs = process.env.VELLUM_WORKSPACE_DIR;
  ws = mkdtempSync(join(tmpdir(), "cue-composio-status-"));
  process.env.VELLUM_WORKSPACE_DIR = ws;
  resetComposioConnectionStatusForTest();
});

afterEach(() => {
  resetComposioConnectionStatusForTest();
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (prevWs === undefined) delete process.env.VELLUM_WORKSPACE_DIR;
  else process.env.VELLUM_WORKSPACE_DIR = prevWs;
});

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("recordActiveComposioToolkits / composioToolkitStatus", () => {
  test("cold cache reads as unknown, never as connected", () => {
    expect(getComposioConnectionStatus()).toBeNull();
    expect(composioToolkitStatus("gmail")).toBe("unknown");
  });

  test("recorded slugs read active; unrecorded read broken (positive absence)", () => {
    recordActiveComposioToolkits(["googlesheets", "googlecalendar"]);
    expect(composioToolkitStatus("googlesheets")).toBe("active");
    // gmail was NOT in the active set → known-inactive, i.e. broken.
    expect(composioToolkitStatus("gmail")).toBe("broken");
    expect(getComposioConnectionStatus()?.active.has("googlesheets")).toBe(true);
  });

  test("a later record REPLACES the set wholesale (dropped slug goes broken)", () => {
    recordActiveComposioToolkits(["gmail", "slack"]);
    expect(composioToolkitStatus("gmail")).toBe("active");
    recordActiveComposioToolkits(["slack"]); // gmail fell out of ACTIVE
    expect(composioToolkitStatus("gmail")).toBe("broken");
    expect(composioToolkitStatus("slack")).toBe("active");
  });

  test("survives a reload from disk (persisted)", () => {
    recordActiveComposioToolkits(["gmail"]);
    resetComposioConnectionStatusForTest(); // drop in-memory, force disk reload
    expect(composioToolkitStatus("gmail")).toBe("active");
  });
});

describe("kickComposioStatusRefresh", () => {
  test("no creds → no-op, no throw", () => {
    expect(() => kickComposioStatusRefresh()).not.toThrow();
    expect(getComposioConnectionStatus()).toBeNull();
  });

  test("with creds + stale cache, refreshes from Composio active accounts", async () => {
    writeFileSync(
      join(ws, "connectors.json"),
      JSON.stringify({ composioApiKey: "ak_test", userId: "u_test" }),
    );
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            { toolkit: { slug: "gmail" } },
            { toolkit: { slug: "slack" } },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    kickComposioStatusRefresh(fakeFetch);
    await until(() => getComposioConnectionStatus() !== null);
    expect(composioToolkitStatus("gmail")).toBe("active");
    expect(composioToolkitStatus("slack")).toBe("active");
  });

  test("a fresh snapshot is not re-fetched", () => {
    writeFileSync(
      join(ws, "connectors.json"),
      JSON.stringify({ composioApiKey: "ak_test", userId: "u_test" }),
    );
    recordActiveComposioToolkits(["gmail"]); // refreshedAt = now
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    kickComposioStatusRefresh(fakeFetch);
    expect(called).toBe(false);
    expect(STATUS_REFRESH_TTL_MS).toBeGreaterThan(0);
  });
});
