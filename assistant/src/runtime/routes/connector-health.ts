/**
 * Connector health probe — turns "a Composio login exists" into an honest
 * per-app health verdict for `GET /v1/connector-apps`.
 *
 * REALITY (probed against prod 2026-07-21): Composio's `connected_accounts`
 * metadata is NOT sufficient. A connection can sit `status: ACTIVE` with
 * fresh-looking token metadata while the provider rejects every real call —
 * and conversely most `EXPIRED` rows are just abandoned OAuth initiations
 * ("Connection initiation did not complete within 10 minutes"), pure noise.
 * So health here is built from evidence of REAL authenticated calls:
 *
 *  · passive signals — the Composio request proxy path records every
 *    connector call's success/failure (`oauth/connector-health-store.ts`);
 *  · active probes — for a small allowlist of toolkits with a known-cheap
 *    no-op endpoint (Gmail profile, Slack auth.test, …) we make one tiny
 *    authenticated call through the same proxy, TTL-cached ~10 minutes;
 *  · account metadata — only `is_disabled` on the ACTIVE account is a
 *    trustworthy attention signal from metadata alone.
 *
 * Verdicts: `attention` needs positive evidence of breakage (provider
 * rejected auth, or the account is disabled); `ok` needs positive evidence
 * of life (a real successful call). Anything else — including probe
 * infrastructure failures — degrades to `unknown`, never throws, and the
 * list route never blocks on a probe (stale-while-revalidate: serve what we
 * know, refresh in the background, single-flight, TTL-bounded).
 */

import { COMPOSIO_PROXY_URL } from "../../oauth/composio-oauth.js";
import {
  type ConnectorProbeResult,
  type ConnectorSignal,
  getConnectorHealthState,
  recordConnectorProbe,
} from "../../oauth/connector-health-store.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("connector-health");

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Probe results are fresh for 10 minutes. */
export const HEALTH_TTL_MS = 10 * 60_000;
/** `?refreshHealth=1` can force a re-probe at most this often. */
export const HEALTH_FORCE_MIN_MS = 30_000;
/** Per-probe upstream timeout. */
const PROBE_TIMEOUT_MS = 5_000;
/** Never fan out to more than this many probes per refresh. */
const PROBE_CAP = 12;
/**
 * Evidence older than this can no longer claim "ok"/"attention" — a success
 * from three weeks ago says nothing about today. (Raw timestamps are still
 * reported so the UI can say "last worked 3w ago".)
 */
export const HEALTH_EVIDENCE_FRESH_MS = 7 * 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Cheap liveness checks — metadata-adjacent no-op calls per toolkit.
// Only slugs listed here are actively probed; everything else rides passive
// signals alone. Every endpoint is read-only and single-object cheap.
// ---------------------------------------------------------------------------

interface LivenessProbeSpec {
  method: "GET" | "POST";
  endpoint: string;
}

export const LIVENESS_PROBES: Record<string, LivenessProbeSpec> = {
  gmail: {
    method: "GET",
    endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  },
  googlecalendar: {
    method: "GET",
    endpoint:
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
  },
  googledrive: {
    method: "GET",
    endpoint: "https://www.googleapis.com/drive/v3/about?fields=user",
  },
  // Slack's Web API returns HTTP 200 with `{ok:false, error:"token_revoked"}`
  // on dead tokens — runLivenessProbe special-cases the body check.
  slack: { method: "POST", endpoint: "https://slack.com/api/auth.test" },
  github: { method: "GET", endpoint: "https://api.github.com/user" },
  outlook: { method: "GET", endpoint: "https://graph.microsoft.com/v1.0/me" },
};

// ---------------------------------------------------------------------------
// Probe execution
// ---------------------------------------------------------------------------

export interface ConnectedAccountInfo {
  id: string;
  isDisabled: boolean;
}

/**
 * One cheap authenticated call through the Composio request proxy.
 * Classification:
 *  · provider 2xx/3xx (and Slack `ok !== false`) → "ok"
 *  · provider 401/403, Slack `ok: false`         → "failed" (auth is broken)
 *  · anything else (proxy error, timeout, 5xx)   → "inconclusive"
 */
