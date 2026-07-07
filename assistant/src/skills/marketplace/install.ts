/**
 * Marketplace install path — writes into the EXISTING managed skills dir
 * (`$VELLUM_WORKSPACE_DIR/skills/{id}/`) so `skill_load` picks marketplace
 * skills up with zero changes, and pins every install in
 * `$VELLUM_WORKSPACE_DIR/skills-lock.json`.
 *
 * SAFETY BOUNDARY (v1, do not relax): only SKILL.md plus markdown/text
 * assets are installed from third-party sources. Anything executable —
 * `tools/` manifests, scripts, binaries, package.json — is SKIPPED and the
 * skip is DISCLOSED in the confirmation payload and the lock entry.
 *
 * Staging/commit reuses the catalog installer's helpers
 * (`createSkillInstallStagingDir` / `commitStagedSkillInstall`), so the
 * atomic-rename + backup + catalog-discoverability guarantees are identical
 * to the first-party flow.
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { getLogger } from "../../util/logger.js";
import { getWorkspaceSkillsDir } from "../../util/platform.js";
import {
  commitStagedSkillInstall,
  createSkillInstallStagingDir,
  installSkillLocally,
  resolveCatalog,
  writeSkillFilesToDir,
} from "../catalog-install.js";
import { writeInstallMeta } from "../install-meta.js";
import { buildConsentNotice } from "./capabilities.js";
import type { TreeEntry } from "./github.js";
import { fetchRawFile, fetchRepoTree, mapWithConcurrency } from "./github.js";
import { getLockEntry, readSkillsLock, removeLockEntry, upsertLockEntry } from "./lock.js";
import type {
  CapabilityManifest,
  InstallPlan,
  InstallResult,
  MarketplaceItem,
  PlannedFile,
  SkillsLockEntry,
  SkippedFile,
  UpdateCheck,
  UpdateFileChange,
} from "./types.js";
import { hasDeclaredCapabilities } from "./types.js";

const log = getLogger("marketplace-install");

const RAW_FETCH_CONCURRENCY = 6;
const MAX_INSTALL_FILE_BYTES = 512 * 1024;
const MAX_INSTALL_FILES = 64;

// ─── Safety boundary: which source files may be installed ───────────────────

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const ALLOWED_BASENAMES = new Set(["LICENSE", "NOTICE", "LICENCE"]);

export interface FileClassification {
  install: boolean;
  reason?: string;
}

/**
 * Decide whether a skill-relative file may be installed. Markdown/text
 * only — everything else (scripts, tool manifests, binaries, images) is
 * skipped and disclosed.
 */
export function classifyInstallFile(
  relPath: string,
  size?: number,
): FileClassification {
  const name = basename(relPath);
  const dotIndex = name.lastIndexOf(".");
  const ext = dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
  const stem = dotIndex >= 0 ? name.slice(0, dotIndex) : name;

  const allowedName =
    ALLOWED_BASENAMES.has(name.toUpperCase()) ||
    ALLOWED_BASENAMES.has(stem.toUpperCase());
  const allowedExt = TEXT_EXTENSIONS.has(ext);

  if (!allowedName && !allowedExt) {
    return {
      install: false,
      reason:
        "not a markdown/text asset (executable or binary content is skipped in v1)",
    };
  }
  if (typeof size === "number" && size > MAX_INSTALL_FILE_BYTES) {
    return { install: false, reason: "file exceeds the 512KB install cap" };
  }
  return { install: true };
}

// ─── Source folder resolution ────────────────────────────────────────────────

interface SourceFolderListing {
  installable: Array<{ relPath: string; entry: TreeEntry }>;
  skipped: SkippedFile[];
}

/**
 * Short-lived memo of full repo trees so a plan→confirm sequence (or a
 * plan over several items from one source) costs a single tree fetch.
 */
const TREE_MEMO_TTL_MS = 60_000;
const treeMemo = new Map<string, { at: number; entries: TreeEntry[] }>();

