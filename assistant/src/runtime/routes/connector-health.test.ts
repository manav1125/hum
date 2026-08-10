/**
 * Connector health probe: the merge verdict (evidence in → status out), the
 * probe classifier against realistic Composio proxy responses (including the
 * Slack 200-but-ok:false trap), and the TTL/single-flight scheduling.
 *
 * Reality these tests encode (probed against prod): a Composio account can
 * be `ACTIVE` while the provider rejects calls, so `attention` requires
 * positive evidence of breakage and `ok` requires positive evidence of life;
 * probe infrastructure failures must degrade to `unknown`.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import {
  type ConnectorProbeResult,
  getConnectorHealthState,
  pruneProbesWithoutActiveAccount,
  recordConnectorProbe,
  resetConnectorHealthStoreForTest,
} from "../../oauth/connector-health-store.js";
import {
  computeConnectorHealth,
  HEALTH_EVIDENCE_FRESH_MS,
  HEALTH_FORCE_MIN_MS,
  HEALTH_TTL_MS,
  kickHealthRefresh,
  runLivenessProbe,
  settleHealthRefreshForTest,
  shouldRunHealthRefresh,
} from "./connector-health.js";

const NOW = Date.parse("2026-07-21T00:00:00Z");
const HOUR = 60 * 60_000;

afterEach(async () => {
  await settleHealthRefreshForTest();
  resetConnectorHealthStoreForTest();
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  if (ws && existsSync(join(ws, "connector-health.json"))) {
    rmSync(join(ws, "connector-health.json"));
  }
});

describe("computeConnectorHealth", () => {
  it("distinguishes 'no probe exists' from 'probed and could not tell'", () => {
    // Google Sheets has no entry in LIVENESS_PROBES, so it rode passive
    // signals alone and rendered as a BLANK cell beside nine connectors
    // showing a state. A blank reads as a bug. `unknown` was carrying two
    // different facts; this separates them so the client can say "not
    // actively checked" and give the reason.
    const noProbe = computeConnectorHealth({
      now: NOW,
      activelyChecked: false,
    });
    expect(noProbe.status).toBe("unknown");
    expect(noProbe.activelyChecked).toBe(false);

    const probedInconclusive = computeConnectorHealth({
      now: NOW,
      probe: { checkedAt: NOW, status: "inconclusive", error: "timeout" },
    });
    expect(probedInconclusive.status).toBe("unknown");
    expect(probedInconclusive.activelyChecked).toBe(true);
  });

  it("is unknown with no evidence (linked ≠ verified)", () => {
    expect(computeConnectorHealth({ now: NOW })).toEqual({
      status: "unknown",
      activelyChecked: true,
    });
  });

  it("is ok on a fresh passive success", () => {
    const h = computeConnectorHealth({
      now: NOW,
      signal: { lastSuccessAt: NOW - 2 * HOUR },
    });
    expect(h.status).toBe("ok");
    expect(h.lastSuccessAt).toBe(new Date(NOW - 2 * HOUR).toISOString());
    expect(h.lastError).toBeUndefined();
  });

  it("is attention when the latest evidence is a failure", () => {
    const h = computeConnectorHealth({
      now: NOW,
      signal: {
        lastSuccessAt: NOW - 5 * HOUR,
        lastErrorAt: NOW - 1 * HOUR,
        lastError: "Provider rejected the connection (HTTP 401)",
      },
    });
    expect(h.status).toBe("attention");
    expect(h.lastError).toContain("401");
    // The last success is still reported so the UI can say when it worked.
    expect(h.lastSuccessAt).toBe(new Date(NOW - 5 * HOUR).toISOString());
  });

  it("recovers to ok when a success lands after the failure", () => {
    const h = computeConnectorHealth({
      now: NOW,
      signal: {
        lastErrorAt: NOW - 3 * HOUR,
        lastError: "boom",
        lastSuccessAt: NOW - HOUR,
      },
    });
    expect(h.status).toBe("ok");
    expect(h.lastError).toBeUndefined();
  });

  it("a failed probe beats an older passive success", () => {
    const probe: ConnectorProbeResult = {
      checkedAt: NOW - 10_000,
      status: "failed",
      error: "Slack rejected the connection (token_revoked) — reconnect to fix",
    };
    const h = computeConnectorHealth({
      now: NOW,
      signal: { lastSuccessAt: NOW - 2 * HOUR },
      probe,
    });
    expect(h.status).toBe("attention");
    expect(h.lastError).toContain("token_revoked");
    expect(h.checkedAt).toBe(new Date(NOW - 10_000).toISOString());
  });

  it("an ok probe alone yields ok (probe success = real call succeeded)", () => {
    const h = computeConnectorHealth({
      now: NOW,
      probe: { checkedAt: NOW - 60_000, status: "ok" },
    });
    expect(h.status).toBe("ok");
    expect(h.lastSuccessAt).toBe(new Date(NOW - 60_000).toISOString());
  });

  it("an inconclusive probe never flips the verdict", () => {
    // Alone → unknown (probe infra failure ≠ broken connection).
    expect(
      computeConnectorHealth({
        now: NOW,
        probe: {
          checkedAt: NOW - 1000,
          status: "inconclusive",
          error: "Probe failed: timeout",
        },
      }).status,
    ).toBe("unknown");
    // Alongside a passive success → still ok.
    expect(
      computeConnectorHealth({
        now: NOW,
        signal: { lastSuccessAt: NOW - HOUR },
        probe: { checkedAt: NOW - 1000, status: "inconclusive" },
      }).status,
    ).toBe("ok");
  });

  it("stale evidence degrades to unknown but is still reported", () => {
    const old = NOW - HEALTH_EVIDENCE_FRESH_MS - HOUR;
    const h = computeConnectorHealth({
      now: NOW,
      signal: { lastSuccessAt: old },
    });
    expect(h.status).toBe("unknown");
    expect(h.lastSuccessAt).toBe(new Date(old).toISOString());
  });

  it("a disabled account is attention even with a fresh success", () => {
    const h = computeConnectorHealth({
      now: NOW,
      isDisabled: true,
      signal: { lastSuccessAt: NOW - HOUR },
    });
    expect(h.status).toBe("attention");
  });
});

// ---------------------------------------------------------------------------
// Probe classifier — mocked Composio proxy responses.
// ---------------------------------------------------------------------------

const proxyFetch = (respond: () => Response): typeof fetch =>
  (async () => respond()) as unknown as typeof fetch;

describe("runLivenessProbe", () => {
  it("classifies a provider 200 as ok", async () => {
    const r = await runLivenessProbe(
      "key",
      "gmail",
      "ca_x",
      proxyFetch(
        () =>
          new Response(
            JSON.stringify({
              data: { emailAddress: "a@b.c" },
              status: 200,
            }),
          ),
      ),
    );
    expect(r.status).toBe("ok");
  });

  it("classifies a provider 401 as failed (auth is broken)", async () => {
    const r = await runLivenessProbe(
      "gmail",
      "gmail",
      "ca_x",
      proxyFetch(() => new Response(JSON.stringify({ data: {}, status: 401 }))),
    );
    expect(r.status).toBe("failed");
    expect(r.error).toContain("401");
  });

  it("catches Slack's 200-but-ok:false dead-token shape", async () => {
    const r = await runLivenessProbe(
      "key",
      "slack",
      "ca_x",
      proxyFetch(
        () =>
          new Response(
            JSON.stringify({
              data: { ok: false, error: "token_revoked" },
              status: 200,
            }),
          ),
      ),
    );
    expect(r.status).toBe("failed");
    expect(r.error).toContain("token_revoked");
  });

  it("treats proxy-level failures as inconclusive, never failed", async () => {
    const r = await runLivenessProbe(
      "key",
      "gmail",
      "ca_x",
      proxyFetch(() => new Response("upstream exploded", { status: 502 })),
    );
    expect(r.status).toBe("inconclusive");
  });

  it("treats a thrown fetch (timeout/offline) as inconclusive", async () => {
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await runLivenessProbe("key", "gmail", "ca_x", boom);
    expect(r.status).toBe("inconclusive");
    expect(r.error).toContain("network down");
  });

  it("treats a provider 429/5xx as inconclusive (not auth-shaped)", async () => {
    const r = await runLivenessProbe(
      "key",
      "gmail",
      "ca_x",
      proxyFetch(() => new Response(JSON.stringify({ data: {}, status: 429 }))),
    );
    expect(r.status).toBe("inconclusive");
  });
});

// ---------------------------------------------------------------------------
// Scheduling — TTL, forced cooldown, single-flight.
// ---------------------------------------------------------------------------

describe("shouldRunHealthRefresh", () => {
  it("respects the 10-minute TTL", () => {
    expect(
      shouldRunHealthRefresh({
        now: NOW,
        lastRunAt: NOW - HEALTH_TTL_MS + 1,
        force: false,
      }),
    ).toBe(false);
    expect(
      shouldRunHealthRefresh({
        now: NOW,
        lastRunAt: NOW - HEALTH_TTL_MS,
        force: false,
      }),
    ).toBe(true);
  });

  it("force shortens to the 30s cooldown but never below it", () => {
    expect(
      shouldRunHealthRefresh({
        now: NOW,
        lastRunAt: NOW - HEALTH_FORCE_MIN_MS + 1,
        force: true,
      }),
    ).toBe(false);
    expect(
      shouldRunHealthRefresh({
        now: NOW,
        lastRunAt: NOW - HEALTH_FORCE_MIN_MS,
        force: true,
      }),
    ).toBe(true);
  });
});

describe("kickHealthRefresh", () => {
  it("probes only allowlisted connected apps and stores results", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        connected_account_id: string;
      };
      calls.push(body.connected_account_id);
      return new Response(JSON.stringify({ data: { ok: true }, status: 200 }));
    }) as unknown as typeof fetch;

    kickHealthRefresh(
      "key",
      new Map([
        ["gmail", { id: "ca_gmail", isDisabled: false }],
        ["notion", { id: "ca_notion", isDisabled: false }], // no probe spec
      ]),
      true,
      fetchImpl,
    );
    await settleHealthRefreshForTest();
    expect(calls).toEqual(["ca_gmail"]);
  });

  it("is TTL-bounded: an immediate second kick is a no-op", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response(JSON.stringify({ data: {}, status: 200 }));
    }) as unknown as typeof fetch;
    const accounts = new Map([["gmail", { id: "ca_1", isDisabled: false }]]);

    kickHealthRefresh("key", accounts, false, fetchImpl);
    await new Promise((r) => setTimeout(r, 0));
    // Second kick inside the TTL window (not forced) must not probe again.
    kickHealthRefresh("key", accounts, false, fetchImpl);
    await settleHealthRefreshForTest();
    expect(n).toBe(1);
  });
});

describe("a probe for a connector with no active account is not evidence", () => {
  // MEASURED ON PROD: googlecalendar and googledrive both reported probe "ok"
  // while Composio held ZERO active accounts for either (8 and 5 expired rows).
  // The agent was simultaneously and correctly refusing to use them — "No
  // active connection found for toolkit(s) in this session". So the HEALTH
  // SURFACE was the thing telling the owner a comforting lie, which is why the
  // dead connectors went unnoticed.
  //
  // The mechanism: the refresh sweep only probes toolkits with an ACTIVE
  // account, so when an account expires its toolkit stops being probed and its
  // last successful result is simply left behind, claiming ok forever.

  it("drops probes whose toolkit lost its active account", () => {
    resetConnectorHealthStoreForTest();
    recordConnectorProbe("gmail", { checkedAt: NOW, status: "ok" });
    recordConnectorProbe("googlecalendar", { checkedAt: NOW, status: "ok" });

    const dropped = pruneProbesWithoutActiveAccount(new Set(["gmail"]));

    expect(dropped).toEqual(["googlecalendar"]);
    const { probes } = getConnectorHealthState();
    expect(probes.gmail?.status).toBe("ok");
    expect(probes.googlecalendar).toBeUndefined();
  });

  it("an absent probe reads as unknown and NOT actively checked", () => {
    // Silence is the honest state for a connector nothing can probe. The
    // `activelyChecked` flag already distinguishes "no probe exists" from
    // "probed and could not tell", so the surface can say why.
    const h = computeConnectorHealth({ now: NOW, activelyChecked: false });
    expect(h.status).toBe("unknown");
    expect(h.activelyChecked).toBe(false);
  });

  it("keeps every probe when every toolkit is still active", () => {
    resetConnectorHealthStoreForTest();
    recordConnectorProbe("gmail", { checkedAt: NOW, status: "ok" });
    recordConnectorProbe("slack", { checkedAt: NOW, status: "failed" });

    expect(
      pruneProbesWithoutActiveAccount(new Set(["gmail", "slack"])),
    ).toEqual([]);
    const { probes } = getConnectorHealthState();
    expect(probes.gmail?.status).toBe("ok");
    expect(probes.slack?.status).toBe("failed");
  });

  it("an empty active set drops everything rather than keeping stale ok", () => {
    // The exact end-state of a fully-expired instance. Nothing active means
    // nothing may claim ok.
    resetConnectorHealthStoreForTest();
    recordConnectorProbe("gmail", { checkedAt: NOW, status: "ok" });
    expect(pruneProbesWithoutActiveAccount(new Set())).toEqual(["gmail"]);
    expect(getConnectorHealthState().probes.gmail).toBeUndefined();
  });
});
