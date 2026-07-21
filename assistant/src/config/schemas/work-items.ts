import { z } from "zod";

/**
 * Work-item hygiene configuration. Today this holds the background auto-filer
 * (`workItems.autoFile.*`) — the periodic job that assigns unfiled queued
 * tasks to the user's active projects via a single batched flash-LLM call
 * (see work-items/work-item-auto-file.ts).
 */
const AutoFileConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "workItems.autoFile.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether the background auto-filer runs — periodically files unfiled queued tasks into matching active projects. Filing never grants run permission (auto_run_eligibility is untouched).",
      ),
    intervalMinutes: z
      .number({ error: "workItems.autoFile.intervalMinutes must be a number" })
      .int("workItems.autoFile.intervalMinutes must be an integer")
      .positive("workItems.autoFile.intervalMinutes must be positive")
      .default(5)
      .describe("Minutes between auto-file sweeps"),
    confidenceThreshold: z
      .number({
        error: "workItems.autoFile.confidenceThreshold must be a number",
      })
      .min(0, "workItems.autoFile.confidenceThreshold must be >= 0")
      .max(1, "workItems.autoFile.confidenceThreshold must be <= 1")
      .default(0.7)
      .describe(
        "Minimum 0-1 model confidence required to file an item; below it the item stays unfiled for the normal came-in triage",
      ),
  })
  .describe("Background auto-filing of unfiled tasks into projects");

/**
 * Pre-run assessment (see work-items/work-item-assessment.ts): one cheap
 * flash-tier call before a work item's execution turn that decides whether Cue
 * understands the task and can actually do it with the context it has.
 */
const AssessmentConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "workItems.assessment.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether the pre-run assessment runs at all. Off = today's behaviour: every run goes straight to the execution turn with no verdict, plan, or question.",
      ),
    gate: z
      .boolean({ error: "workItems.assessment.gate must be a boolean" })
      .default(true)
      .describe(
        "Whether a non-'execute' verdict actually holds the run back (item parks with its question/missing thing surfaced). Off = assess and narrate only, never block — the observe-first rollback position.",
      ),
    timeoutMs: z
      .number({ error: "workItems.assessment.timeoutMs must be a number" })
      .int("workItems.assessment.timeoutMs must be an integer")
      .positive("workItems.assessment.timeoutMs must be positive")
      .default(30_000)
      .describe(
        "Hard deadline on each assessment attempt (two are made). On timeout the run proceeds unassessed (fail-open). Generous by design: the run it precedes takes minutes, and a burst of dispatches slows the flash provider enough that a tight deadline drops most of the batch.",
      ),
    notAiTaskMinConfidence: z
      .number({
        error: "workItems.assessment.notAiTaskMinConfidence must be a number",
      })
      .min(0, "workItems.assessment.notAiTaskMinConfidence must be >= 0")
      .max(1, "workItems.assessment.notAiTaskMinConfidence must be <= 1")
      .default(0.7)
      .describe(
        "Minimum confidence required to keep a 'not_ai_task' verdict. Below it the verdict is softened (to 'clarify' when a question was given, else 'execute') — a wrong 'not_ai_task' is worse than an extra question.",
      ),
  })
  .describe("Pre-run task assessment (understand → decide → narrate)");

export const WorkItemsConfigSchema = z
  .object({
    autoFile: AutoFileConfigSchema.default(AutoFileConfigSchema.parse({})),
    assessment: AssessmentConfigSchema.default(
      AssessmentConfigSchema.parse({}),
    ),
  })
  .describe("Work-item (task queue) hygiene configuration");

export type WorkItemsConfig = z.infer<typeof WorkItemsConfigSchema>;