async function fetchTreeMemoized(
  source: string,
  ref: string,
): Promise<TreeEntry[]> {
  const key = `${source}@${ref}`;
  const cached = treeMemo.get(key);
  if (cached && Date.now() - cached.at < TREE_MEMO_TTL_MS) {
    return cached.entries;
  }
  const tree = await fetchRepoTree(source, ref);
  if (tree.notModified) {
    throw new Error(`Unexpected 304 from unconditional tree fetch (${source})`);
  }
  treeMemo.set(key, { at: Date.now(), entries: tree.entries });
  return tree.entries;
}

/**
 * List the files under an item's skill folder in the source repo and split
 * them into installable vs skipped (safety boundary). One tree fetch.
 */
async function listSourceFolder(
  source: string,
  ref: string,
  skillPath: string,
): Promise<SourceFolderListing> {
  const entries = await fetchTreeMemoized(source, ref);
  const prefix = skillPath ? `${skillPath}/` : "";
  const installable: Array<{ relPath: string; entry: TreeEntry }> = [];
  const skipped: SkippedFile[] = [];

  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if (prefix && !entry.path.startsWith(prefix)) continue;
    const relPath = prefix ? entry.path.slice(prefix.length) : entry.path;
    if (!relPath || relPath.includes("..")) continue;
    // Repo-root skills would sweep in the whole repo — install only the
    // top-level SKILL.md plus top-level text files in that case.
    if (!skillPath && relPath.includes("/")) continue;

    const verdict = classifyInstallFile(relPath, entry.size);
    if (!verdict.install) {
      skipped.push({ path: relPath, reason: verdict.reason ?? "skipped" });
      continue;
    }
    installable.push({ relPath, entry });
  }

  // Deterministic order; SKILL.md first for readability of payloads.
  installable.sort((a, b) =>
    a.relPath === "SKILL.md"
      ? -1
      : b.relPath === "SKILL.md"
        ? 1
        : a.relPath.localeCompare(b.relPath),
  );

  if (installable.length > MAX_INSTALL_FILES) {
    for (const extra of installable.splice(MAX_INSTALL_FILES)) {
      skipped.push({
        path: extra.relPath,
        reason: `exceeds the ${MAX_INSTALL_FILES}-file install cap`,
      });
    }
  }

  if (!installable.some((f) => f.relPath === "SKILL.md")) {
    throw new Error(
      `SKILL.md not found under ${source}@${ref}:${skillPath || "(root)"}`,
    );
  }

  return { installable, skipped };
}

// ─── Plan (confirmation payload) ─────────────────────────────────────────────

const EMPTY_CAPABILITIES: CapabilityManifest = {
  secrets: [],
  connectors: [],
  network: [],
  writes: [],
};

/**
 * Build the install-confirmation payload for an item. ALWAYS returned
 * before an install applies — the client re-posts with `confirm: true`.
 */
export async function planInstall(item: MarketplaceItem): Promise<InstallPlan> {
  const capabilities = item.capabilities ?? EMPTY_CAPABILITIES;

  if (item.source === "cue-official") {
    return {
      requiresConfirmation: true,
      item,
      skillId: item.id,
      files: [{ path: "SKILL.md" }],
      skipped: [],
      capabilities,
      notice: buildConsentNotice(capabilities, item.source),
      alreadyInstalled: existsSync(
        join(getWorkspaceSkillsDir(), item.id, "SKILL.md"),
      ),
    };
  }

  const { installable, skipped } = await listSourceFolder(
    item.source,
    item.ref,
    item.skillPath,
  );
  const files: PlannedFile[] = installable.map(({ relPath, entry }) => ({
    path: relPath,
    ...(typeof entry.size === "number" ? { size: entry.size } : {}),
  }));

  return {
    requiresConfirmation: true,
    item,
    skillId: item.id,
    files,
    skipped,
    capabilities,
    notice: buildConsentNotice(capabilities, item.source),
    alreadyInstalled: existsSync(
      join(getWorkspaceSkillsDir(), item.id, "SKILL.md"),
    ),
  };
}

// ─── Install ─────────────────────────────────────────────────────────────────

