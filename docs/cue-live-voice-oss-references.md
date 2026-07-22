# Cue Live — Open-Source References for Full-Duplex Voice (the parts we're stuck on)

**Date:** 2026-07-10
**Context:** Cue runs Gemini Live server-side (browser → Cue Node/TS daemon WS → Gemini Live; native audio out 24kHz PCM), with a cascaded STT→LLM→TTS fallback. The live engine works E2E, but we're stuck on the **client-side audio hard-parts**: real-device echo (the model hears its own TTS and self-interrupts), VAD/turn tuning, and **barge-in** (our protocol has no "flush playback" path). This doc lists the OSS repos that have these solved and exactly what to lift.
**Companion:** `docs/cue-live-voice-research.md`, `docs/cue-voice-architecture-review.md`.

---

## 0. The reframe that unblocks us

**Our struggle is an audio-transport problem, not a model problem.** We stream raw mic PCM over a WebSocket and play 24kHz PCM back through the Web Audio API (`AudioBufferSourceNode`s). That path **bypasses the browser's echo canceller entirely**: `getUserMedia({echoCancellation:true})` only cancels audio the browser treats as the WebRTC *far-end* (a remote `RTCPeerConnection`/`<audio>` track) — it does **not** cancel audio we schedule ourselves through an `AudioContext`. So the mic picks up our own TTS and the model self-interrupts. This is a documented, long-standing gap (WebKit #179411, Chromium #40252911, webrtc/samples #1243), not a Cue bug.

That single fact defines the fix options, cheapest → most robust:
1. **Lift a correct barge-in flush** (closes our "no clear frame" gap) — hours.
2. **WebRTC-loopback AEC trick** — make the browser's own AEC cancel our TTS without changing transport — ~a day.
3. **Drop-in VAD + semantic turn model** — better endpointing/barge-in trigger — a day or two.
4. **Move the audio path to real WebRTC transport (self-hosted LiveKit), keep Gemini as the brain** — the robust, bigger option if 1–3 aren't enough on loudspeakers.

None of these require abandoning our daemon or Gemini Live.

---

## 1. The single most useful repo — matches our stack exactly

### `google-gemini/live-api-web-console` — Apache-2.0, TypeScript, official (~2.6k★)
Google's official React/TS starter for Gemini Live. It solves three of our four gaps and is near-drop-in because the audio classes are plain TS event-emitters with no React coupling. Files to lift (`src/lib/`):

- **`audio-streamer.ts`** — 24kHz playback with lookahead scheduling **and the barge-in flush we're missing**: `stop()` sets `isStreamComplete`, **clears the queued buffer**, resets `scheduledTime`, and ramps gain to zero over 100ms (no click). This is exactly the "clear queued playback" our protocol lacks.
- **`genai-live-client.ts`** — the interruption edge: on `serverContent.interrupted` it emits `"interrupted"`, and the app does `client.on("interrupted", () => audioStreamer.stop())`. **Copy this edge verbatim** — it's the entire barge-in playback-flush pattern.
- **`audio-recorder.ts` + `worklets/audio-processing.ts`** — correct 16kHz Int16 capture via AudioWorklet (Float32→Int16 in the worklet, ~128ms chunks, no manual resample because the `AudioContext` is created at 16000). Lift this, but **explicitly set `echoCancellation:true, noiseSuppression:true, autoGainControl:true`** in `getUserMedia` (the console leaves it default).

Also useful: **`google-gemini/gemini-live-api-examples`** (official) — its `gemini-live-ephemeral-tokens-websocket/` example shows the `FunctionCallDefinition`/`addFunction()` tool-bridge over the raw protocol, and the Node/Python `command-line/` examples show canonical `interrupted`/`generationComplete`/`turnComplete` handling to validate our daemon against.

