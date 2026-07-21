/**
 * Connector health signals — the daemon-side record of whether connector
 * calls are ACTUALLY succeeding, per Composio toolkit slug.
 *
 * Two kinds of evidence land here:
 *  · passive signals — every authenticated call routed through the Composio
 *    request proxy (`oauth/composio-oauth.ts`) records success/failure as a
 *    side effect, so real usage keeps health fresh for free;
 *  · probe results — the connector-apps health probe
 *    (`runtime/routes/connector-health.ts`) stores its cheap liveness-check
 *    outcomes so a restart doesn't forget the last verdict.
 *
 * Persisted to `connector-health.json` in the workspace (same home as
 * `connectors.json`). Everything here is best-effort and never throws —
 * health is an observation layer, and a broken disk must not break
 * connector calls or the list route.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";

const log = getLogger("connector-health-store");

const FILE_NAME = "connector-health.json";
const MAX_ERROR_LEN = 200;
/** Throttle pure-success persists — a busy turn can fire many connector calls. */
const SUCCESS_PERSIST_MIN_MS = 30_000;

/** Passive per-slug signal from real connector traffic. Epoch-ms timestamps. */
export interface ConnectorSignal {
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastError?: string;
}

/**
 * One liveness-probe outcome. `"failed"` means the provider rejected auth
 * (the connection itself is broken); `"inconclusive"` means the probe could
 * not tell (Composio unreachable, timeout, provider 5xx) — inconclusive
 * probes must never flip a connector to "attention".
 */
export interface ConnectorProbeResult {
  checkedAt: number;
  status: "ok" | "failed" | "inconclusive";
  error?: string;
}

interface HealthFile {
  version: 1;
  signals: Record<string, ConnectorSignal>;
  probes: Record<string, ConnectorProbeResult>;
}

let state: HealthFile | null = null;
let lastSuccessPersistAt = 0;

function filePath(): string | null {
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  return ws ? join(ws, FILE_NAME) : null;
}

function load(): HealthFile {
  if (state) return state;
  const path = filePath();
  if (path) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as HealthFile;
      if (
        raw !== null &&
        typeof raw === "object" &&
        raw.version === 1 &&
        typeof raw.signals === "object" &&
        typeof raw.probes === "object"
      ) {
        state = {
          version: 1,
          signals: raw.signals ?? {},
          probes: raw.probes ?? {},
        };
        return state;
      }
    } catch {
      // No file yet (fresh install) — start empty.
    }
  }
  state = { version: 1, signals: {}, probes: {} };
  return state;
}

function persist(): void {
  const path = filePath();
  if (!path || !state) return;
  try {
    writeFileSync(path, JSON.stringify(state));
  } catch (err) {
    log.warn({ err }, "connector-health persist failed");
  }
}

const clip = (s: string): string => s.slice(0, MAX_ERROR_LEN);

/** A connector call authenticated and reached the provider. */
export function recordConnectorSuccess(slug: string): void {
  try {
    const s = load();
    const prev = s.signals[slug];
    const hadError = prev?.lastErrorAt !== undefined;
    s.signals[slug] = { ...prev, lastSuccessAt: Date.now() };
    // Persist immediately when this clears a prior error (a state change the
    // UI cares about); otherwise throttle repeat-success writes.
    const now = Date.now();
    if (hadError || now - lastSuccessPersistAt >= SUCCESS_PERSIST_MIN_MS) {
      lastSuccessPersistAt = now;
      persist();
    }
  } catch (err) {
    log.warn({ err, slug }, "recordConnectorSuccess failed");
  }
}

/** A connector call failed in a connection-shaped way (auth/proxy failure). */
export function recordConnectorFailure(slug: string, error: string): void {
  try {
    const s = load();
    s.signals[slug] = {
      ...s.signals[slug],
      lastErrorAt: Date.now(),
      lastError: clip(error),
    };
    persist();
  } catch (err) {
    log.warn({ err, slug }, "recordConnectorFailure failed");
  }
}

/** Store a liveness-probe outcome (from the connector-apps health probe). */
export function recordConnectorProbe(
  slug: string,
  result: ConnectorProbeResult,
): void {
  try {
    const s = load();
    s.probes[slug] = {
      ...result,
      ...(result.error !== undefined ? { error: clip(result.error) } : {}),
    };
    persist();
  } catch (err) {
    log.warn({ err, slug }, "recordConnectorProbe failed");
  }
}

/** Current signals + probes (loaded from disk on first read). */
export function getConnectorHealthState(): {
  signals: Record<string, ConnectorSignal>;
  probes: Record<string, ConnectorProbeResult>;
} {
  try {
    const s = load();
    return { signals: s.signals, probes: s.probes };
  } catch (err) {
    log.warn({ err }, "getConnectorHealthState failed");
    return { signals: {}, probes: {} };
  }
}

/** Test hook: drop the in-memory state so the next read reloads from disk. */
export function resetConnectorHealthStoreForTest(): void {
  state = null;
  lastSuccessPersistAt = 0;
}
