import { z } from "zod";

export const MorningBriefConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "notifications.morningBrief.enabled must be a boolean",
      })
      .default(true)
      .describe("Whether the daily Morning Brief push notification is enabled"),
    time: z
      .string()
      .regex(
        /^([01]\d|2[0-3]):[0-5]\d$/,
        "notifications.morningBrief.time must be HH:MM (24h)",
      )
      .default("07:30")
      .describe(
        "Local time of day (HH:MM, 24h) at which the Morning Brief push fires",
      ),
    timezone: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "IANA timezone for the Morning Brief time, e.g. 'America/Los_Angeles'. " +
          "Null = the daemon's local timezone (note: cloud daemons typically run UTC).",
      ),
  })
  .describe("Daily 7:30 Morning Brief push notification");

export const NotificationsConfigSchema = z
  .object({
    morningBrief: MorningBriefConfigSchema.default(
      MorningBriefConfigSchema.parse({}),
    ),
  })
  .describe(
    "Notification delivery configuration. Model selection lives under llm.callSites.notificationDecision and llm.callSites.preferenceExtraction.",
  );

export type MorningBriefConfig = z.infer<typeof MorningBriefConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
