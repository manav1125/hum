/**
 * Loader for `plugins/registry.json` — the curated, commit-pinned plugin
 * allowlist, plus a workspace-local override file for user-added sources.
 *
 * Resolution order for the bundled catalog:
 *   1. `$CUE_PLUGIN_REGISTRY_FILE` when set (used by tests and by a compiled
 *      daemon that ships the file at a known path).
 *   2. `plugins/registry.json` located by walking up from this module to the
 *      repo root (the on-disk source/CLI case).
 *   3. A minimal embedded fallback (built-in sources only, no pinned plugins)
 *      so a `bun --compile` binary that cannot see the file still degrades to
 *      a working — if empty — catalog rather than throwing.
 *
 * User-added sources are stored separately in
 * `$VELLUM_WORKSPACE_DIR/plugin-registry-sources.json` so an app upgrade that
 * rewrites the bundled `plugins/registry.json` never clobbers them. The two
 * are merged at read time (bundled first, then overrides; an override with the
 * same address replaces the bundled source).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type {
  PluginRegistryEntry,
  PluginRegistryFile,
  PluginRegistrySource,
} from "./types.js";

const log = getLogger("plugin-registry-file");

/**
 * Minimal embedded fallback: the one source Cue genuinely curates (it carries
 * the in-repo loader adapter at `plugins/caveman/`), no pins. `curated` is an
 * ownership claim, so the fallback must not seed a third-party repo with it.
 */
const EMBEDDED_FALLBACK: PluginRegistryFile = {
  version: 1,
  name: "cue-plugin-registry",
  sources: [
    {
      address: "JuliusBrussee/caveman",
      kind: "github",
      label: "caveman (Cue maintains the loader adapter)",
      enabled: true,
      builtIn: true,
      reviewStatus: "curated",
      license: "MIT",
    },
  ],
  plugins: [],
};

const GITHUB_ADDRESS_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isValidSource(raw: unknown): raw is PluginRegistrySource {
  if (typeof raw !== "object" || raw === null) return false;
  const s = raw as Record<string, unknown>;
  return (
    typeof s.address === "string" &&
    GITHUB_ADDRESS_RE.test(s.address) &&
    s.kind === "github" &&
    typeof s.enabled === "boolean"
  );
}

function isValidEntry(raw: unknown): raw is PluginRegistryEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const e = raw as Record<string, unknown>;
  const src = e.source as Record<string, unknown> | undefined;
  return (
    typeof e.name === "string" &&
    e.name.length > 0 &&
    typeof e.description === "string" &&
    typeof src === "object" &&
    src !== null &&
    src.source === "github" &&
    typeof src.repo === "string" &&
    typeof src.ref === "string"
  );
}

/** Locate the bundled `plugins/registry.json`, or null if not on disk. */
export function locateBundledRegistryFile(): string | null {
  const fromEnv = process.env.CUE_PLUGIN_REGISTRY_FILE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // Walk up from this module (…/assistant/src/plugins/registry/) to the repo
  // root, looking for `plugins/registry.json`.
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "plugins", "registry.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromCwd = join(process.cwd(), "plugins", "registry.json");
  if (existsSync(fromCwd)) return fromCwd;
  return null;
}

function parseRegistryFile(raw: string): PluginRegistryFile | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PluginRegistryFile>;
    if (parsed.version !== 1) return null;
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.filter(isValidSource)
      : [];
    const plugins = Array.isArray(parsed.plugins)
      ? parsed.plugins.filter(isValidEntry)
      : [];
    return {
      version: 1,
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.owner ? { owner: parsed.owner } : {}),
      sources,
      plugins,
    };
  } catch (err) {
    log.warn({ err }, "Failed to parse plugin registry file");
    return null;
  }
}

