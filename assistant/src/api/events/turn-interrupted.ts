/**
 * `turn_interrupted` SSE event.
 *
 * Emitted when the daemon discovers an assistant turn that died without
 * finishing — today that is the boot-recovery sweep marking turns that
 * were in flight when the previous daemon process exited (deploy restart,
 * crash). `messageId` identifies the assistant row that was reserved for
 * the dead turn; the same row is durably stamped with
 * `metadata.interrupted = true` so clients that reconnect after the event
 * was broadcast still discover the interruption via a history refetch.
 *
 * Clients settle any in-flight turn UI for the conversation and render an
 * inline "response was interrupted" affordance with a retry action.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const TurnInterruptedEventSchema = z.object({
  type: z.literal("turn_interrupted"),
  conversationId: z.string(),
  /** Assistant message row reserved for the turn that never finished. */
  messageId: z.string(),
  /** Epoch ms when the daemon marked the turn as interrupted. */
  interruptedAt: z.number(),
  /** What detected the interruption. Currently always a daemon restart. */
  reason: z.literal("daemon_restart"),
});

export type TurnInterruptedEvent = z.infer<typeof TurnInterruptedEventSchema>;
