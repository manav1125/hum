/**
 * Minimal local-git driver for the config-as-code exporter (WS5).
 *
 * Shells out to the `git` CLI with a sanitized environment and per-invocation
 * `-c` overrides so user/global git config can never interfere:
 *  - `commit.gpgsign=false` — signing would prompt/fail headlessly.
 *  - `core.hooksPath` pointed at an empty directory — user hooks are
 *    neutralized (a hook could block or exfiltrate).
 *  - fixed committer identity — no dependence on user.name/user.email.
 *
 * LOCAL only in v1: no remotes, no push. All operations are best-effort and
 * return result objects instead of throwing so callers can swallow-and-log.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const GIT_IDENTITY = [
  "-c",
  "user.name=Cue Config Repo",
  "-c",
  "user.email=config-repo@cue.invalid",
  "-c",
  "commit.gpgsign=false",
];

export interface GitResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

/** Path of an (empty, auto-created) hooks dir used to neutralize hooksPath. */
function noHooksDir(repoDir: string): string {
  const dir = join(repoDir, ".git", "no-hooks");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort; git tolerates a missing hooksPath dir (no hooks run).
  }
  return dir;
}

export function runGit(repoDir: string, args: string[]): GitResult {
  try {
    const stdout = execFileSync(
      "git",
      [
        "-C",
        repoDir,
        ...GIT_IDENTITY,
        "-c",
        `core.hooksPath=${noHooksDir(repoDir)}`,
        ...args,
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
        env: {
          // Sanitized env: no credentials, no user git config surprises.
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    );
    return { ok: true, stdout: stdout ?? "" };
  } catch (err) {
    const e = err as { message?: string; stderr?: unknown };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString("utf-8")
          : "";
    return {
      ok: false,
      stdout: "",
      error: (stderr || e.message || "git failed").trim(),
    };
  }
}

/** Initialize the repo if `.git` is missing. Returns false on failure. */
export function ensureRepo(repoDir: string): boolean {
  try {
    mkdirSync(repoDir, { recursive: true });
  } catch {
    return false;
  }
  if (existsSync(join(repoDir, ".git"))) return true;
  const init = runGit(repoDir, ["init", "--initial-branch=main"]);
  if (!init.ok) {
    // Older git without --initial-branch support.
    return runGit(repoDir, ["init"]).ok;
  }
  return true;
}

/** True when the working tree differs from HEAD (or the repo has no commits). */
export function hasChanges(repoDir: string): boolean {
  const status = runGit(repoDir, ["status", "--porcelain"]);
  return status.ok && status.stdout.trim().length > 0;
}

/**
 * Stage everything and commit. Returns the new commit hash, or null when
 * there was nothing to commit (identical state ⇒ no commit), or an error.
 */
export function commitAll(
  repoDir: string,
  message: string,
): { hash: string | null; error?: string } {
  if (!hasChanges(repoDir)) return { hash: null };
  const add = runGit(repoDir, ["add", "-A"]);
  if (!add.ok) return { hash: null, error: add.error };
  const commit = runGit(repoDir, ["commit", "-m", message, "--no-verify"]);
  if (!commit.ok) return { hash: null, error: commit.error };
  const head = runGit(repoDir, ["rev-parse", "HEAD"]);
  if (!head.ok) return { hash: null, error: head.error };
  return { hash: head.stdout.trim() };
}

/**
 * `git show --name-status` summary of a commit, as "STATUS\tpath" lines.
 * Used to build the Review-lane diff bullets.
 */
export function commitChangeSummary(repoDir: string, hash: string): string[] {
  const res = runGit(repoDir, [
    "show",
    "--name-status",
    "--format=",
    "--no-color",
    hash,
  ]);
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Revert a commit (creates a revert commit). Returns the revert commit hash.
 * On conflict the revert is aborted and an error is returned — observe-only
 * v1 never leaves the repo mid-revert.
 */
export function revertCommit(
  repoDir: string,
  hash: string,
): { success: boolean; revertHash?: string; error?: string } {
  const revert = runGit(repoDir, ["revert", "--no-edit", hash]);
  if (!revert.ok) {
    runGit(repoDir, ["revert", "--abort"]);
    return { success: false, error: revert.error };
  }
  const head = runGit(repoDir, ["rev-parse", "HEAD"]);
  return head.ok
    ? { success: true, revertHash: head.stdout.trim() }
    : { success: true };
}
