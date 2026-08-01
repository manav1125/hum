import { z } from "zod";

/**
 * Watcher configuration.
 *
 * Today this holds auto-provisioning (`watchers.autoProvision.*`) — the rule
 * that connecting a watchable connector (Gmail, Google Calendar, …) also
 * stands up a default watcher for it, so "connected" actually means "watched"
 * instead of "available if you go build an automation by hand".
 */
const AutoProvisionConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "watchers.autoProvision.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether connecting a watchable connector also creates a default watcher for it. Off = today's pre-2026-08 behaviour: watchers only ever exist if you create them in Automations or via the CLI. Turning this off does not touch watchers that were already provisioned — disable or delete those individually.",
      ),
    /**
     * Deliberately NOT a single global interval: the right cadence is a
     * property of the source, not of the feature. See `auto-provision.ts`
     * for the per-connector defaults and their justification.
     */
    minPollIntervalMs: z
      .number({
        error: "watchers.autoProvision.minPollIntervalMs must be a number",
      })
      .int("watchers.autoProvision.minPollIntervalMs must be an integer")
      .min(60_000, "watchers.autoProvision.minPollIntervalMs must be >= 60000")
      .default(300_000)
      .describe(
        "Floor applied to every auto-provisioned watcher's poll interval. A watcher the user never explicitly asked for must not be the thing that burns their upstream quota, so the floor is deliberately far above the 60s store default. Raise it to make all auto-provisioned watchers lazier; it cannot go below 60s.",
      ),
  })
  .describe("Auto-provisioning of watchers when a connector is connected");

/**
 * The relevance gate at the arrival → work-item boundary
 * (`arrivals/arrival-gate.ts`): the thing that decides whether a watcher hit
 * becomes something the owner must look at, or is filed away — recorded,
 * browsable and reversible, but out of the Came-in lane.
 */
const RelevanceGateConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "watchers.relevanceGate.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether arrivals are filtered at all. Off = the pre-gate behaviour: every watcher hit becomes a work item in the Came-in lane. Arrivals are still recorded either way, so turning this off never loses the record of what came in — it only stops anything being filed.",
      ),
    useModel: z
      .boolean({ error: "watchers.relevanceGate.useModel must be a boolean" })
      .default(true)
      .describe(
        "Whether the ambiguous middle (mail with no bulk headers and no safety-floor hit) is sent to a flash-tier judge. Off = deterministic header rules only; everything the rules do not catch is surfaced. The safety floor applies in both modes.",
      ),
  })
  .describe("Relevance filtering of watcher arrivals before they become work");

export const WatchersConfigSchema = z
  .object({
    autoProvision: AutoProvisionConfigSchema.default(
      AutoProvisionConfigSchema.parse({}),
    ),
    relevanceGate: RelevanceGateConfigSchema.default(
      RelevanceGateConfigSchema.parse({}),
    ),
  })
  .describe("Watcher (standing poller) configuration");

export type WatchersConfig = z.infer<typeof WatchersConfigSchema>;
