# Claude Design brief — Cue Live voice surface (elevation pass)

**Status:** the voice surface is already **built and functional** (shipped behind the `voice-mode` flag, now enabled on prod `manav.justcue.app`). This is **not a from-scratch brief** — it is a request to *elevate an existing, working surface* to a premium, demo-grade "Cue Live" experience. Do not redesign the plumbing; redesign the feel.

Brain runs on Gemini 2.5 Flash; voice on ElevenLabs; STT on Deepgram. All live and verified.

---

## 1. What exists today (design against this, don't reinvent)

- **Entry:** a mic button in the chat composer (`EnterVoiceModeButton`). Tapping it opens a **full-bleed ink overlay** over the current conversation (`InChatVoiceOverlay` → `VoiceModeSurface`), bound to the same thread, and auto-starts a session. `Esc` or "Done" returns to typing.
- **The surface** (`apps/web/src/domains/chat/voice/voice-mode-surface.tsx`, ~677 lines):
  - Full-bleed **ink panel** with a centered **`VoiceOrb`** (design-library component).
  - **Live transcript**: the user's in-flight partial transcript, their finalized utterance, and Cue's streaming reply text.
  - **Status caption**: "● listening" / "thinking…" / "speaking".
  - **Controls**: tap-orb to start/stop, **Mute/unmute**, **Done** (keyboard icon → back to text), a **voice/provider selector**, and a permission-denied state.
- **The orb** (`packages/design-library/src/components/voice-orb.tsx`): 4 visual states, `motion-reduce` aware, token-driven colors:
  - `idle` — calm, dim core
  - `listening` — expanding rings + violet equalizer (user speaking)
  - `thinking` — core pulses, no rings/bars
  - `speaking` — expanding rings (Cue speaking)

**The engine exposes these signals — the redesign may use any of them:**

| Signal | Meaning |
|---|---|
| `state` | `idle · connecting · listening · transcribing · thinking · speaking · ending · failed` |
| `inputAmplitude` | smoothed RMS mic level `[0,1]` — already drives orb reactivity + barge-in |
| `partialTranscript` | user's in-flight utterance (interim STT) |
| `finalTranscript` | user's last finalized utterance |
| `assistantText` (streaming) | Cue's reply text, arriving as deltas |
| `error` | human-readable failure (e.g. mic permission denied) |

---

## 2. The design system (match Cue, don't invent a new language)

From the Cue design book / `design/surfaces/CueLive.dc.html`:

- **Type:** `DM Sans` (UI), `DM Mono` (labels/metadata/keycaps, uppercase + letter-spacing), `Instrument Serif` (occasional editorial accents).
- **Color:** ink `#1A2230`, canvas `#F4F6F9`, Cue blue `#3D6EE8`, take-control violet `#534AB7`, hairline `#E5E9F0`, muted text `#5A6672`/`#8D99A5`, danger `#DA491A`.
- **Shape/feel:** generous radii (12–14px cards, 999px pills), soft deep shadows, calm, confident, "a presence" — not a phone dialer. The brand mark is the **eye/iris** (see the animated `cueLook`/`cueBlink` keyframes in `CueLive.dc.html`) — the orb should feel related to that identity.
- Tokens are CSS-variable driven; keep everything themeable (light + dark/ink).

---

## 3. What to elevate (the actual ask)

The surface works; it doesn't yet feel *premium* or *alive*. Priorities:

1. **The orb as the emotional center.** Today it's competent (rings + equalizer). Make it *expressive and unmistakably Cue* — its resting state, how it "leans in" when listening (drive off `inputAmplitude`), how thinking reads as genuine cognition (not a spinner), how speaking pulses in time with output. Tie it to the eye/iris identity. This is the single most important deliverable.
2. **State legibility without clutter.** A first-time user must always know: *is it hearing me, thinking, or talking?* — from the orb alone, caption second. Design all 8 states incl. the transitional ones (`connecting`, `transcribing`, `ending`).
3. **Transcript as ambient, not a chat log.** The partial→final user text and Cue's streaming reply should feel like a calm caption layer, not a competing message thread. Decide hierarchy: orb-primary, transcript-secondary.
4. **Full-duplex affordances (near-term).** We will enable continuous/barge-in mode next. Design the **"you can interrupt me" cue** — how the orb/caption shows Cue is listening *while* speaking, and what barge-in feels like (user starts talking → Cue yields). Half-duplex (push-to-talk) and full-duplex should share one visual language.
5. **Controls & exits.** Mute, Done/return-to-text, voice picker, and a clear **End** — quiet by default, obvious when sought. Respect "Stop always wins" from the Cue trust model.
6. **Failure & permission states.** Mic denied, connection lost/reconnecting, no-speech-detected — designed, calm, recoverable. Not a red error dump.
7. **Responsive.** Desktop overlay **and** a mobile-first full-screen (390px) treatment. Mobile is likely the primary voice context.
8. **Empty/first-run.** The first time someone opens voice: a one-line "Say something to Cue" invitation, then get out of the way.

**Explicit non-goals:** don't touch the `CueLive.dc.html` *control panel* (that's the desktop-presence config surface, separate). Don't design new session mechanics or settings. Don't add a message composer inside the voice surface.

---

## 4. Deliverables

- The orb in all states, incl. motion specs (and `motion-reduce` fallbacks).
- Full voice surface: desktop overlay + mobile full-screen, all 8 states + mute/error/permission/first-run.
- The full-duplex "interruptible" visual language.
- Redlines/tokens mapping to the existing CSS variables so implementation is a re-skin of `VoiceModeSurface` + `VoiceOrb`, not a rebuild.

## 5. How to evaluate / open questions for the designer

- Should voice remain a **modal overlay over chat**, or also become a **dedicated destination**? (Both entry points are plausible; recommend one.)
- How much transcript to show — full rolling captions vs. last exchange only?
- Orb identity: literal iris/eye, or abstract presence that echoes it?

**Reference the live thing first:** open `manav.justcue.app`, tap the composer mic, and experience the current surface before redesigning — the brief above describes exactly what you'll see.
