/**
 * `useLiveVoice()` — session controller for the browser live-voice channel.
 *
 * Web-app counterpart to the macOS `LiveVoiceChannelManager`
 * (`clients/macos/.../LiveVoiceChannelManager.swift`). It wires the three merged
 * primitives — {@link LiveVoiceChannelClient} (transport), {@link
 * LiveVoiceAudioCapture} (mic → PCM), {@link LiveVoiceAudioPlayer} (TTS
 * playback) — into the session state machine and projects observable state into
 * {@link useLiveVoiceStore}.
 *
 * The state machine is held in `useLiveVoiceStore`; this module owns the imperative
 * glue (event wiring, barge-in, automatic push-to-talk release, teardown). One
 * controller instance drives at most one session at a time; `start()` while a
 * session is live is a no-op (matching the macOS guard).
 *
 * ## Full-duplex (default) vs. single-utterance sessions
 * By default this controller opts into continuous **full-duplex** mode (opt out
 * with `fullDuplex: false`). The daemon keeps one socket open across turns: after
 * the assistant finishes speaking (`tts_done`) the daemon loops back to
 * listening, so this controller re-arms the mic forwarding gate (→ `listening`)
 * for the next utterance instead of ending the session. Barge-in interrupts the
 * assistant and resumes listening on the same socket.
 *
 * In legacy **half-duplex** mode (`fullDuplex: false`) a session handles exactly
 * one utterance → one response: the runtime treats `ptt_release` as terminal
 * (post-release audio yields `invalid_audio_payload`), so the controller ends the
 * session after the response and the user starts a fresh one for the next turn;
 * barge-in reconnects.
 *
 * ## State transitions
 * `idle → connecting` (start) → `listening` (ready + capture started) →
 * `transcribing` (ptt released) → `thinking` (server response) → `speaking`
 * (tts_audio). In full-duplex, `speaking` → `listening` after the response
 * drains (next turn on the same socket); in half-duplex, `speaking` → `idle`
 * (session ended). The mic keeps capturing for the whole session; `stop()`,
 * teardown, an error, or a server `archived`/`closed` returns to `idle`/`failed`.
 *
 * ## Mic forwarding
 * The mic capture graph runs for the entire active session so amplitude keeps
 * flowing for barge-in even while the assistant is thinking/speaking. Audio
 * *forwarding* (`session.forwardingAudio`) is gated to the user's turn: captured
 * PCM is streamed only while forwarding is on. Push-to-talk release flips
 * forwarding off (without stopping the mic); it is not re-opened within a
 * session (the session is single-utterance — see above).
 *
 * ## Barge-in
 * Hands-free (server_vad) sessions: barge-in is SERVER-detected. The daemon's
 * sustained-speech guard fires `speech_started` (flush playback → listening,
 * unconditional, even mid-thinking) and `turn_cancelled` (the turn it
 * aborted); the client's amplitude heuristic stands down so two detectors
 * never race. Manual sessions keep the client-side amplitude barge-in: while
 * `speaking`, a captured amplitude over {@link BARGE_IN_AMPLITUDE_THRESHOLD}
 * stops playback and sends `interrupt` (once per response). In full-duplex the
 * daemon re-arms listening, so the controller resumes forwarding on the same
 * socket (→ `listening`). In half-duplex the interrupted session is terminal, so
 * the controller ends the session (→ idle) and the user starts a fresh one.
 *
 * ## Automatic push-to-talk release
 * While `listening`, sustained speech (≥ {@link MINIMUM_SPEECH_DURATION_BEFORE_RELEASE_MS})
 * followed by {@link SILENCE_DURATION_BEFORE_RELEASE_MS} of silence releases
 * push-to-talk and moves to `transcribing` (mic stays open).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  LiveVoiceChannelClient,
  type LiveVoiceClientError,
} from "@/domains/chat/voice/live-voice/live-voice-client";
import {
  LiveVoiceAudioCapture,
  LIVE_VOICE_AUDIO_FORMAT,
} from "@/domains/chat/voice/live-voice/pcm-capture";
import {
  LiveVoiceAudioPlayer,
  type TtsAudioChunk,
} from "@/domains/chat/voice/live-voice/tts-playback";
import {
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { resolveVoicePersona } from "@/domains/chat/voice/live-voice/voice-personas";
import { resolveVoiceEngine } from "@/utils/voice-engine";

// ---------------------------------------------------------------------------
// Thresholds (mirror the macOS LiveVoiceChannelManager defaults)
// ---------------------------------------------------------------------------

/**
 * Mic amplitude (in [0, 1]) above which barge-in interrupts assistant speech.
 * Set above the residual echo the mic's echo-cancellation leaves from the
 * assistant's own voice through the speakers, so only real, close user speech
 * interrupts — not the assistant hearing itself. Requires sustained speech (see
 * {@link BARGE_IN_MIN_SPEECH_MS}) as a second guard against transient echo.
 */
const BARGE_IN_AMPLITUDE_THRESHOLD = 0.09;

/** Sustained speech (ms) over the barge-in threshold before it interrupts. */
const BARGE_IN_MIN_SPEECH_MS = 220;

