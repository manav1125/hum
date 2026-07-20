/**
 * Tests for `buildSystemPrompt` render memoization.
 *
 * The prompt is rebuilt on every agent-loop round; the memo must return
 * byte-identical output for unchanged inputs (this is also what keeps the
 * prompt prefix provider-cacheable turn-over-turn) while busting on
 * workspace prompt-file edits (mtime/size fingerprint) and on
 * render-relevant option changes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  __clearSystemPromptMemoForTesting,
  buildSystemPrompt,
} from "../prompts/system-prompt.js";
import { getWorkspaceDir } from "../util/platform.js";

beforeEach(() => {
  __clearSystemPromptMemoForTesting();
});

describe("buildSystemPrompt memoization", () => {
  test("repeated builds with identical inputs are byte-identical", () => {
    const first = buildSystemPrompt();
    const second = buildSystemPrompt();
    expect(second).toBe(first);
  });

  test("editing a workspace prompt file busts the memo", () => {
    const workspaceDir = getWorkspaceDir();
    mkdirSync(workspaceDir, { recursive: true });
    const soulPath = join(workspaceDir, "SOUL.md");

    writeFileSync(soulPath, "# Soul\n\nCalm and precise memo-test persona.\n");
    const first = buildSystemPrompt();
    expect(first).toContain("memo-test persona");

    // Same content → memo hit, byte-identical.
    expect(buildSystemPrompt()).toBe(first);

    writeFileSync(
      soulPath,
      "# Soul\n\nEnergetic and playful memo-test persona v2.\n",
    );
    const second = buildSystemPrompt();
    expect(second).toContain("memo-test persona v2");
    expect(second).not.toBe(first);
  });

  test("different render-relevant options produce distinct entries", () => {
    const withClient = buildSystemPrompt({ hasNoClient: false });
    const withoutClient = buildSystemPrompt({ hasNoClient: true });
    // hasNoClient flips the External Service Access section body.
    expect(withoutClient).not.toBe(withClient);
    // And each variant stays stable on re-build.
    expect(buildSystemPrompt({ hasNoClient: false })).toBe(withClient);
    expect(buildSystemPrompt({ hasNoClient: true })).toBe(withoutClient);
  });
});
