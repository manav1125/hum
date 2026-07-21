import { z } from "zod";

/**
 * Live-voice (Cue Live's in-app duplex audio) configuration.
 *
 * Adopted from upstream's voice cluster (WS-E). Our fork runs VAD / barge-in
 * detection client-side (the web + macOS clients emit explicit `ptt_release`
 * and `interrupt` frames), so the `vad` block here is a tuning surface the
 * clients read via config rather than a set of thresholds the daemon enforces.
 * The `frontModel` block drives the daemon-side presence layer (semantic
 * endpointing + spoken acknowledgements), which is fully server-side and
 * shippable inert behind its per-feature flags.
 */

export const VALID_LIVE_VOICE_MODES = ["ptt", "open-mic"] as const;

export const LiveVoiceVadConfigSchema = z
  .object({
    silenceThresholdMs: z
      .number({ error: "liveVoice.vad.silenceThresholdMs must be a number" })
      .int("liveVoice.vad.silenceThresholdMs must be an integer")
      .positive("liveVoice.vad.silenceThresholdMs must be a positive integer")
      .default(1200)
      .describe(
        "Trailing silence duration (ms) after speech that ends the user's turn — the default 'pause before reply'. Consumed by the client's VAD; clients may override it per-session via the start frame.",
      ),
    bargeInMinSpeechMs: z
      .number({ error: "liveVoice.vad.bargeInMinSpeechMs must be a number" })
      .int("liveVoice.vad.bargeInMinSpeechMs must be an integer")
      .nonnegative(
        "liveVoice.vad.bargeInMinSpeechMs must be a nonnegative integer",
      )
      .default(250)
      .describe(
        "Sustained speech (ms) required before speech during assistant playback interrupts it — the 'interrupt sensitivity' (higher = harder to interrupt). 0 disables the guard. Consumed by the client's VAD before it emits an `interrupt` frame. Raised from 60 so brief TTS bleed through imperfect echo cancellation no longer self-interrupts the assistant (self-interruption reduction).",
      ),
    maxTurnDurationMs: z
      .number({ error: "liveVoice.vad.maxTurnDurationMs must be a number" })
      .int("liveVoice.vad.maxTurnDurationMs must be an integer")
      .positive("liveVoice.vad.maxTurnDurationMs must be a positive integer")
      .default(30_000)
      .describe(
        "Maximum duration (ms) of a single user turn before the client force-ends it",
      ),
  })
  .describe(
    "Voice-activity-detection tuning for live voice sessions. Our clients own VAD; these values are the tuning surface they read (pause sensitivity + barge-in sensitivity).",
  );