/**
 * Whether talking over the assistant interrupts it (barge-in). Enabled by
 * default with a raised threshold + sustained-speech guard so the assistant's
 * own voice through the speakers (residual echo after cancellation) doesn't trip
 * it, while real user speech does. On a device where echo still leaks through,
 * disable with `localStorage["cue.voiceBargeIn"]="0"` (assistant then finishes
 * its turn before listening).
 */
function isBargeInEnabled(): boolean {
  try {
    return window.localStorage.getItem("cue.voiceBargeIn") !== "0";
  } catch {
    return true;
  }
}

/**
 * Whether hands-free (server-side VAD) mode is enabled. On by default: the
 * session connects with `turnDetection: "server_vad"` and, when the daemon
 * echoes the mode on `ready`, the client's own silence-detection auto-release
 * is disabled — the server owns utterance boundaries. Kill switch for devices
 * where the server endpointing misbehaves:
 * `localStorage["cue.voiceServerVad"]="0"` reverts to full client-side VAD
 * (consistent with `cue.voiceBargeIn`).
 */
function isServerVadEnabled(): boolean {
  try {
    return window.localStorage.getItem("cue.voiceServerVad") !== "0";
  } catch {
    return true;
  }
}

/** Mic amplitude above which a chunk counts as speech (for silence detection). */
const SPEECH_AMPLITUDE_THRESHOLD = 0.03;

/** Trailing silence (ms) after speech that triggers an automatic ptt_release. */
const SILENCE_DURATION_BEFORE_RELEASE_MS = 1000;

/** Minimum speech (ms) required before a silence window can trigger release. */
const MINIMUM_SPEECH_DURATION_BEFORE_RELEASE_MS = 120;

/**
 * Hard cap on waiting for TTS playback to drain before re-arming the mic. Only
 * fires if playback can't complete (e.g. a playback context that failed to
 * resume); normal replies drain in a couple of seconds, well under this.
 */
const DRAIN_SAFETY_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UseLiveVoiceResult {
  /** Current session phase. */
  state: LiveVoiceSessionState;
  /** In-flight partial user transcript. */
  partialTranscript: string;
  /** Last finalized user transcript. */
  finalTranscript: string;
  /** Accumulated assistant response text for the current turn. */
  assistantTranscript: string;
  /** Smoothed mic amplitude in [0, 1]. */
  inputAmplitude: number;
  /** Failure message when `state === "failed"`, else `null`. */
  error: string | null;
  /**
   * What kind of failure occurred (`"mic"` = capture/permission, `"session"` =
   * provider/network), so the UI shows the right recovery. `null` unless failed.
   */
  failureKind: "mic" | "session" | null;
  /** Whether the mic is currently muted (audio tracks disabled). */
  muted: boolean;
  /** Start a session for `assistantId`, optionally attaching a conversation. */
  start: (assistantId: string, conversationId?: string) => Promise<void>;
  /** End the session and release the mic, socket, and audio context. */
  stop: () => Promise<void>;
  /**
   * Mute/unmute the live mic. Toggles `enabled` on the active capture's audio
   * tracks: the session, socket, and capture graph stay up, but no real audio
   * is forwarded to the server while muted. The preference is retained across
   * `start()` so a session begins muted if the user muted before starting.
   */
  setMuted: (muted: boolean) => void;
  /**
   * Interrupt the assistant mid-reply and hand the floor back — the deliberate
   * version of barge-in, for a surface that offers "tap anywhere to interrupt".
   *
   * It routes through the SAME path sustained speech uses, so a tap and a
   * spoken interruption cannot diverge, and it is a no-op unless the assistant
   * is actually speaking. That last part matters: a control that reports doing
   * something while nothing happened is the fake status this surface exists to
   * remove, so the caller only draws the invitation while `speaking`.
   */
  interrupt: () => void;
}

/** Injectable factories so tests can supply mock primitives. */
export interface UseLiveVoiceOptions {
  createClient?: () => LiveVoiceChannelClient;
  createCapture?: (
    options: ConstructorParameters<typeof LiveVoiceAudioCapture>[0],
  ) => LiveVoiceAudioCapture;
  createPlayer?: () => LiveVoiceAudioPlayer;
  /**
   * Opt into continuous full-duplex sessions (default `true`). When enabled the
   * socket stays open across turns: after the assistant finishes speaking the
   * hook re-arms the mic (→ `listening`) for the next utterance instead of
   * ending the session, and barge-in interrupts without tearing the socket
   * down. Set to `false` to force the legacy single-utterance behavior (close
   * after `tts_done`; a fresh session per turn).
   */
  fullDuplex?: boolean;
  /**
   * Which server voice engine to use. Defaults to resolving the opt-in flag
   * (`?voiceEngine=gemini-live` or `localStorage["cue.voiceEngine"]`), falling
   * back to `"cascade"`. Lets us dogfood the speech-native Gemini Live engine
   * without changing the default experience.
   */
  engine?: "cascade" | "gemini-live";
  /**
   * Conversation persona/mode. Defaults to resolving
   * `localStorage["cue.voicePersona"]`, falling back to companion.
   */
  persona?: string;
  /**
   * Opt in/out of hands-free (server-side VAD) turn detection. Defaults to
   * the `cue.voiceServerVad` kill switch (on unless set to "0"). Only
   * meaningful for full-duplex sessions; when the daemon does not echo
   * `server_vad` on `ready` the session falls back to full client-side VAD
   * regardless.
   */
  handsFree?: boolean;
}

