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
 * ## CORRECTION: this was NOT inert, and the claim that it was caused an outage
 *
 * This docblock originally said the migration changed no behaviour on the day
 * it ran, because "the owner's threshold sits at its own default of `none`
 * (Strict)". **That was false**, and it was the reasoning that let a blanket
 * change ship without anyone checking what it would deny.
 *
 * An empty `auto_approve_thresholds` table does not mean Strict. It means no
 * row exists, so the gateway falls back to `GLOBAL_DEFAULTS` in
 * `gateway/src/ipc/threshold-handlers.ts`, which are per execution context:
 *
 *     interactive: "medium"   autonomous: "low"   headless: "none"
 *
 * Only headless is Strict. A conversation auto-approves up to medium and a
 * background run up to low, on a fresh instance, with nothing configured. So
 * dropping these servers to the schema's fail-closed `"high"` put every
 * Composio tool above BOTH live thresholds at once, and a `high` that cannot
 * be prompted in an unattended or voice session is a denial.
 *
 * The owner's `tool_invocations` show the flip exactly — the same connectors,
 * before and after this migration ran on 2026-08-16:
 *
 *     2026-08-12   low    allow    42        2026-08-16   high   denied   1
 *     2026-08-15   low    allow     5        2026-08-17   high   denied   2
 *
 * Calendar, Gmail, Drive and Slack all went from working to denied in voice
 * and in background runs. Reading a calendar is not a risk anyone accepted;
 * it is what the blanket cost.
 *
 * ## Why this is still not reverted
 *
 * Removing the blanket `"low"` was right. The mistake was the *blanket*, and
 * it was wrong in both directions: one number per SERVER cannot be correct for
 * both `GMAIL_FETCH_EMAILS` and `GMAIL_SEND_EMAIL`. Set low it auto-approved
 * sending; set high it denied reading.
 *
 * Risk for these tools no longer comes from this field at all. It is derived
 * per operation, from the verb in the tool name, in
 * `gateway/src/risk/connector-risk-classifier.ts` — reads and drafts low,
 * modifications medium, send/delete/publish/pay high, and anything the
 * taxonomy does not recognise high. Deleting the field here leaves a
 * normalized instance in the shape a freshly provisioned one has, which is
 * what that classifier expects to see.
 *
 * The trap this migration closes is real and remains closed: with the field
 * present at `"low"`, an owner raising their threshold would have made every
 * Composio tool on the instance auto-approvable — including the ones that
 * send — without them having done anything to make it so.
 *
 * The lesson, since it cost a working connector surface: a claim that a
 * security change is inert is a claim about a live value, and live values are
 * to be read, not derived from what a default "should" be. The threshold was
 * two IPC handlers away.
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
