/**
 * task_list_remove — remove a work item from the task queue.
 */

import { executeTaskListRemove } from "../../../../tools/tasks/work-item-remove.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskListRemove(input, context);
}
