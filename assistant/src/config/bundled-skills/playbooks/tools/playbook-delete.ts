import {
  deletePlaybook,
  getPlaybook,
} from "../../../../playbooks/playbook-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function executePlaybookDelete(
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

    if (!deletePlaybook(existing.id)) {
      return {
        content: `Error: Playbook with ID "${playbookId}" could not be deleted`,
        isError: true,
      };
    }

    return {
      content: `Playbook deleted (ID: ${existing.id}, trigger: "${existing.triggerText}").`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error deleting playbook: ${msg}`, isError: true };
  }
}

export { executePlaybookDelete as run };
