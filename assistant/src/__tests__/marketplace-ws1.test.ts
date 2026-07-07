/**
 * WS1 skill marketplace — focused verification.
 *
 * Covers, per the execution brief (docs/cue-kortix-execution-brief.md §3 WS1):
 *  1. Real GitHub indexing of a public repo (anthropics/skills) — SKILL.md
 *     items parse with name/description via the SHARED frontmatter parser.
 *  2. Install writes into the EXISTING managed skills dir, records a
 *     hash-pinned skills-lock.json entry, and SKIPS executable content
 *     (markdown-only safety boundary).
 *  3. The capability-consent payload is ALWAYS returned before install.
 *  4. Non-regression: `loadSkillBySelector` on a bundled skill behaves
 *     unchanged; installed marketplace skills surface as ordinary managed
 *     skills.
 *  5. Feature flag OFF ⇒ marketplace routes 404 and produce no side
 *     effects (no source seeding, no cache writes).
 *
 * Network note: the indexing/install describes hit the real GitHub API
 * (unauthenticated, ~3 requests total) — that is the point: real surfaces,
 * no mocks.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { clearFeatureFlagOverridesCache } from "../config/assistant-feature-flags.js";
import { loadSkillBySelector, loadSkillCatalog } from "../config/skills.js";
import { NotFoundError } from "../runtime/routes/errors.js";
import { ROUTES as MARKETPLACE_ROUTES } from "../runtime/routes/marketplace-routes.js";
import { buildConsentNotice } from "../skills/marketplace/capabilities.js";
import { indexSource, marketplaceSkillId, parseSkillMdForIndex } from "../skills/marketplace/indexer.js";
import { checkUpdates, classifyInstallFile, planInstall } from "../skills/marketplace/install.js";
import { getSkillsLockPath, readSkillsLock } from "../skills/marketplace/lock.js";
import { getSourcesFilePath, loadSources, normalizeGithubAddress } from "../skills/marketplace/sources.js";
import type { MarketplaceItem, MarketplaceSource } from "../skills/marketplace/types.js";
import { getWorkspaceSkillsDir } from "../util/platform.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

const ANTHROPIC_SKILLS: MarketplaceSource = {
  address: "anthropics/skills",
  kind: "github",
  enabled: true,
};

function routeHandler(operationId: string) {
  const route = MARKETPLACE_ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`route ${operationId} not registered`);
  return route.handler;
}

afterAll(() => {
  clearFeatureFlagOverridesCache();
});

// ─── 5. Feature flag OFF: 404s, zero side effects ───────────────────────────
// Runs FIRST so we can assert the OFF state seeds/caches nothing before any
// other test touches the workspace.

describe("marketplace feature flag OFF", () => {
  test("routes 404 and perform no work", async () => {
    setOverridesForTesting({ marketplace: false });
    try {
      expect(existsSync(getSourcesFilePath())).toBe(false);

      for (const operationId of [
        "listMarketplaceItems",
        "listMarketplaceSources",
        "listMarketplaceInstalled",
        "checkMarketplaceUpdates",
      ]) {
        await expect(routeHandler(operationId)({})).rejects.toBeInstanceOf(
          NotFoundError,
        );
      }
      await expect(
        routeHandler("installMarketplaceSkill")({
          body: { itemId: "x--y--z", confirm: true },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // OFF state left no trace: no sources file, no cache dir, no lock.
      expect(existsSync(getSourcesFilePath())).toBe(false);
      expect(
        existsSync(join(getWorkspaceSkillsDir(), "..", "marketplace-cache")),
      ).toBe(false);
      expect(existsSync(getSkillsLockPath())).toBe(false);
    } finally {
      clearFeatureFlagOverridesCache();
    }
  });

  test("flag defaults ON (registry defaultEnabled: true)", async () => {
    // With no overrides, the declared registry default applies.
    const result = (await routeHandler("listMarketplaceSources")({})) as {
      sources: Array<{ address: string }>;
    };
    expect(result.sources.length).toBeGreaterThan(0);
  });
});

// ─── Sources registry ────────────────────────────────────────────────────────

describe("marketplace sources", () => {
  test("seeds the vetted defaults (license-checked; ComposioHQ dropped)", () => {
    const sources = loadSources();
    const addresses = sources.map((s) => s.address);
    expect(addresses).toContain("cue-official");
    expect(addresses).toContain("anthropics/skills");
    expect(addresses).toContain("anthropics/knowledge-work-plugins");
    expect(addresses).toContain("davila7/claude-code-templates");
    expect(addresses).toContain("alirezarezvani/claude-skills");
    expect(addresses).toContain("github/awesome-copilot");
    expect(addresses).toContain("obra/superpowers");
    // Dropped at seed time: no license file on the repo.
    expect(addresses).not.toContain("ComposioHQ/awesome-claude-skills");
    expect(sources.every((s) => s.enabled)).toBe(true);
  });

  test("normalizes github addresses", () => {
    expect(normalizeGithubAddress("owner/repo")).toBe("owner/repo");
    expect(normalizeGithubAddress("https://github.com/owner/repo")).toBe(
      "owner/repo",
    );
    expect(
      normalizeGithubAddress("https://github.com/owner/repo/tree/main/x"),
    ).toBe("owner/repo");
    expect(normalizeGithubAddress("owner/repo.git")).toBe("owner/repo");
    expect(normalizeGithubAddress("not a repo")).toBeNull();
  });
});

// ─── Safety boundary ─────────────────────────────────────────────────────────

describe("markdown-only install boundary", () => {
  test("allows markdown/text assets", () => {
    expect(classifyInstallFile("SKILL.md").install).toBe(true);
    expect(classifyInstallFile("references/guide.md").install).toBe(true);
    expect(classifyInstallFile("notes.txt").install).toBe(true);
    expect(classifyInstallFile("LICENSE").install).toBe(true);
    expect(classifyInstallFile("LICENSE.md").install).toBe(true);
  });

  test("skips executable and binary content with a disclosed reason", () => {
    for (const path of [
      "tools/run.sh",
      "scripts/extract.py",
      "TOOLS.json",
      "index.ts",
      "helper.js",
      "bin/tool",
      "logo.png",
      "package.json",
    ]) {
      const verdict = classifyInstallFile(path);
      expect(verdict.install).toBe(false);
      expect(verdict.reason).toBeTruthy();
    }
    // Oversized text is skipped too.
    expect(classifyInstallFile("big.md", 10 * 1024 * 1024).install).toBe(false);
  });
});

// ─── Capability manifest + consent ───────────────────────────────────────────

describe("capability manifest + consent payload", () => {
  test("parses declared frontmatter capabilities via the shared parser", () => {
    const parsed = parseSkillMdForIndex(
      [
        "---",
        "name: cap-demo",
        "description: Demo skill declaring capabilities",
        "secrets:",
        "  - STRIPE_API_KEY",
        "connectors: [gmail, slack]",
        "network:",
        "  - api.stripe.com",
        "writes: workspace",
        "---",
        "Body",
      ].join("\n"),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("cap-demo");
    expect(parsed!.capabilities.secrets).toEqual(["STRIPE_API_KEY"]);
    expect(parsed!.capabilities.connectors).toEqual(["gmail", "slack"]);
    expect(parsed!.capabilities.network).toEqual(["api.stripe.com"]);
    expect(parsed!.capabilities.writes).toEqual(["workspace"]);

    const notice = buildConsentNotice(parsed!.capabilities, "owner/repo");
    expect(notice).toContain("secrets (STRIPE_API_KEY)");
    expect(notice).toContain("connectors (gmail, slack)");
  });

  test("undeclared capabilities get the review-before-use notice", () => {
    const notice = buildConsentNotice(
      { secrets: [], connectors: [], network: [], writes: [] },
      "owner/repo",
    );
    expect(notice).toContain(
      "No declared capabilities — third-party skill from owner/repo, review before use.",
    );
  });
});

// ─── 1. Real GitHub indexing ─────────────────────────────────────────────────

let indexedItems: MarketplaceItem[] = [];

describe("real GitHub indexing (anthropics/skills)", () => {
  test(
    "indexes SKILL.md items with parsed name/description",
    async () => {
      const index = await indexSource(ANTHROPIC_SKILLS);
      indexedItems = index.items;

      expect(index.items.length).toBeGreaterThan(3);
      for (const item of index.items) {
        expect(item.name.length).toBeGreaterThan(0);
        expect(item.description.length).toBeGreaterThan(0);
        expect(item.id.startsWith("anthropics--skills--")).toBe(true);
        expect(item.source).toBe("anthropics/skills");
        expect(item.capabilities).toBeDefined();
      }
      // Namespacing helper matches the produced ids.
      expect(marketplaceSkillId("anthropics/skills", "docx")).toBe(
        "anthropics--skills--docx",
      );
    },
    { timeout: 120_000 },
  );

  test("serves the second call from the 24h cache", async () => {
    const first = await indexSource(ANTHROPIC_SKILLS);
    const second = await indexSource(ANTHROPIC_SKILLS);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.items.length).toBe(first.items.length);
  });

  test("items flow through the route with query filtering", async () => {
    const result = (await routeHandler("listMarketplaceItems")({
      queryParams: { source: "anthropics/skills" },
    })) as { items: MarketplaceItem[] };
    expect(result.items.length).toBe(indexedItems.length);

    const query = indexedItems[0].name.slice(0, 6);
    const filtered = (await routeHandler("listMarketplaceItems")({
      queryParams: { source: "anthropics/skills", query },
    })) as { items: MarketplaceItem[] };
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.length).toBeLessThanOrEqual(indexedItems.length);
  });
});

// ─── 2+3. Install: consent payload, managed dir, lock, skips ────────────────

describe("marketplace install (real repo)", () => {
  test(
    "install without confirm returns the consent payload; with confirm writes managed dir + lock and skips executables",
    async () => {
      expect(indexedItems.length).toBeGreaterThan(0);

      // Prefer a skill that ships non-markdown content so the skip
      // disclosure is exercised for real; fall back to the smallest one.
      let chosen: { item: MarketplaceItem; planSkipped: number } | null = null;
      for (const item of indexedItems.slice(0, 8)) {
        const plan = await planInstall(item);
        if (plan.skipped.length > 0) {
          chosen = { item, planSkipped: plan.skipped.length };
          break;
        }
        chosen ??= { item, planSkipped: 0 };
      }
      const item = chosen!.item;

      // Phase 1 — the confirmation payload (ALWAYS returned first).
      const payload = (await routeHandler("installMarketplaceSkill")({
        body: { itemId: item.id },
      })) as {
        requiresConfirmation: boolean;
        skillId: string;
        files: Array<{ path: string }>;
        skipped: Array<{ path: string; reason: string }>;
        notice: string;
        capabilities: { secrets: string[] };
      };
      expect(payload.requiresConfirmation).toBe(true);
      expect(payload.skillId).toBe(item.id);
      expect(payload.files.some((f) => f.path === "SKILL.md")).toBe(true);
      expect(payload.notice.length).toBeGreaterThan(0);
      expect(payload.capabilities).toBeDefined();
      // Nothing installed yet.
      expect(
        existsSync(join(getWorkspaceSkillsDir(), item.id, "SKILL.md")),
      ).toBe(false);

      // Phase 2 — explicit consent.
      const result = (await routeHandler("installMarketplaceSkill")({
        body: { itemId: item.id, confirm: true },
      })) as {
        ok: boolean;
        skillId: string;
        lock: {
          source: string;
          sourceType: string;
          ref: string;
          skillPath: string;
          computedHash: Record<string, string>;
          consent: { undeclared: boolean; consentedAt: string };
        };
        skipped: Array<{ path: string }>;
      };
      expect(result.ok).toBe(true);

      // Managed dir: skill_load's dir, untouched conventions.
      const skillDir = join(getWorkspaceSkillsDir(), item.id);
      expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);

      // Lock entry: hash-pinned, source-pinned, consent recorded.
      const lock = readSkillsLock();
      const entry = lock.skills[item.id];
      expect(entry).toBeDefined();
      expect(entry.source).toBe("anthropics/skills");
      expect(entry.sourceType).toBe("github");
      expect(entry.skillPath).toBe(item.skillPath);
      expect(entry.consent.consentedAt).toBeTruthy();
      const hashes = Object.entries(entry.computedHash);
      expect(hashes.length).toBeGreaterThan(0);
      for (const [, hash] of hashes) {
        expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
      // The recorded sha256 of SKILL.md matches the bytes on disk.
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(readFileSync(join(skillDir, "SKILL.md"), "utf-8"));
      expect(entry.computedHash["SKILL.md"]).toBe(
        `sha256:${hasher.digest("hex")}`,
      );

      // Safety boundary: nothing outside the allowlist landed on disk.
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? walk(join(dir, e.name)).map((p) => `${e.name}/${p}`)
            : [e.name],
        );
      for (const relPath of walk(skillDir)) {
        if (relPath === "install-meta.json") continue; // installer provenance
        expect(classifyInstallFile(relPath).install).toBe(true);
      }
      // Skips are disclosed in payload + lock when the source had them.
      if (chosen!.planSkipped > 0) {
        expect(result.skipped.length).toBeGreaterThan(0);
        expect(entry.skippedFiles?.length).toBeGreaterThan(0);
      }

      // 4. The installed skill is an ordinary managed skill: the shared
      // catalog discovers it and loadSkillBySelector loads it with the
      // CLEAN display name (namespacing lives only in the id).
      const catalogEntry = loadSkillCatalog().find((s) => s.id === item.id);
      expect(catalogEntry).toBeDefined();
      expect(catalogEntry!.source).toBe("managed");
      const loaded = loadSkillBySelector(item.id);
      expect(loaded.skill).toBeDefined();
      expect(loaded.skill!.name).toBe(item.name);
      expect(loaded.skill!.body.length).toBeGreaterThan(0);

      // installed flag now shows on the listing.
      const listing = (await routeHandler("listMarketplaceInstalled")({})) as {
        installed: Array<{ skillId: string }>;
      };
      expect(listing.installed.some((i) => i.skillId === item.id)).toBe(true);
    },
    { timeout: 180_000 },
  );

  test(
    "updates check reports the fresh install as up to date",
    async () => {
      const updates = await checkUpdates();
      expect(updates.length).toBeGreaterThan(0);
      for (const update of updates) {
        expect(update.error).toBeUndefined();
        expect(update.upToDate).toBe(true);
        expect(update.changes.length).toBe(0);
      }
    },
    { timeout: 120_000 },
  );
});

// ─── 4. Non-regression: skill_load machinery untouched ──────────────────────

describe("non-regression: existing skill machinery", () => {
  test("loadSkillBySelector on a bundled skill behaves unchanged", () => {
    const bundled = loadSkillCatalog().filter((s) => s.source === "bundled");
    expect(bundled.length).toBeGreaterThan(0);

    const target = bundled[0];
    const loaded = loadSkillBySelector(target.id);
    expect(loaded.error).toBeUndefined();
    expect(loaded.skill).toBeDefined();
    expect(loaded.skill!.id).toBe(target.id);
    expect(loaded.skill!.name).toBe(target.name);
    expect(loaded.skill!.source).toBe("bundled");
    expect(typeof loaded.skill!.body).toBe("string");
    // {baseDir} substitution still applies (loadSkillDefinition semantics).
    expect(loaded.skill!.body.includes("{baseDir}")).toBe(false);
  });

  test("unknown selector still resolves through the unchanged error path", () => {
    const loaded = loadSkillBySelector("definitely-not-a-real-skill-xyz");
    expect(loaded.skill).toBeUndefined();
    expect(loaded.errorCode).toBe("not_found");
  });
});
