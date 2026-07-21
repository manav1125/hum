import { z } from "zod";

/**
 * Cue Live configuration.
 *
 * Today this holds `cueLive.observationCapture.*` — the ambient
 * screen-observation → task-capture pass (see
 * `cue-live/observation-capture.ts`). Cue Live's stated purpose is that Cue
 * watches your screen so it can pick up the work it sees; that pass is the
 * part that turns an observation into a captured, parked work item.
 *
 * Because it is ambient observation of the user's screen, every knob here is
 * a *restraint*: it ships OFF, a session is time-bounded, and both the model
 * spend and the number of items it may file are hard-capped.
 */

/**
 * App-name fragments that mark a screen Cue must not extract from. Matched
 * case-insensitively as substrings of the frontmost app name AND of the
 * observation text, so "1Password" catches both the app and a window title.
 *
 * This is a cheap heuristic, not a guarantee — see the honesty note in
 * `cue-live/observation-capture.ts`.
 */
export const DEFAULT_SENSITIVE_APP_DENY_LIST: readonly string[] = [
  "1password",
  "bitwarden",
  "lastpass",
  "dashlane",
  "keeper password",
  "keychain access",
  "authenticator",
  "banking",
  "online banking",
  "coinbase",
  "metamask",
  "ledger live",
  "system settings",
  "system preferences",
];

export const CueLiveObservationCaptureConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "cueLive.observationCapture.enabled must be a boolean",
      })
      .default(false)
      .describe(
        "Master switch for turning screen observations into captured tasks. Ships OFF: this is ambient observation of the user's screen, so it must be opted into. Even ON, nothing is captured until an explicit, time-bounded capture session is started.",
      ),
    intervalSeconds: z
      .number({
        error: "cueLive.observationCapture.intervalSeconds must be a number",
      })
      .int("cueLive.observationCapture.intervalSeconds must be an integer")
      .min(15, "cueLive.observationCapture.intervalSeconds must be >= 15")
      .default(90)
      .describe(
        "Minimum seconds between two extraction passes. The floor is the primary cost gate — observations arriving inside the window are dropped without a model call.",
      ),
    sessionMaxMinutes: z
      .number({
        error: "cueLive.observationCapture.sessionMaxMinutes must be a number",
      })
      .int("cueLive.observationCapture.sessionMaxMinutes must be an integer")
      .positive("cueLive.observationCapture.sessionMaxMinutes must be positive")
      .max(240, "cueLive.observationCapture.sessionMaxMinutes must be <= 240")
      .default(30)
      .describe(
        "Hard ceiling (minutes) on a single capture session. A session always expires — there is no 'watch forever' setting. A shorter duration requested at start time wins.",
      ),
    maxExtractionsPerSession: z
      .number({
        error:
          "cueLive.observationCapture.maxExtractionsPerSession must be a number",
      })
      .int(
        "cueLive.observationCapture.maxExtractionsPerSession must be an integer",
      )
      .positive(
        "cueLive.observationCapture.maxExtractionsPerSession must be positive",
      )
      .default(20)
      .describe(
        "Hard cap on extraction model calls per session — the spend ceiling. Once hit, the session observes nothing further until it is restarted.",
      ),
    maxItemsPerSession: z
      .number({
        error: "cueLive.observationCapture.maxItemsPerSession must be a number",
      })
      .int("cueLive.observationCapture.maxItemsPerSession must be an integer")
      .positive(
        "cueLive.observationCapture.maxItemsPerSession must be positive",
      )
      .default(10)
      .describe(
        "Hard cap on work items a single session may file. Protects the Came-in lane from being flooded by a long watch.",
      ),
    maxItemsPerObservation: z
      .number({
        error:
          "cueLive.observationCapture.maxItemsPerObservation must be a number",
      })
      .int(
        "cueLive.observationCapture.maxItemsPerObservation must be an integer",
      )
      .min(1, "cueLive.observationCapture.maxItemsPerObservation must be >= 1")
      .max(5, "cueLive.observationCapture.maxItemsPerObservation must be <= 5")
      .default(2)
      .describe(
        "Cap on tasks extracted from one screen observation. Deliberately small: one screen rarely carries more than a couple of genuine to-dos, and a high cap invites junk.",
      ),
    dedupeWindowMinutes: z
      .number({
        error:
          "cueLive.observationCapture.dedupeWindowMinutes must be a number",
      })
      .int("cueLive.observationCapture.dedupeWindowMinutes must be an integer")
      .positive(
        "cueLive.observationCapture.dedupeWindowMinutes must be positive",
      )
      .default(360)
      .describe(
        "How long (minutes) a captured task's normalized title suppresses re-capture of the same task. Keeps a to-do that stays on screen across consecutive frames from being filed twice.",
      ),
    sensitiveAppDenyList: z
      .array(z.string(), {
        error:
          "cueLive.observationCapture.sensitiveAppDenyList must be an array of strings",
      })
      .default([...DEFAULT_SENSITIVE_APP_DENY_LIST])
      .describe(
        "Case-insensitive substrings that, when found in the frontmost app name or the observation text, skip the observation entirely. A cheap heuristic over the only signals the daemon has (app name + text) — not a guarantee that no sensitive screen is ever read.",
      ),
  })
  .describe(
    "Ambient screen-observation → task capture. Opt-in, time-bounded, capped, and always files PARKED work items that never auto-run.",
  );

export const CueLiveConfigSchema = z
  .object({
    observationCapture: CueLiveObservationCaptureConfigSchema.default(
      CueLiveObservationCaptureConfigSchema.parse({}),
    ),
  })
  .describe("Cue Live (screen watching) configuration");

export type CueLiveConfig = z.infer<typeof CueLiveConfigSchema>;
export type CueLiveObservationCaptureConfig = z.infer<
  typeof CueLiveObservationCaptureConfigSchema
>;
