import { dedupeTasks } from "../../tasks/task-store.js";
import { getLogger } from "../../util/logger.js";
import { dedupeWorkItems } from "../../work-items/work-item-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("task-dedupe");

/**
 * Collapse existing exact-duplicate task templates and work items, keeping the
 * oldest of each duplicate group. Non-destructive to non-duplicate data and
 * idempotent — a second run is a no-op. Work items are collapsed first so the
 * (now-orphaned) donor templates can be removed/repointed cleanly.
 */
export async function executeTaskDedupe(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const workItems = dedupeWorkItems();
    const tasks = dedupeTasks();

    log.info(
      {
        workItemsCollapsed: workItems.collapsed,
        workItemGroups: workItems.groups,
        templatesCollapsed: tasks.collapsed,
        templateGroups: tasks.groups,
      },
      "task dedupe completed",
    );

    if (workItems.collapsed === 0 && tasks.collapsed === 0) {
      return {
        content:
          "No duplicate tasks or work items found — nothing to collapse.",
        isError: false,
      };
    }

    const lines = ["Deduplicated tasks."];
    if (workItems.collapsed > 0) {
      lines.push(
        `  Work items: collapsed ${workItems.collapsed} duplicate(s) across ${workItems.groups} group(s).`,
      );
    }
    if (tasks.collapsed > 0) {
      lines.push(
        `  Templates: collapsed ${tasks.collapsed} duplicate(s) across ${tasks.groups} group(s).`,
      );
    }
    return { content: lines.join("\n"), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, "dedupe failed");
    return { content: `Error: ${msg}`, isError: true };
  }
}