**Protocol facts to hardcode correctly (from Google's docs):** audio is always little-endian 16-bit PCM; **input 16kHz** (`mimeType:"audio/pcm;rate=16000"`), **output 24kHz**. Flush playback **only on `serverContent.interrupted:true`**, never on `generationComplete`/`turnComplete`. Auto-VAD is tunable via `realtimeInputConfig.automaticActivityDetection` (`startOfSpeechSensitivity`, `endOfSpeechSensitivity`, `prefixPaddingMs`, `silenceDurationMs`); or go manual and send `activityStart`/`activityEnd` yourself (useful to gate the mic while the model speaks — see §2).

---

## 2. The echo fix without a transport rewrite

### `nguyenvulebinh/browser-aec` — MIT, self-contained, no deps
The **WebRTC-loopback AEC trick**, ~50 lines: take the TTS Web-Audio graph → `audioContext.createMediaStreamDestination()` → add that track to a local `RTCPeerConnection` looped back to a second peer → play the *looped* stream to the speaker. Because the TTS now arrives as a "remote" track, the browser's AEC3 treats it as the far-end reference and **subtracts it from the mic**. This makes the browser's *built-in* AEC actually cancel our own TTS, with no WASM and no change to our WS-to-Gemini backend. **Highest leverage, lowest effort for the echo problem — do this before considering a transport swap.**

**Cheaper still / complementary — daemon-side RMS gate** (the "GoNoGo" pattern, no deps): since our daemon knows when it's streaming model audio, hard-suppress mic input while the model speaks, then keep a ~1.5s cooldown with an elevated RMS threshold (e.g. 0.03→0.05) to reject room-resonance decay while still allowing a real barge-in. Half-duplex-ish but robust; good as a fallback for loudspeaker users or as a stopgap this week.

**What NOT to chase:** there is no maintained npm package shipping libwebrtc **AEC3 as browser WASM** (the compiled artifacts target Android/native). SpeexDSP-WASM AEC exists but is older/less accurate and makes you own exact mic/reference frame alignment. Skip both unless the loopback trick fails.

---

## 3. Drop-in VAD + turn detection

### Client VAD / barge-in trigger — `@ricky0123/vad-web` (+ `@ricky0123/vad-react`) — MIT
Runs **Silero VAD** (MIT, ~2MB, <1ms/frame) via ONNX-Runtime-Web WASM inside an AudioWorklet; resamples to 16kHz, 512-sample (~32ms) frames. Callbacks are exactly what we need: **`onSpeechStart` = the barge-in trigger** (→ call `audioStreamer.stop()` from §1), `onSpeechEnd(audio)` = endpoint, `onVADMisfire` = cancel an optimistic barge-in. Tune `redemptionFrames` (silence-to-endpoint), `minSpeechFrames` (cough filter), `preSpeechPadFrames` (don't clip onsets). Genuinely drop-in for our React client. Lower-latency alternative: **TEN VAD** (`TEN-framework/ten-vad`, Apache-2.0-with-conditions, 306KB, ships WASM+JS) — claims faster speech→non-speech transitions than Silero.

### Semantic endpointing (server-side, Node) — `pipecat-ai/smart-turn` v3 — **BSD-2**
8M-param model that decides if a turn is *actually complete* vs mid-thought, operating on the **raw waveform (no transcript/STT needed)** — perfect for sitting on our PCM stream. **8MB int8 ONNX, ~12ms CPU**, multilingual, runs in Node via `onnxruntime-node`. This replaces naive silence-timeout endpointing and is the biggest naturalness upgrade after AEC. (Alternative: **LiveKit turn-detector** — but it needs STT text input and ships under the non-standard *LiveKit Model License*; only worth it on the cascade path.)

---

## 4. The exact barge-in flush technique (so it doesn't glitch)

When `onSpeechStart` fires (or Gemini sends `interrupted:true`), do all of this:
1. Keep a reference to **every scheduled `AudioBufferSourceNode`** as you create them.
2. Call **`node.stop(0)`** on each — scheduled audio can't be un-scheduled any other way; clearing your JS array alone leaves audio playing.
3. **Clear the pending PCM queue** so no new sources get created.
4. Route playback through one **`GainNode`** and ramp to 0 (~5–10ms `setTargetAtTime`) *before* stopping, to kill the click.
5. **Detach `onended` handlers before stopping** — otherwise the dying node's `onended` fires into the next turn and corrupts state (a known footgun; Pipecat #3077/#2941 are the failure modes).
6. Send a WS control message so the **daemon stops forwarding any buffered Gemini audio** and, on the cascade, cancels in-flight TTS.

`live-api-web-console`'s `audio-streamer.ts` already implements 1–4; add 5–6. Consider adding an explicit `clear`/`flush` server→client frame to our `/v1/live-voice` protocol (the gap noted in our own backlog).

---

## 5. The robust escalation — if loudspeaker echo still isn't good enough

### Self-hosted **LiveKit** as transport-only (Apache-2.0), keep Gemini as the brain
Run the open-source LiveKit SFU on our own infra; put LiveKit **client SDKs** (JS/React + Swift for iOS/macOS) in the clients; have our daemon **join the room as a participant** and keep running the Gemini-Live / cascade brain. Because the audio path is real **WebRTC**, we inherit **browser + iOS AEC, jitter buffering, and barge-in for free** — the whole class of problems in §0 disappears. We do *not* have to use LiveKit's STT/LLM/TTS graph. Caveat: LiveKit's fanciest *Adaptive Interruption* model is hosted-only; self-hosted falls back to VAD-based interruption (still good, and we'd pair it with Silero/smart-turn anyway). This is the biggest change (new media server + client SDK swap) — only escalate here if §1–3 don't hold up on real devices.

**Pipecat** is the alternative reference (BSD-2, Python): its `GeminiLiveLLMService` + `gemini-webrtc-web-simple` demo is a working WebRTC-Gemini full-duplex loop with interruption handled. Even if we don't adopt the Python server, `@pipecat-ai/client-js` and its `small-webrtc-transport` are a study reference. (Vocode = stalled; Bolna = telephony/WS, no browser AEC; Ultravox = a model, not plumbing — skip for this problem.)

---

## 6. Recommended action plan (mapped to our exact gaps)

| Priority | Fixes which Cue gap | Do this | Repo / license | Effort |
|---|---|---|---|---|
| **P0** | "protocol has no clear frame" / barge-in cuts glitchy | Lift `audio-streamer.ts` + the `on("interrupted")→stop()` edge; add the §4 steps 5–6 + a `flush` protocol frame | live-api-web-console (Apache-2.0) | hours |
| **P0** | model hears its own TTS (echo/self-interrupt) | Add the WebRTC-loopback AEC; ship a daemon RMS-gate as fallback | browser-aec (MIT) | ~1 day |
| **P1** | VAD/turn tuning; barge-in trigger | `@ricky0123/vad-web` `onSpeechStart`→flush; tune `redemptionFrames` | ricky0123/vad (MIT) | ~1 day |
| **P1** | premature/late endpointing | smart-turn v3 in the daemon (audio-native, no STT) | pipecat smart-turn (BSD-2) | 1–2 days |
| **P2** | if loudspeaker echo still bad on real devices | Move audio path to self-hosted LiveKit WebRTC, keep Gemini brain | livekit (Apache-2.0) | multi-day |

**Licensing note for the builder:** everything in P0–P1 is permissive (Apache-2.0 / MIT / BSD-2). The **LiveKit turn-detector** model and the **TEN** models carry non-standard/additional terms — check before commercial use. Verify repo currency/versions at implementation time.

**Bottom line:** we are ~2–3 small, permissively-licensed lifts away from fixing this — the barge-in flush from Google's own console, the WebRTC-loopback AEC trick, and Silero VAD — with self-hosted LiveKit as the escape hatch only if loudspeaker echo demands true WebRTC transport. The problems we're fighting are the exact ones these repos exist to solve.
