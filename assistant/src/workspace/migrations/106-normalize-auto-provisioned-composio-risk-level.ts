import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Drop the auto-written `defaultRiskLevel: "low"` from Composio MCP servers so
 * the schema's fail-closed default of `"high"` applies to them.
 *
 * ## What was wrong
 *
 * The Composio provisioner wrote `defaultRiskLevel: "low"` into every server
 * entry it created, overriding the deliberate `"high"` default in
 * `McpServerConfigSchema`. These servers are provisioned automatically, with
 * the owner reviewing not one tool, and they reach real third-party accounts —
 * mail, calendar, drive, CRM.
 *
 * The provisioner stopped writing the field, but provisioning is idempotent and
 * skips server keys that already exist, so every instance provisioned before
 * that change keeps `"low"` in its `config.json` indefinitely. One owner's
 * instance carried fifteen such entries, Gmail and Slack among them.
 *
 * ## Why this is a migration and not a fix in the provisioner
 *
 * `provisionComposioMcpServers` returns early when Composio credentials are
 * missing or lapsed. An instance whose credentials have since lapsed would
 * never reach a normalization step living there — and that is precisely the
 * state worth worrying about, because the stale entries still name servers
 * pointed at real accounts. A migration runs once at startup on every
 * instance regardless of credentials.
 *
 * ## Why it is inert today, and why that is not a reason to skip it
 *
 * Nothing auto-approves while the owner's threshold sits at its own default of
 * `"none"` (Strict) — `auto_approve_thresholds` is empty on a fresh instance
 * and the reader defaults to `"none"`. So this changes no behaviour on the day
 * it runs. It closes a trap: the moment an owner raises their threshold to cut
 * down on prompting, every stale-`"low"` Composio tool becomes auto-approvable
 * without them having done anything to make it so.
 *
 * ## Why only `"low"`, only `composio` keys, and only once
 *
 * The field is DELETED rather than set to `"high"`, so a normalized instance
 * ends up in exactly the shape a freshly provisioned one has, and a future
 * change to the schema default reaches both alike.
 *
 * Only `"low"` is touched. `"medium"` and `"high"` are left alone: an owner who
 * moved a server off the auto-written value made a choice, and this must not
 * overwrite it.
 *
 * Running once is what protects a deliberate `"low"`. A migration is
 * checkpointed, so an owner who sets `"low"` on a Composio server after this
 * runs keeps it forever. The only value at risk is one set by hand BEFORE the
 * migration, and there the asymmetry settles it: raising a risk level costs an
 * extra approval prompt, while leaving a wrongly-lowered one costs an
 * unreviewed action against someone's real mail or CRM.
 *
 * Servers the owner added themselves are untouched — the key match is exact
 * (`composio`, the tool-router server) or the provisioner's own
 * `composio_<toolkit>` prefix, so a hand-added `composio-mine` is not swept up.
 */
export const normalizeAutoProvisionedComposioRiskLevelMigration: WorkspaceMigration =
  {
    id: "106-normalize-auto-provisioned-composio-risk-level",
    description:
      "Remove the auto-written defaultRiskLevel 'low' from Composio MCP servers so the fail-closed schema default applies",
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

      const mcp = readObject(config.mcp);
      if (mcp === null) return;
      const servers = readObject(mcp.servers);
      if (servers === null) return;

      let changed = false;
      for (const [key, rawEntry] of Object.entries(servers)) {
        if (!isAutoProvisionedComposioKey(key)) continue;
        const entry = readObject(rawEntry);
        if (entry === null) continue;
        if (entry.defaultRiskLevel !== AUTO_WRITTEN_RISK_LEVEL) continue;

        delete entry.defaultRiskLevel;
        servers[key] = entry;
        changed = true;
      }

      // Idempotent: a second run finds nothing at "low" and writes nothing.
      if (!changed) return;

      mcp.servers = servers;
      config.mcp = mcp;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    },
    down(_workspaceDir: string): void {
      // Forward-only: restoring these would restore the trap.
    },
  };

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

/** The exact value the provisioner used to write. Nothing else is touched. */
const AUTO_WRITTEN_RISK_LEVEL = "low";

/** The tool-router server key the provisioner creates. */
const TOOL_ROUTER_SERVER_KEY = "composio";

/** Prefix for the provisioner's per-toolkit servers (`composio_gmail`, …). */
const TOOLKIT_SERVER_PREFIX = "composio_";

/**
 * Whether a server key is one the Composio provisioner creates.
 *
 * Matched exactly rather than by a bare `startsWith("composio")` so a server
 * the owner added and named something like `composio-mine` is left alone.
 */
function isAutoProvisionedComposioKey(key: string): boolean {
  return (
    key === TOOL_ROUTER_SERVER_KEY || key.startsWith(TOOLKIT_SERVER_PREFIX)
  );
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
