/**
 * Cheap, cached view of which Composio toolkits are ACTUALLY connected.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 * A Composio-backed provider is wired into config as an enabled MCP server
 * (`composio_gmail`, …) at connect time. That `enabled` flag says "Cue will
 * route to this server" — it is set once and NEVER cleared when the underlying
 * Composio OAuth connection dies. So `enabled` is INDEPENDENT of whether the
 * account is actually usable: a `composio_gmail` server can sit `enabled: true`
 * while Composio reports the connection `initiated`/expired (OAuth started,
 * never completed). Deriving "linked accounts" from `enabled` therefore
 * OVER-CLAIMS — it tells the model Gmail is connected when the very next call
 * throws "no active gmail connection".
 *
 * The ground truth lives at Composio: `GET /connected_accounts?statuses=ACTIVE`
 * returns exactly the toolkits that authenticate right now. But
 * `buildCapabilitySnapshot()` runs on the assessment / system-prompt hot path
 * and must stay cheap and synchronous — it cannot make a per-turn network call.
 *
 * ── The design ─────────────────────────────────────────────────────────────
 * Keep a persisted snapshot of the known-ACTIVE toolkit set, refreshed for
 * free from calls the daemon ALREADY makes against that same endpoint:
 *   · `connectedAccounts()` in `runtime/routes/connector-apps-routes.ts`
 *     (every Connectors-page view), and
 *   · `activeToolkits()` in `oauth/composio-oauth.ts`
 *     (every real Composio-proxied OAuth request).
 * Both fetch the FULL active set (limit 100), so each successful fetch replaces
 * the snapshot wholesale — a toolkit that drops out of ACTIVE (e.g. expired) is
 * removed on the next refresh. Readers get a synchronous, fail-soft answer.
 *
 * To keep the snapshot warm even on an idle daemon, readers may kick a
 * single-flight, TTL-bounded background refresh (`kickComposioStatusRefresh`) —
 * the accepted stale-while-revalidate pattern. It never blocks and never throws.
 *
 * Everything here is best-effort: a missing/cold snapshot reads as "unknown",
 * never as "connected". Honesty over completeness.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { selectOwnedAccounts } from "../oauth/composio-account-ownership.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("composio-connection-status");

const FILE_NAME = "composio-connection-status.json";
/** How stale the snapshot may get before a reader kicks a background refresh. */
export const STATUS_REFRESH_TTL_MS = 5 * 60_000;
/** Upstream timeout for the background refresh call. */
const REFRESH_TIMEOUT_MS = 5_000;
const COMPOSIO_CONNECTED_ACCOUNTS_URL =
  "https://backend.composio.dev/api/v3/connected_accounts";

interface StatusFile {
  version: 1;
  /** Composio toolkit slugs whose connection was ACTIVE at `refreshedAt`. */
  activeToolkits: string[];
  /** Epoch ms of the fetch that produced `activeToolkits`. */
  refreshedAt: number;
}

let state: StatusFile | null = null;

function filePath(): string | null {
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  return ws ? join(ws, FILE_NAME) : null;
}

function load(): StatusFile | null {
  if (state) return state;
  const path = filePath();
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as StatusFile;
    if (
      raw !== null &&
      typeof raw === "object" &&
      raw.version === 1 &&
      Array.isArray(raw.activeToolkits) &&
      typeof raw.refreshedAt === "number"
    ) {
      state = {
        version: 1,
        activeToolkits: raw.activeToolkits.filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        ),
        refreshedAt: raw.refreshedAt,
      };
      return state;
    }
  } catch {
    // No snapshot yet (fresh install) — stays unknown.
  }
  return null;
}

function persist(): void {
  const path = filePath();
  if (!path || !state) return;
  try {
    writeFileSync(path, JSON.stringify(state));
  } catch (err) {
    log.warn({ err }, "composio connection-status persist failed");
  }
}

/**
 * Record the CURRENT full set of ACTIVE Composio toolkit slugs, replacing any
 * prior snapshot wholesale (so a toolkit that fell out of ACTIVE is dropped).
 * Call only after a SUCCESSFUL full fetch of the active set — never from an
 * error fallback, or a transient failure would wrongly wipe known-good state.
 * Best-effort; never throws.
 *
 * This is also the daemon's only observation point for "a connector became
 * connected": Composio owns the OAuth callback, so no in-daemon success
 * handler exists and every path that learns about a connection lands here.
 * Watcher auto-provisioning therefore hangs off this function rather than off
 * the connect route — see `watcher/auto-provision.ts`.
 */
