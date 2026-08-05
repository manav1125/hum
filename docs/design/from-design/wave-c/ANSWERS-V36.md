# Cue — v36 answers to code (2026-08-05)

Response to `BRIEF-2026-08-05-v35-built.md`. One file: **cue-design-answers-v36.html** (the rendered HTML is the spec — inspect inline styles for exact values).

## Your five findings — all accepted
Finding 2 especially: the four live bugs the rename surfaced are the whole argument for having asked, and the inverted names (`--mv3-violet-on-fill` holding a background) were exactly the failure the convention predicted.

---

## T1 · The three thinking states (your finding 1) — drawn
Same ring, three captions. **The distinction is carried by the orbiting dot, not just the words:**
- **Named** — "Checking the pricing model…" · ring pulses, dot orbits
- **Unnamed** — "Using a tool…" · **identical motion** — a tool genuinely started, so the orbit still runs; the phrase is merely missing
- **Silent** — "Thinking…" · **no orbit** — no tool claim is being made

That way "Using a tool…" reads as *true but unnamed* rather than *vague*, and a missing phrase is visibly different from a missing signal.

**Standing rule:** a tool's thinking-state phrase is part of its definition of done. State 2 is what every new tool looks like on ship day — it's also the reminder to write the copy.

## G1 · Mobile Guardrails (your B) — reduced band
The stop selector + two link-out rows:
```
REACHING YOU
[ ● Needs you ▾ ]                     ← same control, same daemon state
"Filtered items stay in Work…"
◎ 2 missions override this   View ›   ← pushed screen, not inline list
✕ What the ✕ has taught          ›    ← pushed screen
```
The overrides list and taught-senders detail are **pushed screens on the phone** — no scrolling table inside a rules page. The fail-open sentence lives on the stop selector's own sheet.

## G2 · The ✕-taught row (your C) — yes, three states
- **TAUGHT** — "The ✕ has quieted **34 senders** so far…"
- **NOTHING YET** — "Nothing taught yet — dismiss anything with ✕ and Cue learns what to quiet." (a fact about the **account**)
- **COULDN'T READ** (amber) — "I couldn't read what the ✕ has taught just now — **the filter itself is still working.** Try again ›" (a fact about the **query**)

Requires `learnedDownSenders()` to surface errors rather than swallowing them into an empty array.

**Standing rule:** "nothing yet" and "couldn't read" are never the same sentence — every learned/accumulated surface needs both.

---

## Rulings on the findings

**Finding 2 · Two grounds get two named stops. Adopted:**
- `--muted-on-paper: #6B6B60` — warm `#F4F3EF`/`#E8E6E0` family (HQ desktop)
- `--muted-on-canvas: #5A6672` — cool `#F2F3F7` family (mobile)
- `--muted-on-dark: #9A9AA8` — unchanged

Plus the lint your inverted-name bugs argue for: **`-on-` tokens may appear only in `color:`/`fill`/`stroke`, never `background`.** A test can hold a bug more firmly than no test — and a lint can hold the convention more firmly than a review.

**Finding 3 · `learnedDownSenders` is the right number.** Report what the rules actually quiet, not what's been clicked — anything else overstates the person's achievement. Zero-in-words is right.

**Finding 4 · `moving` accepted into the spec.** Nine live runs and a week of silence drawing the same tick was a real defect in my three-state model. V3 amended to four states: on-track ✓ · **moving (blue segment + live bars)** · blocked ◼ + cycle count · parked ○. Constant test-pinned arc lengths per state — geometry must never be readable as progress.

**Finding 5 · Derived label accepted.** Reading the label from the response bound (never the request) is the honest-numbers rule made structural; the 55% overstatement it prevented is the argument.

## The four open items

**A · Cue's 🎙 turns — filed is correct.** Ordinary assistant bubbles lose nothing today. One addition when the plumbing lands: a quiet **"🎙 voice call · 4:12" divider** above the transcript run, so calls are findable even before Cue's turns carry the marker.

**B · answered above (G1).**

**C · answered above (G2).**

**D · The six confirmations — the list is lost on both sides.** It originated in your build report; neither of us retained it, and I won't guess. **Ruling: the class is closed.** Anything from it that still matters will resurface as a concrete build question against a specific frame — raise those individually and they get same-pass answers. No standing debt.
