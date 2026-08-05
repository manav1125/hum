# Voice re-platform — architecture plan

Branch: `cue/voice-replatform` (off `cue/upstream-wave-c`).

## STATUS (2026-08-05): BUILT — flag-off, awaiting device QA

Shipped on this branch: V-1a (`354dd16582`), V-2 (`95895cdac1`), V-1b+c
(`daca355c0e`), V-3 (`b191f8d30f`). Everything is inert in production until
flipped: server VAD activates only for sessions sending
`turnDetection:"server_vad"` (web hands-free does, kill switch
`cue.voiceServerVad=0`), and the speculative front door additionally requires
`liveVoice.frontDoor.enabled` (default false).

**Deferred:** V-1d detached barge-in continuation; V-4 mobile sheet + Live
Activity (needs a native module — own project); capability-flagging the
pre-existing `card` frame (Swift-client fatal — needs its own flag, not
server_vad, else manual web sessions lose cards); upstream's `update_config`
in-call settings gear UI (frame is implemented, no UI); multilingual STT
code-switching (`699c1c889f`, independent).

## Synthetic E2E result (2026-08-06, local instance, real speech via `say`)

The full pipeline verified against a hatched local instance (`voiceqa`):
`ready(server_vad)` 760ms → `speech_started` 1.2s → Deepgram finals →
`utterance_end(silence)` → front-door dispatch → answer "132" + 51KB TTS →
clean re-arm. Findings:

- **Front-door TTFT reality**: `dispatchToFirstDeltaMs` = 3303ms on
  DeepSeek — the 1200ms verdict deadline fails open every time, so the front
  door currently adds nothing (and costs nothing — the leg IS the answer leg).
  To make it win, front `voiceFrontDoor` with a genuinely fast model. This is
  exactly what decision 2's instrumentation was for.
- Fixed en route (`71a66cf194`): local-mode voice was entirely broken
  client-side — the relative `__gateway` ingress URL threw inside
  `new URL()` before any socket/mic activity ("connecting…" forever). The WS
  now dials the loopback gateway directly; this also unblocks the packaged
  Electron app's local mode (its protocol handler can't upgrade WS either).
- QA-rig gotchas: the daemon's disk-pressure guard (≥95% volume) silently
  fails voice turns — `VELLUM_DISABLE_DISK_PRESSURE=1` for dev instances on
  full Macs; STT key comes from env (`DEEPGRAM_API_KEY`), TTS key must be in
  the vault (`credentials set --service elevenlabs --field api_key`); a
  Vite dev proxy cannot carry the WS (and vite's http-proxy crashes on Bun's
  missing `socket.destroySoon` if it tries).

## Device QA checklist (the flip-on gate — needs a real mic)

Setup: web app against a local daemon; set `liveVoice.frontDoor.enabled: true`
in workspace config for the front-door items. Watch the `metrics` frames
(`dispatchToFirstDeltaMs`, `endpointHoldCount`).

1. **Endpointing feel** (server VAD alone, front door off): speak, pause
   naturally — turn should start ~1.2s after you stop; no mid-sentence cuts on
   brief pauses; ptt/tap release still works as manual override.
