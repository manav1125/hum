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

const TIME_OF_DAY_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const PushCategoriesConfigSchema = z
  .object({
    needsYou: z
      .boolean({
        error: "notifications.push.categories.needsYou must be a boolean",
      })
      .default(true)
      .describe(
        "Device push when a tool call is blocked on your approval (confirmation_request)",
      ),
    reviewReady: z
      .boolean({
        error: "notifications.push.categories.reviewReady must be a boolean",
      })
      .default(true)
      .describe(
        "Device push when background work finishes and is awaiting your review",
      ),
    morningBrief: z
      .boolean({
        error: "notifications.push.categories.morningBrief must be a boolean",
      })
      .default(true)
      .describe(
        "Device push mirror of the daily Morning Brief (the in-app brief itself is governed by notifications.morningBrief)",
      ),
    mentions: z
      .boolean({
        error: "notifications.push.categories.mentions must be a boolean",
      })
      .default(true)
      .describe(
        "Device push for channel mentions/inbound messages. Reserved — no emission point sends these yet.",
      ),
  })
  .describe("Per-category device-push toggles (all default on)");

export const PushQuietHoursConfigSchema = z
  .object({
    start: z
      .string()
      .regex(
        TIME_OF_DAY_REGEX,
        "notifications.push.quietHours.start must be HH:MM (24h)",
      )
      .nullable()
      .default(null)
      .describe(
        "Quiet-hours start (HH:MM, 24h). Quiet hours are active only when both start and end are set.",
      ),
    end: z
      .string()
      .regex(
        TIME_OF_DAY_REGEX,
        "notifications.push.quietHours.end must be HH:MM (24h)",
      )
      .nullable()
      .default(null)
      .describe(
        "Quiet-hours end (HH:MM, 24h). A start after the end wraps past midnight (e.g. 22:00 → 08:00).",
      ),
    timezone: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "IANA timezone for quiet hours, e.g. 'America/Los_Angeles'. " +
          "Null = the daemon's local timezone (note: cloud daemons typically run UTC).",
      ),
  })
  .describe(
    "Window during which device pushes are suppressed (dropped, not deferred — items still surface in-app)",
  );

export const PushConfigSchema = z
  .object({
    categories: PushCategoriesConfigSchema.default(
      PushCategoriesConfigSchema.parse({}),
    ),
    quietHours: PushQuietHoursConfigSchema.default(
      PushQuietHoursConfigSchema.parse({}),
    ),
  })
  .describe(
    "Device-push (APNs) delivery preferences. Transport credentials come from env (CUE_APNS_*), not config.",
  );

export const NotificationsConfigSchema = z
  .object({
    morningBrief: MorningBriefConfigSchema.default(
      MorningBriefConfigSchema.parse({}),
    ),
    push: PushConfigSchema.default(PushConfigSchema.parse({})),
  })
  .describe(
    "Notification delivery configuration. Model selection lives under llm.callSites.notificationDecision and llm.callSites.preferenceExtraction.",
  );

export type MorningBriefConfig = z.infer<typeof MorningBriefConfigSchema>;
export type PushCategoriesConfig = z.infer<typeof PushCategoriesConfigSchema>;
export type PushQuietHoursConfig = z.infer<typeof PushQuietHoursConfigSchema>;
export type PushConfig = z.infer<typeof PushConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
