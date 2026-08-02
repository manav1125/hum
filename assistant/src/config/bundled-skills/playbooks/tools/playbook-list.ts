import { effectiveAutonomy } from "../../../../playbooks/autonomy-cap.js";
import {
  ANY_CHANNEL,
  describePlaybookChannel,
  normalizePlaybookChannel,
} from "../../../../playbooks/playbook-channel.js";
import { listPlaybooks } from "../../../../playbooks/playbook-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function executePlaybookList(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const channelFilter =
    typeof input.channel === "string" && input.channel.trim() !== ""
      ? normalizePlaybookChannel(input.channel)
      : null;

  try {
    const all = listPlaybooks();

    if (all.length === 0) {
      return {
        content:
          "No playbooks found. Without one, watcher hits still reach the owner — they go through the relevance gate into Came In. A playbook is an override that claims a hit before the gate judges it.",
        isError: false,
      };
    }

    const entries = all.filter(
      (p) =>
        channelFilter === null ||
        p.channel === channelFilter ||
        p.channel === ANY_CHANNEL,
    );

    if (entries.length === 0) {
      return {
        content: `No playbooks found matching channel="${describePlaybookChannel(channelFilter ?? ANY_CHANNEL)}".`,
        isError: false,
      };
    }

    // `listPlaybooks` already orders by priority desc, then creation.
    const lines: string[] = [`Found ${entries.length} playbook(s):\n`];
    for (const p of entries) {
      const capped = effectiveAutonomy(p.autonomyLevel);
      const autonomy = capped.capped
        ? `${capped.effective} (asked for ${capped.requested}, capped by ${capped.dial} trust)`
        : capped.effective;
      const lastFired = p.lastFiredAt
        ? new Date(p.lastFiredAt).toISOString()
        : "never";
      lines.push(
        `- **${p.name}** — when "${p.triggerText}" on ${describePlaybookChannel(p.channel)} → ${p.action}`,
      );
      lines.push(
        `  _ID: ${p.id} | autonomy: ${autonomy} | priority: ${p.priority} | ${p.enabled ? "enabled" : "disabled"} | last fired: ${lastFired}_`,
      );
    }

    return { content: lines.join("\n"), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error listing playbooks: ${msg}`, isError: true };
  }
}

export { executePlaybookList as run };