/**
 * Auto-recover from an UNEXPECTED live-voice drop (server closed the socket, a
 * network blip, an idle/timeout close) — the thing that made voice "stop after
 * a few turns and not re-engage": the client is one-shot terminal, so a dropped
 * socket used to land the session in idle with no retry. A clean user `end()`
 * nulls the session first, so those never reach the recovery path; and a
 * `protocol-error` (the server saying no) is terminal and is NOT retried, so
 * this can't mask a real refusal or storm the server.
 */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = [400, 1_200, 3_000];

/**
 * Mutable per-session bookkeeping that must not trigger re-renders. Lives in a
 * ref alongside the active primitives; replaced wholesale on each `start()`.
 */
interface SessionContext {
  client: LiveVoiceChannelClient;
  capture: LiveVoiceAudioCapture;
  player: LiveVoiceAudioPlayer;
  /** Unsubscribe callbacks for the client event handlers. */
  unsubscribes: Array<() => void>;
  /** Monotonic id; a stale callback whose generation differs is ignored. */
  generation: number;
  /** Whether the mic capture graph is running (open for the whole session). */
  captureRunning: boolean;
  /**
   * Whether captured PCM is currently streamed to the server. On while the user
   * is speaking (`listening`); turned off after an automatic push-to-talk
   * release. In legacy (half-duplex) sessions the runtime treats `ptt_release`
   * as terminal — it never re-accepts audio — so forwarding is not re-opened
   * within a session: the session ends after the response and a fresh session is
   * started for the next turn. In full-duplex sessions the socket stays open:
   * after `tts_done` (or a barge-in) forwarding is re-armed for the next
   * utterance on the same session. Amplitude keeps flowing regardless so barge-in
   * works while not forwarding.
   */
  forwardingAudio: boolean;
  /** Whether this session negotiated continuous full-duplex mode. */
  fullDuplex: boolean;
  /**
   * Whether this session runs hands-free: the daemon's server-side VAD owns
   * utterance boundaries (`speech_started` / `utterance_end` frames) and the
   * client's silence-detection auto-release is disabled. Requested via
   * `turnDetection: "server_vad"` on the start frame; REVERTED to false on
   * `ready` when an older daemon fails to echo the mode, so the session
   * falls back to exactly today's client-side VAD instead of hanging with no
   * release path. Barge-in is server-detected in this mode (`speech_started`
   * flushes playback; `turn_cancelled` reports the aborted turn), so the
   * client's amplitude barge-in stands down; manual sessions keep it.
   */
  handsFree: boolean;
  /** A server-VAD utterance is open (between speech_started and utterance_end). */
  utteranceOpen: boolean;
  /**
   * Count of `utterance_end` frames seen this session. The post-`tts_done`
   * drain waiter snapshots it to tell a `transcribing` phase that belongs to
   * a NEWER utterance (closed while the previous turn's audio tail drained —
   * the server owns its state) from this turn's own answerless close (which
   * must cycle back to `listening` or the session sticks deaf).
   */
  utteranceEndSeq: number;
  /** Whether the assistant has sent any TTS audio for the current response. */
  responseAudioStarted: boolean;
  /** Whether an interrupt was already sent for the current response. */
  interruptSent: boolean;
  /** Whether an automatic ptt_release is already in flight for this utterance. */
  releaseInFlight: boolean;
  /** Accumulated speech duration (ms) in the current utterance. */
  speechMs: number;
  /** Accumulated trailing silence (ms) after speech in the current utterance. */
  silenceMs: number;
  /**
   * Timestamp (ms epoch) when the mic first went over the barge-in threshold in
   * the current over-threshold run, or null when below. Barge-in fires only
   * after the level stays high for {@link BARGE_IN_MIN_SPEECH_MS}, so a brief
   * echo transient doesn't interrupt.
   */
  bargeInSinceMs: number | null;
}

/** Number of bytes per Int16 PCM sample. */
const BYTES_PER_SAMPLE = 2;

/** Milliseconds of audio represented by a captured PCM chunk. */
function chunkDurationMs(buf: ArrayBuffer): number {
  const sampleCount = buf.byteLength / BYTES_PER_SAMPLE;
  return (sampleCount / LIVE_VOICE_AUDIO_FORMAT.sampleRate) * 1000;
}