/** Read the bundled `plugins/registry.json` (falls back to the embedded seed). */
export function loadBundledRegistry(): PluginRegistryFile {
  const path = locateBundledRegistryFile();
  if (!path) {
    log.warn(
      "plugins/registry.json not found on disk — using the embedded fallback catalog",
    );
    return EMBEDDED_FALLBACK;
  }
  const parsed = parseRegistryFile(readFileSync(path, "utf-8"));
  return parsed ?? EMBEDDED_FALLBACK;
}

// ─── Workspace source overrides ──────────────────────────────────────────────

export function getSourceOverridesPath(): string {
  return join(getWorkspaceDir(), "plugin-registry-sources.json");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, filePath);
}

function readSourceOverrides(): PluginRegistrySource[] {
  const path = getSourceOverridesPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      sources?: unknown;
    };
    if (!Array.isArray(parsed.sources)) return [];
    return parsed.sources.filter(isValidSource);
  } catch (err) {
    log.warn({ err }, "Failed to read plugin registry source overrides");
    return [];
  }
}

function writeSourceOverrides(sources: PluginRegistrySource[]): void {
  atomicWriteJson(getSourceOverridesPath(), { version: 1, sources });
}

/**
 * All registry sources: the bundled built-ins merged with workspace overrides.
 * An override with the same address replaces the bundled source (so a user can
 * disable a built-in or pin it to a ref).
 */
export function loadSources(): PluginRegistrySource[] {
  const bundled = loadBundledRegistry().sources;
  const overrides = readSourceOverrides();
  const byAddress = new Map<string, PluginRegistrySource>();
  for (const s of bundled) byAddress.set(s.address, s);
  for (const s of overrides) {
    const existing = byAddress.get(s.address);
    byAddress.set(s.address, existing ? { ...existing, ...s } : s);
  }
  return [...byAddress.values()];
}

/** The curated, pinned plugin entries from the bundled registry. */
export function loadRegistryPlugins(): PluginRegistryEntry[] {
  return loadBundledRegistry().plugins;
}

/** Find a curated entry by install name. */
export function findRegistryPlugin(
  name: string,
): PluginRegistryEntry | undefined {
  return loadRegistryPlugins().find((p) => p.name === name);
}

export interface AddSourceInput {
  address: string;
  ref?: string;
  label?: string;
  license?: string;
}

/**
 * Normalize a user-entered source address to `owner/repo`. Accepts bare
 * `owner/repo` and github.com URLs. Returns null when unparseable.
 */
export function normalizeGithubAddress(input: string): string | null {
  let address = input.trim();
  const urlMatch = address.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+)/i,
  );
  if (urlMatch) address = `${urlMatch[1]}/${urlMatch[2]}`;
  address = address.replace(/\.git$/, "");
  if (!GITHUB_ADDRESS_RE.test(address)) return null;
  return address;
}

/** Add (or re-enable) a github source in the workspace override file. */
export function addSource(input: AddSourceInput): PluginRegistrySource {
  const overrides = readSourceOverrides();
  const existing = overrides.find((s) => s.address === input.address);
  if (existing) {
    existing.enabled = true;
    if (input.ref) existing.ref = input.ref;
    if (input.label) existing.label = input.label;
    if (input.license) existing.license = input.license;
    writeSourceOverrides(overrides);
    return existing;
  }
  const source: PluginRegistrySource = {
    address: input.address,
    kind: "github",
    enabled: true,
    reviewStatus: "unreviewed",
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.license ? { license: input.license } : {}),
  };
  overrides.push(source);
  writeSourceOverrides(overrides);
  return source;
}

/**
 * Disable a source. Built-in sources are shadowed by a disabled override
 * (never removed); pure overrides are dropped. Returns false when unknown.
 */
export function setSourceEnabled(address: string, enabled: boolean): boolean {
  const all = loadSources();
  const match = all.find((s) => s.address === address);
  if (!match) return false;
  const overrides = readSourceOverrides();
  const idx = overrides.findIndex((s) => s.address === address);
  if (idx === -1) {
    overrides.push({ ...match, enabled });
  } else {
    overrides[idx].enabled = enabled;
  }
  writeSourceOverrides(overrides);
  return true;
}
