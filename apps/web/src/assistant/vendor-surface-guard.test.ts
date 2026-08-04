/**
 * The fixpoint guard for vendor discretion in the web client.
 *
 * A managed (HQ-provisioned) customer never chose, pays for, or administers
 * the inference vendor, and the product must not name it. `hideVendorUi()`
 * is the mechanism — but a mechanism nobody remembers to call is not a
 * control. The audit that prompted this file found eight surfaces printing
 * the provider's name in a codebase that already had the helper and applied
 * it correctly in six places; the helper was not the problem, the absence of
 * a tripwire was.
 *
 * So this suite enumerates, from the source itself, every file that could
 * name a vendor, and requires each one to be either gated or explicitly
 * exempted with a reason. A NEW surface fails here on the commit that adds
 * it, instead of being found by the next audit.
 *
 * Three scans, because the leak has three shapes:
 *   1. STATIC — a vendor name written as a literal in the web source.
 *   2. DYNAMIC — a model/provider string that arrives from the daemon as
 *      data and flows through a generic renderer. No literal to grep, so
 *      those call sites are listed by hand in `DYNAMIC_MODEL_SURFACES`.
 *   3. SEED — a vendor name baked into a record the DAEMON writes into a
 *      customer's workspace: an inference-profile description, a seeded
 *      connection label, onboarding copy. This one is not a web file at
 *      all, and gating the renderer does not help: the string is already
 *      on the customer's disk, and any future surface that prints it
 *      leaks on the spot. The seeded `Balanced Economy` description read
 *      "Strong open model (MiniMax M3) at a lower price point" and was
 *      fetched into the usage tab's profile metadata while going
 *      unrendered — latent, not safe.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..");

/**
 * Prose forms only — capitalized as a human would read them. The lowercase
 * slug forms (`gemini-live`, `deepseek/deepseek-v4-pro`) are internal
 * identifiers that appear in enum values and API payload keys; matching
 * those would drown the signal in identifiers nobody reads.
 */
const VENDOR_PROSE = [
  "Anthropic",
  "Claude",
  "DeepSeek",
  "Deepseek",
  "Fireworks",
  "Gemini",
  "Kimi",
  "MiniMax",
  "OpenAI",
  "OpenRouter",
  "Qwen",
];

/**
 * A file counts as guarded only when it references the gate MODULE.
 *
 * Deliberately not "mentions `hideVendor`": a local variable of that name
 * survives deleting the import, so the looser marker made this suite pass
 * against a mutant with the gate torn out. The import is the thing that
 * cannot be there by accident.
 */
const GATE_MODULE = "use-managed-mode";

function isGated(source: string): boolean {
  return source.includes(GATE_MODULE);
}

/**
 * Files allowed to name a vendor without referencing the gate themselves,
 * each with the reason. Every entry is a claim that can be checked by
 * reading the named gate — not a "known failure" list.
 */