export function useLiveVoice(
  options: UseLiveVoiceOptions = {},
): UseLiveVoiceResult {
  const state = useLiveVoiceStore.use.state();
  const partialTranscript = useLiveVoiceStore.use.partialTranscript();
  const finalTranscript = useLiveVoiceStore.use.finalTranscript();
  const assistantTranscript = useLiveVoiceStore.use.assistantTranscript();
  const inputAmplitude = useLiveVoiceStore.use.inputAmplitude();
  const error = useLiveVoiceStore.use.error();
  const failureKind = useLiveVoiceStore.use.failureKind();

  const sessionRef = useRef<SessionContext | null>(null);
  // Reconnect bookkeeping outlives the session (which is recreated on each
  // reconnect). Reset to 0 on a successful `ready` and when attempts run out.
  const reconnectAttemptsRef = useRef(0);
  const startRef = useRef<
    ((assistantId: string, conversationId?: string) => Promise<void>) | null
  >(null);

  // Mute is UI-reactive state; a mirror ref lets async glue (startCapture) read
  // the latest value without re-subscribing. The mic preference persists across
  // sessions, so it is not reset on stop()/teardown.
  const [muted, setMutedState] = useState(false);
  const mutedRef = useRef(muted);

  // Keep the factories in a ref so start()/stop() stay stable across renders
  // even if callers pass inline option objects. The ref is updated in an effect
  // (not during render) to satisfy the react-compiler "no refs during render"
  // rule; `start()` only reads it on user action, well after mount.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  /**
   * Mute/unmute the live mic. Applies immediately to the active capture (if any)
   * and stores the preference for the next `startCapture` so a session that
   * starts while muted comes up muted.
   */
  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    mutedRef.current = next;
    sessionRef.current?.capture.setMuted(next);
  }, []);

  /**
   * Tear down the active session's primitives, clear the ref, and reset the
   * store to idle.
   *
   * Resetting here keeps the store from getting stuck non-idle when the
   * consumer unmounts mid-session (otherwise the composer would permanently
   * disable dictation and keep the transcript surface mounted). Callers that
   * need a terminal state other than `idle` (e.g. `finishWithError` → `failed`)
   * set it *after* calling `teardown()`, so the reset can't clobber it.
   */
  const teardown = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    // Bump the generation so any in-flight async callbacks become stale no-ops.
    session.generation += 1;
    for (const unsubscribe of session.unsubscribes) unsubscribe();
    session.unsubscribes = [];
    session.client.close();
    // dispose() stops playback *and* releases the AudioContext; a bare stop()
    // would leak the context across repeated sessions until page unload.
    void session.player.dispose();
    void session.capture.shutdown();
    useLiveVoiceStore.getState().reset();
  }, []);

  /**
   * Drop the dead session and re-establish it with the SAME conversationId so
   * context continues, after a short backoff. Returns false (and resets the
   * counter) once attempts are exhausted, so the caller falls through to its
   * normal give-up path. `teardown()` nulls the session, and `start()`'s guard
   * short-circuits on a null session, so re-entering `start()` is safe even
   * though the store phase isn't idle.
   */
  const attemptReconnect = useCallback(
    (assistantId: string, conversationId: string | undefined): boolean => {
      const n = reconnectAttemptsRef.current;
      if (n >= MAX_RECONNECT_ATTEMPTS) {
        reconnectAttemptsRef.current = 0;
        return false;
      }
      reconnectAttemptsRef.current = n + 1;
      const delay =
        RECONNECT_BACKOFF_MS[Math.min(n, RECONNECT_BACKOFF_MS.length - 1)];
      teardown();
      useLiveVoiceStore.getState().setState("connecting");
      setTimeout(() => {
        void startRef.current?.(assistantId, conversationId);
      }, delay);
      return true;
    },
    [teardown],
  );

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      useLiveVoiceStore.getState().reset();
      return;
    }
    sessionRef.current = null;
    session.generation += 1;
    // A deliberate stop ends the recovery budget too.
    reconnectAttemptsRef.current = 0;
    useLiveVoiceStore.getState().setState("ending");
    for (const unsubscribe of session.unsubscribes) unsubscribe();
    session.unsubscribes = [];
    session.client.end();
    // Release the AudioContext, not just the scheduled sources (see teardown).
    await session.player.dispose();
    await session.capture.shutdown();
    useLiveVoiceStore.getState().reset();
  }, []);

  const start = useCallback(
    async (assistantId: string, conversationId?: string) => {
      const current = sessionRef.current;
      // A live session (anything but idle/failed) blocks a new start.
      const phase = useLiveVoiceStore.getState().state;
      if (current && phase !== "idle" && phase !== "failed") return;
      if (current) teardown();

      const store = useLiveVoiceStore.getState();
      store.reset();
      store.setState("connecting");

      const opts = optionsRef.current;
      // Full-duplex (continuous conversation) is the default: the daemon +
      // client paths are built, and the full STT → brain → streaming-TTS loop
      // plus the re-arm-after-response path are verified end-to-end on prod.
      // Echo is handled by the mic's echoCancellation constraint. A consumer can
      // still force legacy push-to-talk by passing `fullDuplex: false`.
      const fullDuplex = opts.fullDuplex !== false;
      const engine = resolveVoiceEngine(opts.engine);
      const persona = resolveVoicePersona(opts.persona);
      // Hands-free (server VAD) rides on full-duplex multi-turn sessions
      // only; a forced single-utterance session keeps manual semantics.
      const handsFree = fullDuplex && (opts.handsFree ?? isServerVadEnabled());
      // Consumers that render inside a chat thread need to know whether the
      // daemon is also streaming this session's turns into that thread.
      store.setEngine(engine);
      const client = (
        opts.createClient ?? (() => new LiveVoiceChannelClient())
      )();
      const player = (
        opts.createPlayer ?? (() => new LiveVoiceAudioPlayer())
      )();
      // `start()` runs inside the user gesture (mic tap). Unlock + resume the
      // playback AudioContext now, while the gesture is fresh, so the first
      // `tts_audio` frame — which for the realtime engine arrives seconds later,
      // outside the gesture window — actually sounds instead of landing on a
      // suspended context (which also hangs the drain and stalls re-arm).
      player.prewarm();

      const session: SessionContext = {
        client,
        capture: undefined as unknown as LiveVoiceAudioCapture,
        player,
        unsubscribes: [],
        generation: 0,
        captureRunning: false,
        forwardingAudio: false,
        fullDuplex,
        handsFree,
        utteranceOpen: false,
        utteranceEndSeq: 0,
        responseAudioStarted: false,
        interruptSent: false,
        releaseInFlight: false,
        speechMs: 0,
        silenceMs: 0,
        bargeInSinceMs: null,
      };

      const capture = (
        opts.createCapture ?? ((o) => new LiveVoiceAudioCapture(o))
      )({
        onChunk: (buf) => handleChunk(session, buf),
        onAmplitude: (amplitude) =>
          handleAmplitude(session, amplitude, teardown),
      });
      session.capture = capture;
      sessionRef.current = session;

      const generation = session.generation;
      const live = () =>
        sessionRef.current === session && session.generation === generation;

      // Publish the requested mode; the `ready` echo below is what confirms it.
      store.setHandsFree(handsFree);

      session.unsubscribes.push(
        client.on("ready", (frame) => {
          if (!live()) return;
          // Version skew: an older daemon ignores the start frame's
          // turnDetection and runs a manual session without echoing the mode.
          // Fall back to full client-side VAD (auto-release stays armed) so
          // the session works instead of hanging with no release path.
          if (session.handsFree && frame.turnDetection !== "server_vad") {
            session.handsFree = false;
            useLiveVoiceStore.getState().setHandsFree(false);
          }
          // A healthy connection clears the reconnect budget.
          reconnectAttemptsRef.current = 0;
          void startCapture(session, teardown, mutedRef.current);
        }),
        client.on("speechStarted", () => {
          if (!live() || !session.handsFree) return;
          // Server VAD heard the user: flush tail playback unconditionally
          // (even mid-`thinking`, when no cancellation follows) and open the
          // next utterance. Barge-in is server-detected in server_vad mode —
          // during assistant playback the daemon defers this frame behind
          // its sustained-speech guard, so a flush here is always real user
          // speech, never an echo blip.
          session.utteranceOpen = true;
          flushPlaybackToListening(session);
        }),
        client.on("turnCancelled", () => {
          if (!live() || !session.handsFree) return;
          // Barge-in aborted the turn; no tts_done follows a cancelled turn.
          // A mid-call approval belonging to that turn is over with it (the
          // daemon also sends approval_resolved outcome "superseded" — this
          // is the belt to that suspender).
          useLiveVoiceStore.getState().clearPendingApproval();
          flushPlaybackToListening(session);
        }),
        client.on("utteranceEnd", () => {
          if (!live() || !session.handsFree) return;
          session.utteranceOpen = false;
          session.utteranceEndSeq += 1;
          // Server VAD closed the utterance; its transcription is finishing.
          // The hands-free analog of the client's own auto-release transition.
          const s = useLiveVoiceStore.getState();
          if (s.state === "listening") s.setState("transcribing");
        }),
        client.on("sttPartial", (frame) => {
          if (!live()) return;
          const s = useLiveVoiceStore.getState();
          s.setPartialTranscript(frame.text);
          // Manual mode: only while still forwarding (the user's turn) does a
          // partial keep us in `listening`; after ptt-release we're
          // transcribing/thinking. Hands-free transitions are frame-driven
          // (`speech_started`/`utterance_end`), so partials never move state.
          if (!session.handsFree && session.forwardingAudio) {
            s.setState("listening");
          }
        }),
        client.on("sttFinal", (frame) => {
          if (!live()) return;
          const s = useLiveVoiceStore.getState();
          s.setFinalTranscript(frame.text);
          s.setPartialTranscript("");
          // Manual mode: forwarding ⇒ the user is still speaking (stay
          // listening); otherwise ptt was released and the server is about to
          // think.
          if (!session.handsFree && session.forwardingAudio) {
            s.setState("listening");
            return;
          }
          if (session.handsFree) {
            // Hands-free: only a closed utterance (`transcribing`, entered on
            // `utterance_end`) advances to `thinking`. An empty final never
            // starts a server turn — the daemon closes it with a bare
            // `tts_done` — and a final while still `listening` belongs to an
            // utterance the server has not closed yet.
            if (frame.text.trim().length === 0) return;
            if (s.state !== "transcribing") return;
          }
          s.setState("thinking");
        }),
        client.on("thinking", () => {
          if (!live()) return;
          // New response: reset the per-response transcript and barge-in flags.
          session.responseAudioStarted = false;
          session.interruptSent = false;
          const s = useLiveVoiceStore.getState();
          s.clearAssistantTranscript();
          // Cards are per-turn and replace: drop the previous turn's stack so
          // stale results don't pile up above the orb across turns.
          s.clearCards();
          s.setState("thinking");
        }),
        client.on("assistantTextDelta", (frame) => {
          if (!live() || frame.text.length === 0) return;
          const s = useLiveVoiceStore.getState();
          s.appendAssistantTranscript(frame.text);
          const phase = s.state;
          if (phase === "listening" || phase === "transcribing") {
            s.setState("thinking");
          }
        }),
        client.on("ttsAudio", (frame) => {
          if (!live()) return;
          beginAssistantAudioIfNeeded(session);
          const chunk: TtsAudioChunk = {
            dataBase64: frame.dataBase64,
            sampleRate: frame.sampleRate,
            mimeType: frame.mimeType,
          };
          session.player.enqueue(chunk);
          useLiveVoiceStore.getState().setState("speaking");
        }),
        client.on("ttsDone", () => {
          if (!live()) return;
          void finishResponseAfterPlayback(session, teardown);
        }),
        client.on("archived", () => {
          if (!live()) return;
          // Persisted; nothing user-visible to do here.
        }),
        client.on("card", (frame) => {
          if (!live()) return;
          const s = useLiveVoiceStore.getState();
          switch (frame.op) {
            case "show":
              s.showCard(frame);
              return;
            case "update":
              s.updateCard(frame);
              return;
            case "dismiss":
              s.dismissCard(frame.surfaceId);
              return;
          }
        }),
        client.on("minimizeRoom", () => {
          if (!live()) return;
          // The daemon revealed a surface behind the call ("voice announces,
          // screen follows" — the frame only arrives after the announcing
          // reply's tts_done). The store bumps a seq; the ladder owner
          // (voice-call-host on desktop, the fullscreen flag on mobile)
          // demotes on it. Promotion back is the user's — never automatic.
          useLiveVoiceStore.getState().requestRoomMinimize();
        }),
        client.on("approvalPending", (frame) => {
          if (!live()) return;
          // Mid-call approval: featured immediately (approval ≠ reveal — no
          // waiting for the sentence to end). Ladder owners demote on the
          // store field appearing.
          useLiveVoiceStore.getState().setPendingApproval(frame);
        }),
        client.on("approvalResolved", (frame) => {
          if (!live()) return;
          useLiveVoiceStore.getState().clearPendingApproval(frame.requestId);
        }),
        client.on("toolActivity", (frame) => {
          if (!live()) return;
          // The one place a "what is it doing" caption may come from. It is a
          // real tool name from a tool that really started; the surface decides
          // what words to put on it, and says something honest when it has none.
          useLiveVoiceStore.getState().setActivityTool(frame.toolName);
        }),
        client.on("busy", () => {
          if (!live()) return;
          finishWithError(
            session,
            teardown,
            "Another live-voice session is active.",
          );
        }),
        client.on("error", (err: LiveVoiceClientError) => {
          if (!live()) return;
          // The daemon marked this one non-terminal and is still running the
          // session (a transcriber poll hiccup, say). Tearing down here is what
          // dropped live conversations mid-sentence; the socket is fine.
          if (err.fatal === false) return;
          // Transient transport failures recover; a protocol-error is the
          // server refusing and is terminal (never retried).
          if (
            (err.reason === "connection-failed" || err.reason === "timeout") &&
            attemptReconnect(assistantId, conversationId)
          ) {
            return;
          }
          finishWithError(session, teardown, err.message);
        }),
        client.on("closed", () => {
          // A transport close after a clean end()/teardown is expected — those
          // null the session first, so `live()` is already false. Reaching here
          // with a live session means an UNEXPECTED drop: try to recover it
          // before giving up.
          if (!live()) return;
          if (attemptReconnect(assistantId, conversationId)) return;
          // Recovery is exhausted. Say so — silently resetting to idle is how a
          // dropped session read as "voice randomly stops", with the orb back
          // at "tap to talk" and nothing explaining why.
          finishWithError(
            session,
            teardown,
            "Voice disconnected and couldn't reconnect. Tap to start again.",
          );
        }),
      );

      await client.connect({
        assistantId,
        conversationId,
        fullDuplex,
        engine,
        persona,
        ...(handsFree ? { turnDetection: "server_vad" as const } : {}),
      });
    },
    [teardown, attemptReconnect],
  );

  const interrupt = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    interruptIfSpeaking(session, teardown);
  }, [teardown]);

  // The reconnect path re-enters `start()` via this ref (start references
  // attemptReconnect, which can't reference start directly).
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  // Release everything if the consumer unmounts mid-session. teardown() also
  // resets the store to idle so a mid-session unmount doesn't strand it in a
  // non-idle phase (which would keep dictation disabled via the composer).
  useEffect(() => () => teardown(), [teardown]);

  return {
    state,
    partialTranscript,
    finalTranscript,
    assistantTranscript,
    inputAmplitude,
    error,
    failureKind,
    muted,
    start,
    stop,
    setMuted,
    interrupt,
  };
}

