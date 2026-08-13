import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

import type { PluginInspection } from "../../cli/lib/inspect-plugin.js";
import {
  isAutoUpdateEnabled,
  listAutoUpdatePlugins,
  type PluginAutoUpdateDeps,
  runPluginAutoUpdateSweepIfDue,
  setAutoUpdateEnabled,
  tracksCuratedSource,
} from "../auto-update.js";

let pluginsDir: string;
let dataDir: string;

function writePlugin(name: string): void {
  const dir = join(pluginsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
}

function inspection(
  name: string,
  status: PluginInspection["status"],
  opts: {
    sourceRepo?: string;
    sourcePath?: string;
    remoteRepo?: string;
    remotePath?: string;
  } = {},
): PluginInspection {
  const local =
    status === "not-installed"
      ? null
      : ({
          target: join(pluginsDir, name),
          commit: "a".repeat(40),
          committedAt: null,
          version: "1.0.0",
          description: null,
          installedAt: null,
          source: opts.sourceRepo
            ? {
                kind: "github",
                owner: opts.sourceRepo.split("/")[0]!,
                repo: opts.sourceRepo.split("/")[1]!,
                path: opts.sourcePath,
                ref: "a".repeat(40),
              }
            : null,
          localChanges: null,
          issues: [],
        } as unknown as PluginInspection["local"]);
  const remote =
    status === "not-in-marketplace" || status === "remote-unavailable"
      ? null
      : ({
          repo: opts.remoteRepo ?? "curated/repo",
          path: opts.remotePath ?? "",
          commit: "b".repeat(40),
          committedAt: null,
          description: null,
          homepage: null,
          license: null,
          category: null,
          marketplaceRef: "main",
        } as unknown as PluginInspection["remote"]);
  return {
    name,
    installed: status !== "not-installed",
    status,
    local,
    remote,
    remoteError: null,
  } as PluginInspection;
}

interface Recorded {
  installed: string[];
  reloaded: string[];
  reconciled: number;
}

function makeDeps(
  inspections: Record<string, PluginInspection>,
  recorded: Recorded,
  overrides: Partial<PluginAutoUpdateDeps> = {},
): PluginAutoUpdateDeps {
  return {
    workspacePluginsDir: pluginsDir,
    dataDir,
    inspectPlugin: (async (opts: { name: string }) => {
      const found = inspections[opts.name];
      if (!found) throw new Error(`no inspection for ${opts.name}`);
      return found;
    }) as PluginAutoUpdateDeps["inspectPlugin"],
    installPlugin: (async (opts: { name: string }) => {
      recorded.installed.push(opts.name);
      return {
        name: opts.name,
        target: join(pluginsDir, opts.name),
        fileCount: 1,
        ref: "b".repeat(40),
        commit: "b".repeat(40),
        committedAt: null,
      };
    }) as unknown as PluginAutoUpdateDeps["installPlugin"],
    reloadPlugin: async (name: string) => {
      recorded.reloaded.push(name);
    },
    reconcileSchedules: async () => {
      recorded.reconciled += 1;
    },
    ...overrides,
  };
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "plugin-auto-update-"));
  pluginsDir = join(root, "plugins");
  dataDir = join(root, "plugins-data");
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
});

describe("opt-in store", () => {
  test("nothing is opted in by default", () => {
    expect(isAutoUpdateEnabled("alpha", dataDir)).toBe(false);
    expect(listAutoUpdatePlugins(dataDir)).toEqual([]);
  });

  test("set/unset round-trips and lists only deliberate opt-ins", () => {
    setAutoUpdateEnabled("alpha", true, dataDir);
    setAutoUpdateEnabled("beta", true, dataDir);
    expect(isAutoUpdateEnabled("alpha", dataDir)).toBe(true);
    expect(listAutoUpdatePlugins(dataDir)).toEqual(["alpha", "beta"]);
    setAutoUpdateEnabled("alpha", false, dataDir);
    expect(isAutoUpdateEnabled("alpha", dataDir)).toBe(false);
    expect(listAutoUpdatePlugins(dataDir)).toEqual(["beta"]);
  });

  test("a corrupt opt-in file opts nothing in", () => {
    writeFileSync(join(dataDir, "plugin-auto-update.json"), "{ broken");
    expect(isAutoUpdateEnabled("alpha", dataDir)).toBe(false);
  });
});

