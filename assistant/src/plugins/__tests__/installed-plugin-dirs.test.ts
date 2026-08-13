import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  isInsidePluginRoot,
  listInstalledPluginDirs,
} from "../installed-plugin-dirs.js";

let root: string;
let pluginsDir: string;

function writePlugin(name: string): string {
  const dir = join(pluginsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "installed-plugin-dirs-"));
  pluginsDir = join(root, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
});

describe("listInstalledPluginDirs", () => {
  test("missing plugins directory yields []", () => {
    expect(listInstalledPluginDirs(join(root, "nope"))).toEqual([]);
  });

  test("lists directories carrying a package.json; skips files, dotted, and manifest-less entries", () => {
    writePlugin("alpha");
    mkdirSync(join(pluginsDir, "no-manifest"));
    mkdirSync(join(pluginsDir, ".hidden"));
    writeFileSync(join(pluginsDir, "stray.txt"), "x");
    const listed = listInstalledPluginDirs(pluginsDir);
    expect(listed.map((p) => p.name)).toEqual(["alpha"]);
    expect(listed[0]!.dir).toBe(join(pluginsDir, "alpha"));
  });

  test("a symlink escaping the plugins directory is not reported as installed", () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "x" }));
    symlinkSync(outside, join(pluginsDir, "escape"));
    expect(listInstalledPluginDirs(pluginsDir)).toEqual([]);
  });

  test("a symlink that stays inside the plugins directory passes", () => {
    writePlugin("alpha");
    symlinkSync(join(pluginsDir, "alpha"), join(pluginsDir, "alias"));
    const names = listInstalledPluginDirs(pluginsDir).map((p) => p.name);
    expect(names).toContain("alpha");
    expect(names).toContain("alias");
  });
});

describe("isInsidePluginRoot", () => {
  test("a real child is inside; the root itself is not", () => {
    const dir = writePlugin("alpha");
    expect(isInsidePluginRoot(dir, pluginsDir)).toBe(true);
    expect(isInsidePluginRoot(pluginsDir, pluginsDir)).toBe(false);
  });

  test("a dangling link is not provably contained", () => {
    symlinkSync(join(root, "gone"), join(pluginsDir, "dangle"));
    expect(isInsidePluginRoot(join(pluginsDir, "dangle"), pluginsDir)).toBe(
      false,
    );
  });
});
