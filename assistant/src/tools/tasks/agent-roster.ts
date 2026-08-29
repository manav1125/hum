/**
 * `agent_roster`: who the owner has on staff, and what each one is for.
 *
 * Delegation was unreachable from a conversation without this. Work items
 * carry an `assignee`, and everything that makes an agent an agent keys off
 * that name — its spend cap, its tool scopes, its model pin — but the model
 * had no way to learn which names exist. Guessing is worse than not trying:
 * matching is by name, so a near-miss hands the work to the unrestricted house
 * assistant while the owner believes they gave it to a capped, scoped agent.
 *
 * So this exists to be read before delegating, and `task_list_add` rejects a
 * name that is not on the list rather than quietly falling back.
 *
 * Reports the things that decide whether an agent is the right recipient AND
 * whether it can actually act: a paused agent will not run, an agent at its
 * cap will stop, and an agent with tool scopes cannot do work outside them.
 * Handing an invoice to an agent scoped to email is a delegation that looks
 * like it worked and then quietly does not.
 */

import { getAgentSpend, listAgents } from "../../work-items/agent-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/** Autonomy tiers as the roster surfaces name them. */
const TIER_LABEL: Record<string, string> = {
  "1": "suggests only",
  "2": "drafts for approval",
  "3": "acts, tells you after",
  "4": "acts autonomously",
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function executeAgentRoster(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const agents = listAgents();
  if (agents.length === 0) {
    return {
      content:
        "No agents on the roster yet. Work runs as the house assistant. The owner can add agents in Settings, or you can just do the task yourself.",
      isError: false,
    };
  }

  // Spend is per-agent and only meaningful against a cap, so it is fetched
  // once and joined rather than queried per row.
  const spend = getAgentSpend();
  const spentByName = new Map(
    spend.byAgent.map((a) => [a.agent.toLowerCase(), a.spentCents]),
  );

  const lines = agents.map((a) => {
    const bits: string[] = [];
    bits.push(`${a.emoji ? `${a.emoji} ` : ""}${a.name}`);
    if (a.domain) bits.push(`— ${a.domain}`);

    const notes: string[] = [];
    notes.push(TIER_LABEL[a.tier] ?? `tier ${a.tier}`);
    if (a.paused) notes.push("PAUSED (will not run)");
    if (a.capCents != null) {
      const spent = spentByName.get(a.name.toLowerCase()) ?? 0;
      notes.push(
        `${money(spent)} of ${money(a.capCents)} this week${
          a.hardStopEnabled ? " (hard stop)" : " (advisory)"
        }`,
      );
    }
    if (a.toolScopes && a.toolScopes.length > 0) {
      // Named explicitly: an agent scoped away from the work is a delegation
      // that looks like it worked and then quietly does not.
      notes.push(`limited to: ${a.toolScopes.join(", ")}`);
    }
    if (a.model) notes.push(`model: ${a.model}`);

    const head = `${bits.join(" ")} · ${notes.join(" · ")}`;
    return a.charter ? `${head}\n    ${a.charter}` : head;
  });

  return {
    content: [
      `Agents on the roster (${agents.length}):`,
      "",
      ...lines.map((l) => `- ${l}`),
      "",
      'Delegate by passing the agent\'s name as `assignee` to task_list_add. Use "you" for the owner, or omit it to run as the house assistant.',
    ].join("\n"),
    isError: false,
  };
}