// ---------------------------------------------------------------------------
// Session helpers (operate on the session context; never re-render directly)
// ---------------------------------------------------------------------------

/** Open the mic and begin streaming PCM. Failure transitions to `failed`. */
async function startCapture(
  session: SessionContext,
  teardown: () => void,
  muted: boolean,
): Promise<void> {
  const generation = session.generation;
  const result = await session.capture.start();
  // A stop()/teardown that raced our await replaced or advanced the session.
  if (session.generation !== generation) {
    if (result.ok) void session.capture.stop();
    return;
  }
  if (!result.ok) {
    finishWithError(
      session,
      teardown,
      "Microphone capture could not start.",
      "mic",
    );
    return;
  }
  session.captureRunning = true;
  session.forwardingAudio = true;
  // Honor a mute set before the session opened (the mic comes up muted).
  if (muted) session.capture.setMuted(true);
  const s = useLiveVoiceStore.getState();
  if (s.state === "connecting") s.setState("listening");
}

/**
 * Forward a captured PCM chunk to the server and drive silence detection.
 *
 * The mic stays open across the whole session, but PCM is only streamed while
 * `forwardingAudio` is on (i.e. during the user's turn; hands-free sessions
 * keep it on across turns — the server VAD needs the continuous stream).
 * Client-local silence detection is manual-mode only: in hands-free the
 * server VAD owns utterance boundaries, so the auto-release path
 * (SILENCE_DURATION_BEFORE_RELEASE_MS) is disabled.
 */
