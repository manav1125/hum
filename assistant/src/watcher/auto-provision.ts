/**
 * Auto-provision watchers when a connector is connected.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 * The watcher engine, the Gmail/Calendar providers, the Came-in intake and the
 * playbook layer were all built and shipped — and the `watchers` table has zero
 * rows in production. Nothing ever *creates* a watcher. `createWatcher` is
 * reachable only from the Automations UI route and the `assistant watchers
 * create` CLI, so a user who connects Gmail gets an assistant that can answer
 * questions about their inbox when asked, and notices nothing on its own.
 * Connecting a source is the moment the user says "this is my work" — that is
 * the moment a watcher should exist.
 *
 * ── Where this hooks in ────────────────────────────────────────────────────
 * There is no in-daemon "Composio connection completed" callback: the connect
 * route hands the user a Composio redirect URL and Composio owns the callback.
 * The daemon only ever LEARNS about a connection by observing the active
 * connected-accounts set, and every one of those observations funnels through
 * `recordActiveComposioToolkits()` (see
 * `capabilities/composio-connection-status.ts`) — the Connectors-page fetch,
 * the OAuth request proxy's `activeToolkits()`, and the background
 * status refresh. That single choke point is the hook: whatever path noticed
 * the connection, provisioning runs there.
 *
 * Because the hook is "the current active set" rather than an edge-triggered
 * event, it also back-fills installs whose connectors were connected before
 * this code existed — which is every install today.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 * Two independent guards, because they answer different questions:
 *  1. A durable ledger (`watcher-auto-provision.json` in the workspace) records
 *     every slug we have ever provisioned. This is what makes DELETION stick:
 *     if the user deletes the auto-created watcher, the row is gone from the
 *     DB but the ledger entry remains, so we never resurrect it. Without this,
 *     "delete the watcher" would be undone within five minutes.
 *  2. A live scan of existing watchers for the same provider. This covers the
 *     user who hand-built a Gmail watcher in Automations before connecting —
 *     we adopt it into the ledger instead of creating a second one.
 *
 * ── Disconnect behaviour (deliberate) ──────────────────────────────────────
 * When a toolkit drops out of the active set we do NOTHING. Deleting the
 * watcher would destroy user edits (renamed, re-timed, bound playbooks point
 * at `watcher_id`) over what is often a transient state, and a re-connect
 * would then start from a fresh watermark and replay the inbox. Instead the
 * watcher goes dormant on its own: the engine's pre-poll credential gate finds
 * neither a native connection nor an active toolkit and calls
 * `skipWatcherPoll`, which applies backoff WITHOUT incrementing
 * `consecutive_errors` — so the circuit breaker never trips and the watcher is
 * never auto-disabled by a disconnect. The Automations UI already renders this
 * as `not_connected`. Reconnecting resumes it on the next tick, watermark
 * intact, and the ledger stops us creating a duplicate.
 *
 * ── Turning it off ─────────────────────────────────────────────────────────
 *  · `watchers.autoProvision.enabled = false` — never provision anything.
 *  · Disable the watcher in Automations — `enabled = 0`; the ledger entry
 *    already exists, so nothing re-creates or re-enables it.
 *  · Delete the watcher — the ledger entry keeps it deleted, permanently.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { getWatcherProvider } from "./provider-registry.js";
import { createWatcher, listWatchers } from "./watcher-store.js";

const log = getLogger("watcher-auto-provision");

const LEDGER_FILENAME = "watcher-auto-provision.json";

// ---------------------------------------------------------------------------
// What gets a watcher, and how often it polls
// ---------------------------------------------------------------------------

export interface ConnectorWatcherDefault {
  /** Registered watcher provider id (see `daemon/providers-setup.ts`). */
  providerId: string;
  /** Credential service the provider authenticates with. */
  credentialService: string;
  /** Name the watcher gets in the Automations list. */
  name: string;
  /** Poll cadence — see the per-entry justification below. */
  pollIntervalMs: number;
}

