import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Drop seeded call-site `model` overrides that name a BARE Anthropic model on
 * a workspace with no Anthropic provider — they cannot be served, so every
 * call through them fails.
 *
 * ## What was wrong
 *
 * Migrations 040/046/052/054/072 seed call sites with bare ids like
 * `claude-haiku-4-5-20251001`. Those are valid only when the request goes to
 * Anthropic directly. A freshly provisioned Cue routes through OpenRouter,
 * where the id must carry its vendor prefix (`anthropic/claude-haiku-4.5` —
 * migration 073 already encodes that form). Sent bare, OpenRouter answers:
 *
 *     400 "claude-haiku-4-5-20251001 is not a valid model ID"
 *
 * Verified against a fresh instance on 2026-08-12: `deepseek/deepseek-v4-pro`
 * and `deepseek/deepseek-v4-flash` returned 200 on the same key, the bare
 * Anthropic id returned 400.
 *
 * ## Why it stayed hidden
 *
 * `llm.callSites[site]` sits ABOVE the profile layers in the resolver, so the
 * broken override wins over the perfectly good `llm.profiles` the same
 * workspace already has. And the owner's own instance had these entries
 * cleared long ago, so the failure only ever reached NEW workspaces — chat
 * itself worked (it reads profiles), while ~10 quieter jobs died: conversation
 * starters, reply suggestions, notification decisions, preference extraction,
 * summarization, interaction classification, skill-category inference, commit
 * messages, guardian question copy, invite instructions. A Cue that talks
 * fine and is subtly witless everywhere else.
 *
 * ## The repair
 *
 * Delete ONLY the `model` key. Every call site declares its own default
 * profile in `call-site-defaults.ts` (`cost-optimized`, `balanced`, …), so
 * with the override gone the resolver falls through to that profile and the
 * ORIGINAL routing intent is restored — cheap sites stay cheap. This is
 * exactly the shape the owner's long-running instance is in, which is the
 * empirical proof that falling through works.
 *
 * `effort` and `thinking` are deliberately preserved: they are real per-site
 * intent and are provider-independent. An entry left with nothing but its
 * model is removed entirely rather than left as an empty shell.
 *
 * Workspaces that genuinely talk to Anthropic are untouched — a bare id is
 * correct there. The check reads both the entry's own `provider` and
 * `llm.default.provider`.
 */
export const repairUnservableAnthropicCallsiteModelsMigration: WorkspaceMigration =
  {
    id: "105-repair-unservable-anthropic-callsite-models",
    description:
      "Remove bare Anthropic call-site model overrides that no configured provider can serve",
    run(workspaceDir: string): void {
      const configPath = join(workspaceDir, "config.json");
      if (!existsSync(configPath)) return;

      let config: Record<string, unknown>;
      try {
        const raw: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
        const obj = readObject(raw);
        if (obj === null) return;
        config = obj;
      } catch {
        // A workspace we cannot parse is not a workspace we should rewrite.
        return;
      }

      const llm = readObject(config.llm);
      if (llm === null) return;
      const callSites = readObject(llm.callSites);
      if (callSites === null) return;

      // A workspace pointed at Anthropic serves bare ids correctly.
      const defaultProvider = readString(
        readObject(llm.default)?.provider,
      )?.toLowerCase();
      if (defaultProvider === ANTHROPIC) return;

      let changed = false;
      for (const [siteName, rawEntry] of Object.entries(callSites)) {
        const entry = readObject(rawEntry);
        if (entry === null) continue;

        // An entry that names its own provider is a deliberate choice.
        if (readString(entry.provider)?.toLowerCase() === ANTHROPIC) continue;

        const model = readString(entry.model);
        if (model === undefined || !isBareAnthropicModel(model)) continue;

        delete entry.model;
        // Nothing left but the override we just removed — drop the shell so
        // the resolver sees no entry at all rather than an empty one.
        if (Object.keys(entry).length === 0) delete callSites[siteName];
        else callSites[siteName] = entry;
        changed = true;
      }

      // Idempotent: a second run finds no bare ids and writes nothing.
      if (!changed) return;

      if (Object.keys(callSites).length === 0) delete llm.callSites;
      else llm.callSites = callSites;
      config.llm = llm;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    },
    down(_workspaceDir: string): void {
      // Forward-only: restoring these would restore a guaranteed 400.
    },
  };

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const ANTHROPIC = "anthropic";

/**
 * A bare Anthropic id — `claude-…` with no vendor prefix.
 *
 * The slash test is the whole point: `anthropic/claude-haiku-4.5` is the
 * CORRECT OpenRouter form and must survive this migration untouched.
 */
function isBareAnthropicModel(model: string): boolean {
  return model.startsWith("claude-") && !model.includes("/");
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
