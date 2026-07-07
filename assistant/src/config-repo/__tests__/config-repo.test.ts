/**
 * WS5 config-as-code exporter tests.
 *
 * Covers the brief's verification list:
 *  - flag OFF (default) ⇒ exporter never runs, no repo created
 *  - redaction: seeded canary secrets never appear in the exported tree
 *  - identical state ⇒ no duplicate commit (deterministic serialize)
 *  - forced exporter failure ⇒ the mutating operation still succeeds
 *  - skill mutation hook ⇒ redacted commit
 *  - autonomous change ⇒ awaiting_review work item whose output route
 *    synthesizes highlights from notes; Redo (run route) ⇒ revert commit
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";

// Silence the schedule-store's debounced background-wake refresh — its timer
// races test teardown and is covered by the background-wake tests.
mock.module("../../background-wake/publisher.js", () => ({
  refreshBackgroundWakeIntent: () => {},
}));

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  invalidateConfigCache,
  loadRawConfig,
} from "../../config/loader.js";
import { initializeDb } from "../../memory/db-init.js";
import { ROUTES } from "../../runtime/routes/work-items-routes.js";
import { createSchedule } from "../../schedule/schedule-store.js";
import { createManagedSkill } from "../../skills/managed-store.js";
import {
  getWorkItem,
  listWorkItems,
} from "../../work-items/work-item-store.js";
import {
  getWorkspaceConfigPath,
  getWorkspaceDir,
} from "../../util/platform.js";
import { runGit } from "../git.js";
import {
  flushConfigRepo,
  getConfigRepoDir,
  recordConfigChange,
} from "../index.js";
import { redactConfigValue, scrubSecretsFromString } from "../redact.js";

initializeDb();

// ── Helpers ──────────────────────────────────────────────────────────

function writeConfig(raw: Record<string, unknown>): void {
  writeFileSync(getWorkspaceConfigPath(), JSON.stringify(raw, null, 2) + "\n");
  invalidateConfigCache();
}

function enableConfigRepo(extraConfig: Record<string, unknown> = {}): void {
  const raw = loadRawConfig();
  writeConfig({ ...raw, ...extraConfig, configRepo: { enabled: true } });
}

function commitSubjects(): string[] {
  const log = runGit(getConfigRepoDir(), ["log", "--format=%s"]);
  return log.ok ? log.stdout.split("\n").filter(Boolean) : [];
}

function readTree(dir: string, acc: Record<string, string> = {}, rel = "") {
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const abs = join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) readTree(abs, acc, relPath);
    else acc[relPath] = readFileSync(abs, "utf-8");
  }
  return acc;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await flushConfigRepo();
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const CANARIES = [
  "sk-ant-canary1234567890",
  "sk-or-canaryabcdef1234",
  "sk-plaincanary123456",
  "r8_canaryZZZZ11112222",
  "whsec_canary1234567890",
  "xoxb-canary-1234567890-abcdef",
  "ghp_canaryABC123456789",
  "AKIACANARY0123456789",
  "canary-blanked-by-key-name",
  "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
];

// Secret-shape patterns from the execution brief (§3 WS5) — the exported
// tree must not match ANY of them.
const BRIEF_PATTERNS = [
  /sk-(?:ant-|or-)?[A-Za-z0-9_-]{8,}/,
  /r8_[A-Za-z0-9]{8,}/,
  /whsec_[A-Za-z0-9]{8,}/,
  /xox[a-z]-[A-Za-z0-9-]{8,}/,
  /ghp_[A-Za-z0-9]{8,}/,
  /AKIA[0-9A-Z]{16}/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/,
  /api[-_]?key\s*[=:]\s*canary/i,
];

// ── Tests (sequential; state accumulates within the temp workspace) ──

describe("config-repo (WS5)", () => {
  beforeAll(() => {
    // Workspace-root persona file + memory tree file with embedded secrets.
    writeFileSync(
      join(getWorkspaceDir(), "IDENTITY.md"),
      "# Identity\n\nDeploy token is r8_canaryZZZZ11112222 and Bearer canarybearertoken123.\n",
    );
    mkdirSync(join(getWorkspaceDir(), "memory"), { recursive: true });
    writeFileSync(
      join(getWorkspaceDir(), "memory", "notes.md"),
      "AWS key AKIACANARY0123456789 and jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl\n",
    );
  });

  test("redaction unit: key blanking + value-shape scrubbing", () => {
    const redacted = redactConfigValue({
      apiKey: "canary-blanked-by-key-name",
      nested: { webhookSecret: "canary-blanked-by-key-name" },
      innocuous: "prefix sk-ant-canary1234567890 suffix",
    }) as Record<string, unknown>;
    expect(redacted.apiKey).toBe("[redacted]");
    expect((redacted.nested as Record<string, unknown>).webhookSecret).toBe(
      "[redacted]",
    );
    expect(redacted.innocuous).toBe("prefix [redacted] suffix");
    expect(scrubSecretsFromString("api_key=canaryqueryvalue rest")).toBe(
      "[redacted] rest",
    );
  });

  test("flag OFF (default): recordConfigChange never runs, no repo, no items", async () => {
    // Default config: configRepo absent ⇒ enabled defaults to false.
    writeConfig(loadRawConfig());
    recordConfigChange({ cause: "should never export", actor: "assistant" });
    await flushConfigRepo();
    expect(existsSync(getConfigRepoDir())).toBe(false);
    expect(
      listWorkItems({ status: "awaiting_review" }).filter(
        (i) => i.sourceType === "config_repo",
      ),
    ).toHaveLength(0);
  });

  test("forced exporter failure: mutation still succeeds, nothing thrown", async () => {
    enableConfigRepo();
    // A regular FILE at the repo path makes ensureRepo/mkdir fail.
    writeFileSync(getConfigRepoDir(), "not a directory");
    try {
      const result = createManagedSkill({
        id: "ws5-failure-path-skill",
        name: "WS5 failure path",
        description: "exporter failure must not block this",
        bodyMarkdown: "body",
        contactId: "user-1",
      });
      expect(result.created).toBe(true);
      await flushConfigRepo(); // must not throw
      expect(statSync(getConfigRepoDir()).isFile()).toBe(true);
    } finally {
      rmSync(getConfigRepoDir(), { force: true });
    }
  });

  test("redaction: canaries seeded across the config surface never reach the tree", async () => {
    enableConfigRepo({
      toolApis: { tavilyKey: "sk-plaincanary123456" },
      customService: {
        apiToken: "canary-blanked-by-key-name",
        note: "use sk-ant-canary1234567890 or sk-or-canaryabcdef1234, hook whsec_canary1234567890, slack xoxb-canary-1234567890-abcdef, gh ghp_canaryABC123456789, api_key=canaryqueryvalue",
      },
    });
    createSchedule({
      name: "ws5-canary-schedule",
      message: "rotate whsec_canary1234567890 weekly",
      cronExpression: "0 9 * * 1",
      createdBy: "user",
    });

    recordConfigChange({ cause: "canary seed", actor: "user" });
    await waitFor(
      () => commitSubjects().some((s) => s.includes("canary seed")),
      "canary-seed commit",
    );

    const tree = readTree(getConfigRepoDir());
    const paths = Object.keys(tree);
    expect(paths).toContain("assistant.json");
    expect(paths).toContain("skills/installed.json");
    expect(paths).toContain("schedules.json");
    expect(paths).toContain("profile/IDENTITY.md");
    expect(paths).toContain("memory/notes.md");

    const everything = Object.values(tree).join("\n");
    for (const canary of CANARIES) {
      expect(everything).not.toContain(canary);
    }
    for (const pattern of BRIEF_PATTERNS) {
      expect(everything).not.toMatch(pattern);
    }
    expect(everything).toContain("[redacted]");
    // The canary-bearing rows still exist, redacted in place.
    expect(tree["schedules.json"]).toContain("ws5-canary-schedule");
    expect(tree["assistant.json"]).toContain("customService");
  });

  test("deterministic serialize: identical state ⇒ no new commit", async () => {
    const before = commitSubjects().length;
    recordConfigChange({ cause: "no-op export", actor: "user" });
    await flushConfigRepo();
    expect(commitSubjects().length).toBe(before);
  });

  test("skill mutation hook ⇒ redacted commit naming actor+cause", async () => {
    const result = createManagedSkill({
      id: "ws5-user-skill",
      name: "WS5 user skill",
      description: "installed by a user",
      bodyMarkdown: "body",
      contactId: "user-1",
    });
    expect(result.created).toBe(true);

    await waitFor(
      () =>
        commitSubjects().some((s) =>
          s.includes("managed skill created: ws5-user-skill (user)"),
        ),
      "user skill-creation commit",
    );

    const tree = readTree(getConfigRepoDir());
    expect(tree["skills/installed.json"]).toContain("ws5-user-skill");
    // User-attributed change ⇒ commit only, no Review item.
    expect(
      listWorkItems({ status: "awaiting_review" }).filter(
        (i) => i.sourceType === "config_repo",
      ),
    ).toHaveLength(0);
  });

  test("autonomous change ⇒ awaiting_review item; output route synthesizes highlights; Redo reverts", async () => {
    // No contactId ⇒ the hook records an autonomous ("assistant") change.
    const result = createManagedSkill({
      id: "ws5-auto-skill",
      name: "WS5 autonomous skill",
      description: "scaffolded by the agent",
      bodyMarkdown: "body",
    });
    expect(result.created).toBe(true);

    let itemId = "";
    await waitFor(() => {
      const items = listWorkItems({ status: "awaiting_review" }).filter(
        (i) =>
          i.sourceType === "config_repo" &&
          (i.notes ?? "").includes("ws5-auto-skill"),
      );
      if (items.length === 0) return false;
      itemId = items[0].id;
      return true;
    }, "autonomous review item");

    const item = getWorkItem(itemId)!;
    expect(item.sourceType).toBe("config_repo");
    expect(item.sourceId).toMatch(/^[0-9a-f]{40}$/);
    expect(item.notes ?? "").toContain("- ");

    // Output route (the CURRENT one) must return synthesized highlights.
    const outputRoute = ROUTES.find(
      (r) => r.operationId === "getWorkItemOutput",
    )!;
    const outputRes = (await outputRoute.handler({
      pathParams: { id: itemId },
    })) as {
      success: boolean;
      output: { summary: string; highlights: string[] };
    };
    expect(outputRes.success).toBe(true);
    expect(outputRes.output.summary.length).toBeGreaterThan(0);
    expect(outputRes.output.highlights.length).toBeGreaterThan(0);
    expect(
      outputRes.output.highlights.some((h) => h.startsWith("- ")),
    ).toBe(true);

    // Redo (run route) ⇒ git revert of the recorded commit, item closed.
    const runRoute = ROUTES.find((r) => r.operationId === "runWorkItem")!;
    const runRes = (await runRoute.handler({
      pathParams: { id: itemId },
    })) as { success: boolean };
    expect(runRes.success).toBe(true);

    const subjects = commitSubjects();
    expect(subjects[0].startsWith("Revert")).toBe(true);
    const after = getWorkItem(itemId)!;
    expect(after.status).toBe("done");
    expect(after.lastRunStatus).toBe("reverted");
  });
});