function handleChunk(session: SessionContext, buf: ArrayBuffer): void {
  if (!session.captureRunning || !session.forwardingAudio) return;
  session.client.sendAudio(buf);
  if (!session.handsFree) updateAutomaticRelease(session, buf);
}

/**
 * Apply the latest amplitude to the store and run barge-in detection.
 *
 * Runs whenever the mic is open — including while not forwarding — so a loud
 * amplitude can interrupt the assistant mid-response (barge-in).
 */
function handleAmplitude(
  session: SessionContext,
  amplitude: number,
  teardown: () => void,
): void {
  if (!session.captureRunning) return;
  useLiveVoiceStore.getState().setInputAmplitude(amplitude);
  // server_vad sessions: barge-in is server-detected (the daemon's
  // sustained-speech guard fires `speech_started` / `turn_cancelled`), so
  // the client's amplitude heuristic stands down — two independent
  // barge-in detectors would race and double-interrupt. Manual sessions
  // keep the client-side amplitude barge-in unchanged.
  if (session.handsFree) {
    session.bargeInSinceMs = null;
    return;
  }
  if (!isBargeInEnabled()) {
    session.bargeInSinceMs = null;
    return;
  }
  // Require the level to stay above the threshold for a minimum duration before
  // interrupting, so a transient echo spike from the assistant's own voice
  // doesn't cut it off — only sustained, real user speech barges in.
  if (amplitude >= BARGE_IN_AMPLITUDE_THRESHOLD) {
    const now = Date.now();
    if (session.bargeInSinceMs === null) session.bargeInSinceMs = now;
    else if (now - session.bargeInSinceMs >= BARGE_IN_MIN_SPEECH_MS) {
      interruptIfSpeaking(session, teardown);
    }
  } else {
    session.bargeInSinceMs = null;
  }
}