export function recordActiveComposioToolkits(slugs: Iterable<string>): void {
  let active: string[];
  try {
    active = [
      ...new Set(
        [...slugs].filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        ),
      ),
    ].sort();
    state = { version: 1, activeToolkits: active, refreshedAt: Date.now() };
    persist();
  } catch (err) {
    log.warn({ err }, "recordActiveComposioToolkits failed");
    return;
  }

  // Stand up default watchers for newly connected watchable connectors. Kept
  // strictly downstream of the snapshot write so a provisioning failure can
  // never cost us the status update the rest of the daemon reads.
  //
  // Imported lazily and on purpose. This module is read on the capability /
  // system-prompt hot path by callers that have no business pulling in the
  // watcher store (and its DB schema) just to ask which toolkits are live.
  // Fire-and-forget: provisioning is never something a status write waits on.
  void import("../watcher/auto-provision.js")
    .then((m) => m.autoProvisionWatchersForToolkits(active))
    .catch((err: unknown) => {
      log.warn({ err }, "watcher auto-provision from connection status failed");
    });
}

/**
 * The known-ACTIVE toolkit snapshot, or null when nothing has ever been
 * learned (cold cache). `active` is the set of ACTIVE toolkit slugs; a slug's
 * ABSENCE from a non-null snapshot is positive evidence it is NOT active.
 */
export function getComposioConnectionStatus(): {
  active: Set<string>;
  refreshedAt: number;
} | null {
  const s = load();
  if (!s) return null;
  return { active: new Set(s.activeToolkits), refreshedAt: s.refreshedAt };
}

/**
 * Per-toolkit connection verdict, decided from the cached snapshot alone:
 *  · `active`  — the snapshot is known and lists this toolkit.
 *  · `broken`  — the snapshot is known and this toolkit is ABSENT (enabled in
 *                config but not ACTIVE at Composio: initiated/expired/removed).
 *  · `unknown` — no snapshot yet (cold cache): we genuinely cannot tell.
 */
export type ToolkitStatus = "active" | "broken" | "unknown";

export function composioToolkitStatus(slug: string): ToolkitStatus {
  const snapshot = getComposioConnectionStatus();
  if (!snapshot) return "unknown";
  return snapshot.active.has(slug.trim().toLowerCase()) ? "active" : "broken";
}

// ---------------------------------------------------------------------------
// Background refresh — single-flight, TTL-bounded, fire-and-forget.
// ---------------------------------------------------------------------------

let inFlight = false;

interface Creds {
  apiKey: string;
  userId: string;
}

function readCreds(): Creds | null {
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  if (!ws) return null;
  try {
    const raw = JSON.parse(
      readFileSync(join(ws, "connectors.json"), "utf8"),
    ) as { composioApiKey?: string; userId?: string };
    return raw.composioApiKey && raw.userId
      ? { apiKey: raw.composioApiKey, userId: raw.userId }
      : null;
  } catch {
    return null;
  }
}

/**
 * If the snapshot is missing or older than {@link STATUS_REFRESH_TTL_MS}, kick
 * a background refresh from Composio's active connected-accounts. Returns
 * immediately; concurrent callers share one refresh. Never blocks, never
 * throws — a hot-path reader can call this freely and read the (possibly still
 * stale) snapshot synchronously afterwards.
 */
export function kickComposioStatusRefresh(
  fetchImpl: typeof fetch = fetch,
): void {
  try {
    if (inFlight) return;
    const snapshot = getComposioConnectionStatus();
    if (snapshot && Date.now() - snapshot.refreshedAt < STATUS_REFRESH_TTL_MS) {
      return;
    }
    const creds = readCreds();
    if (!creds) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetchImpl(
          `${COMPOSIO_CONNECTED_ACCOUNTS_URL}?user_ids=${encodeURIComponent(
            creds.userId,
          )}&statuses=ACTIVE&limit=100`,
          {
            headers: { "x-api-key": creds.apiKey },
            signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
          },
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          items?: Array<{ toolkit?: { slug?: string }; user_id?: unknown }>;
        };
        // Ownership is verified, not assumed — see `selectOwnedAccounts`. This
        // snapshot drives "which accounts are linked", so a foreign row here
        // would make the model believe it can act on someone else's account.
        const slugs = selectOwnedAccounts(
          data.items ?? [],
          creds.userId,
          "composioStatusRefresh",
        )
          .map((c) => c.toolkit?.slug)
          .filter((s): s is string => typeof s === "string" && s.length > 0);
        recordActiveComposioToolkits(slugs);
      } catch (err) {
        log.debug({ err: String(err) }, "composio status refresh failed");
      } finally {
        inFlight = false;
      }
    })();
  } catch (err) {
    log.debug({ err: String(err) }, "kickComposioStatusRefresh failed");
    inFlight = false;
  }
}

/** Test hook: drop in-memory state so the next read reloads from disk. */
export function resetComposioConnectionStatusForTest(): void {
  state = null;
  inFlight = false;
}
