/**
 * Tests for `skill-history.ts`, run against a REAL git repository rather than
 * a mocked git.
 *
 * The behavior worth protecting is entirely about how git actually responds to
 * a pathspec: that a commit touching many unrelated files still yields a diff
 * scoped to one skill, that `:(exclude)` really drops the usage stamp, and
 * that a commit whose only in-skill change was excluded disappears from the
 * list. A stubbed git would let all three regress while the tests stayed
 * green, so each test builds commits in a temp repo and reads them back.
 *
 * The textconv sentinel test additionally proves these reads inherit the
 * central `--no-textconv --no-ext-diff` hardening (the S4 guard) from
 * `WorkspaceGitService.execGit`: it arms a repository-controlled textconv
 * driver, confirms raw `git show` would have run it, and asserts the history
 * read did not.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { _resetGitServiceRegistry } from "./git-service.js";

let repoDir = "";

// The module resolves the workspace through `getWorkspaceDir()`; point it at
// the temp repository while a test is running, deferring to the real
// implementation otherwise so later files in a combined run are unaffected.
// `getWorkspaceGitService` is left real so the git invocations under test are
// the ones that ship (including execGit's central diff-helper hardening).
const actualPlatform = await import("../util/platform.js");
// Grab the real function BEFORE mocking: `mock.module` updates the namespace
// object's live bindings, so reading it from `actualPlatform` inside the mock
// would call the mock itself and recurse forever.
const realGetWorkspaceDir = actualPlatform.getWorkspaceDir;
mock.module("../util/platform.js", () => ({
  ...actualPlatform,
  getWorkspaceDir: () => (repoDir.length > 0 ? repoDir : realGetWorkspaceDir()),
}));

const { getSkillHistory, DIFF_TRUNCATION_MARKER, MAX_REVISION_DIFF_CHARS } =
  await import("./skill-history.js");

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

/** Write a file under the repo, creating parents. */
function write(relPath: string, content: string): void {
  const full = join(repoDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function commit(message: string): void {
  git("add", "-A");
  git("commit", "--no-verify", "-m", message);
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "skill-history-"));
  git("init", "-b", "main");
  // Fresh service per repo: the registry caches by directory, and a cached
  // service from an earlier (deleted) temp dir must not leak between tests.
  _resetGitServiceRegistry();
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  repoDir = "";
});

