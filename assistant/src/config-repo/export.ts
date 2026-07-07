/**
 * Deterministic serializer for the config-as-code exporter (WS5).
 *
 * Builds a file tree (relative path → content) covering the durable config
 * surface:
 *
 *   assistant.json          — raw config.json, SANS SECRETS (redacted)
 *   skills/installed.json   — installed managed skills + install-meta lock
 *   schedules.json          — durable schedule definitions (no runtime state)
 *   profile/<name>.md       — workspace-root prompt/persona markdown
 *                             (IDENTITY.md, SOUL.md, MEMORY.md, …)
 *   memory/<rel-path>.md    — memory tree markdown files
 *
 * Determinism contract: identical durable state must serialize to an
 * identical tree (sorted keys, sorted lists, trailing newlines) so the git
 * layer can skip commits when nothing changed. Volatile fields (nextRunAt,
 * retry counters, lastRunAt) are deliberately excluded.
 *
 * Everything written here passes through the redaction layer — see redact.ts.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { loadRawConfig } from "../config/loader.js";
import { parseFrontmatterFields } from "../skills/frontmatter.js";
import { readInstallMeta } from "../skills/install-meta.js";
import { getWorkspaceDir, getWorkspaceSkillsDir } from "../util/platform.js";
import { redactConfigValue, scrubSecretsFromString } from "./redact.js";

export interface ExportLimits {
  maxMemoryFiles: number;
  maxFileBytes: number;
}

const DEFAULT_LIMITS: ExportLimits = {
  maxMemoryFiles: 200,
  maxFileBytes: 262144,
};

/** JSON.stringify with recursively sorted object keys + trailing newline. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + "\n";
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = sortKeysDeep(src[key]);
    }
    return out;
  }
  return value;
}

// ── Section builders ─────────────────────────────────────────────────

function buildAssistantJson(): string {
  const raw = loadRawConfig();
  return stableStringify(redactConfigValue(raw));
}

function buildInstalledSkills(): string {
  const skillsDir = getWorkspaceSkillsDir();
  const entries: Array<Record<string, unknown>> = [];
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir).sort()) {
      if (name.startsWith(".")) continue;
      const skillDir = join(skillsDir, name);
      const skillMdPath = join(skillDir, "SKILL.md");
      try {
        if (!statSync(skillDir).isDirectory()) continue;
        if (!existsSync(skillMdPath)) continue;
      } catch {
        continue;
      }

      const entry: Record<string, unknown> = { id: name };
      try {
        const parsed = parseFrontmatterFields(
          readFileSync(skillMdPath, "utf-8"),
        );
        if (parsed) {
          if (typeof parsed.fields.name === "string") {
            entry.name = parsed.fields.name;
          }
          if (typeof parsed.fields.description === "string") {
            entry.description = scrubSecretsFromString(
              parsed.fields.description,
            );
          }
        }
      } catch {
        // Unreadable SKILL.md — keep the bare id entry.
      }

      // Lock data: origin/version/hash from install-meta.json when present.
      const meta = readInstallMeta(skillDir);
      if (meta) {
        entry.lock = redactConfigValue({
          origin: meta.origin,
          installedAt: meta.installedAt,
          ...(meta.version ? { version: meta.version } : {}),
          ...(meta.contentHash ? { contentHash: meta.contentHash } : {}),
        });
      }
      entries.push(entry);
    }
  }
  return stableStringify({ skills: entries });
}

async function buildSchedules(): Promise<string> {
  // Dynamic import: schedule-store pulls in the DB layer; keep that out of
  // this module's static graph (and out of any consumer that only needs the
  // pure serializers).
  const { listSchedules } = await import("../schedule/schedule-store.js");
  const jobs = listSchedules();
  const durable = jobs
    .map((j) => ({
      id: j.id,
      name: j.name,
      description: j.description,
      enabled: j.enabled,
      syntax: j.syntax,
      expression: j.expression,
      timezone: j.timezone,
      message: j.message,
      script: j.script,
      mode: j.mode,
      routingIntent: j.routingIntent,
      routingHints: j.routingHints,
      quiet: j.quiet,
      reuseConversation: j.reuseConversation,
      maxRetries: j.maxRetries,
      retryBackoffMs: j.retryBackoffMs,
      timeoutMs: j.timeoutMs,
      inferenceProfile: j.inferenceProfile,
      createdBy: j.createdBy,
      createdAt: j.createdAt,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return stableStringify({ schedules: redactConfigValue(durable) });
}

/** Workspace-root prompt/persona markdown (IDENTITY.md, SOUL.md, MEMORY.md…). */
function collectProfileFiles(
  files: Map<string, string>,
  limits: ExportLimits,
): void {
  const root = getWorkspaceDir();
  if (!existsSync(root)) return;
  for (const name of readdirSync(root).sort()) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const abs = join(root, name);
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > limits.maxFileBytes) continue;
      files.set(
        `profile/${name}`,
        ensureTrailingNewline(scrubSecretsFromString(readFileSync(abs, "utf-8"))),
      );
    } catch {
      // Skip unreadable files — the export is best-effort per section.
    }
  }
}

/** Memory tree markdown files ($VELLUM_WORKSPACE_DIR/memory/**). */
function collectMemoryFiles(
  files: Map<string, string>,
  limits: ExportLimits,
): void {
  const memoryRoot = join(getWorkspaceDir(), "memory");
  if (!existsSync(memoryRoot)) return;

  const collected: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (collected.length >= limits.maxMemoryFiles) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (collected.length >= limits.maxMemoryFiles) return;
      if (name.startsWith(".")) continue;
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      try {
        const st = statSync(abs);
        if (st.isDirectory()) {
          walk(abs, relPath);
        } else if (
          st.isFile() &&
          name.toLowerCase().endsWith(".md") &&
          st.size <= limits.maxFileBytes
        ) {
          files.set(
            `memory/${relPath}`,
            ensureTrailingNewline(
              scrubSecretsFromString(readFileSync(abs, "utf-8")),
            ),
          );
          collected.push(relPath);
        }
      } catch {
        // Skip unreadable entries.
      }
    }
  };
  walk(memoryRoot, "");
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : content + "\n";
}

// ── Tree build + write ───────────────────────────────────────────────

/** Build the full export tree: relative path → file content. */
export async function buildConfigExportTree(
  limits: ExportLimits = DEFAULT_LIMITS,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  files.set("assistant.json", buildAssistantJson());
  files.set("skills/installed.json", buildInstalledSkills());
  files.set("schedules.json", await buildSchedules());
  collectProfileFiles(files, limits);
  collectMemoryFiles(files, limits);
  return files;
}

/**
 * Materialize the tree into the repo working directory. Everything except
 * `.git` is replaced so deletions in the durable state show up as deletions
 * in the diff.
 */
export function writeConfigExportTree(
  repoDir: string,
  files: Map<string, string>,
): void {
  if (existsSync(repoDir)) {
    for (const name of readdirSync(repoDir)) {
      if (name === ".git") continue;
      rmSync(join(repoDir, name), { recursive: true, force: true });
    }
  }
  for (const [rel, content] of files) {
    const abs = join(repoDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
}
