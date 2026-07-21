/**
 * Tests for {@link getPluginDetails}.
 *
 * The curated catalog entry is injected via the `findRegistryEntry` dependency
 * (the on-disk `plugins/registry.json` is never touched), the external repo is
 * a in-memory GitHub Contents API fixture passed via `fetch`, and the
 * installed-copy path runs against a real temp directory passed via
 * `workspacePluginsDir` — no globals are monkey-patched. The fetch fixture
 * answers two URL shapes:
 *   - directory listings (`/contents/<path>` → entry array or 404),
 *   - raw file downloads (a listing entry's `download_url`).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  PluginRegistryEntry,
  PluginSourceRef,
} from "../../../plugins/registry/types.js";
import type { FetchLike } from "../install-from-github.js";
import {
  getPluginDetails,
  PluginDetailsNotFoundError,
} from "../plugin-details.js";

interface ContentEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
}

function fileEntry(name: string, downloadUrl: string): ContentEntry {
  return { name, path: name, type: "file", download_url: downloadUrl };
}

interface FixtureConfig {
  /** Directory listings keyed by `<owner>/<repo>[/<path>]`. Missing key → 404. */
  listings?: Record<string, ContentEntry[]>;
  /** Raw file bodies keyed by `download_url`. Missing key → 404. */
  raw?: Record<string, string>;
  /** URL substrings that should reject with a network error. */
  failOn?: string[];
}

/**
 * Build a `fetch` that routes GitHub Contents API requests against in-memory
 * fixtures. Anything unrecognised returns 500 so test bugs surface loudly.
 */
function makeFetch(config: FixtureConfig): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    for (const needle of config.failOn ?? []) {
      if (url.includes(needle)) throw new Error(`network down: ${needle}`);
    }

    if (config.raw && url in config.raw) {
      return new Response(config.raw[url], { status: 200 });
    }

    if (url.includes("/contents")) {
      const key = listingKey(url);
      const entries = config.listings?.[key];
      if (!entries) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(entries), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("unexpected url: " + url, { status: 500 });
  }) as FetchLike;
}

/** Derive the `<owner>/<repo>[/<path>]` listing key from a contents URL. */
function listingKey(url: string): string {
  const afterRepos = url.split("/repos/")[1] ?? "";
  const [ownerRepo, rest = ""] = splitOnce(afterRepos, "/contents");
  const pathPart = rest.split("?")[0] ?? ""; // leading "/" or ""
  return `${ownerRepo}${pathPart}`;
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  if (i === -1) return [s, ""];
  return [s.slice(0, i), s.slice(i + sep.length)];
}

/** Build a `findRegistryEntry` dep that returns `entry` for its `name`. */
function registryLookup(
  ...entries: PluginRegistryEntry[]
): (name: string) => PluginRegistryEntry | undefined {
  return (name) => entries.find((e) => e.name === name);
}

