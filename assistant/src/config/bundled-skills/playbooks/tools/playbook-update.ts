import { effectiveAutonomy } from "../../../../playbooks/autonomy-cap.js";
import {
  describePlaybookChannel,
  normalizePlaybookChannel,
} from "../../../../playbooks/playbook-channel.js";
import {
  getPlaybook,
  listPlaybooks,
  updatePlaybook,
} from "../../../../playbooks/playbook-store.js";
import type { PlaybookAutonomyLevel } from "../../../../playbooks/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const VALID_AUTONOMY_LEVELS = new Set<string>(["auto", "draft", "notify"]);

export async function executePlaybookUpdate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const playbookId = input.playbook_id as string;
  if (!playbookId || typeof playbookId !== "string") {
    return {
      content: "Error: playbook_id is required and must be a string",
      isError: true,
    };
  }

  try {
    const existing = getPlaybook(playbookId);
    if (!existing) {
      return {
        content: `Error: Playbook with ID "${playbookId}" not found`,
        isError: true,
      };
    }

    const next = {
      name:
        typeof input.name === "string" && input.name.trim() !== ""
          ? input.name.trim().slice(0, 120)
          : existing.name,
      triggerText:
        typeof input.trigger === "string"
          ? input.trigger
          : existing.triggerText,
      channel:
        input.channel === undefined
          ? existing.channel
          : normalizePlaybookChannel(input.channel),
      action: typeof input.action === "string" ? input.action : existing.action,
      autonomyLevel:
        typeof input.autonomy_level === "string" &&
        VALID_AUTONOMY_LEVELS.has(input.autonomy_level)
          ? (input.autonomy_level as PlaybookAutonomyLevel)
          : existing.autonomyLevel,
      priority:
        typeof input.priority === "number" ? input.priority : existing.priority,
      enabled:
        typeof input.enabled === "boolean" ? input.enabled : existing.enabled,
    };

    const collision = listPlaybooks().find(
      (p) =>
        p.id !== existing.id &&
        p.triggerText === next.triggerText &&
        p.channel === next.channel &&
        p.action === next.action,
    );
    if (collision) {
      return {
        content: `Error: Another playbook with this exact configuration already exists (ID: ${collision.id}).`,
        isError: true,
      };
    }

    const updated = updatePlaybook(existing.id, next);
    if (!updated) {
      return {
        content: `Error: Playbook with ID "${playbookId}" not found`,
        isError: true,
      };
    }

    const capped = effectiveAutonomy(updated.autonomyLevel);
    const autonomyLabel =
      capped.effective === "auto"
        ? "execute automatically"
        : capped.effective === "draft"
          ? "draft for review"
          : "notify only";

    return {
      content: [
        "Playbook updated successfully.",
        `  ID: ${updated.id}`,
        `  Name: ${updated.name}`,
        `  Trigger: ${updated.triggerText}`,
        `  Channel: ${describePlaybookChannel(updated.channel)}`,
        `  Action: ${updated.action}`,
        `  Autonomy: ${autonomyLabel}`,
        ...(capped.capped
          ? [
              `  Note: you asked for "${capped.requested}", but the global trust dial (${capped.dial}) holds it at "${capped.effective}".`,
            ]
          : []),
        `  Priority: ${updated.priority}`,
      ].join("\n"),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error updating playbook: ${msg}`, isError: true };
  }
}

export { executePlaybookUpdate as run };
