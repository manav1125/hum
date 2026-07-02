/**
 * task_list_add — enqueue a work item on the user's task queue.
 *
 * Thin skill-tool wrapper around the shared executor so the agent can capture
 * tasks with a first-class tool call instead of shelling out to the CLI. The
 * executor stamps channel provenance, dedupes on (source, title), and kicks
 * off background triage + policy-gated auto-run.
 */

import { executeTaskListAdd } from "../../../../tools/tasks/work-item-enqueue.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskListAdd(input, context);
}
