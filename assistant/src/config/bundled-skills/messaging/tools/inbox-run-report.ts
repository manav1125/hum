/**
 * inbox_run_report — record the end-of-run inbox-management summary so the
 * morning brief can narrate the overnight run (see
 * src/home/inbox-run-summary.ts and skills/inbox-management).
 */

import { recordInboxRunSummary } from "../../../../home/inbox-run-summary.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

function asCount(v: unknown, name: string): number | string {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    return `${name} must be a non-negative number.`;
  }
  return Math.floor(v);
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const archived = asCount(input.archived, "archived");
  const drafted = asCount(input.drafted, "drafted");
  const keptImportant = asCount(input.kept_important, "kept_important");
  for (const v of [archived, drafted, keptImportant]) {
    if (typeof v === "string") return err(v);
  }

  recordInboxRunSummary({
    archived: archived as number,
    drafted: drafted as number,
    keptImportant: keptImportant as number,
  });
  return ok(
    `Recorded inbox run summary: ${archived} archived, ${drafted} drafted, ${keptImportant} kept as important. It will appear in the next morning brief.`,
  );
}
