/**
 * Reads the user's signed-in Cue session token from an open instance tab.
 *
 * ── Why this exists (Option A: read from the tab, not postMessage) ─────────
 * To pair with a REMOTE self-hosted instance the extension must present the
 * owner's live `actor_client_v1` session token to `POST /v1/pair/session`
 * (see pair-client.ts). The web SPA already persists that token in the Cue
 * tab's `localStorage` — the durable refresh credential the auth layer keeps so
 * a reopened tab can silently re-derive its gateway session (see
 * apps/web `lib/self-hosted/cue-self-host.ts`). Because the extension has
 * `<all_urls>` host permission and the `scripting` permission, it can read that
 * value directly out of the same-origin tab it already auto-detects.
 *
 * This is preferred over adding `externally_connectable` + a web-app
 * `postMessage` handshake because it needs NO new web surface, no per-environment
 * extension-id wiring in the web app, and no new inbound message channel into
 * the service worker. The token never leaves the user's machine except when the
 * caller then sends it to that SAME instance origin over HTTPS.
 *
 * ── Security properties ────────────────────────────────────────────────────
 *   - Read ONLY on an explicit user action (Connect / Pair in the popup) — this
 *     module never runs on a schedule or on tab events.
 *   - Read ONLY from a tab whose origin exactly matches the instance being
 *     paired; we never scrape tokens from arbitrary origins.
 *   - The injected reader runs in the default ISOLATED content-script world, so
 *     page JavaScript cannot observe or tamper with the read.
 *   - The value is returned to the caller and immediately exchanged for a narrow
 *     token; it is never logged, never written to extension storage, and never
 *     sent anywhere but its own origin's `/v1/pair/session` over HTTPS.
 *
 * The `localStorage` key names are a storage contract shared with the web SPA;
 * they stay `vellum`/`cue` exactly as the SPA writes them.
 */

import { normalizeOrigin } from "./instance-detect.js";

/**
 * `localStorage` keys the session token may live under, in preference order.
 *   - `cue:selfHost:actorToken` — the durable `actor_client_v1` refresh
 *     credential the self-host SPA persists (the canonical source).
 *   - `vellum:gw:token` — the active gateway-session slot; in self-host mode it
 *     holds the same actor token. A fallback for sessions seeded before the
 *     durable key existed (mirrors the SPA's own `getStoredActorToken`).
 */
export const SESSION_TOKEN_LS_KEYS = [
  "cue:selfHost:actorToken",
  "vellum:gw:token",
] as const;

/**
 * Given the values read for {@link SESSION_TOKEN_LS_KEYS} (in the same order),
 * pick the first that is a well-formed JWT. Pure — the unit of logic worth
 * testing without a live tab.
 */
export function pickSessionToken(
  values: Array<string | null | undefined>,
): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.split(".").length === 3) return v;
  }
  return null;
}

/**
 * From a set of open tabs, pick the id of one whose origin matches `origin`.
 * Prefers the earliest match (callers pass active/focused tabs first). Pure.
 */
export function pickTabIdForOrigin(
  tabs: ChromeTab[],
  origin: string,
): number | null {
  for (const t of tabs) {
    if (t.id === undefined || !t.url) continue;
    if (normalizeOrigin(t.url) === origin) return t.id;
  }
  return null;
}

/**
 * Injectable seam so the orchestration can be unit-tested without the real
 * `chrome.tabs` / `chrome.scripting` APIs.
 */
export interface SessionTokenReaderDeps {
  /** List tabs (defaults to `chrome.tabs.query`). */
  queryTabs: (query: ChromeTabsQueryInfo) => Promise<ChromeTab[]>;
  /** Read the given localStorage keys from a tab (defaults to scripting). */
  readLocalStorageKeys: (
    tabId: number,
    keys: readonly string[],
  ) => Promise<Array<string | null>>;
}

async function defaultReadLocalStorageKeys(
  tabId: number,
  keys: readonly string[],
): Promise<Array<string | null>> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    // Runs in the default ISOLATED world; localStorage is per-origin so the
    // injected function reads the host page's own store.
    func: (ks: string[]): Array<string | null> =>
      ks.map((k) => {
        try {
          return localStorage.getItem(k);
        } catch {
          return null;
        }
      }),
    args: [keys as string[]],
  });
  const first = results?.[0]?.result;
  return Array.isArray(first) ? (first as Array<string | null>) : [];
}

const defaultDeps: SessionTokenReaderDeps = {
  queryTabs: (query) => chrome.tabs.query(query),
  readLocalStorageKeys: defaultReadLocalStorageKeys,
};

/**
 * Read the signed-in Cue session token from an open tab whose origin matches
 * `origin`. Returns `null` when no matching tab is open or none of the tabs
 * carry a usable token (e.g. the user is signed out). Never throws; never logs
 * the token.
 */
export async function readActorSessionToken(
  origin: string,
  deps: SessionTokenReaderDeps = defaultDeps,
): Promise<string | null> {
  try {
    // Order the active/last-focused tab first so, when several instance tabs
    // are open, the one the user is looking at is preferred.
    const [active, all] = await Promise.all([
      deps.queryTabs({ active: true, lastFocusedWindow: true }),
      deps.queryTabs({}),
    ]);
    const seen = new Set<number>();
    const ordered: ChromeTab[] = [];
    for (const t of [...active, ...all]) {
      if (t.id === undefined || seen.has(t.id)) continue;
      seen.add(t.id);
      ordered.push(t);
    }
    const tabId = pickTabIdForOrigin(ordered, origin);
    if (tabId === null) return null;
    const values = await deps.readLocalStorageKeys(tabId, SESSION_TOKEN_LS_KEYS);
    return pickSessionToken(values);
  } catch {
    return null;
  }
}
