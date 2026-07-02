/**
 * task_list_show — view the user's task queue (work items by status).
 */

import { executeTaskListShow } from "../../../../tools/tasks/work-item-list.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskListShow(input, context);
}
