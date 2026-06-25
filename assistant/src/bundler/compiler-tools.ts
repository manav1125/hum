/**
 * Resolution of the esbuild binary + preact for app compilation.
 *
 * Two strategies, tried in order:
 *
 * 1. **Installed dependencies** (preferred). When `esbuild` and `preact` are
 *    present in the assistant's `node_modules` — the case for every
 *    container/server deploy, where `bun install` materialises the
 *    platform-correct `@esbuild/<os>-<arch>` native binary — we use those
 *    directly. No network, no wrong-platform binary risk, no subprocess
 *    permission prompts. This is what makes app compilation work in the
 *    Render Linux container.
 *
 * 2. **JIT download** (fallback). The macOS `.app` is built with
 *    `bun build --compile` and intentionally does not ship these (~11 MB), so
 *    when they can't be resolved from disk we download the pinned versions to
 *    `$VELLUM_WORKSPACE_DIR/compiler-tools/` on first compile. Follows the
 *    same pattern as EmbeddingRuntimeManager.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { PromiseGuard } from "../util/promise-guard.js";

const log = getLogger("compiler-tools");

// Pinned versions matching assistant/bun.lock
const ESBUILD_VERSION = "0.24.2";
const PREACT_VERSION = "10.28.4";

const TOOLS_VERSION = `esbuild-${ESBUILD_VERSION}_preact-${PREACT_VERSION}`;

export interface CompilerTools {
  esbuildBin: string;
  preactDir: string;
}

interface VersionManifest {
  toolsVersion: string;
  esbuildVersion: string;
  preactVersion: string;
  platform: string;
  arch: string;
  installedAt: string;
}

function getToolsDir(): string {
  return join(getWorkspaceDir(), "compiler-tools");
}

const installGuard = new PromiseGuard<void>();

function npmTarballUrl(pkg: string, version: string): string {
  const encoded = pkg.replace("/", "%2f");
  const basename = pkg.startsWith("@") ? pkg.split("/")[1] : pkg;
  return `https://registry.npmjs.org/${encoded}/-/${basename}-${version}.tgz`;
}

async function fetchNpmIntegrity(
  pkg: string,
  version: string,
): Promise<string> {
  const encoded = pkg.replace("/", "%2f");
  const metadataUrl = `https://registry.npmjs.org/${encoded}/${version}`;
  const response = await fetch(metadataUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch npm metadata for ${pkg}@${version}: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    dist?: { integrity?: string; shasum?: string };
  };

  if (
    typeof data.dist?.integrity === "string" &&
    data.dist.integrity.length > 0
  ) {
    return data.dist.integrity;
  }

  if (typeof data.dist?.shasum === "string" && data.dist.shasum.length > 0) {
    return `sha1-${Buffer.from(data.dist.shasum, "hex").toString("base64")}`;
  }

  throw new Error(`Missing npm integrity metadata for ${pkg}@${version}`);
}

function verifyIntegrity(
  tarball: Uint8Array,
  integrity: string,
  pkg: string,
  version: string,
): void {
  const [algorithm, expectedDigest] = integrity.split("-", 2);
  if (!algorithm || !expectedDigest) {
    throw new Error(`Invalid integrity metadata for ${pkg}@${version}`);
  }

  if (algorithm !== "sha512" && algorithm !== "sha1") {
    throw new Error(
      `Unsupported integrity algorithm ${algorithm} for ${pkg}@${version}`,
    );
  }

  const actualDigest = createHash(algorithm).update(tarball).digest("base64");
  if (actualDigest !== expectedDigest) {
    throw new Error(`Integrity verification failed for ${pkg}@${version}`);
  }
}

async function downloadAndExtract(
  pkg: string,
  version: string,
  url: string,
  targetDir: string,
): Promise<void> {
  log.info({ pkg, version, url, targetDir }, "Downloading npm package");

  const integrity = await fetchNpmIntegrity(pkg, version);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const tarball = new Uint8Array(await response.arrayBuffer());
  verifyIntegrity(tarball, integrity, pkg, version);
  mkdirSync(targetDir, { recursive: true });

  const tmpTar = join(targetDir, `download-${Date.now()}.tgz`);
  writeFileSync(tmpTar, Buffer.from(tarball));

  try {
    const proc = Bun.spawn({
      cmd: ["tar", "xzf", tmpTar, "-C", targetDir, "--strip-components=1"],
      stdout: "ignore",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to extract ${url}: ${stderr}`);
    }
  } finally {
    try {
      rmSync(tmpTar);
    } catch {
      /* ignore */
    }
  }
}