const ALLOWLIST: Record<string, string> = {
  // The BYO provider/key UI. The whole page returns null on managed via
  // `domains/settings/ai/ai-page.tsx`, and the sidebar entry is dropped by
  // `domains/settings/settings-layout.tsx`. A self-hoster who supplies the
  // key is entitled to every word of it.
  "domains/settings/ai/ai-types.ts": "gated by domains/settings/ai/ai-page.tsx",
  "domains/settings/ai/chatgpt-oauth-section.tsx":
    "gated by domains/settings/ai/ai-page.tsx",
  "domains/settings/ai/profile-advanced-params.tsx":
    "gated by domains/settings/ai/ai-page.tsx",
  "domains/settings/ai/profile-editor-modal.tsx":
    "gated by domains/settings/ai/ai-page.tsx",
  "domains/settings/ai/image-generation-card.tsx":
    "gated by domains/settings/ai/ai-page.tsx",
  "domains/settings/ai/profile-editor-provider-section.tsx":
    "gated by domains/settings/ai/ai-page.tsx",
  "domains/settings/ai/profile-param-visibility.ts":
    "gated by domains/settings/ai/ai-page.tsx",
  "domains/settings/ai/profile-prefill.ts":
    "gated by domains/settings/ai/ai-page.tsx",
  "domains/settings/ai/provider-create-form.tsx":
    "gated by domains/settings/ai/ai-page.tsx",
  "domains/settings/ai/provider-editor-modal.tsx":
    "gated by domains/settings/ai/ai-page.tsx",

  // Model/provider catalogs. Imported ONLY by domains/settings/ai/** (the
  // gated page) and by the BYO onboarding key screen, which returns null on
  // managed via `domains/onboarding/pages/api-key-screen.tsx`.
  "assistant/llm-model-catalog.ts":
    "consumed only by domains/settings/ai/** (gated)",
  "domains/onboarding/provider-catalog.ts":
    "consumed only by the BYO key screen (gated by api-key-screen.tsx)",

  // The LLM inspector's provider display map. The inspector is a staff
  // developer tool (`domains/chat/inspector/access.ts`), and on a managed
  // instance the daemon refuses its data routes outright — see
  // `vendorDisclosing` in assistant/src/runtime/auth/route-policy.ts.
  "domains/chat/inspector/inspector-formatters.ts":
    "staff-only inspector; its data routes are vendorDisclosing on managed",

  // Not Cue's vendor: the list of assistants a user is migrating FROM
  // ("Which assistant are you coming from?").
  "domains/onboarding/prechat.ts": "names competitor products, not Cue's model",

  // The BYO-key validation hook behind the onboarding "How Cue thinks" step.
  // Its only caller is `pages/hq-onboarding/think-step.tsx`, which drops the
  // BYO option entirely when `hideVendorUi()` is true — so this code is
  // unreachable on a managed instance.
  "pages/hq-onboarding/use-setup-data.ts":
    "only reachable from the BYO option, which think-step.tsx gates",

  // The gate itself, which quotes the names in order to ban them.
  "assistant/use-managed-mode.ts": "defines the gate",
};

/**
 * Surfaces that render a model or provider value supplied by the daemon.
 * There is no literal to grep for, so they are listed here and each must
 * reference the gate. Removing a gate makes this fail even though the
 * static scan would stay silent.
 */
// NOTE: `domains/logs/usage-tab-state.ts` is deliberately absent — it is a
// pure helper that takes the resolved boolean as an argument and names no
// vendor itself. Its gating lives in `usage-tab.tsx`, which is listed.
const DYNAMIC_MODEL_SURFACES = [
  // Usage & spend: `model` / `provider` group-by rows and chart legend.
  "domains/logs/components/usage-tab.tsx",
  "domains/logs/group-labels.ts",
  // Guardrails: MODEL MIX band, per-act model, per-agent model pin.
  "domains/guardrails/guardrails-page.tsx",
  // Mobile act ledger: per-act model.
  "mobile-v3/you/ledger-page.tsx",
  // Mobile AI settings leaf: "Running on <model>".
  "domains/settings/mobile/mobile-settings-leafs.tsx",
  // The composer's `/` menu: `/models` is one click from being sent.
  "domains/chat/components/chat-composer/chat-composer.tsx",
  "domains/chat/components/mobile-chat-view.tsx",
];

// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") continue;
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Drop comments so a developer note explaining WHY a vendor is not named
 * does not itself trip the scan. Line comments and any line inside (or
 * opening) a block comment are removed.
 */
function stripComments(source: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line.startsWith("*") || line.startsWith("//")) continue;
    kept.push(rawLine.split("//")[0]);
  }
  return kept.join("\n");
}

// Test files are excluded: a test may legitimately assert on a vendor
// string (this one does), and a test is not a surface a customer can read.
const SOURCE_FILES = walk(SRC_ROOT)
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f))
  .map((f) => ({ path: relative(SRC_ROOT, f), full: f }));

describe("vendor discretion — static scan", () => {
  test("every file naming a vendor is gated or explicitly exempt", () => {
    const ungated: Array<{ file: string; vendor: string; line: string }> = [];

    for (const { path, full } of SOURCE_FILES) {
      if (ALLOWLIST[path]) continue;
      const source = readFileSync(full, "utf8");
      if (isGated(source)) continue;

      const code = stripComments(source);
      for (const vendor of VENDOR_PROSE) {
        if (!code.includes(vendor)) continue;
        const line =
          code
            .split("\n")
            .find((l) => l.includes(vendor))
            ?.trim() ?? "";
        ungated.push({ file: path, vendor, line: line.slice(0, 120) });
        break;
      }
    }

    // A failure here is not "add it to the allowlist" — it is "decide
    // whether a managed customer may read this, then gate it or justify it".
    expect(ungated).toEqual([]);
  });

  test("the allowlist has no stale entries", () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (path) => !SOURCE_FILES.some((f) => f.path === path),
    );
    expect(stale).toEqual([]);
  });

  test("the scan can actually see a vendor name", () => {
    // Guards the guard: a stripComments bug that ate everything would make
    // the scan above pass vacuously.
    const code = stripComments('const a = "runs on Claude";\n// Claude\n');
    expect(code).toContain("Claude");
    expect(code.split("Claude")).toHaveLength(2);
  });
});

