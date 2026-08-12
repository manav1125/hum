/**
 * Default agent-roster seed — boot-time safety net for an empty registry.
 *
 * The named-agent infrastructure (agent-store: charter, domain, model pin,
 * tool scopes, caps) only shapes work when the roster has rows: the mission
 * planner assigns items to roster agents by name (mission-orchestrator) and
 * the work-item runner applies the assignee agent's charter/pin/scopes to the
 * run. With an empty roster, every item silently falls back to the implicit
 * house agent. Migration `296-agents` seeds a default roster, but it is
 * checkpointed (once per workspace), so any workspace whose roster ended up
 * empty after that point stays empty forever. This module closes that gap at
 * boot.
 *
 * Semantics (deliberately conservative):
 *
 *   - Seeds exactly three roles — Ops / Growth / Inbox — ONLY when the
 *     registry holds no agents at all. A non-empty roster (any rows, e.g. an
 *     older seed with different names) is left completely untouched and
 *     logged: reconciling a diverged roster is a manual, human decision.
 *   - Zero-behavior-change bias: no model pin (runs inherit the normal
 *     resolution), `hardStopEnabled` off (caps stay advisory), no spend cap,
 *     default autonomy tier, not paused.
 *   - Conservative tool scopes: each role gets only the read/research/draft
 *     domain scopes its charter needs (see `guardrails/agent-tool-scopes.ts`
 *     for the scope vocabulary). Scopes are domain-granular, not
 *     verb-granular — consequential verbs (send / pay / delete / publish)
 *     remain gated per call by risk gates, trust rules, and the autonomy
 *     policy, and each charter states the draft-only mandate explicitly.
 *   - Boot-safe: never throws; any failure is logged and reported in the
 *     result. Kill switch: set `CUE_DISABLE_DEFAULT_AGENT_SEED=1` to skip.
 *
 * Note: because this runs at every boot, a roster the owner emptied on
 * purpose is re-seeded on the next restart (unlike the checkpointed
 * migration). The kill switch is the escape hatch for that case.
 */

import { getLogger } from "../util/logger.js";
import { type Agent, countAgents, createAgent } from "./agent-store.js";

const log = getLogger("default-roster-seed");

/** Env var that disables the boot-time default roster seed entirely. */
export const DISABLE_DEFAULT_AGENT_SEED_ENV = "CUE_DISABLE_DEFAULT_AGENT_SEED";

interface DefaultRosterAgent {
  name: string;
  emoji: string;
  domain: string;
  charter: string;
  /** Conservative domain allowlist — see guardrails/agent-tool-scopes.ts. */
  toolScopes: string[];
}

/**
 * The three default roles. Exported so tests (and any future reconciliation
 * tooling) assert against the single source of truth instead of copies.
 */
export const DEFAULT_AGENT_ROSTER: readonly DefaultRosterAgent[] = [
  {
    name: "Ops",
    emoji: "⚙",
    domain: "Operations",
    charter:
      "Keep day-to-day operations moving: manage the calendar, prepare " +
      "scheduling options, organize files and documents, chase open admin " +
      "threads, and assemble the background research a decision needs. Work " +
      "in drafts and proposals — never send, pay, delete, or commit on the " +
      "owner's behalf; anything consequential is queued for their approval.",
    // "messaging" (Slack and its kin — see guardrails/agent-tool-scopes.ts)
    // covers the channel-digest surface Ops tends; the charter above still
    // holds it to drafts and proposals.
    toolScopes: ["calendar", "docs", "files", "research", "messaging"],
  },
  {
    name: "Growth",
    emoji: "✦",
    domain: "Growth",
    charter:
      "Grow the pipeline through research and words: research prospects, " +
      "markets, and competitors; draft outreach, follow-ups, and content in " +
      "the owner's voice; and keep a running picture of what is working. " +
      "Everything Growth produces is a draft for review — it never sends " +
      "outreach, publishes content, or spends money; the owner approves " +
      "every send.",
    toolScopes: ["research", "docs", "files"],
  },
  {
    name: "Inbox",
    emoji: "✉",
    domain: "Inbox",
    charter:
      "Own message triage: read incoming email and messages, sort the " +
      "routine from the important, summarize what needs attention, and " +
      "prepare reply drafts ready for one-tap review. Drafts only — Inbox " +
      "never sends a reply, never deletes or archives destructively, and " +
      "surfaces anything sensitive or ambiguous to the owner instead of " +
      "acting on it.",
    toolScopes: ["email", "research", "docs"],
  },
];

export interface SeedDefaultAgentRosterResult {
  /** True when this call created the default roles. */
  seeded: boolean;
  reason: "seeded" | "disabled" | "roster_not_empty" | "error";
  /** Names created (in seed order) when `seeded` is true. */
  createdNames: string[];
}

function isSeedDisabled(): boolean {
  const raw = process.env[DISABLE_DEFAULT_AGENT_SEED_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Idempotent, boot-safe default-roster seed. Call once at daemon startup,
 * after the DB is ready. Never throws.
 */
export function seedDefaultAgentRoster(): SeedDefaultAgentRosterResult {
  try {
    if (isSeedDisabled()) {
      log.info(
        { env: DISABLE_DEFAULT_AGENT_SEED_ENV },
        "Default agent-roster seed disabled via env — skipping",
      );
      return { seeded: false, reason: "disabled", createdNames: [] };
    }

    const existing = countAgents();
    if (existing > 0) {
      // A staffed (or legacy-seeded) roster is the owner's org chart — never
      // touch it here. If the names diverge from the current defaults
      // (e.g. an older Ops/Builder/Growth seed), reconciliation is a manual
      // step, on purpose.
      log.debug(
        { existing },
        "Agent roster is non-empty — default seed not applied",
      );
      return { seeded: false, reason: "roster_not_empty", createdNames: [] };
    }

    const created: Agent[] = [];
    for (const role of DEFAULT_AGENT_ROSTER) {
      created.push(
        createAgent({
          name: role.name,
          emoji: role.emoji,
          domain: role.domain,
          charter: role.charter,
          toolScopes: [...role.toolScopes],
          // Zero-behavior-change bias, spelled out: no pin, advisory-only
          // budget (hard stop off), uncapped, default tier, active.
          model: null,
          hardStopEnabled: false,
          capCents: null,
          paused: false,
        }),
      );
    }
    const createdNames = created.map((a) => a.name);
    log.info(
      { createdNames },
      "Seeded the default agent roster (registry was empty)",
    );
    return { seeded: true, reason: "seeded", createdNames };
  } catch (err) {
    // Boot-safe by contract: a seeding failure must never block startup —
    // the daemon degrades to the pre-seed behavior (house agent only).
    log.warn(
      { err: String(err) },
      "Default agent-roster seed failed — continuing without it",
    );
    return { seeded: false, reason: "error", createdNames: [] };
  }
}
