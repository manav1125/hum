import { effectiveAutonomy } from "../../../../playbooks/autonomy-cap.js";
import {
  describePlaybookChannel,
  normalizePlaybookChannel,
} from "../../../../playbooks/playbook-channel.js";
import {
  createPlaybook,
  listPlaybooks,
} from "../../../../playbooks/playbook-store.js";
import type { PlaybookAutonomyLevel } from "../../../../playbooks/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const VALID_AUTONOMY_LEVELS = new Set<string>(["auto", "draft", "notify"]);

/** Fall back to the trigger when the caller didn't name the rule. */
function deriveName(input: Record<string, unknown>, trigger: string): string {
  const given = typeof input.name === "string" ? input.name.trim() : "";
  if (given !== "") return given.slice(0, 120);
  return trigger
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
}

export async function executePlaybookCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const trigger = input.trigger as string;
  const action = input.action as string;

  if (!trigger || typeof trigger !== "string") {
    return {
      content: "Error: trigger is required and must be a string",
      isError: true,
    };
  }
  if (!action || typeof action !== "string") {
    return {
      content: "Error: action is required and must be a string",
      isError: true,
    };
  }

  const channel = normalizePlaybookChannel(input.channel);
  const autonomyLevel: PlaybookAutonomyLevel =
    typeof input.autonomy_level === "string" &&
    VALID_AUTONOMY_LEVELS.has(input.autonomy_level)
      ? (input.autonomy_level as PlaybookAutonomyLevel)
      : "draft";
  const priority = typeof input.priority === "number" ? input.priority : 0;
  const name = deriveName(input, trigger);

  try {
    const duplicate = listPlaybooks().find(
      (p) =>
        p.triggerText === trigger &&
        p.channel === channel &&
        p.action === action,
    );
    if (duplicate) {
      return {
        content: `A playbook with this exact configuration already exists (ID: ${duplicate.id}).`,
        isError: false,
      };
    }

    const created = createPlaybook({
      name,
      triggerText: trigger,
      action,
      channel,
      autonomyLevel,
      priority,
    });

    // Report the autonomy that will actually apply, not just the one asked
    // for — the global trust dial clamps it, and saying "execute
    // automatically" when the dial holds it at draft is exactly the kind of
    // confident-but-false report this tool used to give.
    const capped = effectiveAutonomy(created.autonomyLevel);
    const autonomyLabel =
      capped.effective === "auto"
        ? "execute automatically"
        : capped.effective === "draft"
          ? "draft for review"
          : "notify only";

    return {
      content: [
        "Playbook created successfully.",
        `  ID: ${created.id}`,
        `  Name: ${created.name}`,
        `  Trigger: ${created.triggerText}`,
        `  Channel: ${describePlaybookChannel(created.channel)}`,
        `  Action: ${created.action}`,
        `  Autonomy: ${autonomyLabel}`,
        ...(capped.capped
          ? [
              `  Note: you asked for "${capped.requested}", but the global trust dial (${capped.dial}) holds it at "${capped.effective}".`,
            ]
          : []),
        `  Priority: ${created.priority}`,
      ].join("\n"),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error creating playbook: ${msg}`, isError: true };
  }
}

export { executePlaybookCreate as run };
