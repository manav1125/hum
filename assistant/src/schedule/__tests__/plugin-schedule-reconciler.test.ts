import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

// Stub the background-wake publisher so these unit tests stay hermetic —
// `notifySchedulesChanged()` fires a debounced refresh on every mutation.
const actualBackgroundWake = await import("../../background-wake/publisher.js");
mock.module("../../background-wake/publisher.js", () => ({
  ...actualBackgroundWake,
  refreshBackgroundWakeIntent: () => {},
}));

// Drive the feature gate from the test rather than the flag registry.
let pluginSchedulesFlag = true;
const actualGate = await import("../plugin-schedules-gate.js");
mock.module("../plugin-schedules-gate.js", () => ({
  ...actualGate,
  isPluginSchedulesEnabled: () => pluginSchedulesFlag,
}));

// Capture definition-lifecycle notifications instead of running the
// pipeline.
const emitted: Array<{ sourceEventName: string; dedupeKey?: string }> = [];
const actualEmitSignal = await import("../../notifications/emit-signal.js");
mock.module("../../notifications/emit-signal.js", () => ({
  ...actualEmitSignal,
  emitNotificationSignal: async (params: {
    sourceEventName: string;
    dedupeKey?: string;
  }) => {
    emitted.push({
      sourceEventName: params.sourceEventName,
      dedupeKey: params.dedupeKey,
    });
    return { signalId: "s", deduplicated: false, dispatched: true };
  },
}));

import { initializeDb } from "../../memory/db-init.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  reconcilePluginSchedules,
  resetDefinitionErrorEmitGuardForTests,
  resetPluginSchedulesStateForTests,
} from "../plugin-schedule-reconciler.js";
import {
  deleteSchedule,
  getSchedule,
  listSchedules,
  type ScheduleJob,
  updateSchedule,
} from "../schedule-store.js";

initializeDb();

const pluginsDir = getWorkspacePluginsDir();

