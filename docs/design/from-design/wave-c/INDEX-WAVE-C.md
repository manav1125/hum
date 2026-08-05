# Cue — Wave C design package (INDEX) · 2026-08-05

Everything code needs from design for the current wave, in one folder. Three rounds of answers built on the HQ redesign that anchors them. **Read in this order; build in the order each doc states.**

## Read order
1. **README.md** — the HQ redesign (the volume valve + one-surface/two-density HQ). The structural decision the rest sits on.
2. **ANSWERS-V35.md** + `cue-design-answers-v35.html` — voice room, valve control's three homes, status-only rings.
3. **ANSWERS-V36.md** + `cue-design-answers-v36.html` — the three thinking states, mobile Guardrails, the ✕-taught states, four rulings.
4. **ANSWERS-V37.md** + `cue-design-answers-v37.html` — **the voice surface system in full** (state ladder, reveal, approval), memory import, four polish rulings, and the **v37.1 reconciliation** against upstream's reference pack.

## Build order (gating first)
- **Ship now, unblocks the most:** the HQ **volume valve** (README §1) — no HQ layout survives without it.
- **Before the voice re-platform:** the whole voice system (V37 §1 + v37.1). Every number/threshold it needs is now specified; nothing here waits on the port.
- **Paste-ready today:** the spoken-copy pass (V37 W3 + the escalation-bridge phrase in v37.1) — ships flag-off, no dependency.
- **Thin layer over landed importers:** memory import (V37 §2).
- **Polish on shipped features, any order:** bookmarks → conversations · system cards · decided approvals · Cue rebrand of skill copy.

## The invariants every frame here obeys (the spine, restated for code)
1. **Never fake a number.** A pending value is an em-dash with a pulse, never a confident zero; every accumulated surface carries both a "nothing yet" (account) and a "couldn't read" (query) state.
2. **The valve fails open, and the UI says so.** If Cue can't score something it treats it as urgent — so turning the valve down makes Cue louder, not quieter, and no frame shows "filtered" as an empty state.
3. **One surface visible at a time** (voice ladder) and **one HQ breathing** (Glance↔Deck) — detail is gained, never a second page.
4. **The mark is the state.** Cue's avatar is the open ring across every surface — listening breathes, thinking orbits, speaking waveforms. No eyes, no face.
5. **The daemon states facts and never says "I".** That pronoun is Cue's; system cards are quiet, centered, first-person-less.
6. **Muted tokens are named for ground and role** — `--muted-on-paper #6B6B60` · `--muted-on-canvas #5A6672` · `--muted-on-dark #9A9AA8`; fills carrying white text take text variants; `-on-` tokens never appear in `background`.

## Open threads — carried to the next round, not blocking
- **The six mobile confirmations (v36 D)** — list lost on both sides; class closed. Anything still live resurfaces as a concrete per-frame question and gets a same-pass answer. No standing debt.
- **Title-bar pill, bookmarks page, concept graph** — no upstream stories existed; covered here by behaviour spec (V37) rather than a captured reference. Worth a screenshot pass once code has them running, to confirm the drawn behaviour survived contact.
- **Images elicit-set** (from the create rounds) — 4 templates, 0 elicit sets; still open whether the prompts carry enough or it needs a chip set like Video.
- **Post-alpha, explicitly parked:** iPad layout, Watch, home-screen widget, memory-graph overhaul, unified skills+plugins view (v21's "who works for you" group is where the last one would live if it returns).

## Where this leaves the surface map
v21 remains the IA of record: five sidebar rows (Talk to Cue · HQ · Work — People · Library) + **Your Cue** as the one config shell (18 leaves, 5 groups). Nothing in Wave C changes that; the voice ladder, memory import and bookmarks all slot into surfaces it already names.