describe("getSkillHistory", () => {
  test("returns one entry per update, with the diff scoped to that skill", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n\nStep one.\n");
    write("skills/beta/SKILL.md", "# Beta\n\nUnrelated.\n");
    commit("initial");

    // A batched commit, the way the workspace heartbeat writes them: this
    // skill, an unrelated skill, and a conversation file all at once.
    write("skills/alpha/SKILL.md", "# Alpha\n\nStep one, corrected.\n");
    write("skills/beta/SKILL.md", "# Beta\n\nAlso changed.\n");
    write("conversations/whatever.jsonl", "{}\n");
    commit("auto-commit: heartbeat safety net (3 files)");

    const history = await getSkillHistory("alpha");

    expect(history.skillId).toBe("alpha");
    expect(history.revisions).toHaveLength(2);
    // Newest first.
    const [latest] = history.revisions;
    expect(latest!.files).toEqual(["SKILL.md"]);
    expect(latest!.diff).toContain("Step one, corrected.");
    // The other skill and the conversation file are absent even though the
    // same commit changed them.
    expect(latest!.diff).not.toContain("Also changed.");
    expect(latest!.diff).not.toContain("conversations/");
  });

  test("combines SKILL.md and companion changes from one update into a single entry", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    commit("initial");

    write("skills/alpha/SKILL.md", "# Alpha\n\nRun the script.\n");
    write("skills/alpha/scripts/export.py", "print('v1')\n");
    write("skills/alpha/references/gotchas.md", "Watch the rate limit.\n");
    commit("auto-commit: heartbeat safety net (3 files)");

    const history = await getSkillHistory("alpha");

    // One update, not three per-file entries.
    const [latest] = history.revisions;
    expect(latest!.files.sort()).toEqual([
      "SKILL.md",
      "references/gotchas.md",
      "scripts/export.py",
    ]);
    expect(latest!.diff).toContain("Run the script.");
    expect(latest!.diff).toContain("print('v1')");
    expect(latest!.diff).toContain("Watch the rate limit.");
  });

  test("a load-only commit does not appear as an update", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    write(
      "skills/alpha/install-meta.json",
      JSON.stringify({ origin: "custom", lastUsedAt: "2026-08-04" }),
    );
    commit("initial");

    // The skill was loaded, so only the usage stamp moved. Roughly half of a
    // real skill's commits look like this.
    write(
      "skills/alpha/install-meta.json",
      JSON.stringify({ origin: "custom", lastUsedAt: "2026-08-05" }),
    );
    commit("auto-commit: heartbeat safety net (1 file)");

    const history = await getSkillHistory("alpha");

    // Only the creating commit counts; the stamp bump is not an update.
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]!.files).toEqual(["SKILL.md"]);
  });

  test("a real edit alongside a stamp bump keeps the edit and drops the stamp", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    write(
      "skills/alpha/install-meta.json",
      JSON.stringify({ lastUsedAt: "1" }),
    );
    commit("initial");

    write("skills/alpha/SKILL.md", "# Alpha\n\nRefined.\n");
    write(
      "skills/alpha/install-meta.json",
      JSON.stringify({ lastUsedAt: "2" }),
    );
    commit("auto-commit: heartbeat safety net (2 files)");

    const history = await getSkillHistory("alpha");

    const [latest] = history.revisions;
    expect(latest!.files).toEqual(["SKILL.md"]);
    expect(latest!.diff).toContain("Refined.");
    expect(latest!.diff).not.toContain("lastUsedAt");
  });

  test("respects the limit after filtering, not before", async () => {
    write("skills/alpha/SKILL.md", "v0\n");
    commit("initial");
    // Interleave real edits with load-only commits, so a naive
    // `--max-count=limit` would return mostly stamps.
    for (let i = 1; i <= 4; i++) {
      write(
        "skills/alpha/install-meta.json",
        JSON.stringify({ lastUsedAt: `stamp-${i}` }),
      );
      commit(`stamp ${i}`);
      write("skills/alpha/SKILL.md", `v${i}\n`);
      commit(`edit ${i}`);
    }

    const history = await getSkillHistory("alpha", { limit: 3 });

    expect(history.revisions).toHaveLength(3);
    // Every returned entry is a real edit.
    for (const revision of history.revisions) {
      expect(revision.files).toEqual(["SKILL.md"]);
    }
  });

  test("caps an oversized revision diff and marks the cut", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    commit("initial");

    // One revision whose diff comfortably exceeds the per-revision cap.
    const hugeLine = "x".repeat(200);
    const huge = Array.from(
      { length: Math.ceil((MAX_REVISION_DIFF_CHARS * 2) / hugeLine.length) },
      (_, i) => `${i} ${hugeLine}`,
    ).join("\n");
    write("skills/alpha/references/generated.txt", `${huge}\n`);
    commit("auto-commit: heartbeat safety net (1 file)");

    const history = await getSkillHistory("alpha");

    const [latest] = history.revisions;
    expect(latest!.diff.endsWith(DIFF_TRUNCATION_MARKER)).toBe(true);
    expect(latest!.diff.length).toBeLessThanOrEqual(
      MAX_REVISION_DIFF_CHARS + DIFF_TRUNCATION_MARKER.length,
    );
    // The entry still identifies what changed even though the diff was cut.
    expect(latest!.files).toEqual(["references/generated.txt"]);
  });

  test("reports when older history was squashed away", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    commit("Compacted workspace history (14667 commits squashed)");
    write("skills/alpha/SKILL.md", "# Alpha\n\nMore.\n");
    commit("auto-commit: heartbeat safety net (1 file)");

    const history = await getSkillHistory("alpha");

    // The caller needs this to avoid presenting the oldest entry as creation.
    expect(history.truncatedByCompaction).toBe(true);
  });

  test("an untracked skill has empty history rather than an error", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    commit("initial");

    const history = await getSkillHistory("never-committed");

    expect(history.revisions).toEqual([]);
    expect(history.skillId).toBe("never-committed");
  });

  test("a traversal-shaped id is rejected before it reaches a pathspec", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    commit("initial");

    await expect(getSkillHistory("../../etc")).rejects.toThrow(
      /Invalid skill id/,
    );
  });

  test("a workspace that is not a repository yields empty history, and stays not a repository", async () => {
    const bare = mkdtempSync(join(tmpdir(), "skill-history-norepo-"));
    const previous = repoDir;
    repoDir = bare;
    try {
      const history = await getSkillHistory("alpha");

      expect(history.revisions).toEqual([]);
      // The empty result is not enough on its own: reaching
      // `runReadOnlyGit` would ALSO return empty here, having quietly
      // created the repository first (git init, .gitignore, hooks, an
      // initial commit). This is served from a GET, so the absence of the
      // write is the actual invariant.
      expect(existsSync(join(bare, ".git"))).toBe(false);
    } finally {
      repoDir = previous;
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("a repository-controlled textconv driver never runs for history reads (S4 guard)", async () => {
    // Arm the sentinel: a diff driver whose textconv would replace every
    // `.md` hunk with a marker string. Workspace files and git config are
    // model-writable in production, so this is exactly the shape of a
    // malicious workspace.
    // The conversion must depend on the file content: a constant output
    // converts both sides of the diff to the same text, which yields an
    // EMPTY diff rather than a marked one. Prefixing every line keeps the
    // two sides different so the marker lands in the rendered hunks.
    const sentinel = join(repoDir, "sentinel.sh");
    writeFileSync(sentinel, '#!/bin/sh\nsed "s/^/TEXTCONV_RAN /" "$1"\n');
    chmodSync(sentinel, 0o755);
    write(".gitattributes", "*.md diff=sentinel\n");
    git("config", "diff.sentinel.textconv", sentinel);

    write("skills/alpha/SKILL.md", "# Alpha\n");
    commit("initial");
    write("skills/alpha/SKILL.md", "# Alpha\n\nReal content.\n");
    commit("edit");

    // Prove the sentinel is live: an unguarded `git show` DOES run it.
    const sha = git("rev-parse", "--short", "HEAD").trim();
    const unguarded = git("show", "--format=", sha, "--", "skills/alpha/");
    expect(unguarded).toContain("TEXTCONV_RAN");

    // The shipped read path must not: execGit splices --no-textconv
    // --no-ext-diff into every diff/show/log invocation.
    const history = await getSkillHistory("alpha");
    const [latest] = history.revisions;
    expect(latest!.diff).toContain("Real content.");
    expect(latest!.diff).not.toContain("TEXTCONV_RAN");
  });
});