function writePlugin(name: string): string {
  const dir = join(pluginsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  return dir;
}

function writeDeclaration(
  pluginName: string,
  scheduleName: string,
  files: Record<string, string>,
): string {
  const dir = join(pluginsDir, pluginName, "schedules", scheduleName);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function declaredRows(): ScheduleJob[] {
  return listSchedules().filter((j) => j.createdBy.startsWith("plugin:"));
}

const CONFIG = JSON.stringify({ expression: "0 9 * * *", description: "d" });

beforeEach(() => {
  pluginSchedulesFlag = true;
  emitted.length = 0;
  resetDefinitionErrorEmitGuardForTests();
  resetPluginSchedulesStateForTests();
  rmSync(pluginsDir, { recursive: true, force: true });
  mkdirSync(pluginsDir, { recursive: true });
});

describe("reconcilePluginSchedules", () => {
  test("creates a schedule row from a declaration and is idempotent", async () => {
    writePlugin("alpha");
    writeDeclaration("alpha", "digest", {
      "config.json": CONFIG,
      "index.md": "Summarize.",
    });

    await reconcilePluginSchedules();
    const rows = declaredRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.name).toBe("alpha/digest");
    expect(row.createdBy).toBe("plugin:alpha");
    expect(row.mode).toBe("execute");
    expect(row.message).toBe("Summarize.");
    expect(row.cronExpression).toBe("0 9 * * *");
    expect(row.enabled).toBe(true);
    expect(
      emitted.filter((e) => e.sourceEventName === "schedule.declared"),
    ).toHaveLength(1);

    // Second pass: no duplicate row, no re-notification.
    await reconcilePluginSchedules();
    expect(declaredRows()).toHaveLength(1);
    expect(declaredRows()[0]!.id).toBe(row.id);
    expect(
      emitted.filter((e) => e.sourceEventName === "schedule.declared"),
    ).toHaveLength(1);
  });

  test("a changed definition updates the row in place and notifies", async () => {
    writePlugin("alpha");
    writeDeclaration("alpha", "digest", {
      "config.json": CONFIG,
      "index.md": "v1",
    });
    await reconcilePluginSchedules();
    const id = declaredRows()[0]!.id;

    writeFileSync(
      join(pluginsDir, "alpha", "schedules", "digest", "index.md"),
      "v2",
    );
    await reconcilePluginSchedules();

    const rows = declaredRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.message).toBe("v2");
    expect(
      emitted.filter(
        (e) => e.sourceEventName === "schedule.definition_changed",
      ),
    ).toHaveLength(1);
  });

  test("a user's disable survives reconciles and definition updates", async () => {
    writePlugin("alpha");
    writeDeclaration("alpha", "digest", {
      "config.json": CONFIG,
      "index.md": "v1",
    });
    await reconcilePluginSchedules();
    const id = declaredRows()[0]!.id;

    updateSchedule(id, { enabled: false });
    await reconcilePluginSchedules();
    expect(getSchedule(id)!.enabled).toBe(false);

    writeFileSync(
      join(pluginsDir, "alpha", "schedules", "digest", "index.md"),
      "v2",
    );
    await reconcilePluginSchedules();
    const row = getSchedule(id)!;
    expect(row.enabled).toBe(false);
    expect(row.message).toBe("v2");
  });

  test("removing the declaration disarms the row (kept, not deleted); restoring re-arms it", async () => {
    writePlugin("alpha");
    writeDeclaration("alpha", "digest", {
      "config.json": CONFIG,
      "index.md": "v1",
    });
    await reconcilePluginSchedules();
    const id = declaredRows()[0]!.id;

    rmSync(join(pluginsDir, "alpha", "schedules"), {
      recursive: true,
      force: true,
    });
    await reconcilePluginSchedules();
    expect(getSchedule(id)!.enabled).toBe(false);

    writeDeclaration("alpha", "digest", {
      "config.json": CONFIG,
      "index.md": "v1",
    });
    await reconcilePluginSchedules();
    expect(getSchedule(id)!.enabled).toBe(true);
  });

  test("the feature flag is a kill switch: off disarms, on re-arms", async () => {
    writePlugin("alpha");
    writeDeclaration("alpha", "digest", {
      "config.json": CONFIG,
      "index.md": "v1",
    });
    await reconcilePluginSchedules();
    const id = declaredRows()[0]!.id;
    expect(getSchedule(id)!.enabled).toBe(true);

    pluginSchedulesFlag = false;
    await reconcilePluginSchedules();
    expect(getSchedule(id)!.enabled).toBe(false);

    pluginSchedulesFlag = true;
    await reconcilePluginSchedules();
    expect(getSchedule(id)!.enabled).toBe(true);
  });

  test("a disabled plugin's schedules disarm", async () => {
    writePlugin("alpha");
    writeDeclaration("alpha", "digest", {
      "config.json": CONFIG,
      "index.md": "v1",
    });
    await reconcilePluginSchedules();
    const id = declaredRows()[0]!.id;

    writeFileSync(join(pluginsDir, "alpha", ".disabled"), "");
    await reconcilePluginSchedules();
    expect(getSchedule(id)!.enabled).toBe(false);
  });

  test("an invalid declaration keeps the last-good execute row untouched", async () => {
    writePlugin("alpha");
    writeDeclaration("alpha", "digest", {
      "config.json": CONFIG,
      "index.md": "v1",
    });
    await reconcilePluginSchedules();
    const id = declaredRows()[0]!.id;

    writeFileSync(
      join(pluginsDir, "alpha", "schedules", "digest", "config.json"),
      "{ broken",
    );
    await reconcilePluginSchedules();
    const row = getSchedule(id)!;
    expect(row.enabled).toBe(true);
    expect(row.message).toBe("v1");
    expect(
      emitted.filter((e) => e.sourceEventName === "schedule.definition_error"),
    ).toHaveLength(1);
  });

  test("an invalid declaration disarms a script row (fail closed on by-path execution)", async () => {
    writePlugin("alpha");
    writeDeclaration("alpha", "backup", {
      "config.json": CONFIG,
      "index.sh": "#!/bin/sh\necho hi\n",
    });
    await reconcilePluginSchedules();
    const id = declaredRows()[0]!.id;
    expect(getSchedule(id)!.mode).toBe("script");

    writeFileSync(
      join(pluginsDir, "alpha", "schedules", "backup", "config.json"),
      "{ broken",
    );
    await reconcilePluginSchedules();
    expect(getSchedule(id)!.enabled).toBe(false);
  });

  test("a user-deleted row stays deleted until the definition changes", async () => {
    writePlugin("alpha");
    writeDeclaration("alpha", "digest", {
      "config.json": CONFIG,
      "index.md": "v1",
    });
    await reconcilePluginSchedules();
    const id = declaredRows()[0]!.id;

    deleteSchedule(id);
    await reconcilePluginSchedules();
    expect(declaredRows()).toHaveLength(0);

    writeFileSync(
      join(pluginsDir, "alpha", "schedules", "digest", "index.md"),
      "v2",
    );
    await reconcilePluginSchedules();
    const rows = declaredRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(id);
    expect(rows[0]!.message).toBe("v2");
  });

  test("a plugin whose manifest fails to parse has its schedules disarmed", async () => {
    writePlugin("alpha");
    writeDeclaration("alpha", "digest", {
      "config.json": CONFIG,
      "index.md": "v1",
    });
    await reconcilePluginSchedules();
    const id = declaredRows()[0]!.id;

    writeFileSync(join(pluginsDir, "alpha", "package.json"), "{ broken");
    await reconcilePluginSchedules();
    expect(getSchedule(id)!.enabled).toBe(false);
    expect(
      emitted.filter((e) => e.sourceEventName === "schedule.definition_error"),
    ).toHaveLength(1);
  });

  test("declared enabled:false inserts a disarmed row and never notifies arrival", async () => {
    writePlugin("alpha");
    writeDeclaration("alpha", "quietone", {
      "config.json": JSON.stringify({
        expression: "0 9 * * *",
        enabled: false,
      }),
      "index.md": "v1",
    });
    await reconcilePluginSchedules();
    const rows = declaredRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(false);
    expect(
      emitted.filter((e) => e.sourceEventName === "schedule.declared"),
    ).toHaveLength(0);
  });
});