function readManifest(baseDir: string): VersionManifest | null {
  const manifestPath = join(baseDir, "version.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
}

function isReady(baseDir: string): boolean {
  const manifest = readManifest(baseDir);
  if (!manifest || manifest.toolsVersion !== TOOLS_VERSION) return false;
  return (
    existsSync(join(baseDir, "bin", "esbuild")) &&
    existsSync(join(baseDir, "node_modules", "preact"))
  );
}

/**
 * Resolve esbuild + preact from the assistant's installed `node_modules`.
 *
 * `esbuild` and `preact` are declared as dependencies of the assistant
 * package, so on any deploy that runs `bun install` (notably the Render
 * Linux container) both are present and esbuild's platform-correct native
 * binary lives in `@esbuild/<os>-<arch>`. Using them directly avoids the JIT
 * download entirely — no network call, no chance of a wrong-platform binary,
 * no `tar`/subprocess work that could be sandboxed.
 *
 * Returns null when either cannot be resolved (e.g. the macOS `--compile`
 * bundle, which ships neither), so the caller falls back to JIT download.
 */
function resolveInstalledTools(): CompilerTools | null {
  let require: NodeRequire;
  try {
    require = createRequire(import.meta.url);
  } catch {
    return null;
  }

  // The native esbuild executable lives at `bin/esbuild` inside the
  // platform package (`@esbuild/<os>-<arch>`). That package declares no `bin`
  // field, so the binary path is by convention `bin/esbuild` relative to the
  // package root — we read any `bin` override defensively but default to it.
  let esbuildBin: string | undefined;
  try {
    const esbuildPlatform = installedEsbuildPlatformPkg();
    const pkgJsonPath = require.resolve(`${esbuildPlatform}/package.json`);
    const pkgDir = dirname(pkgJsonPath);
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
      bin?: Record<string, string> | string;
    };
    const binRel =
      typeof pkgJson.bin === "string"
        ? pkgJson.bin
        : (pkgJson.bin?.esbuild ?? "bin/esbuild");
    const candidate = join(pkgDir, binRel);
    if (existsSync(candidate)) {
      esbuildBin = candidate;
    }
  } catch {
    // platform package not installed (e.g. cross-platform install) — fall back
  }

  if (!esbuildBin) return null;

  let preactDir: string | undefined;
  try {
    const preactPkgJson = require.resolve("preact/package.json");
    preactDir = dirname(preactPkgJson);
  } catch {
    return null;
  }

  if (!existsSync(preactDir)) return null;

  return { esbuildBin, preactDir };
}

/** The `@esbuild/<os>-<arch>` package name for the current platform. */
function installedEsbuildPlatformPkg(): string {
  const os = platform();
  const cpu = arch();
  const platformTag =
    os === "darwin"
      ? cpu === "arm64"
        ? "darwin-arm64"
        : "darwin-x64"
      : cpu === "arm64"
        ? "linux-arm64"
        : "linux-x64";
  return `@esbuild/${platformTag}`;
}

/** Cached result of the installed-tools probe (null = not available). */
let installedToolsProbe: CompilerTools | null | undefined;

/**
 * Ensure esbuild binary + preact are available, preferring the versions
 * installed in `node_modules` and falling back to a JIT download.
 * Safe to call concurrently — deduplicates via PromiseGuard.
 */
