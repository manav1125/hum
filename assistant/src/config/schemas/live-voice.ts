import { z } from "zod";

/**
 * Live-voice (Cue Live's in-app duplex audio) configuration.
 *
 * Adopted from upstream's voice cluster (WS-E). The `vad` block tunes the
 * daemon's server-side VAD for `turnDetection: "server_vad"` sessions (and
 * remains the tuning surface manual clients read via config). The
 * `frontModel` block drives the daemon-side presence layer (spoken
 * acknowledgements + progress narration); the `frontDoor` block drives the
 * unified speculative-dispatch endpointing + triage routing. Everything is
 * fully server-side and shippable inert behind its per-feature flags.
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
    echoBargeInMargin: z
      .number({ error: "liveVoice.vad.echoBargeInMargin must be a number" })
      .gt(1, "liveVoice.vad.echoBargeInMargin must be greater than 1")
      .default(1.5)
      .describe(
        "Multiplier over the learned playback echo level that microphone input must exceed to count as speech during playback. Higher values reduce false interruptions but require louder barge-in speech. Only consulted for sessions without echoSafePlayback — echo-safe clients skip the classifier entirely.",
      ),
    echoEmaHalfLifeMs: z
      .number({ error: "liveVoice.vad.echoEmaHalfLifeMs must be a number" })
      .int("liveVoice.vad.echoEmaHalfLifeMs must be an integer")
      .positive("liveVoice.vad.echoEmaHalfLifeMs must be a positive integer")
      .default(400)
      .describe(
        "Half-life (ms) of the learned playback echo level. Smaller values adapt faster to changing speaker volume; larger values are steadier against transients.",
      ),
    echoDrainSlackMs: z
      .number({ error: "liveVoice.vad.echoDrainSlackMs must be a number" })
      .int("liveVoice.vad.echoDrainSlackMs must be an integer")
      .nonnegative(
        "liveVoice.vad.echoDrainSlackMs must be a nonnegative integer",
      )
      .default(300)
      .describe(
        "Time (ms) after the estimated client playback tail during which microphone input can still be classified as playback echo.",
      ),
  })
  .describe(
    "Voice-activity-detection tuning for live voice sessions. Our clients own VAD; these values are the tuning surface they read (pause sensitivity + barge-in sensitivity).",
  );

export const LiveVoiceProgressConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "liveVoice.frontModel.progress.enabled must be a boolean",
      })
      // DEVIATION from upstream (which defaults true): our voice flags ship
      // inert until real-device QA, matching spokenAcks/semanticEndpointing
      // above. Flip to true once narration has been QA'd on-device.
      .default(false)
      .describe(
        "Speak short progress updates during long-running tool-heavy turns. Ships OFF pending real-device QA (upstream defaults ON).",
      ),
    opsThreshold: z
      .number({
        error: "liveVoice.frontModel.progress.opsThreshold must be a number",
      })
      .int("liveVoice.frontModel.progress.opsThreshold must be an integer")
      .positive(
        "liveVoice.frontModel.progress.opsThreshold must be a positive integer",
      )
      .default(3)
      .describe(
        "Narrate after this many tool operations since the last narration",
      ),
    idleIntervalMs: z
      .number({
        error: "liveVoice.frontModel.progress.idleIntervalMs must be a number",
      })
      .int("liveVoice.frontModel.progress.idleIntervalMs must be an integer")
      .positive(
        "liveVoice.frontModel.progress.idleIntervalMs must be a positive integer",
      )
      .default(5_000)
      .describe(
        "How often (ms) a running turn's silence is checked, and so the soonest new tool activity is narrated",
      ),
    maxSilenceMs: z
      .number({
        error: "liveVoice.frontModel.progress.maxSilenceMs must be a number",
      })
      .int("liveVoice.frontModel.progress.maxSilenceMs must be an integer")
      .positive(
        "liveVoice.frontModel.progress.maxSilenceMs must be a positive integer",
      )
      .default(35_000)
      .describe(
        "Heartbeat ceiling (ms): narrate after this much unbroken silence even when nothing new has happened. Evaluated on the idle tick, so its resolution is idleIntervalMs and it must be at least that long",
      ),
    longOpMs: z
      .number({
        error: "liveVoice.frontModel.progress.longOpMs must be a number",
      })
      .int("liveVoice.frontModel.progress.longOpMs must be an integer")
      .positive(
        "liveVoice.frontModel.progress.longOpMs must be a positive integer",
      )
      .default(15_000)
      .describe(
        "A tool operation that ran at least this long (ms) narrates the moment it completes, without waiting for opsThreshold",
      ),
    minGapMs: z
      .number({
        error: "liveVoice.frontModel.progress.minGapMs must be a number",
      })
      .int("liveVoice.frontModel.progress.minGapMs must be an integer")
      .positive(
        "liveVoice.frontModel.progress.minGapMs must be a positive integer",
      )
      .default(6_000)
      .describe(
        "Minimum spacing (ms) from any spoken floor-holder — ack or narration",
      ),
    generationTimeoutMs: z
      .number({
        error:
          "liveVoice.frontModel.progress.generationTimeoutMs must be a number",
      })
      .int(
        "liveVoice.frontModel.progress.generationTimeoutMs must be an integer",
      )
      .positive(
        "liveVoice.frontModel.progress.generationTimeoutMs must be a positive integer",
      )
      .default(1_500)
      .describe(
        "Budget (ms) for LLM-generated progress text — not latency-critical: it speaks into dead air",
      ),
  })
  // The heartbeat is checked when the idle tick finds the turn silent, so a
  // ceiling shorter than the tick interval would be missed by up to a full
  // interval — a promise the cadence cannot keep. Rejecting the combination
  // beats silently overshooting it.
  .refine((progress) => progress.maxSilenceMs >= progress.idleIntervalMs, {
    error:
      "liveVoice.frontModel.progress.maxSilenceMs must be at least idleIntervalMs — the heartbeat is evaluated on the idle tick",
  })
  .describe(
    "Spoken progress narration for long-running voice turns (liveVoice.frontModel.progress)",
  );

export const LiveVoiceFrontModelConfigSchema = z
  .object({
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
    progress: LiveVoiceProgressConfigSchema.default(
      LiveVoiceProgressConfigSchema.parse({}),
    ),
  })
  .describe(
    "Front-model presence layer for live voice sessions (spoken acks + progress narration). Every behavior ships inert behind its own flag.",
  );

/**
 * The unified front door (upstream's speculative-dispatch endpointing +
 * triage-and-escalate routing): at a server-VAD silence boundary the answer
 * leg is dispatched speculatively on the `voiceFrontDoor` call site, and its
 * leading token doubles as the endpointing verdict (hold / escalate /
 * answer). Only ever active in `turnDetection: "server_vad"` sessions; with
 * `enabled` false the boundary releases exactly as V-1a did.
 */
export const LiveVoiceFrontDoorConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "liveVoice.frontDoor.enabled must be a boolean" })
      // Ships OFF, but it is now genuinely FLIPPABLE: the structural
      // blocker — a front-door leg's verdict tokens reaching the shared
      // conversation hub, and so the web/passive transcripts — is closed by
      // `createFrontDoorStreamGate` (calls/voice-triage-escalate.ts), wired
      // into the hub broadcast in calls/voice-session-bridge.ts. What is
      // left before flipping is a judgement call, not a defect: real-device
      // QA on endpointing feel and escalation-bridge audio. Fail-open
      // everywhere once enabled.
      .default(false)
      .describe(
        "Unified voice front door: speculative answer dispatch at the silence boundary, with the leg's leading token as the endpointing verdict and triage-and-escalate routing. server_vad sessions only. Ships OFF pending real-device QA.",
      ),
    endpointDecisionTimeoutMs: z
      .number({
        error: "liveVoice.frontDoor.endpointDecisionTimeoutMs must be a number",
      })
      .int("liveVoice.frontDoor.endpointDecisionTimeoutMs must be an integer")
      .positive(
        "liveVoice.frontDoor.endpointDecisionTimeoutMs must be a positive integer",
      )
      .default(1200)
      .describe(
        "Verdict deadline (ms) for a speculative leg: with no leading verdict inside this budget the turn commits anyway (fail-open), so a provider TTFT tail is bounded dead air instead of unbounded structural silence.",
      ),
    endpointExtensionMs: z
      .number({
        error: "liveVoice.frontDoor.endpointExtensionMs must be a number",
      })
      .int("liveVoice.frontDoor.endpointExtensionMs must be an integer")
      .positive(
        "liveVoice.frontDoor.endpointExtensionMs must be a positive integer",
      )
      .default(1500)
      .describe(
        "How long (ms) a hold verdict keeps the utterance open before the silence boundary replays",
      ),
    endpointMaxExtensions: z
      .number({
        error: "liveVoice.frontDoor.endpointMaxExtensions must be a number",
      })
      .int("liveVoice.frontDoor.endpointMaxExtensions must be an integer")
      .nonnegative(
        "liveVoice.frontDoor.endpointMaxExtensions must be a nonnegative integer",
      )
      .default(2)
      .describe("Cap on consecutive hold extensions per utterance"),
  })
  .describe(
    "Unified voice front door (speculative dispatch + verdict-first triage) for server-VAD live voice sessions",
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
    frontDoor: LiveVoiceFrontDoorConfigSchema.default(
      LiveVoiceFrontDoorConfigSchema.parse({}),
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
export type LiveVoiceFrontDoorConfig = z.infer<
  typeof LiveVoiceFrontDoorConfigSchema
>;
export type LiveVoiceFrontModelConfig = z.infer<
  typeof LiveVoiceFrontModelConfigSchema
>;
export type LiveVoiceProgressConfig = z.infer<
  typeof LiveVoiceProgressConfigSchema
>;
