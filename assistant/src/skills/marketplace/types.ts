/**
 * Skill marketplace — shared types.
 *
 * The marketplace is a PARALLEL acquisition path into the existing managed
 * skills dir (`$VELLUM_WORKSPACE_DIR/skills/`). It indexes public GitHub
 * repos ("sources") for `SKILL.md` files, installs markdown/text assets only,
 * and pins every install in `$VELLUM_WORKSPACE_DIR/skills-lock.json` with
 * per-file sha256 hashes. Nothing here touches `skill_load`, the catalog.json
 * flow, includes resolution, or the bundled-tool registry.
 */

// ─── Sources ─────────────────────────────────────────────────────────────────

/** Where a marketplace source's content lives. */
export type MarketplaceSourceKind = "github" | "catalog";

export interface MarketplaceSource {
  /**
   * `owner/repo` for github sources, or the reserved `cue-official` address
   * for the first-party catalog source.
   */
  address: string;
  kind: MarketplaceSourceKind;
  /** Git ref (branch/tag). Defaults to the repo's default branch. */
  ref?: string;
  /** Human label shown on cards/chips. Defaults to the address. */
  label?: string;
  enabled: boolean;
  /** Seeded by Cue — protected from deletion (can still be disabled). */
  builtIn?: boolean;
  /** SPDX id noted at add/seed time (e.g. "MIT", "Apache-2.0"). */
  license?: string;
}

// ─── Capability manifest ─────────────────────────────────────────────────────

/**
 * Optional capability declarations parsed from SKILL.md frontmatter
 * (`secrets:` / `connectors:` / `network:` / `writes:`). Most third-party
 * skills declare nothing — the consent card says so explicitly.
 */
export interface CapabilityManifest {
  secrets: string[];
  connectors: string[];
  network: string[];
  writes: string[];
}

export function hasDeclaredCapabilities(m: CapabilityManifest): boolean {
  return (
    m.secrets.length > 0 ||
    m.connectors.length > 0 ||
    m.network.length > 0 ||
    m.writes.length > 0
  );
}

// ─── Index ───────────────────────────────────────────────────────────────────

export interface MarketplaceItem {
  /** Namespaced install id: `{owner}--{repo}--{skillName}` (or catalog id). */
  id: string;
  /** Frontmatter `name` (clean display name — NOT namespaced). */
  name: string;
  displayName: string;
  description: string;
  /** Source address (`owner/repo` or `cue-official`). */
  source: string;
  sourceLabel: string;
  /** Repo-relative directory of the skill ("" = repo root). */
  skillPath: string;
  /** Resolved git ref the index was built from (branch name). */
  ref: string;
  /** Browsable URL of the skill folder (github html link). */
  url?: string;
  emoji?: string;
  /** Frontmatter `license` when declared (some repos license per-skill). */
  license?: string;
  capabilities: CapabilityManifest;
  /** Git blob sha of SKILL.md — used for cheap change detection. */
  skillMdSha?: string;
}

export interface SourceIndex {
  address: string;
  kind: MarketplaceSourceKind;
  /** Resolved ref (branch) the tree was fetched at. */
  ref: string;
  /** Epoch ms when this index was built. */
  fetchedAt: number;
  /** ETag of the git tree response (conditional re-fetch). */
  treeEtag?: string;
  /** Sha of the git tree the index was built from. */
  treeSha?: string;
  /** True when the recursive tree was truncated or item cap hit. */
  truncated?: boolean;
  items: MarketplaceItem[];
}

// ─── Lock file ───────────────────────────────────────────────────────────────

/** Consent recorded at install time. */
export interface InstallConsent {
  consentedAt: string; // ISO 8601
  /** Snapshot of the capability manifest the user consented to. */
  capabilities: CapabilityManifest;
  /** True when no capabilities were declared (third-party, review before use). */
  undeclared: boolean;
}

export interface SkillsLockEntry {
  /** Source address (`owner/repo`). */
  source: string;
  sourceType: "github";
  /** Git ref (branch) the install resolved. */
  ref: string;
  /** Repo-relative skill directory ("" = repo root). */
  skillPath: string;
  /** Per-file sha256 content hash, keyed by skill-relative path. */
  computedHash: Record<string, string>;
  /**
   * Per-file git blob sha (sha1), keyed by skill-relative path. Lets the
   * updates check diff against a fresh tree without downloading files.
   */
  gitSha?: Record<string, string>;
  installedAt: string; // ISO 8601
  consent: InstallConsent;
  /** Files present in the source folder but NOT installed (safety boundary). */
  skippedFiles?: SkippedFile[];
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface SkillsLockFile {
  version: 1;
  skills: Record<string, SkillsLockEntry>;
}

// ─── Install planning / confirmation ────────────────────────────────────────

export interface PlannedFile {
  /** Skill-relative path (e.g. "SKILL.md", "references/guide.md"). */
  path: string;
  size?: number;
}

/**
 * The install-confirmation payload. ALWAYS returned before an install is
 * applied — the client re-posts with `confirm: true` to proceed.
 */
export interface InstallPlan {
  requiresConfirmation: true;
  item: MarketplaceItem;
  /** The managed-dir skill id the install will write. */
  skillId: string;
  files: PlannedFile[];
  skipped: SkippedFile[];
  capabilities: CapabilityManifest;
  /**
   * Consent copy: lists declared capabilities, or the "no declared
   * capabilities — third-party skill, review before use" notice.
   */
  notice: string;
  /** True when the skill id already exists in the managed dir. */
  alreadyInstalled: boolean;
}

export interface InstallResult {
  ok: true;
  skillId: string;
  lock: SkillsLockEntry;
  skipped: SkippedFile[];
}

// ─── Updates ─────────────────────────────────────────────────────────────────

export interface UpdateFileChange {
  path: string;
  status: "added" | "removed" | "changed";
}

export interface UpdateCheck {
  skillId: string;
  source: string;
  upToDate: boolean;
  /** Present when the source could not be re-resolved. */
  error?: string;
  changes: UpdateFileChange[];
}