export const LiveVoiceFrontModelConfigSchema = z
  .object({
    semanticEndpointing: z
      .boolean({
        error: "liveVoice.frontModel.semanticEndpointing must be a boolean",
      })
      .default(false)
      .describe(
        "Use a fast front model to decide whether a silence-fired turn-end means the speaker is actually done ('release') or mid-thought ('hold'). Ships OFF: the full hold loop additionally depends on client-side VAD cooperation, so enable only after real-device QA. The decider itself is fail-open (any failure releases).",
      ),
    spokenAcks: z
      .boolean({ error: "liveVoice.frontModel.spokenAcks must be a boolean" })
      .default(false)
      .describe(
        "Speak a short floor-holding acknowledgement ('one sec, let me check') when the assistant is slow to produce its first spoken delta, so a slow turn feels responsive instead of silent. Fully server-side. Ships OFF pending real-device QA of TTS overlap/echo.",
      ),
    llmAckText: z
      .boolean({ error: "liveVoice.frontModel.llmAckText must be a boolean" })
      .default(false)
      .describe(
        "When spoken acks are on, use the front model to phrase one short contextual ack; static rotation phrases otherwise. Fail-open to the static phrase on any front-model failure.",
      ),
    endpointDecisionTimeoutMs: z
      .number({
        error:
          "liveVoice.frontModel.endpointDecisionTimeoutMs must be a number",
      })
      .int("liveVoice.frontModel.endpointDecisionTimeoutMs must be an integer")
      .positive(
        "liveVoice.frontModel.endpointDecisionTimeoutMs must be a positive integer",
      )
      .default(1200)
      .describe(
        "Hard budget (ms) for the endpoint decision LLM call. Adds to end-of-turn latency when semantic endpointing is on, so keep it as tight as the decider model's real roundtrip allows — tighter budgets turn the feature into a fail-open no-op.",
      ),
    endpointExtensionMs: z
      .number({
        error: "liveVoice.frontModel.endpointExtensionMs must be a number",
      })
      .int("liveVoice.frontModel.endpointExtensionMs must be an integer")
      .positive(
        "liveVoice.frontModel.endpointExtensionMs must be a positive integer",
      )
      .default(1500)
      .describe(
        "How long (ms) a 'hold' decision keeps the turn open before turn-end replays",
      ),
    endpointMaxExtensions: z
      .number({
        error: "liveVoice.frontModel.endpointMaxExtensions must be a number",
      })
      .int("liveVoice.frontModel.endpointMaxExtensions must be an integer")
      .nonnegative(
        "liveVoice.frontModel.endpointMaxExtensions must be a nonnegative integer",
      )
      .default(2)
      .describe("Cap on consecutive 'hold' extensions per utterance"),
    ackFirstDeltaTimeoutMs: z
      .number({
        error: "liveVoice.frontModel.ackFirstDeltaTimeoutMs must be a number",
      })
      .int("liveVoice.frontModel.ackFirstDeltaTimeoutMs must be an integer")
      .positive(
        "liveVoice.frontModel.ackFirstDeltaTimeoutMs must be a positive integer",
      )
      .default(2500)
      .describe(
        "Keyword-delay budget (ms): a spoken ack fires if no first assistant delta has arrived by then",
      ),
    ackGenerationTimeoutMs: z
      .number({
        error: "liveVoice.frontModel.ackGenerationTimeoutMs must be a number",
      })
      .int("liveVoice.frontModel.ackGenerationTimeoutMs must be an integer")
      .positive(
        "liveVoice.frontModel.ackGenerationTimeoutMs must be a positive integer",
      )
      .default(600)
      .describe("Budget (ms) for LLM-generated ack text"),
  })
  .describe(
    "Front-model presence layer for live voice sessions (semantic endpointing + spoken acks). Every behavior ships inert behind its own flag.",
  );

export const LiveVoiceConfigSchema = z
  .object({
    mode: z
      .enum(VALID_LIVE_VOICE_MODES, {
        error: `liveVoice.mode must be one of: ${VALID_LIVE_VOICE_MODES.join(", ")}`,
      })
      .default("open-mic")
      .describe(
        "Default microphone mode for live voice sessions — hands-free (open-mic) or push-to-talk (ptt)",
      ),
    credentialPreflight: z
      .boolean({ error: "liveVoice.credentialPreflight must be a boolean" })
      .default(true)
      .describe(
        "Reject a live voice session at the `start` frame when the STT or TTS credentials it needs are missing or non-streaming, with a clear message, instead of failing silently mid-conversation. Safe to leave ON — it only rejects sessions that would have broken anyway; flip OFF to disable if a false negative ever blocks a working stack.",
      ),
    vad: LiveVoiceVadConfigSchema.default(LiveVoiceVadConfigSchema.parse({})),
    frontModel: LiveVoiceFrontModelConfigSchema.default(
      LiveVoiceFrontModelConfigSchema.parse({}),
    ),
    maxSessionDurationSeconds: z
      .number({
        error: "liveVoice.maxSessionDurationSeconds must be a number",
      })
      .int("liveVoice.maxSessionDurationSeconds must be an integer")
      .positive(
        "liveVoice.maxSessionDurationSeconds must be a positive integer",
      )
      .default(1800)
      .describe("Maximum duration of a single live voice session in seconds"),
  })
  .describe(
    "Live voice (Cue Live in-app duplex audio) configuration — mic mode, credential preflight, VAD tuning, and the front-model presence layer",
  );

export type LiveVoiceConfig = z.infer<typeof LiveVoiceConfigSchema>;
export type LiveVoiceVadConfig = z.infer<typeof LiveVoiceVadConfigSchema>;
export type LiveVoiceFrontModelConfig = z.infer<
  typeof LiveVoiceFrontModelConfigSchema
>;
