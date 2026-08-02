/**
 * Tests for watcher auto-provisioning.
 *
 * Strategy: stub the watcher store, the provider registry and the config
 * loader via `mock.module()` so the unit under test is the provisioning
 * decision itself, not SQLite. The ledger uses the real filesystem — it is
 * the durability guarantee that keeps a deleted watcher deleted, so mocking
 * it away would test nothing.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { WatchersConfigSchema } from "../../config/schemas/watchers.js";

// ── Fixtures ──────────────────────────────────────────────────────────

interface CreatedWatcher {
  id: string;
  name: string;
  providerId: string;
  credentialService: string;
  actionPrompt: string;
  pollIntervalMs: number;
  configJson: string | null;
  intakeMode: string;
  createdAt: number;
}

let existingWatchers: Array<{ id: string; providerId: string }> = [];
let created: CreatedWatcher[] = [];
let createThrows = false;
let registeredProviders = new Set<string>();
let autoProvisionConfig = { enabled: true, minPollIntervalMs: 300_000 };
let configThrows = false;
let listThrows = false;

let seq = 0;

// ── Module mocks ──────────────────────────────────────────────────────

// `mock.module` is process-global AND replaces the module wholesale, so a
// factory listing only the seams it overrides deletes every other export for
// every later test file in the run — they fail at import with "Export named X
// not found", nowhere near the file that caused it. Spread the real module so
// this narrows exactly the two functions it names.
const realWatcherStore = await import("../watcher-store.js");
mock.module("../watcher-store.js", () => ({
  ...realWatcherStore,
  listWatchers: () => {
    if (listThrows) throw new Error("db unavailable");
    return existingWatchers;
  },
  createWatcher: (params: {
    name: string;
    providerId: string;
    credentialService: string;
    actionPrompt: string;
    pollIntervalMs?: number;
    configJson?: string | null;
    intakeMode?: string;
  }) => {
    if (createThrows) throw new Error("insert failed");
    const row: CreatedWatcher = {
      id: `w-${++seq}`,
      name: params.name,
      providerId: params.providerId,
      credentialService: params.credentialService,
      actionPrompt: params.actionPrompt,
      pollIntervalMs: params.pollIntervalMs ?? 60_000,
      configJson: params.configJson ?? null,
      intakeMode: params.intakeMode ?? "came_in",
      createdAt: Date.now(),
    };
    created.push(row);
    existingWatchers.push({ id: row.id, providerId: row.providerId });
    return row;
  },
}));

const realProviderRegistry = await import("../provider-registry.js");
mock.module("../provider-registry.js", () => ({
  ...realProviderRegistry,
  getWatcherProvider: (id: string) =>
    registeredProviders.has(id) ? { id } : undefined,
}));

// `mock.module` is process-global, so this factory is what EVERY later test
// file in the same run sees. Returning a hand-built `watchers` object with only
// `autoProvision` on it is therefore not a local shortcut — it silently
// rewrites config for unrelated suites. It did exactly that: the arrival
// relevance gate reads `watchers.relevanceGate`, found it missing, and its
// integration tests passed against a *disabled* gate without saying so.
//
// Build the rest from the real schema defaults so this mock narrows exactly one
// key and nothing else.
const watchersDefaults = WatchersConfigSchema.parse({});
mock.module("../../config/loader.js", () => ({
  getConfig: () => {
    if (configThrows) throw new Error("no config");
    return {
      watchers: { ...watchersDefaults, autoProvision: autoProvisionConfig },
    };
  },
}));

const { autoProvisionWatchersForToolkits, resetAutoProvisionLedgerForTest } =
  await import("../auto-provision.js");

// ── Helpers ───────────────────────────────────────────────────────────

function ledgerFile(): string {
  return join(process.env.VELLUM_WORKSPACE_DIR!, "watcher-auto-provision.json");
}

beforeEach(() => {
  existingWatchers = [];
  created = [];
  createThrows = false;
  listThrows = false;
  configThrows = false;
  registeredProviders = new Set(["gmail", "google-calendar"]);
  autoProvisionConfig = { enabled: true, minPollIntervalMs: 300_000 };
  resetAutoProvisionLedgerForTest();
  if (existsSync(ledgerFile())) rmSync(ledgerFile());
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("autoProvisionWatchersForToolkits", () => {
  test("creates a Gmail watcher when the gmail connector is connected", () => {
    const result = autoProvisionWatchersForToolkits(["gmail"]);

    expect(result.created).toEqual(["gmail"]);
    expect(created).toHaveLength(1);
    const watcher = created[0]!;
    expect(watcher.providerId).toBe("gmail");
    expect(watcher.credentialService).toBe("google");
    // The Came-in lane is the whole point — an 'agent' watcher would run a
    // background LLM job per tick instead of filing work items.
    expect(watcher.intakeMode).toBe("came_in");
    expect(JSON.parse(watcher.configJson!)).toMatchObject({
      autoProvisioned: true,
      connectorSlug: "gmail",
    });
  });

  test("provisions each watchable connector at its own cadence", () => {
    autoProvisionWatchersForToolkits(["gmail", "googlecalendar"]);

    const byProvider = new Map(created.map((w) => [w.providerId, w]));
    // 5 min for mail, 15 min for calendar — never the 60s store default.
    expect(byProvider.get("gmail")!.pollIntervalMs).toBe(300_000);
    expect(byProvider.get("google-calendar")!.pollIntervalMs).toBe(900_000);
  });

  test("ignores connectors with no watcher mapping", () => {
    const result = autoProvisionWatchersForToolkits([
      "googledrive",
      "youtube",
      "stripe",
    ]);

    expect(result.created).toEqual([]);
    expect(created).toHaveLength(0);
  });

  test("refuses to create a watcher whose provider is not registered", () => {
    // Slack is a mapped connector but has no watcher provider today. Creating
    // one would fail every poll with "Unknown provider" and trip the circuit
    // breaker, leaving the user a broken automation they never asked for.
    const result = autoProvisionWatchersForToolkits(["slack"]);

    expect(created).toHaveLength(0);
    expect(result.skipped).toEqual([
      { slug: "slack", reason: 'no watcher provider registered for "slack"' },
    ]);
    // Not ledgered — the moment a Slack provider is registered, it provisions.
    registeredProviders.add("slack");
    resetAutoProvisionLedgerForTest();
    expect(autoProvisionWatchersForToolkits(["slack"]).created).toEqual([
      "slack",
    ]);
  });

  test("is idempotent across repeated observations of the same connector", () => {
    autoProvisionWatchersForToolkits(["gmail"]);
    autoProvisionWatchersForToolkits(["gmail"]);
    autoProvisionWatchersForToolkits(["gmail", "googlecalendar"]);

    expect(created.filter((w) => w.providerId === "gmail")).toHaveLength(1);
    expect(created).toHaveLength(2);
  });

  test("survives a daemon restart without duplicating (ledger is on disk)", () => {
    autoProvisionWatchersForToolkits(["gmail"]);
    expect(created).toHaveLength(1);

    // Restart: in-memory ledger gone, DB gone (fresh mock store).
    resetAutoProvisionLedgerForTest();
    existingWatchers = [];

    const result = autoProvisionWatchersForToolkits(["gmail"]);
    expect(result.created).toEqual([]);
    expect(created).toHaveLength(1);
  });

  test("a deleted watcher stays deleted — reconnect does not resurrect it", () => {
    autoProvisionWatchersForToolkits(["gmail"]);
    // User deletes it in Automations.
    existingWatchers = [];
    // Connector drops out and comes back.
    autoProvisionWatchersForToolkits([]);
    const result = autoProvisionWatchersForToolkits(["gmail"]);

    expect(result.created).toEqual([]);
    expect(created).toHaveLength(1);
  });

  test("adopts a hand-made watcher instead of stacking a second one", () => {
    existingWatchers = [{ id: "hand-made", providerId: "gmail" }];

    const result = autoProvisionWatchersForToolkits(["gmail"]);

    expect(result.adopted).toEqual(["gmail"]);
    expect(created).toHaveLength(0);
    // And the adoption is durable.
    resetAutoProvisionLedgerForTest();
    existingWatchers = [];
    expect(autoProvisionWatchersForToolkits(["gmail"]).created).toEqual([]);
  });

  test("does nothing when auto-provisioning is disabled in config", () => {
    autoProvisionConfig = { enabled: false, minPollIntervalMs: 300_000 };

    const result = autoProvisionWatchersForToolkits(["gmail"]);

    expect(result.created).toEqual([]);
    expect(created).toHaveLength(0);
    // Nothing ledgered either — flipping the flag back on still provisions.
    autoProvisionConfig = { enabled: true, minPollIntervalMs: 300_000 };
    expect(autoProvisionWatchersForToolkits(["gmail"]).created).toEqual([
      "gmail",
    ]);
  });

  test("respects the configured minimum poll interval floor", () => {
    autoProvisionConfig = { enabled: true, minPollIntervalMs: 30 * 60_000 };

    autoProvisionWatchersForToolkits(["gmail", "googlecalendar"]);

    for (const watcher of created) {
      expect(watcher.pollIntervalMs).toBe(30 * 60_000);
    }
  });

  test("a failed create is not ledgered, so the next observation retries", () => {
    createThrows = true;
    expect(autoProvisionWatchersForToolkits(["gmail"]).created).toEqual([]);

    createThrows = false;
    expect(autoProvisionWatchersForToolkits(["gmail"]).created).toEqual([
      "gmail",
    ]);
  });

  test("degrades quietly when config or the watcher store is unavailable", () => {
    configThrows = true;
    expect(() => autoProvisionWatchersForToolkits(["gmail"])).not.toThrow();
    expect(created).toHaveLength(0);

    configThrows = false;
    listThrows = true;
    expect(() => autoProvisionWatchersForToolkits(["gmail"])).not.toThrow();
    expect(created).toHaveLength(0);
  });
});

// ── The hook point ────────────────────────────────────────────────────

describe("recordActiveComposioToolkits hook", () => {
  test("observing an active connector set provisions its watchers", async () => {
    const {
      recordActiveComposioToolkits,
      resetComposioConnectionStatusForTest,
    } = await import("../../capabilities/composio-connection-status.js");
    resetComposioConnectionStatusForTest();

    // Exactly the shape production reports today.
    recordActiveComposioToolkits([
      "github",
      "gmail",
      "google_maps",
      "googlecalendar",
      "googledocs",
      "googledrive",
      "googlesheets",
      "slack",
      "youtube",
    ]);
    // The hook is fire-and-forget behind a lazy import (the status write must
    // never wait on provisioning) — let the microtask queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(created.map((w) => w.providerId).sort()).toEqual([
      "gmail",
      "google-calendar",
    ]);

    // And the status snapshot it primarily exists to write is untouched.
    const { getComposioConnectionStatus } =
      await import("../../capabilities/composio-connection-status.js");
    expect(getComposioConnectionStatus()?.active.has("gmail")).toBe(true);
  });
});
