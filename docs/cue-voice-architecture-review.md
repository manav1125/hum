# Cue Voice — Architecture Review & Path to Real-Time

_Written 2026-07-10 during the overnight voice sprint. Responds to: "review this
properly and see if you have the right architecture behind the scenes + what
issues voice actually has," and the decision "harden now, Live next."_

## TL;DR

Your instinct was right: the **cascade** we have is not, and never will be, a
"simultaneous conversation." I hardened it so it is now **reliable and honest**
(it actually does what it says, and stops rambling), which is the right thing to
ship everywhere today. But true real-time voice needs a **second tier built on
the Gemini Live API** — which I proved works with your key tonight (audio +
function-calling, ~2.7s even with a tool call vs the cascade's ~6.4s). Below is
what was actually wrong, what I fixed, and the concrete plan for Live.

---

## 1. What voice actually is today (the cascade)

```
mic → WebSocket → Deepgram STT → Cue's FULL agent loop (Gemini 2.5-flash,
      memory, skills, tools) → ElevenLabs streaming TTS → speaker
```

Every spoken turn runs the **entire chief-of-staff brain** — memory retrieval,
full system prompt, skill tool-schemas, reasoning, tool execution. That is what
makes replies smart and able to take real action. It is also why it is slow.

### The real issues I found (and fixed)

| Symptom you reported | Root cause | Status |
|---|---|---|
| "goes static then quiet" | Odd-length PCM chunks split 16-bit samples | ✅ Fixed (2-byte alignment carry) |
| "just does text" / refuses | Non-guardian trust stripped every action tool; thin persona | ✅ Fixed (guardian trust + real persona) |
| "replies are weak" | Same tool-stripping + no memory in the turn | ✅ Fixed — replies now pull real context (e.g. it cited the AEF NextGen Fund deck + Simon's review unprompted) |
| Tasks silently not created | Model sometimes said "I added it" **without emitting the tool call** | ✅ Fixed — hardened the voice persona to forbid claiming an action is done unless the tool actually ran this turn. Reliability went 2/3 → **4/4** in testing |
| Rambling apologies about missing tools | Persona didn't constrain failure behavior | ✅ Fixed — one short sentence on failure, never reads tool/function names aloud |
| "thinking for a long time, not simultaneous" | **Architectural** — see below | ⚠️ Fundamental limit of the cascade |

### The latency truth (measured tonight, prod)

- First audio: **~6.4s** (complex), ~4.4s (simple)
- I A/B'd turning Gemini's "thinking" off: it only saved ~1–2s **and badly
  degraded quality** (it hallucinated missing tools and rambled). Not worth it.
- **~3s of the latency is fixed agent-loop overhead** (memory retrieval + full
  prompt + 5 preactivated skills), independent of the model. You cannot remove
  it without gutting the capability that makes the reply good.

**Conclusion:** the cascade is a great "voice as an input to my full assistant"
(speak a request, Cue does real work) — a walkie-talkie, not a phone call. It
should stay as the universal, works-everywhere path. It will not become
sub-second by tuning.

---

## 2. The right architecture for real-time: Gemini Live (proven tonight)

The Gemini **Live API** (`BidiGenerateContent`) is speech-native: audio in →
audio out over one WebSocket, with built-in voice-activity detection, barge-in,
and function calling. I tested it directly with **your** Gemini key tonight:

- ✅ Your key has access to `gemini-2.5-flash-native-audio-latest` (plus
  `gemini-3.1-flash-live-preview`, `gemini-3.5-live-translate-preview`)
- ✅ **Function calling round-trips** — the model called `add_task({title:…})`
  and accepted the tool response. This is the key finding: **Cue's tools bridge
  cleanly into Live**, so Live isn't just chit-chat — it can still take real
  actions.
- ✅ Native audio out (real 24kHz PCM speech)
- ✅ **~2.7s to first audio even *with* a tool call**; pure conversation will be
  faster, and it streams + is interruptible, so it *feels* real-time.

### Recommended target: a two-tier voice system

- **Tier 1 — Live (new):** Gemini Live handles the live conversation and the
  common quick actions via a curated set of function declarations (add task,
  check schedule, capture a note, send a quick message, recall memory). Fast,
  interruptible, natural.
- **Tier 2 — Deep work (existing cascade / agent loop):** when the user asks for
  real depth ("draft the investor update", "research X and build a plan"), Live
  calls a single `run_deep_task` function that hands off to the full agent loop
  **in the background** and speaks "on it — I'll have that for you shortly."

This gives you both: the phone-call feel *and* the chief-of-staff depth, without
forcing every "what time is my next meeting" through a 6-second brain.

---

## 3. Concrete build plan for Live (the "Live next" work)

1. **`assistant/src/gemini-live/` bridge module** (dormant, opt-in flag — same
   pattern as the full-duplex ship): browser mic PCM → daemon → Gemini Live WS →
   audio back to browser. Reuse the existing `/v1/live-voice` client protocol so
   the web/orb UI is unchanged; add a `?engine=gemini-live` selector.
2. **Function-declaration bridge:** expose a curated subset of Cue tools to Live
   as `functionDeclarations`; on `toolCall`, execute through Cue's real tool
   executor under **guardian trust** (same path the cascade now uses) and return
   the `functionResponse`. One of them is `run_deep_task` → hands off to the
   agent loop.
3. **Session/persona:** seed Cue's identity + a short briefing (today's
   priorities) as `systemInstruction`; persist the transcript + extracted action
   items into memory at session end (reuse the existing voice-intake pipeline).
4. **Barge-in + VAD:** rely on Live's server-side VAD; wire `interrupted` events
   to stop local playback.
5. **Device tuning (needs you):** audio input format/VAD trailing-silence and
   echo cancellation genuinely need a real mic + device to tune — this is the
   one part that can't be finished blind. Everything up to it can.

### Open technical notes (from tonight's probing)
- `realtimeInput` audio-chunk format vs. `clientContent` text turns: the text
  path works cleanly; the raw audio-streaming VAD needs the exact
  `realtimeInput.audio` shape + trailing silence dialed in (a build detail, not a
  blocker — the text-turn proof already validated audio-out + tools).
- Native-audio models emit a "thinking" text trace alongside audio; suppress it
  from anything user-facing (audio is the product).

---

## 4. What's live right now

- Hardened cascade deployed to prod (`manav.justcue.app`, image
  `deployment-01KX523CBXBQGZVJ3NTF6MPD8N`, commit `0d76834107`).
- Whole brain = your Gemini key (chat + voice). Effort pinned at **medium** (the
  quality/latency sweet spot; none/low degrade reasoning).
- Voice task-add verified **4/4 reliable**, replies pull real memory, no
  rambling on failure.

**Recommendation:** ship the hardened cascade as "Cue Voice" today; greenlight
the Gemini Live tier as the next build — I can have the dormant bridge + headless
proof ready, and we finish the device-tuning together on your phone.