const MINUTE = 60_000;

/**
 * Composio toolkit slug → the watcher we stand up for it.
 *
 * Cadence rationale. The store default is 60s and the Automations route
 * already picked 5min for hand-made watchers; an auto-provisioned watcher is
 * one the user never explicitly asked for, so it must be at least as cheap.
 * Every poll is an upstream call through the Composio request proxy, and every
 * hit it returns fans out into a Came-in work item plus playbook evaluation —
 * the LLM fan-out, not the HTTP call, is what a tight interval actually costs.
 *
 *  · gmail (5 min) — matches the Automations default. Email is the one source
 *    where latency is visible to the user, but a five-minute-old email is
 *    still a fresh email; 60s would mean 1,440 polls/day for a signal whose
 *    value does not decay inside a minute.
 *  · googlecalendar (15 min) — calendar events are scheduled hours or days
 *    ahead, so detection latency is nearly free. Three times lazier than
 *    Gmail for a source that changes a few times a day.
 *  · slack (5 min) — parity with Gmail: messages are conversational. Inert
 *    today; see the provider-registration guard below.
 */
export const CONNECTOR_WATCHER_DEFAULTS: Readonly<
  Record<string, ConnectorWatcherDefault>
> = {
  gmail: {
    providerId: "gmail",
    credentialService: "google",
    name: "Gmail — new mail",
    pollIntervalMs: 5 * MINUTE,
  },
  googlecalendar: {
    providerId: "google-calendar",
    credentialService: "google",
    name: "Google Calendar — schedule changes",
    pollIntervalMs: 15 * MINUTE,
  },
  slack: {
    providerId: "slack",
    credentialService: "slack",
    name: "Slack — new messages",
    pollIntervalMs: 5 * MINUTE,
  },
};

// ---------------------------------------------------------------------------
// Ledger — "we have already provisioned this slug once, ever"
// ---------------------------------------------------------------------------

interface LedgerEntry {
  /** Watcher row created (or adopted) for this slug. */
  watcherId: string;
  provisionedAt: number;
  /** True when we adopted a pre-existing watcher rather than creating one. */
  adopted?: boolean;
}

interface LedgerFile {
  version: 1;
  entries: Record<string, LedgerEntry>;
}

let ledgerMemo: LedgerFile | null = null;

function ledgerPath(): string | null {
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  return ws ? join(ws, LEDGER_FILENAME) : null;
}

function readLedger(): LedgerFile {
  if (ledgerMemo) return ledgerMemo;
  const path = ledgerPath();
  const empty: LedgerFile = { version: 1, entries: {} };
  if (!path) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
    if (
      raw !== null &&
      typeof raw === "object" &&
      raw.version === 1 &&
      raw.entries !== null &&
      typeof raw.entries === "object"
    ) {
      ledgerMemo = { version: 1, entries: { ...raw.entries } };
      return ledgerMemo;
    }
  } catch {
    // No ledger yet (fresh install), or an unreadable one. Falling through to
    // the empty ledger is safe: the live watcher scan below still prevents a
    // duplicate for anything that currently exists.
  }
  ledgerMemo = empty;
  return ledgerMemo;
}

function writeLedgerEntry(slug: string, entry: LedgerEntry): void {
  const ledger = readLedger();
  ledger.entries[slug] = entry;
  ledgerMemo = ledger;
  const path = ledgerPath();
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(ledger));
  } catch (err) {
    // A ledger we cannot persist would let us re-create a deleted watcher on
    // the next daemon start, so this is worth a warn rather than a debug.
    log.warn({ err, slug }, "watcher auto-provision ledger write failed");
  }
}

