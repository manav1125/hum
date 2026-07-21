/**
 * Tests for enable/disable via the `.disabled` sentinel. Uses a temp plugins
 * dir passed through `workspacePluginsDir` — no workspace globals touched.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isPluginDisabled } from "../../../plugins/disabled-state.js";
import {
  disablePlugin,
  enablePlugin,
  PluginNotInstalledError,
} from "../toggle-plugin.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cue-toggle-"));
  mkdirSync(join(dir, "my-plugin"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("disablePlugin / enablePlugin", () => {
  test("disable writes the sentinel and enable removes it", () => {
    expect(isPluginDisabled("my-plugin", dir)).toBe(false);

    const disabled = disablePlugin({
      name: "my-plugin",
      workspacePluginsDir: dir,
    });
    expect(disabled.disabled).toBe(true);
    expect(disabled.changed).toBe(true);
    expect(existsSync(join(dir, "my-plugin", ".disabled"))).toBe(true);
    expect(isPluginDisabled("my-plugin", dir)).toBe(true);

    const enabled = enablePlugin({
      name: "my-plugin",
      workspacePluginsDir: dir,
    });
    expect(enabled.disabled).toBe(false);
    expect(enabled.changed).toBe(true);
    expect(existsSync(join(dir, "my-plugin", ".disabled"))).toBe(false);
  });

  test("disabling an already-disabled plugin is a no-op (changed=false)", () => {
    disablePlugin({ name: "my-plugin", workspacePluginsDir: dir });
    const again = disablePlugin({
      name: "my-plugin",
      workspacePluginsDir: dir,
    });
    expect(again.changed).toBe(false);
    expect(again.disabled).toBe(true);
  });

  test("enabling an already-enabled plugin is a no-op (changed=false)", () => {
    const res = enablePlugin({ name: "my-plugin", workspacePluginsDir: dir });
    expect(res.changed).toBe(false);
    expect(res.disabled).toBe(false);
  });

  test("throws PluginNotInstalledError for an unknown plugin", () => {
    expect(() =>
      disablePlugin({ name: "nope", workspacePluginsDir: dir }),
    ).toThrow(PluginNotInstalledError);
  });
});