function sha256Hex(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/**
 * Perform a consented install: fetch the installable files, stage, commit
 * into the managed dir, and record the lock entry (per-file sha256 + git
 * blob shas + the consent snapshot).
 */
export async function performInstall(
  item: MarketplaceItem,
): Promise<InstallResult> {
  if (item.source === "cue-official") {
    const catalog = await resolveCatalog(item.id);
    const entry = catalog.find((s) => s.id === item.id);
    if (!entry) {
      throw new Error(`Skill "${item.id}" not found in the Cue catalog`);
    }
    await installSkillLocally(item.id, entry, true);
    // First-party installs keep their existing provenance (install-meta.json);
    // the github lock does not apply.
    return {
      ok: true,
      skillId: item.id,
      lock: {
        source: "cue-official",
        sourceType: "github",
        ref: "catalog",
        skillPath: item.id,
        computedHash: {},
        installedAt: new Date().toISOString(),
        consent: {
          consentedAt: new Date().toISOString(),
          capabilities: EMPTY_CAPABILITIES,
          undeclared: false,
        },
      },
      skipped: [],
    };
  }

  const { installable, skipped } = await listSourceFolder(
    item.source,
    item.ref,
    item.skillPath,
  );

  const fetched = await mapWithConcurrency(
    installable,
    RAW_FETCH_CONCURRENCY,
    async ({ relPath, entry }) => {
      const sourcePath = item.skillPath
        ? `${item.skillPath}/${relPath}`
        : relPath;
      const content = await fetchRawFile(item.source, item.ref, sourcePath);
      return { relPath, entry, content };
    },
  );

  const files: Record<string, string> = {};
  const computedHash: Record<string, string> = {};
  const gitSha: Record<string, string> = {};
  for (const result of fetched) {
    if (result instanceof Error) throw result;
    files[result.relPath] = result.content;
    computedHash[result.relPath] = `sha256:${sha256Hex(result.content)}`;
    gitSha[result.relPath] = result.entry.sha;
  }
  if (!files["SKILL.md"]) {
    throw new Error(`SKILL.md missing from fetched files for "${item.id}"`);
  }

  const capabilities = item.capabilities ?? EMPTY_CAPABILITIES;
  const skillId = item.id;
  const stagedDir = createSkillInstallStagingDir();
  try {
    const foundSkillMd = writeSkillFilesToDir(files, stagedDir);
    if (!foundSkillMd) {
      throw new Error(`Staged install for "${skillId}" is missing SKILL.md`);
    }
    writeInstallMeta(stagedDir, {
      origin: "custom",
      installedAt: new Date().toISOString(),
      sourceRepo: item.source,
      slug: item.skillPath || undefined,
    });
    // NOTE: no dependency install — package.json is outside the markdown-only
    // safety boundary and never reaches the staging dir.
    commitStagedSkillInstall(skillId, stagedDir);
  } catch (err) {
    log.warn({ err, skillId }, "Marketplace install failed");
    throw err;
  }

  const lockEntry: SkillsLockEntry = {
    source: item.source,
    sourceType: "github",
    ref: item.ref,
    skillPath: item.skillPath,
    computedHash,
    gitSha,
    installedAt: new Date().toISOString(),
    consent: {
      consentedAt: new Date().toISOString(),
      capabilities,
      undeclared: !hasDeclaredCapabilities(capabilities),
    },
    ...(skipped.length > 0 ? { skippedFiles: skipped } : {}),
  };
  upsertLockEntry(skillId, lockEntry);

  log.info(
    { skillId, source: item.source, files: Object.keys(files).length, skipped: skipped.length },
    "Installed marketplace skill",
  );
  return { ok: true, skillId, lock: lockEntry, skipped };
}

// ─── Installed listing ───────────────────────────────────────────────────────

export interface InstalledMarketplaceSkill {
  skillId: string;
  source: string;
  ref: string;
  skillPath: string;
  installedAt: string;
  present: boolean;
  undeclaredCapabilities: boolean;
  skippedFiles?: SkippedFile[];
}

/**
 * List lock-tracked installs. Entries whose managed dir vanished (manual
 * uninstall via the skills surface) are pruned from the lock as we go.
 */
export function listInstalled(): InstalledMarketplaceSkill[] {
  const lock = readSkillsLock();
  const skillsDir = getWorkspaceSkillsDir();
  const result: InstalledMarketplaceSkill[] = [];
  for (const [skillId, entry] of Object.entries(lock.skills)) {
    const present = existsSync(join(skillsDir, skillId, "SKILL.md"));
    if (!present) {
      removeLockEntry(skillId);
      continue;
    }
    result.push({
      skillId,
      source: entry.source,
      ref: entry.ref,
      skillPath: entry.skillPath,
      installedAt: entry.installedAt,
      present,
      undeclaredCapabilities: entry.consent?.undeclared ?? true,
      ...(entry.skippedFiles ? { skippedFiles: entry.skippedFiles } : {}),
    });
  }
  return result.sort((a, b) => a.skillId.localeCompare(b.skillId));
}

// ─── Updates ─────────────────────────────────────────────────────────────────

/**
 * Diff every lock entry against a fresh source tree. One tree fetch per
 * distinct source+ref; comparison rides the stored git blob shas — no file
 * downloads. Never applies anything: updates are explicit via
 * `applyUpdate`, only after the client shows this diff and the user
 * confirms.
 */
export async function checkUpdates(): Promise<UpdateCheck[]> {
  const lock = readSkillsLock();
  const entries = Object.entries(lock.skills);
  if (entries.length === 0) return [];

  const failed = new Map<string, Error>();
  async function treeFor(source: string, ref: string): Promise<TreeEntry[]> {
    const key = `${source}@${ref}`;
    const priorFailure = failed.get(key);
    if (priorFailure) throw priorFailure;
    try {
      return await fetchTreeMemoized(source, ref);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      failed.set(key, error);
      throw error;
    }
  }

  const checks: UpdateCheck[] = [];
  for (const [skillId, entry] of entries) {
    if (entry.source === "cue-official") continue;
    try {
      const treeEntries = await treeFor(entry.source, entry.ref);
      const prefix = entry.skillPath ? `${entry.skillPath}/` : "";
      const current = new Map<string, string>();
      for (const treeEntry of treeEntries) {
        if (treeEntry.type !== "blob") continue;
        if (prefix && !treeEntry.path.startsWith(prefix)) continue;
        const relPath = prefix
          ? treeEntry.path.slice(prefix.length)
          : treeEntry.path;
        if (!relPath || (!entry.skillPath && relPath.includes("/"))) continue;
        if (!classifyInstallFile(relPath, treeEntry.size).install) continue;
        current.set(relPath, treeEntry.sha);
      }

      const installed = entry.gitSha ?? {};
      const changes: UpdateFileChange[] = [];
      for (const [relPath, sha] of current) {
        if (!(relPath in installed)) {
          changes.push({ path: relPath, status: "added" });
        } else if (installed[relPath] !== sha) {
          changes.push({ path: relPath, status: "changed" });
        }
      }
      for (const relPath of Object.keys(installed)) {
        if (!current.has(relPath)) {
          changes.push({ path: relPath, status: "removed" });
        }
      }
      checks.push({
        skillId,
        source: entry.source,
        upToDate: changes.length === 0,
        changes,
      });
    } catch (err) {
      checks.push({
        skillId,
        source: entry.source,
        upToDate: false,
        error: err instanceof Error ? err.message : String(err),
        changes: [],
      });
    }
  }
  return checks;
}

/**
 * Apply an update for one lock entry — re-runs the install against the
 * pinned source/ref/skillPath (explicit confirm handled by the route).
 */
export async function applyUpdate(skillId: string): Promise<InstallResult> {
  const entry = getLockEntry(skillId);
  if (!entry) {
    throw new Error(`"${skillId}" has no marketplace lock entry`);
  }
  const item: MarketplaceItem = {
    id: skillId,
    name: skillId,
    displayName: skillId,
    description: "",
    source: entry.source,
    sourceLabel: entry.source,
    skillPath: entry.skillPath,
    ref: entry.ref,
    capabilities: entry.consent?.capabilities ?? EMPTY_CAPABILITIES,
  };
  return performInstall(item);
}