describe("vendor discretion — dynamic surfaces", () => {
  test("every surface rendering a daemon-supplied model string is gated", () => {
    const ungated = DYNAMIC_MODEL_SURFACES.filter((path) => {
      const full = join(SRC_ROOT, path);
      return !isGated(readFileSync(full, "utf8"));
    });

    expect(ungated).toEqual([]);
  });

  test("every listed surface still exists", () => {
    const missing = DYNAMIC_MODEL_SURFACES.filter(
      (path) => !SOURCE_FILES.some((f) => f.path === path),
    );
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Seed data — the daemon's side of the same rule.
// ---------------------------------------------------------------------------

const SEED_ROOT = join(SRC_ROOT, "..", "..", "..", "assistant", "src");

/**
 * A file holds seed data when it seeds (path says `seed`) or when it is a
 * workspace migration — migrations write directly into a live customer's
 * `config.json`, `memory/`, and DB, which is exactly how the vendor-naming
 * profile description reached every existing instance.
 *
 * `EXTRA_SEED_SOURCES` covers seeders whose filename does not say so.
 */
const EXTRA_SEED_SOURCES = ["providers/inference/connections.ts"];

function isSeedSource(path: string): boolean {
  return /seed/i.test(path) || path.startsWith("workspace/migrations/");
}

/**
 * Seed files allowed to carry a vendor name, each with the reason. As with
 * `ALLOWLIST`, every entry is a claim a reader can check — not a list of
 * known failures.
 */
const SEED_ALLOWLIST: Record<string, string> = {
  // Labels for the canonical provider connections. Rendered only by
  // `domains/settings/ai/manage-providers-modal.tsx` and its siblings — the
  // page `domains/settings/ai/ai-page.tsx` returns null on managed, and a
  // self-hoster supplying the key is entitled to see which vendor it is.
  "providers/inference/connections.ts":
    "connection labels; rendered only by domains/settings/ai/** (gated)",

  // Release-note text appended to `<workspace>/UPDATES.md`. The bulletin
  // feature was removed: nothing reads the file, and migration
  // `098-remove-stale-updates-bulletin-file` deletes it outright — and runs
  // after all three, so a fresh workspace never keeps the text either.
  "workspace/migrations/049-release-notes-default-sonnet.ts":
    "UPDATES.md text; nothing consumes it and migration 098 deletes the file",
  "workspace/migrations/053-release-notes-acp-codex.ts":
    "UPDATES.md text; nothing consumes it and migration 098 deletes the file",
  "workspace/migrations/058-release-notes-acp-sessions-ui.ts":
    "UPDATES.md text; nothing consumes it and migration 098 deletes the file",

  // Onboarding bullet seeded into `memory/threads.md`: "offer to port their
  // context from a prior assistant (ChatGPT, Claude, ...)". Names the
  // products a user is migrating FROM, not Cue's own model — the same call
  // as `domains/onboarding/prechat.ts`. 091 supersedes 069's wording.
  "workspace/migrations/069-seed-onboarding-threads.ts":
    "names prior assistants a user migrates from, not Cue's model",
  "workspace/migrations/091-retighten-migration-onboarding-thread.ts":
    "names prior assistants a user migrates from, not Cue's model",

  // The repair itself, which has to quote the strings in order to replace
  // them — the seed-data equivalent of `use-managed-mode.ts` defining the
  // gate by naming what it bans.
  "workspace/migrations/104-devendor-balanced-economy-description.ts":
    "quotes the two old descriptions in order to overwrite them",
};

/**
 * A `WorkspaceMigration`'s own `description` is a developer log line —
 * `workspace/migrations/runner.ts` logs it and no surface renders it, so
 * "from Kimi K2.6 to MiniMax M3" there is not a leak.
 *
 * Removing exactly that one field, rather than allowlisting the file, keeps
 * the rest of every migration under the scan: `101`'s registry description
 * is forgiven while the `profile.description = ...` it WRITES is not. The
 * match is anchored on the `id:` that precedes it, so an ordinary
 * `description:` key in a seeded record (which is the thing we are hunting)
 * is never swallowed.
 */
const MIGRATION_REGISTRY_DESCRIPTION =
  /\bid:[^,]*,\s*\n\s*description:\s*\n?\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/;

function withoutMigrationRegistryDescription(code: string): string {
  return code.replace(MIGRATION_REGISTRY_DESCRIPTION, "");
}

/**
 * Seeded copy is a string. Scanning literals only — rather than the whole
 * file — keeps identifiers and module paths (`AnthropicProvider`,
 * `forceOpenRouterSelfHost`, `../gemini/client.js`) out of the signal
 * without weakening it: a vendor name a customer can read has to be quoted
 * somewhere to get there.
 */
const STRING_LITERAL =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

function stringLiterals(code: string): string {
  return (code.match(STRING_LITERAL) ?? []).join("\n");
}

/** The vendor prose a seed file quotes, or null when it is clean. */
function seededVendor(path: string, source: string): string | null {
  let code = stripComments(source);
  if (path.startsWith("workspace/migrations/")) {
    code = withoutMigrationRegistryDescription(code);
  }
  const literals = stringLiterals(code);
  return VENDOR_PROSE.find((vendor) => literals.includes(vendor)) ?? null;
}

const SEED_FILES = walk(SEED_ROOT)
  .map((full) => ({ path: relative(SEED_ROOT, full), full }))
  .filter(
    ({ path }) =>
      !/\.(test|spec)\.tsx?$/.test(path) &&
      !path.split("/").includes("__tests__"),
  )
  .filter(
    ({ path }) => isSeedSource(path) || EXTRA_SEED_SOURCES.includes(path),
  );

describe("vendor discretion — daemon seed data", () => {
  test("the seed scan found the daemon source tree", () => {
    // Without this, moving `assistant/src` turns every assertion below into
    // a vacuous pass over an empty list.
    expect(SEED_FILES.length).toBeGreaterThan(50);
  });

  test("no seeded record names a vendor in copy a customer could read", () => {
    const leaking: Array<{ file: string; vendor: string }> = [];

    for (const { path, full } of SEED_FILES) {
      if (SEED_ALLOWLIST[path]) continue;
      const vendor = seededVendor(path, readFileSync(full, "utf8"));
      if (vendor) leaking.push({ file: path, vendor });
    }

    // A failure here means a record the daemon writes onto a customer's disk
    // names the inference vendor. Describe the trade-off instead — speed,
    // cost, depth, context — and never substitute a different vendor's name.
    expect(leaking).toEqual([]);
  });

  test("the seed allowlist has no stale entries", () => {
    const stale = [
      ...Object.keys(SEED_ALLOWLIST),
      ...EXTRA_SEED_SOURCES,
    ].filter((path) => !SEED_FILES.some((f) => f.path === path));
    expect(stale).toEqual([]);
  });

  test("the scan catches a vendor name in a seeded description", () => {
    // The exact shape this scan was written for.
    const seed = `const T = {
  "balanced-economy": {
    label: "Balanced Economy",
    description: "Strong open model (MiniMax M3) at a lower price point",
  },
};`;
    expect(seededVendor("config/seed-inference-profiles.ts", seed)).toBe(
      "MiniMax",
    );
  });

  test("forgiving the migration log line does not forgive what it writes", () => {
    // A migration whose own registry description is clean, but which writes
    // a vendor-naming description into the customer's config, must still
    // trip — otherwise the strip above is a hole rather than a filter.
    const migration = `export const m: WorkspaceMigration = {
  id: "999-example",
  description: "Rewrite the economy profile",
  run(dir: string): void {
    profile.description = "Strong open model (MiniMax M3)";
  },
};`;
    expect(seededVendor("workspace/migrations/999-example.ts", migration)).toBe(
      "MiniMax",
    );

    // And the log line itself is genuinely forgiven.
    const logOnly = `export const m: WorkspaceMigration = {
  id: "998-example",
  description: "Switch the profile from Kimi K2.6 to MiniMax M3",
  run(dir: string): void {},
};`;
    expect(seededVendor("workspace/migrations/998-example.ts", logOnly)).toBe(
      null,
    );
  });
});