/** Test hook: drop the in-memory ledger so the next read reloads from disk. */
export function resetAutoProvisionLedgerForTest(): void {
  ledgerMemo = null;
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export interface AutoProvisionResult {
  /** Toolkit slugs a watcher was created for on this call. */
  created: string[];
  /** Toolkit slugs whose pre-existing watcher was adopted into the ledger. */
  adopted: string[];
  /** Toolkit slugs considered but skipped, with the reason. */
  skipped: Array<{ slug: string; reason: string }>;
}

/**
 * Ensure every watchable connector in `activeSlugs` has a watcher.
 *
 * Synchronous and self-contained (one SELECT plus at most one INSERT per new
 * connector) so it can be called from the connection-status choke point
 * without making that path async. Never throws — the caller is a best-effort
 * status recorder and must not fail because provisioning did.
 */
export function autoProvisionWatchersForToolkits(
  activeSlugs: Iterable<string>,
): AutoProvisionResult {
  const result: AutoProvisionResult = {
    created: [],
    adopted: [],
    skipped: [],
  };

  let cfg: { enabled: boolean; minPollIntervalMs: number };
  try {
    cfg = getConfig().watchers.autoProvision;
  } catch {
    // Config unreadable (e.g. a process that never loaded one). Do nothing
    // rather than provision against an assumed default.
    return result;
  }
  if (!cfg.enabled) return result;

  const candidates = [...activeSlugs]
    .map((s) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
    .filter((s) => s.length > 0 && s in CONNECTOR_WATCHER_DEFAULTS);
  if (candidates.length === 0) return result;

  const ledger = readLedger();
  const pending = candidates.filter((slug) => !(slug in ledger.entries));
  if (pending.length === 0) return result;

  // One read for the whole batch — most calls find nothing pending and never
  // get here at all.
  let existing: Array<{ id: string; providerId: string }>;
  try {
    existing = listWatchers();
  } catch (err) {
    log.debug({ err: String(err) }, "watcher list unavailable — skipping");
    return result;
  }

  for (const slug of pending) {
    const spec = CONNECTOR_WATCHER_DEFAULTS[slug]!;

    // Someone already watches this provider (hand-made in Automations, or a
    // ledger that was lost). Adopt it so we never stack a second one.
    const already = existing.find((w) => w.providerId === spec.providerId);
    if (already) {
      writeLedgerEntry(slug, {
        watcherId: already.id,
        provisionedAt: Date.now(),
        adopted: true,
      });
      result.adopted.push(slug);
      continue;
    }

    // A watcher whose provider is not registered would fail every poll with
    // "Unknown provider", and five of those trip the circuit breaker and
    // auto-disable it — leaving the user a broken automation they never asked
    // for. Refuse to create it. This is the live state for Slack: the toolkit
    // is connectable and mapped above, but no Slack watcher provider exists
    // yet, so the entry stays inert until one is registered.
    if (!getWatcherProvider(spec.providerId)) {
      result.skipped.push({
        slug,
        reason: `no watcher provider registered for "${spec.providerId}"`,
      });
      continue;
    }

    try {
      const watcher = createWatcher({
        name: spec.name,
        providerId: spec.providerId,
        credentialService: spec.credentialService,
        // 'came_in' watchers carry their intent in the hit + playbooks; the
        // prompt only satisfies the NOT NULL column (see migration 313).
        actionPrompt: `Monitor ${spec.name}`,
        pollIntervalMs: Math.max(spec.pollIntervalMs, cfg.minPollIntervalMs),
        configJson: JSON.stringify({
          autoProvisioned: true,
          connectorSlug: slug,
        }),
        intakeMode: "came_in",
      });
      writeLedgerEntry(slug, {
        watcherId: watcher.id,
        provisionedAt: watcher.createdAt,
      });
      result.created.push(slug);
      log.info(
        {
          slug,
          watcherId: watcher.id,
          providerId: spec.providerId,
          pollIntervalMs: watcher.pollIntervalMs,
        },
        "Auto-provisioned a watcher for a newly connected connector",
      );
    } catch (err) {
      // Do NOT ledger a failed create — the next observation retries.
      log.warn({ err, slug }, "watcher auto-provision failed");
      result.skipped.push({ slug, reason: "create failed" });
    }
  }

  return result;
}