function regEntry(
  name: string,
  source: PluginSourceRef,
  overrides: Partial<PluginRegistryEntry> = {},
): PluginRegistryEntry {
  return {
    name,
    source,
    description: overrides.description ?? `${name} description`,
    reviewStatus: overrides.reviewStatus ?? "curated",
    ...(overrides.homepage !== undefined
      ? { homepage: overrides.homepage }
      : {}),
    ...(overrides.license !== undefined ? { license: overrides.license } : {}),
    ...(overrides.category !== undefined
      ? { category: overrides.category }
      : {}),
    ...(overrides.icon !== undefined ? { icon: overrides.icon } : {}),
    ...(overrides.surfaces !== undefined
      ? { surfaces: overrides.surfaces }
      : {}),
  };
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "plugin-details-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("getPluginDetails", () => {
  test("resolves an external plugin: registry metadata + repo README/package.json", async () => {
    // GIVEN a curated registry entry for an external, not-installed plugin
    const entry = regEntry(
      "caveman",
      {
        source: "github",
        repo: "example-org/caveman",
        ref: "1111111111111111111111111111111111111111",
      },
      {
        description: "manifest description",
        homepage: "https://example.com/caveman",
        license: "MIT",
        reviewStatus: "community",
        surfaces: ["hooks"],
        category: "productivity",
        icon: "🦴",
      },
    );
    // AND the external repo root lists a README and package.json
    const fetch = makeFetch({
      listings: {
        "example-org/caveman": [
          fileEntry("README.md", "raw://caveman/readme"),
          fileEntry("package.json", "raw://caveman/pkg"),
        ],
      },
      raw: {
        "raw://caveman/readme": "# Caveman\n\nGrug brain plugin.",
        "raw://caveman/pkg": JSON.stringify({
          version: "1.8.2",
          description: "package description",
          homepage: "https://pkg.example.com",
        }),
      },
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "caveman" },
      {
        fetch,
        workspacePluginsDir: workspace,
        findRegistryEntry: registryLookup(entry),
      },
    );

    // THEN the source is the pinned external repo and the README comes from it
    expect(details.source).toEqual({
      kind: "github",
      repo: "example-org/caveman",
      ref: "1111111111111111111111111111111111111111",
    });
    expect(details.installed).toBe(false);
    expect(details.readme).toContain("Grug brain plugin");
    // AND registry fields win over the repo package.json for description/homepage
    expect(details.description).toBe("manifest description");
    expect(details.homepage).toBe("https://example.com/caveman");
    expect(details.license).toBe("MIT");
    // AND version falls back to the repo package.json (registry has none)
    expect(details.version).toBe("1.8.2");
    // AND the curation metadata is surfaced from the registry entry
    expect(details.reviewStatus).toBe("community");
    expect(details.surfaces).toEqual(["hooks"]);
    expect(details.category).toBe("productivity");
    expect(details.icon).toBe("🦴");
    // AND the reported ref is the entry's pinned commit (where the README was read)
    expect(details.ref).toBe("1111111111111111111111111111111111111111");
  });

  test("reads an external plugin at its pinned source ref, not a caller ref", async () => {
    // GIVEN a registry entry pinned to a specific commit
    const entry = regEntry("caveman", {
      source: "github",
      repo: "example-org/caveman",
      ref: "2222222222222222222222222222222222222222",
    });
    // AND a fetch that records the ref query param of every contents request
    const contentsRefs = new Map<string, string>();
    const fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/contents")) {
        const ref = new URL(url).searchParams.get("ref") ?? "";
        const key = url.includes("example-org/caveman") ? "external" : "other";
        contentsRefs.set(key, ref);
        if (key === "external") {
          return new Response(
            JSON.stringify([fileEntry("README.md", "raw://caveman/readme")]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }
      if (url === "raw://caveman/readme") {
        return new Response("# Caveman", { status: 200 });
      }
      return new Response("unexpected url: " + url, { status: 500 });
    }) as FetchLike;

    // WHEN we resolve the detail view passing a differing fallback ref
    const details = await getPluginDetails(
      { name: "caveman", ref: "main" },
      {
        fetch,
        workspacePluginsDir: workspace,
        findRegistryEntry: registryLookup(entry),
      },
    );

    // THEN the external repo is read at the plugin's pinned ref, not `main`
    expect(contentsRefs.get("external")).toBe(
      "2222222222222222222222222222222222222222",
    );
    // AND the pinned external repo is the only contents request
    expect(contentsRefs.has("other")).toBe(false);
    // AND the README from the pinned ref is surfaced
    expect(details.readme).toContain("Caveman");
    // AND the reported ref is the pinned commit, not the caller's fallback
    expect(details.ref).toBe("2222222222222222222222222222222222222222");
  });

  test("prefers an installed copy's README and package.json over the repo", async () => {
    // GIVEN an installed copy on disk with its own README + package.json
    const target = join(workspace, "caveman");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "README.md"), "# Installed Caveman");
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ version: "2.0.0", license: "Apache-2.0" }),
    );

    // AND a registry entry + external repo that would otherwise be used
    const entry = regEntry(
      "caveman",
      {
        source: "github",
        repo: "example-org/caveman",
        ref: "1111111111111111111111111111111111111111",
      },
      { description: "manifest description" },
    );
    const fetch = makeFetch({
      listings: {
        "example-org/caveman": [fileEntry("README.md", "raw://caveman/readme")],
      },
      raw: { "raw://caveman/readme": "# Remote Caveman" },
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "caveman" },
      {
        fetch,
        workspacePluginsDir: workspace,
        findRegistryEntry: registryLookup(entry),
      },
    );

    // THEN the installed README + version/license win; registry fills the gap
    expect(details.installed).toBe(true);
    expect(details.readme).toBe("# Installed Caveman");
    expect(details.version).toBe("2.0.0");
    expect(details.license).toBe("Apache-2.0");
    expect(details.description).toBe("manifest description");
  });

  test("resolves an installed-only plugin with no registry entry", async () => {
    // GIVEN an installed copy on disk and NO registry entry claiming the name
    const target = join(workspace, "homegrown");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "README.md"), "# Homegrown");
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ version: "0.1.0", description: "local only" }),
    );
    const fetch = makeFetch({});

    // WHEN we resolve the detail view with an empty registry
    const details = await getPluginDetails(
      { name: "homegrown", ref: "main" },
      {
        fetch,
        workspacePluginsDir: workspace,
        findRegistryEntry: registryLookup(),
      },
    );

    // THEN it renders from disk with a null source + null curation metadata,
    // and falls back to the caller-supplied ref
    expect(details.installed).toBe(true);
    expect(details.source).toBeNull();
    expect(details.reviewStatus).toBeNull();
    expect(details.surfaces).toEqual([]);
    expect(details.category).toBeNull();
    expect(details.icon).toBeNull();
    expect(details.description).toBe("local only");
    expect(details.version).toBe("0.1.0");
    expect(details.readme).toBe("# Homegrown");
    expect(details.ref).toBe("main");
  });

  test("throws PluginDetailsNotFoundError when nothing claims the name", async () => {
    // GIVEN no installed copy and an empty registry
    const fetch = makeFetch({});

    // WHEN / THEN resolving an unknown name rejects with the not-found error
    await expect(
      getPluginDetails(
        { name: "ghost" },
        {
          fetch,
          workspacePluginsDir: workspace,
          findRegistryEntry: registryLookup(),
        },
      ),
    ).rejects.toBeInstanceOf(PluginDetailsNotFoundError);
  });

  test("degrades to registry metadata when the repo listing fails", async () => {
    // GIVEN a registry entry whose external repo listing errors out
    const entry = regEntry(
      "caveman",
      {
        source: "github",
        repo: "example-org/caveman",
        ref: "1111111111111111111111111111111111111111",
      },
      { description: "manifest description", license: "MIT" },
    );
    const fetch = makeFetch({ failOn: ["example-org/caveman"] });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "caveman" },
      {
        fetch,
        workspacePluginsDir: workspace,
        findRegistryEntry: registryLookup(entry),
      },
    );

    // THEN it still renders registry metadata with a null README rather than throwing
    expect(details.readme).toBeNull();
    expect(details.description).toBe("manifest description");
    expect(details.license).toBe("MIT");
    expect(details.source).toEqual({
      kind: "github",
      repo: "example-org/caveman",
      ref: "1111111111111111111111111111111111111111",
    });
  });

  test("rejects an invalid (path-traversal) plugin name", async () => {
    // GIVEN a name that fails the install-name sanitizer
    const fetch = makeFetch({});

    // WHEN / THEN resolution throws before any lookup
    await expect(
      getPluginDetails(
        { name: "../escape" },
        {
          fetch,
          workspacePluginsDir: workspace,
          findRegistryEntry: registryLookup(),
        },
      ),
    ).rejects.toThrow();
  });

  test("surfaces a well-formed vellum.artifact from the repo package.json", async () => {
    // GIVEN an external plugin whose repo package.json declares a complete
    // vellum.artifact (https url + 64-hex sha256)
    const sha = "a".repeat(64);
    const entry = regEntry("dynamic-notch", {
      source: "github",
      repo: "example-org/dynamic-notch",
      ref: "1111111111111111111111111111111111111111",
    });
    const fetch = makeFetch({
      listings: {
        "example-org/dynamic-notch": [
          fileEntry("package.json", "raw://notch/pkg"),
        ],
      },
      raw: {
        "raw://notch/pkg": JSON.stringify({
          version: "1.0.0",
          vellum: {
            artifact: {
              url: "https://example.com/releases/v1.0.0/App.dmg",
              sha256: sha,
              label: "Download for macOS",
            },
          },
        }),
      },
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "dynamic-notch" },
      {
        fetch,
        workspacePluginsDir: workspace,
        findRegistryEntry: registryLookup(entry),
      },
    );

    // THEN the artifact descriptor is surfaced, including its optional label
    expect(details.artifact).toEqual({
      url: "https://example.com/releases/v1.0.0/App.dmg",
      sha256: sha,
      label: "Download for macOS",
    });
  });

  test("an installed copy's artifact wins over the repo's", async () => {
    // GIVEN an installed copy whose package.json declares its own artifact
    const localSha = "b".repeat(64);
    const remoteSha = "c".repeat(64);
    const target = join(workspace, "dynamic-notch");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({
        vellum: {
          artifact: {
            url: "https://example.com/local/App.dmg",
            sha256: localSha,
          },
        },
      }),
    );

    // AND a registry entry + repo package.json declaring a different artifact
    const entry = regEntry("dynamic-notch", {
      source: "github",
      repo: "example-org/dynamic-notch",
      ref: "1111111111111111111111111111111111111111",
    });
    const fetch = makeFetch({
      listings: {
        "example-org/dynamic-notch": [
          fileEntry("package.json", "raw://notch/pkg"),
        ],
      },
      raw: {
        "raw://notch/pkg": JSON.stringify({
          vellum: {
            artifact: {
              url: "https://example.com/remote/App.dmg",
              sha256: remoteSha,
            },
          },
        }),
      },
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "dynamic-notch" },
      {
        fetch,
        workspacePluginsDir: workspace,
        findRegistryEntry: registryLookup(entry),
      },
    );

    // THEN the installed copy's artifact wins
    expect(details.artifact).toEqual({
      url: "https://example.com/local/App.dmg",
      sha256: localSha,
    });
  });

  test("treats a placeholder sha256 as no artifact yet", async () => {
    // GIVEN a repo package.json with a url but an empty (placeholder) sha256 —
    // the bootstrap state before a release workflow fills the digest in
    const entry = regEntry("dynamic-notch", {
      source: "github",
      repo: "example-org/dynamic-notch",
      ref: "1111111111111111111111111111111111111111",
    });
    const fetch = makeFetch({
      listings: {
        "example-org/dynamic-notch": [
          fileEntry("package.json", "raw://notch/pkg"),
        ],
      },
      raw: {
        "raw://notch/pkg": JSON.stringify({
          vellum: {
            artifact: {
              url: "https://example.com/releases/v1.0.0/App.dmg",
              sha256: "",
            },
          },
        }),
      },
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "dynamic-notch" },
      {
        fetch,
        workspacePluginsDir: workspace,
        findRegistryEntry: registryLookup(entry),
      },
    );

    // THEN no artifact is surfaced (a client must not offer an unverifiable download)
    expect(details.artifact).toBeNull();
  });
});