export async function ensureCompilerTools(): Promise<CompilerTools> {
  // Prefer installed deps (container/server path). Probe once and cache.
  if (installedToolsProbe === undefined) {
    installedToolsProbe = resolveInstalledTools();
    if (installedToolsProbe) {
      log.info(
        { esbuildBin: installedToolsProbe.esbuildBin },
        "Using esbuild + preact from installed node_modules",
      );
    }
  }
  if (installedToolsProbe) {
    return installedToolsProbe;
  }

  // Fallback: JIT download into the workspace (macOS .app path).
  const baseDir = getToolsDir();

  if (!isReady(baseDir)) {
    await installGuard.run(() => install(baseDir));
    if (!isReady(baseDir)) {
      installGuard.reset();
      throw new Error("Compiler tools installation failed");
    }
  }

  return {
    esbuildBin: join(baseDir, "bin", "esbuild"),
    preactDir: join(baseDir, "node_modules", "preact"),
  };
}

async function install(baseDir: string): Promise<void> {
  if (isReady(baseDir)) return;

  const os = platform();
  const cpu = arch();
  log.info(
    { os, cpu, toolsVersion: TOOLS_VERSION },
    "Installing compiler tools",
  );

  mkdirSync(baseDir, { recursive: true });

  // Lock file to prevent concurrent cross-process installs
  const lockPath = join(baseDir, ".downloading");
  if (existsSync(lockPath)) {
    try {
      const lockPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
      if (!isNaN(lockPid) && lockPid !== process.pid) {
        try {
          process.kill(lockPid, 0);
          log.info(
            { lockPid },
            "Another process is installing compiler tools, waiting",
          );
          // Wait up to 60s for the other process to finish
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            if (isReady(baseDir)) return;
          }
          log.warn("Timed out waiting for other installer, proceeding");
        } catch {
          log.info({ lockPid }, "Cleaning up stale compiler tools lock");
        }
      }
    } catch {
      // Can't read lock, proceed
    }
  }

  writeFileSync(lockPath, String(process.pid));

  const tmpDir = join(baseDir, `.installing-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Determine esbuild platform package name
    const esbuildPlatform =
      os === "darwin"
        ? cpu === "arm64"
          ? "darwin-arm64"
          : "darwin-x64"
        : cpu === "arm64"
          ? "linux-arm64"
          : "linux-x64";

    // Download esbuild binary + preact in parallel
    await Promise.all([
      downloadAndExtract(
        `@esbuild/${esbuildPlatform}`,
        ESBUILD_VERSION,
        npmTarballUrl(`@esbuild/${esbuildPlatform}`, ESBUILD_VERSION),
        join(tmpDir, "esbuild-pkg"),
      ),
      downloadAndExtract(
        "preact",
        PREACT_VERSION,
        npmTarballUrl("preact", PREACT_VERSION),
        join(tmpDir, "node_modules", "preact"),
      ),
    ]);

    // Move esbuild binary to bin/
    const esbuildBinSrc = join(tmpDir, "esbuild-pkg", "bin", "esbuild");
    const binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const { renameSync } = await import("node:fs");
    renameSync(esbuildBinSrc, join(binDir, "esbuild"));
    chmodSync(join(binDir, "esbuild"), 0o755);
    rmSync(join(tmpDir, "esbuild-pkg"), { recursive: true, force: true });

    // Write version manifest
    const manifest: VersionManifest = {
      toolsVersion: TOOLS_VERSION,
      esbuildVersion: ESBUILD_VERSION,
      preactVersion: PREACT_VERSION,
      platform: os,
      arch: cpu,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(tmpDir, "version.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );

    // Atomic swap: clear old install, move new files in
    const { readdirSync } = await import("node:fs");
    for (const entry of readdirSync(baseDir)) {
      if (entry.startsWith(".") || entry === tmpDir.split("/").pop()) continue;
      rmSync(join(baseDir, entry), { recursive: true, force: true });
    }
    for (const entry of readdirSync(tmpDir)) {
      renameSync(join(tmpDir, entry), join(baseDir, entry));
    }

    log.info({ toolsVersion: TOOLS_VERSION }, "Compiler tools installed");
  } catch (err) {
    log.error({ err }, "Failed to install compiler tools");
    throw err;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    try {
      rmSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}