/**
 * Track speech / trailing-silence durations and auto-release push-to-talk once
 * a real utterance is followed by a long-enough silence window.
 */
function updateAutomaticRelease(
  session: SessionContext,
  buf: ArrayBuffer,
): void {
  if (useLiveVoiceStore.getState().state !== "listening") return;
  const durationMs = chunkDurationMs(buf);
  if (durationMs <= 0) return;

  // The amplitude for this chunk was applied via onAmplitude; read it back so
  // chunk-level speech/silence classification stays in sync with the UI value.
  const amplitude = useLiveVoiceStore.getState().inputAmplitude;
  if (amplitude >= SPEECH_AMPLITUDE_THRESHOLD) {
    session.speechMs += durationMs;
    session.silenceMs = 0;
    return;
  }
  if (session.speechMs < MINIMUM_SPEECH_DURATION_BEFORE_RELEASE_MS) {
    session.speechMs = 0;
    return;
  }
  session.silenceMs += durationMs;
  if (session.silenceMs < SILENCE_DURATION_BEFORE_RELEASE_MS) return;
  releasePushToTalk(session);
}

/**
 * Stop *forwarding* audio and release push-to-talk; moves to `transcribing`.
 *
 * The mic capture graph keeps running (so amplitude continues to flow for
 * barge-in); only the per-turn forwarding gate is closed here.
 */
function releasePushToTalk(session: SessionContext): void {
  if (session.releaseInFlight || !session.forwardingAudio) return;
  session.releaseInFlight = true;
  // Drain the capture's sub-batch tail while the forwarding gate is still
  // open: the last <50ms of the utterance may sit in the batch accumulator,
  // and the daemon rejects audio that arrives after the release frame.
  // Synchronous — the flushed chunk passes through handleChunk before the
  // gate closes below (re-entry is blocked by releaseInFlight above).
  session.capture.flush();
  // Hands-free keeps forwarding: the release is a manual override on a
  // session whose server VAD still needs the continuous stream.
  if (!session.handsFree) session.forwardingAudio = false;
  session.client.pttRelease();
  const s = useLiveVoiceStore.getState();
  if (s.state === "listening") s.setState("transcribing");
  s.setInputAmplitude(0);
}

/**
 * Hands-free: flush local TTS playback immediately, drop expectations for
 * the in-flight response, and keep the session live in `listening`. The
 * server owns barge-in in server_vad mode — `speech_started` (sustained
 * user speech) and `turn_cancelled` (the turn it aborted) both land here.
 * Unconditional: even mid-`thinking`, when nothing is playing yet, the
 * state returns to listening and the daemon drives what happens next.
 */
function flushPlaybackToListening(session: SessionContext): void {
  session.player.stop();
  session.responseAudioStarted = false;
  session.interruptSent = false;
  useLiveVoiceStore.getState().setState("listening");
}

/**
 * Resume listening for the next utterance on the same (full-duplex) session:
 * re-open the forwarding gate, clear the per-utterance counters/flags, and move
 * to `listening`. The mic is already running (continuous capture), so there is
 * nothing to restart here. Only valid for full-duplex sessions — the daemon
 * keeps the socket open and re-arms a fresh transcriber after each turn.
 */
