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

export const WorkItemsConfigSchema = z
  .object({
    autoFile: AutoFileConfigSchema.default(AutoFileConfigSchema.parse({})),
  })
  .describe("Work-item (task queue) hygiene configuration");

export type WorkItemsConfig = z.infer<typeof WorkItemsConfigSchema>;
