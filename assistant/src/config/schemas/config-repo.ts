import { z } from "zod";

/**
 * Config-as-code export ("config repo") — WS5.
 *
 * When enabled, the daemon materializes the durable config surface
 * (assistant.json sans secrets, installed skills, schedules, profile +
 * memory markdown) as a deterministic file tree under
 * `$VELLUM_WORKSPACE_DIR/config-repo/` and commits it to a LOCAL git
 * history after each mutating event. Observe-only in v1: the DB and
 * assistant.json remain canonical; the repo is an audit/diff surface.
 *
 * Default OFF — the exporter must never run (and the repo must never be
 * created) unless a deployment explicitly opts in.
 */
export const ConfigRepoConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "configRepo.enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether to export config-as-code snapshots to a local git repo after mutating events (observe-only)",
      ),
    maxMemoryFiles: z
      .number({ error: "configRepo.maxMemoryFiles must be a number" })
      .int("configRepo.maxMemoryFiles must be an integer")
      .positive("configRepo.maxMemoryFiles must be a positive integer")
      .default(200)
      .describe("Maximum number of memory markdown files to export"),
    maxFileBytes: z
      .number({ error: "configRepo.maxFileBytes must be a number" })
      .int("configRepo.maxFileBytes must be an integer")
      .positive("configRepo.maxFileBytes must be a positive integer")
      .default(262144)
      .describe(
        "Per-file size cap (bytes) for exported markdown files; larger files are skipped",
      ),
    reviewItems: z
      .boolean({ error: "configRepo.reviewItems must be a boolean" })
      .default(true)
      .describe(
        "Whether autonomous config changes emit an awaiting_review work item in the Review lane",
      ),
  })
  .describe(
    "Config-as-code export: local git snapshots of the durable config surface + Review-lane diffs",
  );

export type ConfigRepoConfig = z.infer<typeof ConfigRepoConfigSchema>;
