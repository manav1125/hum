import { z } from "zod";

/**
 * Pre-run clarify pre-check for direct chat turns (see
 * daemon/chat-clarify-precheck.ts): a cheap heuristic gate plus, only for
 * consequential + under-specified messages, one flash-tier call that decides
 * whether to ask ONE clarifying question before the turn runs.
 */
const ClarifyConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "conversations.clarify.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether the chat clarify pre-check runs. Off = today's behaviour: every chat turn goes straight to execution, inferring under-specified consequential requests instead of asking. Only ever fires for messages that pass the consequential-action heuristic AND a confident model verdict; simple/cheap turns never reach the model call.",
      ),
    timeoutMs: z
      .number({ error: "conversations.clarify.timeoutMs must be a number" })
      .int("conversations.clarify.timeoutMs must be an integer")
      .positive("conversations.clarify.timeoutMs must be positive")
      .default(2_500)
      .describe(
        "Hard deadline on the pre-check (provider resolution + the flash call). On timeout the turn proceeds unclarified (fail-open). Tighter than the work-item assessor's because this precedes an interactive reply, not a minutes-long task run — the pre-check overlaps context assembly, so anything it needs beyond assembly's ~0.3-1s is a direct stall on the user's reply. A flash tier that cannot verdict in 2.5s effectively disables the feature (fail-open) rather than taxing every consequential-looking turn.",
      ),
    minConfidence: z
      .number({ error: "conversations.clarify.minConfidence must be a number" })
      .min(0, "conversations.clarify.minConfidence must be >= 0")
      .max(1, "conversations.clarify.minConfidence must be <= 1")
      .default(0.6)
      .describe(
        "Minimum model confidence required to actually ask a clarifying question. Below it the turn runs unclarified — over-asking in chat is more annoying than in a task queue, so the bar is biased toward executing.",
      ),
  })
  .describe(
    "Pre-run clarification of under-specified, consequential chat turns",
  );

export const ConversationsConfigSchema = z
  .object({
    clarify: ClarifyConfigSchema.default(ClarifyConfigSchema.parse({})),
    skipAutoRetitling: z
      .boolean({
        error: "conversations.skipAutoRetitling must be a boolean",
      })
      .default(false)
      .describe(
        "When true, skip the second-pass title regeneration that fires after the third user turn. The initial auto-generated title and manual renames are unaffected.",
      ),
    backgroundInjection: z
      .string({
        error: "conversations.backgroundInjection must be a string",
      })
      .default(
        "This is a background turn — your guardian isn't watching. If anything noteworthy comes up, send them a notification so they see it when they're back by invoking the `notifications` skill (`assistant notifications send --message \"...\"`)",
      )
      .describe(
        "Inner text injected into the tail user message of non-interactive turns in background/scheduled conversations. The injector wraps this in <background_turn>...</background_turn> tags. Empty string disables the injection.",
      ),
    resumeProcessingOnStartup: z
      .boolean({
        error: "conversations.resumeProcessingOnStartup must be a boolean",
      })
      .default(false)
      .describe(
        "Controls how conversations left mid-turn by a previous shutdown are handled on startup. Their stale processing flags are always cleared so they come up idle. When true, the assistant additionally resumes each interrupted turn in the background after startup completes, at most 2 consecutive times per conversation (the budget refills whenever a turn completes cleanly) so a turn that repeatedly interrupts the process is eventually left idle.",
      ),
  })
  .describe("Conversation behavior configuration");

export type ConversationsConfig = z.infer<typeof ConversationsConfigSchema>;