function resumeListening(session: SessionContext): void {
  session.forwardingAudio = true;
  session.releaseInFlight = false;
  session.responseAudioStarted = false;
  session.interruptSent = false;
  session.utteranceOpen = false;
  session.speechMs = 0;
  session.silenceMs = 0;
  const s = useLiveVoiceStore.getState();
  s.setPartialTranscript("");
  // The exchange is over: whatever arrives next belongs to a NEW turn. This is
  // the client's own turn boundary — the server `thinking` frame (which only
  // the cascade sends) is no longer the sole thing that resets the reply.
  s.closeTurn();
  s.setInputAmplitude(0);
  s.setState("listening");
}

/**
 * Barge-in: stop playback and interrupt the server once per response.
 *
 * Full-duplex: the daemon keeps the socket open and re-arms listening after the
 * interrupt, so we resume forwarding on the same session (→ `listening`) and the
 * user can immediately speak their interrupting utterance.
 *
 * Half-duplex (legacy): the interrupted session is terminal on the runtime — it
 * won't accept more audio — so we tear the session down (→ idle) and the user
 * starts a fresh session to respond.
 */
function interruptIfSpeaking(
  session: SessionContext,
  teardown: () => void,
): void {
  if (useLiveVoiceStore.getState().state !== "speaking") return;
  if (!session.player.isPlaying || session.interruptSent) return;
  session.interruptSent = true;
  session.player.stop();
  session.client.interrupt();
  if (session.fullDuplex) {
    resumeListening(session);
    return;
  }
  teardown();
}

/** First TTS frame of a response: reset playback flags for the new utterance. */
function beginAssistantAudioIfNeeded(session: SessionContext): void {
  if (session.responseAudioStarted) return;
  session.responseAudioStarted = true;
  session.interruptSent = false;
}

/**
 * After `tts_done`, await playback drain, then finish the response.
 *
 * Full-duplex: the daemon keeps the socket open and loops back to listening, so
 * we re-arm the mic forwarding gate on the same session (→ `listening`) for the
 * next utterance instead of tearing down. The user keeps talking without
 * re-opening the mic.
 *
 * Half-duplex (legacy): a session is single-utterance — once `ptt_release` fires
 * the runtime won't accept more audio on it, so we tear the session down (→
 * idle) and the user starts a fresh one for the next turn (mirrors the macOS
 * `closeCompletedUtteranceSessionAfterPlayback`).
 *
 * Forwarding is suspended during the drain so playback audio captured by the
 * (still-open) mic isn't streamed back. A barge-in during the drain already
 * advanced the session (generation bumped for half-duplex reconnect, or state no
 * longer `speaking`), so we leave that alone.
 */
async function finishResponseAfterPlayback(
  session: SessionContext,
  teardown: () => void,
): Promise<void> {
  const generation = session.generation;
  const utteranceEndSeqAtStart = session.utteranceEndSeq;
  session.responseAudioStarted = false;
  // Hands-free keeps the forwarding gate open through the drain: the server
  // VAD hears the room continuously and parks anything the user says during
  // the tail for the next utterance.
  if (!session.handsFree) session.forwardingAudio = false;

  // Bound the drain wait. Normal playback drains in a few seconds; this cap only
  // fires if playback can't complete (e.g. a context that failed to resume),
  // which would otherwise hang the wait forever and strand the session in
  // `speaking` with no re-arm ("reply then goes silent"). Realtime replies are
  // short, so the cap is comfortably above any real utterance.
  await Promise.race([
    session.player.waitUntilDrained(),
    new Promise<void>((resolve) =>
      setTimeout(resolve, DRAIN_SAFETY_TIMEOUT_MS),
    ),
  ]);
  if (session.generation !== generation) return;

  // A barge-in mid-drain already re-armed the session, and a stopped/failed
  // session must not be revived — leave those alone. Anything else is a turn
  // still waiting to be closed, INCLUDING one that never reached `speaking`:
  // the daemon closes a turn with no spoken answer (an utterance that
  // transcribed to nothing) with a bare `tts_done`, and bailing on every phase
  // but `speaking` left those sessions stuck in `transcribing` with the mic
  // gate shut — alive, but unable to hear another word.
  const phase = useLiveVoiceStore.getState().state;
  if (
    phase === "listening" ||
    phase === "idle" ||
    phase === "ending" ||
    phase === "failed"
  ) {
    return;
  }

  // Hands-free: a `transcribing` phase from an `utterance_end` that landed
  // MID-DRAIN belongs to the next utterance — the server owns its state, so
  // leave it alone. An unchanged seq means the `transcribing` is this turn's
  // own answerless close (empty utterance → bare `tts_done`), which must
  // cycle back to `listening` or the session sticks deaf.
  if (
    session.handsFree &&
    phase === "transcribing" &&
    session.utteranceEndSeq !== utteranceEndSeqAtStart
  ) {
    return;
  }

  if (session.fullDuplex) {
    // Loop back to listening on the same open socket for the next utterance.
    resumeListening(session);
    return;
  }
  teardown();
}

/** Fail the session: tear down primitives and surface the message. */
function finishWithError(
  session: SessionContext,
  teardown: () => void,
  message: string,
  kind: "mic" | "session" = "session",
): void {
  teardown();
  useLiveVoiceStore.getState().fail(message, kind);
}
