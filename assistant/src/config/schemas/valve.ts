import { z } from "zod";

/**
 * The volume valve (`valve/`) — what INTERRUPTS you, as distinct from what Cue
 * keeps.
 *
 * There is deliberately no `defaultStop` key here. Where the valve is set is
 * runtime state the owner changes from HQ, and it lives in `valve_stops`; a
 * config file is not where a control somebody turns lives. The only things
 * configurable here are the two rollback switches.
 */
const AutoArchiveConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "valve.autoArchive.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether quiet, aged work is moved to the archive. Archive is a status, never a delete: an archived item keeps its arrival, its band and its reason, is still returned by the work-items routes, and can be moved back to queued at any time. Only items the valve positively demoted (an automated sender with nothing to action, or a sender you dismissed at least twice) are ever eligible — never anything Cue could not judge, and never anything Cue is holding to run itself.",
      ),
    afterHours: z
      .number({ error: "valve.autoArchive.afterHours must be a number" })
      .int("valve.autoArchive.afterHours must be an integer")
      .min(1, "valve.autoArchive.afterHours must be >= 1")
      .default(48)
      .describe(
        "How long a demoted item sits untouched before it is archived. Measured from the item's last update, so anything that changes starts its clock again.",
      ),
  })
  .describe("Resting quiet work into the archive");

export const ValveConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "valve.enabled must be a boolean" })
      .default(true)
      .describe(
        "The rollback switch. Off = the pre-valve daemon exactly: nothing is banded, and because an item with no band reads as urgent, every item interrupts you at every stop. Turning this off can only ever make Cue noisier, never quieter — which is why it is a safe switch to reach for. Existing bands are kept, not erased, so turning it back on restores what was there.",
      ),
    autoArchive: AutoArchiveConfigSchema.default(
      AutoArchiveConfigSchema.parse({}),
    ),
  })
  .describe(
    "The volume valve — how much of what Cue sees is allowed to interrupt you",
  );

export type ValveConfig = z.infer<typeof ValveConfigSchema>;