export async function runLivenessProbe(
  apiKey: string,
  slug: string,
  connectedAccountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorProbeResult> {
  const spec = LIVENESS_PROBES[slug];
  const checkedAt = Date.now();
  if (!spec) return { checkedAt, status: "inconclusive", error: "no probe" };
  try {
    const res = await fetchImpl(COMPOSIO_PROXY_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        connected_account_id: connectedAccountId,
        endpoint: spec.endpoint,
        method: spec.method,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 120);
      return {
        checkedAt,
        status: "inconclusive",
        error: `Composio proxy HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      };
    }
    const payload = (await res.json()) as {
      data?: unknown;
      status?: number;
    };
    const status = typeof payload.status === "number" ? payload.status : 200;
    if (status === 401 || status === 403) {
      return {
        checkedAt,
        status: "failed",
        error: `Provider rejected the connection (HTTP ${status}) — reconnect to fix`,
      };
    }
    if (status >= 400) {
      // 404/429/5xx on a no-op probe: the call authenticated far enough to
      // get a provider verdict, but it isn't auth-shaped — stay inconclusive.
      return {
        checkedAt,
        status: "inconclusive",
        error: `Provider returned HTTP ${status}`,
      };
    }
    const body = payload.data as { ok?: unknown; error?: unknown } | undefined;
    if (slug === "slack" && body && body.ok === false) {
      const code = typeof body.error === "string" ? body.error : "auth failed";
      return {
        checkedAt,
        status: "failed",
        error: `Slack rejected the connection (${code}) — reconnect to fix`,
      };
    }
    return { checkedAt, status: "ok" };
  } catch (err) {
    return {
      checkedAt,
      status: "inconclusive",
      error: `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Refresh scheduling — single-flight, TTL-bounded, fire-and-forget.
// ---------------------------------------------------------------------------

let lastRunAt = 0;
let inFlight: Promise<void> | null = null;

/** Pure TTL decision, exported for tests. */
export function shouldRunHealthRefresh(args: {
  now: number;
  lastRunAt: number;
  force: boolean;
}): boolean {
  const minGap = args.force ? HEALTH_FORCE_MIN_MS : HEALTH_TTL_MS;
  return args.now - args.lastRunAt >= minGap;
}

/**
 * Kick a background probe sweep over the connected apps that have a cheap
 * liveness check. Never blocks, never throws; concurrent callers share one
 * sweep (single-flight) and the TTL bounds regeneration frequency — the
 * accepted stale-while-revalidate GET pattern.
 */
export function kickHealthRefresh(
  apiKey: string,
  accounts: ReadonlyMap<string, ConnectedAccountInfo>,
  force: boolean,
  fetchImpl: typeof fetch = fetch,
): void {
  if (inFlight) return;
  if (!shouldRunHealthRefresh({ now: Date.now(), lastRunAt, force })) return;
  const targets = [...accounts.entries()]
    .filter(([slug]) => LIVENESS_PROBES[slug] !== undefined)
    .slice(0, PROBE_CAP);
  lastRunAt = Date.now();
  if (targets.length === 0) return;
  inFlight = (async () => {
    await Promise.all(
      targets.map(async ([slug, account]) => {
        const result = await runLivenessProbe(
          apiKey,
          slug,
          account.id,
          fetchImpl,
        );
        recordConnectorProbe(slug, result);
        if (result.status !== "ok") {
          log.info(
            { slug, status: result.status, error: result.error },
            "connector liveness probe not ok",
          );
        }
      }),
    );
  })()
    .catch((err: unknown) => {
      log.warn({ err }, "connector health refresh failed");
    })
    .finally(() => {
      inFlight = null;
    });
}

/** Test hook: await any in-flight sweep and reset the TTL clock. */
export async function settleHealthRefreshForTest(): Promise<void> {
  await inFlight;
  lastRunAt = 0;
}

// ---------------------------------------------------------------------------
// Merge — evidence in, verdict out (pure).
// ---------------------------------------------------------------------------

/** Wire shape of the per-app health object (ISO timestamps). */
export interface ConnectorHealth {
  status: "ok" | "attention" | "unknown";
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  /** When the active probe last ran for this app (absent = never probed). */
  checkedAt?: string;
}

const iso = (t: number | undefined): string | undefined =>
  t === undefined ? undefined : new Date(t).toISOString();

const maxT = (
  a: number | undefined,
  b: number | undefined,
): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

/**
 * Combine passive signals + the latest probe + account metadata into one
 * verdict. The status is decided on FRESH evidence only (7d window); raw
 * timestamps are reported regardless so clients can show "last worked 3w
 * ago" on a stale connection.
 */
export function computeConnectorHealth(input: {
  isDisabled?: boolean;
  signal?: ConnectorSignal;
  probe?: ConnectorProbeResult;
  now?: number;
}): ConnectorHealth {
  const now = input.now ?? Date.now();
  const fresh = (t: number | undefined): number | undefined =>
    t !== undefined && now - t <= HEALTH_EVIDENCE_FRESH_MS ? t : undefined;

  const probe = input.probe;
  const probeSuccessAt = probe?.status === "ok" ? probe.checkedAt : undefined;
  const probeErrorAt = probe?.status === "failed" ? probe.checkedAt : undefined;

  const successAt = maxT(input.signal?.lastSuccessAt, probeSuccessAt);
  const errorAt = maxT(input.signal?.lastErrorAt, probeErrorAt);
  const lastError =
    errorAt === undefined
      ? undefined
      : errorAt === probeErrorAt && probe?.error !== undefined
        ? probe.error
        : (input.signal?.lastError ?? probe?.error);

  const freshSuccessAt = fresh(successAt);
  const freshErrorAt = fresh(errorAt);

  let status: ConnectorHealth["status"];
  if (input.isDisabled === true) {
    status = "attention";
  } else if (
    freshErrorAt !== undefined &&
    (freshSuccessAt === undefined || freshErrorAt > freshSuccessAt)
  ) {
    status = "attention";
  } else if (freshSuccessAt !== undefined) {
    status = "ok";
  } else {
    status = "unknown";
  }

  return {
    status,
    ...(successAt !== undefined ? { lastSuccessAt: iso(successAt) } : {}),
    ...(errorAt !== undefined ? { lastErrorAt: iso(errorAt) } : {}),
    ...(status !== "ok" && lastError !== undefined
      ? { lastError }
      : input.isDisabled === true
        ? { lastError: "The connection is disabled at Composio" }
        : {}),
    ...(probe !== undefined ? { checkedAt: iso(probe.checkedAt) } : {}),
  };
}

/** Health for one connected app from the current store state. */
export function connectorHealthFor(
  slug: string,
  account: ConnectedAccountInfo,
  now?: number,
): ConnectorHealth {
  const { signals, probes } = getConnectorHealthState();
  return computeConnectorHealth({
    isDisabled: account.isDisabled,
    signal: signals[slug],
    probe: probes[slug],
    now,
  });
}