describe("tracksCuratedSource", () => {
  test("no recorded source does not disqualify (re-pin records provenance)", () => {
    expect(tracksCuratedSource(inspection("a", "unknown-provenance"))).toBe(
      true,
    );
  });

  test("matching source repo and path qualifies", () => {
    expect(
      tracksCuratedSource(
        inspection("a", "update-available", {
          sourceRepo: "curated/repo",
          remoteRepo: "curated/repo",
        }),
      ),
    ).toBe(true);
  });

  test("a direct install squatting on a curated name is rejected", () => {
    expect(
      tracksCuratedSource(
        inspection("a", "update-available", {
          sourceRepo: "attacker/other",
          remoteRepo: "curated/repo",
        }),
      ),
    ).toBe(false);
  });

  test("a plugin-root path mismatch is rejected", () => {
    expect(
      tracksCuratedSource(
        inspection("a", "update-available", {
          sourceRepo: "curated/repo",
          sourcePath: "elsewhere",
          remoteRepo: "curated/repo",
          remotePath: "plugins/a",
        }),
      ),
    ).toBe(false);
  });
});

describe("runPluginAutoUpdateSweepIfDue", () => {
  test("upgrades an opted-in, catalog-pinned plugin with drift, then reloads and reconciles", async () => {
    writePlugin("alpha");
    setAutoUpdateEnabled("alpha", true, dataDir);
    const recorded: Recorded = { installed: [], reloaded: [], reconciled: 0 };
    const result = await runPluginAutoUpdateSweepIfDue(
      makeDeps(
        {
          alpha: inspection("alpha", "update-available", {
            sourceRepo: "curated/repo",
            remoteRepo: "curated/repo",
          }),
        },
        recorded,
      ),
    );
    expect(result.skipped).toBeNull();
    expect(result.upgraded).toEqual(["alpha"]);
    expect(recorded.installed).toEqual(["alpha"]);
    expect(recorded.reloaded).toEqual(["alpha"]);
    expect(recorded.reconciled).toBe(1);
  });

  test("plugins that are not opted in are never touched", async () => {
    writePlugin("alpha");
    const recorded: Recorded = { installed: [], reloaded: [], reconciled: 0 };
    const result = await runPluginAutoUpdateSweepIfDue(
      makeDeps({ alpha: inspection("alpha", "update-available") }, recorded),
    );
    expect(result.skipped).toBe("no-candidates");
    expect(recorded.installed).toEqual([]);
  });

  test("direct-GitHub installs (not-in-marketplace) are excluded even when opted in", async () => {
    writePlugin("direct");
    setAutoUpdateEnabled("direct", true, dataDir);
    const recorded: Recorded = { installed: [], reloaded: [], reconciled: 0 };
    const result = await runPluginAutoUpdateSweepIfDue(
      makeDeps(
        { direct: inspection("direct", "not-in-marketplace") },
        recorded,
      ),
    );
    expect(result.skippedUntrusted).toEqual(["direct"]);
    expect(recorded.installed).toEqual([]);
  });

  test("a name-squatting direct install is excluded", async () => {
    writePlugin("squat");
    setAutoUpdateEnabled("squat", true, dataDir);
    const recorded: Recorded = { installed: [], reloaded: [], reconciled: 0 };
    const result = await runPluginAutoUpdateSweepIfDue(
      makeDeps(
        {
          squat: inspection("squat", "update-available", {
            sourceRepo: "attacker/other",
            remoteRepo: "curated/repo",
          }),
        },
        recorded,
      ),
    );
    expect(result.skippedUntrusted).toEqual(["squat"]);
    expect(recorded.installed).toEqual([]);
  });

  test("unknown-provenance installs are re-pinned; up-to-date and remote-unavailable are skipped", async () => {
    writePlugin("mystery");
    writePlugin("current");
    writePlugin("offline");
    for (const name of ["mystery", "current", "offline"]) {
      setAutoUpdateEnabled(name, true, dataDir);
    }
    const recorded: Recorded = { installed: [], reloaded: [], reconciled: 0 };
    const result = await runPluginAutoUpdateSweepIfDue(
      makeDeps(
        {
          mystery: inspection("mystery", "unknown-provenance"),
          current: inspection("current", "up-to-date", {
            sourceRepo: "curated/repo",
            remoteRepo: "curated/repo",
          }),
          offline: inspection("offline", "remote-unavailable"),
        },
        recorded,
      ),
    );
    expect(result.upgraded).toEqual(["mystery"]);
    expect(recorded.installed).toEqual(["mystery"]);
  });

  test("a disabled plugin is left alone even when opted in", async () => {
    writePlugin("off");
    writeFileSync(join(pluginsDir, "off", ".disabled"), "");
    setAutoUpdateEnabled("off", true, dataDir);
    const recorded: Recorded = { installed: [], reloaded: [], reconciled: 0 };
    const result = await runPluginAutoUpdateSweepIfDue(
      makeDeps({ off: inspection("off", "update-available") }, recorded),
    );
    expect(result.skipped).toBe("no-candidates");
    expect(recorded.installed).toEqual([]);
  });

  test("one plugin's failure does not block the rest", async () => {
    writePlugin("bad");
    writePlugin("good");
    setAutoUpdateEnabled("bad", true, dataDir);
    setAutoUpdateEnabled("good", true, dataDir);
    const recorded: Recorded = { installed: [], reloaded: [], reconciled: 0 };
    const deps = makeDeps(
      {
        bad: inspection("bad", "update-available", {
          sourceRepo: "curated/repo",
          remoteRepo: "curated/repo",
        }),
        good: inspection("good", "update-available", {
          sourceRepo: "curated/repo",
          remoteRepo: "curated/repo",
        }),
      },
      recorded,
    );
    const failingInstall = (async (opts: { name: string }) => {
      if (opts.name === "bad") {
        throw new Error("catalog entry vanished");
      }
      recorded.installed.push(opts.name);
      return {
        name: opts.name,
        target: join(pluginsDir, opts.name),
        fileCount: 1,
        ref: "b".repeat(40),
        commit: "b".repeat(40),
        committedAt: null,
      };
    }) as unknown as PluginAutoUpdateDeps["installPlugin"];
    const result = await runPluginAutoUpdateSweepIfDue({
      ...deps,
      installPlugin: failingInstall,
    });
    expect(result.failed).toEqual(["bad"]);
    expect(result.upgraded).toEqual(["good"]);
    expect(recorded.installed).toEqual(["good"]);
  });

  test("the worker tick honors the interval: a fresh stamp skips, a stale one runs", async () => {
    writePlugin("alpha");
    setAutoUpdateEnabled("alpha", true, dataDir);
    const recorded: Recorded = { installed: [], reloaded: [], reconciled: 0 };
    const deps = makeDeps(
      {
        alpha: inspection("alpha", "update-available", {
          sourceRepo: "curated/repo",
          remoteRepo: "curated/repo",
        }),
      },
      recorded,
    );

    const first = await runPluginAutoUpdateSweepIfDue(deps);
    expect(first.upgraded).toEqual(["alpha"]);

    // Immediately after a completed sweep, the stamp makes the next not-due.
    const second = await runPluginAutoUpdateSweepIfDue(deps);
    expect(second.skipped).toBe("not-due");
    expect(recorded.installed).toEqual(["alpha"]);

    // Age the stamp past the interval: the sweep runs again.
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(join(dataDir, "plugin-auto-update-last-run-at"), old, old);
    const third = await runPluginAutoUpdateSweepIfDue(deps);
    expect(third.skipped).toBeNull();
    expect(recorded.installed).toEqual(["alpha", "alpha"]);
  });
});
