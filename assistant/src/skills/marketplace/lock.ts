/**
 * Marketplace lock file — `$VELLUM_WORKSPACE_DIR/skills-lock.json`.
 *
 * One entry per marketplace-installed skill: source, ref, skillPath,
 * per-file sha256 (`computedHash`), per-file git blob sha (`gitSha`, for
 * cheap update diffs), install timestamp, and the recorded capability
 * consent. Catalog installs (`install-meta.json`) are NOT tracked here —
 * the lock covers only the github acquisition path.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { SkillsLockEntry, SkillsLockFile } from "./types.js";

const log = getLogger("marketplace-lock");

export function getSkillsLockPath(): string {
  return join(getWorkspaceDir(), "skills-lock.json");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, filePath);
}

export function readSkillsLock(): SkillsLockFile {
  const filePath = getSkillsLockPath();
  if (!existsSync(filePath)) return { version: 1, skills: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as SkillsLockFile;
    if (parsed.version !== 1 || typeof parsed.skills !== "object" || parsed.skills === null) {
      return { version: 1, skills: {} };
    }
    return parsed;
  } catch (err) {
    log.warn({ err, filePath }, "Failed to read skills-lock.json");
    return { version: 1, skills: {} };
  }
}

export function writeSkillsLock(lock: SkillsLockFile): void {
  atomicWriteJson(getSkillsLockPath(), lock);
}

export function upsertLockEntry(skillId: string, entry: SkillsLockEntry): void {
  const lock = readSkillsLock();
  lock.skills[skillId] = entry;
  writeSkillsLock(lock);
}

export function removeLockEntry(skillId: string): void {
  const lock = readSkillsLock();
  if (skillId in lock.skills) {
    delete lock.skills[skillId];
    writeSkillsLock(lock);
  }
}

export function getLockEntry(skillId: string): SkillsLockEntry | undefined {
  return readSkillsLock().skills[skillId];
}
