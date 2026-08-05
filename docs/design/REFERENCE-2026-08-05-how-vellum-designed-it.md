# Reference — how Vellum designed it (companion to BRIEF-2026-08-05)

Internal reference only: distilled from upstream (vellum-assistant) source at `f68e27b9dd`
(2026-08-03) and their public materials. This is color for our own design work, not a spec
to copy. Screenshots (if capture succeeded) live in `reference/vellum/`; this doc covers
**behavior** — states, transitions, timings, and exact copy — which reads out of code more
reliably than pixels.

Public materials worth a skim first:
- Voice architecture blog: https://www.vellum.ai/blog/vellum-assistant-ai-speech-pipeline-explained
- Their releases page (tone reference for how they narrate features): https://www.vellum.ai/docs/releases

---

## 1 · The voice surface system (brief item 1)

### The one-surface invariant
Exactly one voice surface is visible at any time, from a three-state ladder:

1. **Voice room** — full-screen-ish, inset into the content area (not a modal): animated
   eyes, a "Listening" indicator, centred session controls (mute-assistant, end). Room and
   bar animations are driven by *real audio levels*, not synthetic pulses. Entered from a
   mic button in the composer.
2. **Minimized bar** — when the room gives way to content: a painted block that *takes over
   the chat input row* but leaves a usable chat input above it ("minimized voice bar sits
   above a usable chat input" was an explicit late fix — the bar must never cost you
   typing). Edge-to-edge pill row of controls on touch.
3. **Title-bar pill** — when you navigate away from the conversation entirely, the call
   "rides the header as a painted pill" so the session is never invisible.

Mobile: the room is a **bottom sheet under the header** (not full-screen takeover), and it
"slides up already wearing its avatar" — the avatar is pre-warmed so the sheet never opens
with a placeholder.

### Mid-call surface reveal (their most opinionated interaction)
When the assistant opens a UI surface (chart, doc, app) during a call:
- The reveal is **deterministic and polite**: the room minimizes only after the turn's
  speech has fully drained — never mid-sentence, never for a barged-in turn.
- The trigger is a *successful* surface-showing tool result (an error never minimizes the
  room "to reveal nothing"); a dismissal clears the pending reveal; last write wins.
- The model is prompted to speak *as though the thing is already on screen* ("here's the
  chart — the trend is…"), because by the time speech ends, it is.

### Mid-call approvals
When a sensitive action needs a decision during a call:
- The room minimizes **immediately** (no waiting for speech — a blocked turn has no speech
  left) to reveal the approval card.
- The assistant speaks one **fixed** phrase, never generated:
  > "I need your okay for that one. Take a look."
- Progress narration is suppressed for the whole wait. Unanswered after **45 s**, the call
  falls back to the pre-existing behavior (guardian auto-allow) rather than hanging.
- Phone calls (no screen) never prompt — only screen-bearing surfaces do.

### Spoken fillers (brief item 1, copy pass — needed now)
Three kinds of assistant speech that are *not* the answer:
- **Escalation bridge**: when a harder question is handed to the big model, the fast model
  speaks a one-sentence holding phrase (its own words, capped at the first sentence
  terminator / 140 chars). Canned fallback if generation fails:
  > "Let me think about that for a second."
  The main model is told the exact phrase spoken so it never re-announces.
- **Slow-start / tool acks**: if first audio hasn't arrived within **2.5 s**, or a tool run
  starts, a short generated ack plays (≤120 chars, generation budget 600 ms, silence on
  failure). One ack per turn.
- **Progress narration**: during long tool work, narrations follow **the work, not the
  clock** — triggered by ≥3 tool operations since the last narration, a single ≥15 s
  operation, or ≥35 s of audible silence; suppressed within 6 s of any other speech and
  entirely while awaiting approval. Example register: "Searched the web, reading through it
  now." Narrations are **audio-only** — they never appear in the transcript.
- Latency norms their design tolerates: ~1.2 s of trailing silence ends your turn; barge-in
  needs ~¼ s of sustained speech (so brief noises don't cut the assistant off).

### iOS Live Activity / Dynamic Island content rules
- ContentState is tiny: `phase` (listening / thinking / speaking / …), a one-line `label`,
  optional `detail` activity line, accent color, muted flag; attributes: assistant name,
  start time, avatar.
- The **activity line** is composed daemon-side, present-participle, and deliberately
  redacted for the Lock Screen: *no tool names, no arguments* — "reading your calendar",
  never "gmail_search(q=…)".
- **The server never invents wording**: the client registers the full phase→label lexicon
  at session start, and server pushes only select from it. (Good pattern for us: copy
  decisions stay in one place, owned by the client/brand.)
- Entry points they ship: Siri phrase ("Talk to …" → resume), Action Button and Control
  Center (new conversation), deep links `<scheme>://voice?mode=new|resume`.
- Android equivalent: a notification-channel status surface + Quick Settings tile.

## 2 · Memory import (brief item 2)
Upstream has **no import UX** — their ChatGPT/foreign-assistant importers are CLI + skill
only, exactly where Wave C lands us. Design is genuinely greenfield here; nothing to crib.
The one upstream idea worth keeping: imported pages carry `source` + `origin_date`
provenance in the data model, so a "imported from ChatGPT" treatment is possible if design
wants it surfaced.

## 3 · Bookmarks (brief item 3)
Upstream: bookmark any message from the hover overflow; the list lives **in the sidebar**
(not settings) as a lightweight index; one bookmark per message (toggling is idempotent).
Ours shipped as a Settings leaf for macOS parity. Their placement signals "bookmarks are a
navigation feature, not a preference" — a fair challenge to our current home.

## 4 · System cards (brief item 4)
Upstream converged on a distinct `system_card` message kind for daemon-authored results
(summarize/compact outcomes): visually quieter than assistant messages, no avatar voice,
with the LLM-call inspector attributing the work to the card rather than a phantom
assistant turn. Their earlier iterations (which we currently match) reused the canned
assistant-message pattern — they moved away from it because system results reading as
"the assistant said" muddied the voice. Copy register on those cards: terse, factual,
first-person-less ("Summarized 34 messages · 12.4k → 1.1k tokens").

## 5 · Decided approval cards (brief item 5)
Upstream invariants worth adopting:
- A resolved card **never shows live buttons again** — any surface, any origin, including
  after reload.
- The card's content is preserved for audit (buttons removed, text kept), with a status
  word appended: wording comes from **one shared source** across surfaces; only glyphs are
  per-surface.
- On channels that can't edit history (their Telegram), a silent quoted reply records the
  outcome instead — but only when the deciding flow didn't already answer the guardian in
  that chat (no double-speak).
- Cards deep-link to the message that *triggered* the request ("View message"), stamped at
  ingress so it's exact even under concurrency.

## 6 · Skills copy (brief item 6)
No upstream reference needed — this is purely our rebrand-boundary decision. For calibration:
upstream's own skill copy naturally says "Vellum" everywhere; our convention has kept those
strings verbatim. The sweep, if chosen, touches display prose only.
