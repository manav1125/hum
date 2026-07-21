/**
 * Tests for the plugin manifest parser + id derivation. Pure functions — no
 * network, no filesystem, no globals touched.
 */

import { describe, expect, test } from "bun:test";

import {
  parsePluginManifest,
  pluginItemId,
  sanitizeSegment,
} from "../indexer.js";

describe("parsePluginManifest", () => {
  test("accepts a manifest that peer-depends on @vellumai/plugin-api", () => {
    const pkg = JSON.stringify({
      name: "@acme/cool-plugin",
      version: "1.2.3",
      description: "  Does cool things.  ",
      license: "MIT",
      peerDependencies: { "@vellumai/plugin-api": "^0.1.0" },
    });
    const parsed = parsePluginManifest(pkg, "packages/cool-plugin");
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("cool-plugin"); // scope stripped
    expect(parsed!.version).toBe("1.2.3");
    expect(parsed!.description).toBe("Does cool things.");
    expect(parsed!.apiRange).toBe("^0.1.0");
    expect(parsed!.license).toBe("MIT");
  });

  test("accepts the dep in devDependencies or dependencies too", () => {
    const dev = parsePluginManifest(
      JSON.stringify({
        name: "p",
        devDependencies: { "@vellumai/plugin-api": "*" },
      }),
      "p",
    );
    expect(dev).not.toBeNull();
    const regular = parsePluginManifest(
      JSON.stringify({
        name: "p",
        dependencies: { "@vellumai/plugin-api": "1" },
      }),
      "p",
    );
    expect(regular).not.toBeNull();
  });

  test("rejects a package.json that is not a plugin manifest", () => {
    const pkg = JSON.stringify({
      name: "some-lib",
      dependencies: { lodash: "^4" },
    });
    expect(parsePluginManifest(pkg, "some-lib")).toBeNull();
  });

  test("rejects invalid JSON", () => {
    expect(parsePluginManifest("{ not json", "x")).toBeNull();
  });

  test("falls back to the directory basename when name is missing", () => {
    const pkg = JSON.stringify({
      peerDependencies: { "@vellumai/plugin-api": "^1" },
    });
    expect(parsePluginManifest(pkg, "plugins/notch-thing")!.name).toBe(
      "notch-thing",
    );
  });

  test("reads declared surfaces from vellum metadata", () => {
    const pkg = JSON.stringify({
      name: "p",
      peerDependencies: { "@vellumai/plugin-api": "^1" },
      vellum: { surfaces: ["hooks", "routes"] },
    });
    expect(parsePluginManifest(pkg, "p")!.surfaces).toEqual([
      "hooks",
      "routes",
    ]);
  });
});

describe("pluginItemId / sanitizeSegment", () => {
  test("namespaces id by owner--repo--name", () => {
    expect(pluginItemId("AnitaKirkovska/model-router", "model-router")).toBe(
      "AnitaKirkovska--model-router--model-router",
    );
  });

  test("sanitizes unsafe segments", () => {
    expect(sanitizeSegment("weird name!!")).toBe("weird-name");
    expect(sanitizeSegment("--lead-trail--")).toBe("lead-trail");
  });
});