2. **Front door on**: same flow — the answer should start noticeably sooner
   after the silence boundary; a mid-thought pause ("what's on my… calendar
   tomorrow") should NOT trigger a premature answer (hold) and should never
   produce a spoken "[0]"/"[1]" or narrated deliberation.
3. **Escalation**: ask something tool-needing ("check my calendar") — expect a
   short spoken bridge, then the real answer; no double-announcement.
4. **Barge-in**: interrupt mid-answer — audio should cut fast (sustained speech
   ~250ms), your interruption should be honored and merged; background noise /
   brief coughs should NOT interrupt.
5. **Ladder**: collapse to bar (audio continuous), type in the composer
   mid-call, navigate away (pill appears, audio continuous), click pill back.
6. **Reveal**: ask for something that shows a card — Cue announces, THEN the
   room drops to the bar and the card takes the space; scrolling the card is
   never interrupted by auto-promotion.
7. **Approval**: trigger a sensitive action mid-call — room minimizes at once,
   the fixed phrase plays, amber card offers Approve/Deny/Ask-me-after;
   "Ask me after" leaves the chat approval pending; narration stays quiet while
   the card is up.
8. **Fallbacks**: old-daemon fallback (kill switch on → client VAD unchanged);
   `voiceFrontDoor` TTFT tail — if `dispatchToFirstDeltaMs` regularly exceeds
   ~1200ms on our OpenRouter brain, the front door silently degrades to plain
   server-VAD behavior (fail-open) — acceptable, but retune the call-site
   model if it never wins.

## Why

Our dormant endpointing flags (`liveVoice.frontModel.semanticEndpointing` + the
`endpoint*` knobs) implement upstream's deleted `decideEndpoint` design — built,
706 lines of tests, zero production call sites. Upstream GA'd Voice Mode on the
"unified front door": server-side VAD + speculative dispatch, the answer leg's
leading token doubling as the endpointing verdict. Design's v35–v37 package
specifies the complete call experience on top. This project adopts the engine and
builds the specified surfaces.

## Current state (inventory, 2026-08-05)

- One WS `/v1/live-voice`, single active session, two engines behind one
  `LiveVoiceSession` contract: the cascade (full agent loop, tools+memory+cards)
  and dormant gemini-live (speech-native, 3 tools).
- VAD/endpointing/barge-in are entirely client-side (hardcoded RMS thresholds in
  the web worklet path; the `liveVoice.vad.*` config block is read by nobody; web
  and Swift disagree on thresholds).
- The phone path owns a working server-side VAD: `MediaTurnDetector`
  (assistant/src/calls/media-turn-detector.ts) — speech→silence transitions,
  timer-based, integration-neutral. Unused by live voice. Prime reuse.
- TTS: 2-job prefetch + eager first clause landed (C-4). Spoken acks + progress
  narration fully wired, flag-off. Tool-use ack call site live.
- Approvals mid-call: broadcast on the normal SSE stream; the voice UI renders
  nothing; no timeout, no wire frame; narration assumes turns never park.
- Wire protocol: 3 hand-maintained copies (assistant, web, Swift), no version
  field. Compat levers: additive-optional start fields, capability flags
  (`toolActivity`), `error.fatal`. Known violation: `card` frames are sent
  unconditionally and fatally break the stale Swift client.
- `VoiceTurnHandle` = `{turnId, abort()}` — no `discard()`; changes to the
  voice-session bridge hit the phone channel too.
- Surfaces: mobile has the in-thread bar + fullscreen (v35 three-state room,
  three controls); desktop `VoiceModeSurface` has ✕ only — no collapse ladder.
  Transcript contract (🎙 italic bubbles, no separate call history) already holds.

## Design spec (v35 + v37, binding)

- **Room** (v35): mark IS the state — listening breathes/ripples + live caption
  of current sentence; thinking contracts/dims violet + orbiting dot + tool named
  in words; speaking steady + teal waveform + "tap anywhere to interrupt".
  Exactly three controls: mute · end · collapse. Engine toggle lives in
  Preferences; debug via long-press on timer.
- **W1 ladder**: room → minimized bar (above a fully usable composer; mark +
  ripple, real-audio level bars, state word, ▤ thing chip, timer, mute·end·⤢) →
  title-bar pill (level bars + "Cue · speaking" + timer + ✕; click-anywhere
  returns). Demotion never interrupts audio. Mobile pill = Dynamic Island.
- **W2 reveal**: only after the sentence finishes; voice announces, screen
  follows; room collapses to bar and the surface takes the space; ⤢ returns;
  user scroll wins.
- **W2 approval**: room minimizes immediately; fixed spoken phrase "That one
  needs your okay — take a look."; amber ‖ card, one line of trust language,
  Approve · Deny · **Ask me after** (parks without ending the call).
- **W3 mobile**: room = bottom sheet; Live Activity/Island/notification shows
  phase word · participle label · timer · mark; lock-screen privacy — present
  participles only, no tool names/arguments/person names.
- Spoken copy (W3): shipped in C-4 (`ack-phrases.ts`, `progress-phrases.ts`,
  tone block).

## Slices

### V-1 · Engine — server VAD + unified front door

From the upstream deep-read (checkout `6be0c5eb35`, clone in the session
scratchpad). Key facts that shape the port:

- **The speculative call IS the answer call.** Dispatch fires at the silence
  boundary with nothing user-visible (no `utterance_end`, no `thinking`, no
  timers); the leg runs toolless with a capability digest; the leading token is
  classified `pending|hold|escalate|answer` via `[0]`/`[1]` control markers
  riding the existing marker-holdback machinery (a stray token can never reach
  TTS). Hold is taught only on the first dispatch (one hold per utterance, max
  2 extensions), so waste ≈ prompt + a few tokens on ≤1 discarded leg. Fail-open
  everywhere: verdict deadline 1200ms commits anyway.
- **VAD = 49-line energy gate** (`speech-energy.ts`, threshold 800 on PCM16) +
  `MediaTurnDetector` (we already carry it, ~10 lines drift, needs
  `setSilenceThresholdMs` + `forceEnd`) + a 25-chunk pre-roll ring. Idle silence
  never reaches STT. Zero new dependencies.
- **Barge-in moves server-side**: 250ms sustained-speech guard with 200ms
  per-gap tolerance and a 4× duty-cycle ceiling — constants encode the client's
  50ms/800-sample batching, which must be verified in our `pcm-capture.ts`.
  Client amplitude barge-in is disabled in server_vad mode. Hard flush, no duck.
- **False-start rollback**: `VoiceTurnHandle.discard()` — delete the persisted
  user row, reload conversation from DB, publish; discard latched before the
  handle resolves; the reserved assistant row is removed by the teardown
  transcript-hygiene pass. Discard triggers: speech resumed / hold verdict /
  superseded. Two subtle races to port as-is (manual release during verdict
  window; the zombie partial-flush timer that leaked `[1]` into settled rows).
- **Prompt-injection hardening to carry verbatim**: the caller's utterance is
  JSON-serialized into the front-door rule.
- **Minimum viable commit set**: e6ecf41661 (VAD foundation), 61498a864a
  (gap tolerance), b18908c718 (partial — we have the ack half), 4dd58656fe
  (THE front door), be16df3e63, 31c06e53f1 (don't-hold-complete-questions),
  ff78929883 (flag retirement + `use-supports-live-voice`), 9e42d751c0
  (`[-1]` strip). Skip: 17373029d5/43c532567f/8cbddff2cc (superseded decider
  tuning), f00aa54d6c/f6535c004f (progress narration — C-4 already built ours).
- **Scope**: ~2.5-3k net engine LOC + ~1k client LOC + ~3.5k tests.

**Decisions (made):**
1. **Frame compat**: all new server frames (`speech_started`, `utterance_end`,
   `utterance_discarded`, `turn_cancelled`, `minimize_room`) are emitted ONLY in
   sessions that opted in via `turnDetection: "server_vad"` on the start frame —
   our `toolActivity` capability pattern; `ready` echoes `turnDetection` so the
   client falls back to manual against an old daemon. Same client change also
   ports upstream's `unknown_frame` tolerance as forward hygiene. The Swift
   client never opts in → frozen safely at the old protocol.
2. **Front-door model**: new `voiceFrontDoor` call site pinned to our
   `cost-optimized` (Speed) profile — we have the latency intent, not a separate
   profile key. Instrument `dispatchToFirstDeltaMs` / `dispatchToFirstAudioMs`
   before trusting it; the 1200ms fail-open means a slow tail degrades to
   today's behavior, never breaks.
3. **Progress narration + acks**: keep ours (C-4, design-owned copy — upstream
   deleted canned acks; design's word wins on copy). Our audio-only invariant
   already matches upstream's enqueue-path enforcement — verified, no fix
   needed. `front-decision.ts` sheds `decideEndpoint` and the `endpoint*` config
   knobs move to the front-door schema.

Sub-slices: **V-1a** server VAD ingress + protocol + client hands-free mode;
**V-1b** server barge-in + batching verification; **V-1c** speculative dispatch
+ verdict protocol + bridge `discard()`; **V-1d** (optional, later) duplex
handoff — barge-in continuation on a background subagent (84f9a1e8df +
b6fb2da259, ~3.8k LOC).

### V-2 · Desktop ladder + room polish (web)
- Desktop `VoiceModeSurface` gains the v37 ladder: minimized bar component
  (composer stays usable — typing mid-call is a feature), title-bar pill on
  navigate-away, promotion/demotion transitions that never touch the socket.
- Room brought to v35 exactness where it drifts (state motion, caption rule,
  three controls) on desktop; mobile bar aligned to the W1 bar spec (level bars
  from real audio, state word, thing chip).
- Kill dead `live-voice-button.tsx`.

### V-3 · Mid-call reveal + approval moment
- Reveal: `card` frames become capability-flagged (fixes the Swift fatal);
  "voice announces, screen follows" sequencing — surface show deferred until
  `tts_done` of the announcing sentence; bar collapse choreography.
- Approval: new capability-flagged wire frame for pending approvals; fixed
  spoken phrase (never generative); amber card in the voice surface with
  Approve/Deny/Ask-me-after (defer = park the interaction, resume on call end
  via the normal review queue); narration stands down while pending; timeout →
  guardian fallback per upstream's 45s pattern (exact number from deep-read).
- The turn actually parks: `local-live-voice` approval mode learns to hold.

### V-4 · Mobile: sheet + Live Activity  [scope check after V-2]
- Bottom-sheet room per W3; Dynamic Island / Live Activity with the privacy
  rule. Capacitor wrappers have no native code today — Live Activity needs a
  native module; assess cost, possibly defer to its own project.

### Cross-cutting
- Protocol: single-source the frame types (share or codegen), version field,
  capability flags for every new frame.
- Flags: retire the dead `liveVoice.vad.*` client-tuning block and the
  abandoned `endpoint*` knobs when V-1 replaces them; new flags for server VAD
  and speculative dispatch, default off until device QA.
- Swift client: minimum viable compat = tolerate unknown frames + parse
  `error.fatal` (or formally freeze it at the old protocol and gate new frames
  off its start-frame capabilities).
- Device QA (needs a real mic + user): endpointing feel, barge-in thresholds,
  ladder audio continuity — the flip-on gate for everything above.

## Non-goals

- No speech-native engine swap (gemini-live stays dormant; cascade keeps
  tools+memory — the front door improves the cascade's turn-taking).
- No phone-channel behavior change beyond shared-bridge refactors.
- Voice re-platform does not gate on Wave C merge/deploy; rebase if needed.
