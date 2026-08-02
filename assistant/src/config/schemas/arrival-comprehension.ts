import { z } from "zod";

/**
 * Comprehension and grouping of arrivals (`arrivals/arrival-comprehension.ts`,
 * `arrivals/arrival-grouping.ts`) — the half of intake that happens AFTER the
 * relevance gate has decided the owner should see something: working out what
 * the thing actually asks for, and whether it is the same thing as something
 * they already have.
 *
 * Every switch here degrades to the pre-feature behaviour rather than to a
 * worse one: off means "the item keeps its email subject line and gets its own
 * row", which is exactly how it behaved before.
 */
export const ArrivalComprehensionConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "watchers.comprehension.enabled must be a boolean",
      })
      .default(true)
      .describe(
        "Whether a surfaced arrival is read for what it actually asks for — a verb-phrase title, plus any deadline, amount or asker that is genuinely in the message. Off = every item keeps its `Email from …` subject line, which is what it did before. Extracted facts are always quoted back and checked against the message; nothing is ever invented, in either mode.",
      ),
    confidenceThreshold: z
      .number({
        error: "watchers.comprehension.confidenceThreshold must be a number",
      })
      .min(0)
      .max(1)
      .default(0.6)
      .describe(
        "How sure Cue must be before it replaces the title on your task list. Below this the ORIGINAL title stands and the item is marked low-confidence, because a worse title costs you every time you scan the list. Raise it to be more conservative.",
      ),
    grouping: z
      .boolean({
        error: "watchers.comprehension.grouping must be a boolean",
      })
      .default(true)
      .describe(
        "Whether messages in the same conversation (the provider's own thread id) or from the same automated sender fold into ONE item with a count, instead of one row each. Every merge is listed and can be split back out; nothing is deleted by grouping. Off = one row per message, as before.",
      ),
  })
  .describe("Comprehension and grouping of watcher arrivals");

export type ArrivalComprehensionConfig = z.infer<
  typeof ArrivalComprehensionConfigSchema
>;
