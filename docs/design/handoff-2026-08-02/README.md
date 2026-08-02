# Cue — Complete Design Handoff
**Date:** 2026-08-02 · **From:** design · **For:** Claude Code

> ## → **Start with `BRIEF-FOR-CODE.md`**
> It covers everything designed since your six questions (packs v9–v12): the answers, the navigation rework, the vocabulary changes, the two naming collisions we fixed, and the four gaps that matter most — with build order, schema delta, invariants and precedence.
> Then `INDEX.html` for the coverage matrix, and `01-work-surfaces/WORK-SURFACES.md` for the full spec.

---

## What this package is

Every design deliverable produced for Cue's product surfaces, organised **by surface rather than by date**, with a single stated build target per surface. Every HTML file is self-contained — open at full width. **The rendered HTML is the spec**: inspect inline styles for exact values rather than eyeballing.

```
cue-design-handoff/
├── README.md                          ← this file
├── 01-work-surfaces/                  ← HQ, missions, All work, task detail, triage
│   ├── WORK-SURFACES.md               ← THE DEEP SPEC (24 sections)
│   ├── ADDENDUM/                      ← 4 decisions back to engineering (Aug 1) — read with the spec
│   ├── canonical/cue-canonical.html   ← THE BUILD TARGET for HQ + mobile Today
│   └── packs/v2 … v12/                ← rationale, one folder per round
│         v7  volume + first screen — three tiers, composer landing
│         v8  mobile + web
│         v9  the six answers + tab bar
│         v10 HQ vs Work, detail screen, domain classifier
│         v11 consistency pass — vocabulary, desktop sidebar, day one
│         v12 the partner — conversation surface, voice, welcome back
├── 02-hq-filing/                      ← batch add · auto-file provenance · dismiss
├── 03-discovery-live-plugins/         ← capability discovery · Cue Live clarity · plugin model
├── 04-parity-plus/                    ← macOS overlay · web control panel · mobile parity
├── 05-mobile-native/                  ← the full iOS spec (v3, 52 frames + round 4, 12 more)
├── 06-signon/                         ← first-touch sign-on experience
└── 07-autonomy-states/                ← the autonomy/trust state taxonomy
```

---

## Read order for implementation

| # | Read | Why |
|---|---|---|
| 1 | `01-work-surfaces/WORK-SURFACES.md` + `ADDENDUM/` | The information model, vocabulary, the eight verbs, invariants, schema delta, build order. **Everything else assumes it.** The addendum resolves four open questions: accent-text tokens, the pre-watcher interim state, Rhythms vs Schedules, and the two ledgers. |
| 2 | `01-work-surfaces/canonical/cue-canonical.html` | The one HQ and one mobile Today to build. |
| 3 | `07-autonomy-states/` | The trust taxonomy the whole product references. |
| 4 | `02` → `03` → `04` | Surface-specific behaviour, each with its own README. |
| 5 | `05-mobile-native/` | iOS grammar and the 64-frame inventory. |
| 6 | `06-signon/` | First touch. |

---

## Precedence — no ambiguity

1. **`01-work-surfaces/canonical/cue-canonical.html` wins** for HQ desktop and mobile Today. If any pack disagrees with it, canonical is right.
2. **The packs own every other surface** — mission detail, task detail, triage, the ledger, rhythms, search, batching, the weekly review, day one, corrections, interruption policy, multiplayer, reasoning, data/exit, bulk recovery.
3. **Canonical's K3 block lists additive deltas** for pack frames that predate hand-off and reasoning. Apply those; don't redraw.
4. **v1 of work surfaces is deliberately absent** — it followed a framing we corrected (it led with emptiness).
5. Within mobile, **round 4 supersedes v3** where they overlap; v3 remains the base grammar.

---

## The two ideas everything else follows from

**1 · Lead with what Cue delivered, not what it needs.**
A headline of "3 things need you" makes Cue feel like another inbox. Every competitor opens with your obligations; ours opens with our receipts. Order on every surface that shows both: **delivered → needs you → in motion → came in.**

**2 · Work groups by why. Life groups by when.**
Work ladders up to missions (`◎ Mission → ▣ Project → ▤ Work`). Personal life doesn't have missions — it has horizons (This week / Soon / Someday). **Life is a lens, not a level:** same engine, different spine, marked by `⌂` and a warm ground, no new accent colour. Privacy falls out free.

---

## Non-negotiables (full list in WORK-SURFACES.md §21, §24)

- No raw enum ever reaches a user (`awaiting_review` → "Needs you").
- The **capture bar is fixed furniture** on HQ — ring mark + input + `⌘K` + mic. It was accidentally dropped twice; treat it as structural.
- **The deck never grows.** Needs-you caps at 3 with "N of M"; volume moves the census bar only.
- **Never a fake number** — a ring with no computable metric shows `✓` / `!` / `◼`.
- **A no-op is not a success** — jobs that ran with nothing to read render amber with a "Why?".
- **Archive never deletes**, and "done elsewhere" never credits Cue.
- **Cue reports its own errors first** — verbatim, first person, with a fix and a self-narrowed leash. Red is reserved for this.
- **No colour-only state.** Every state carries a glyph: `‖ ◱ ✓ ↴ ◼ ○ ✨ ⧉`.
- Muted text tokens: light `#6B6B60`, dark `#9A9AA8`. Lighter greys are grounds, never text.

---

## The Cue mark

Open ring — `circle r=150 cx=232 cy=256`, `stroke-dasharray="707 236"`, `rotate(42)`, plus a blue dot at `cx=392 cy=372`. **Never a closed circle, never a letter C.** It is the product's heartbeat: capture bar, sidebar, mobile tab bar, Dynamic Island, voice mic.

## Type & colour

Instrument Serif (display) · DM Sans (body/UI) · DM Mono (microlabels, counts, keyboard chips). Mobile uses **SF Pro** with iOS large-title physics.
Desktop light `#F4F3EF` / card `#fff` / ink `#1A2230` · desktop dark `#15161B` / card `#1E2027` · mobile `#0A0C12` with glass over aurora · accent `#3D6EE8` (theme-invariant).

---

## Suggested build order

1. **Reorder HQ** — delivered-first + capture bar + the queryable stat row. **No backend.** Shippable this week.
2. **Honest empty states** — especially *"Cue can see your inbox — but it isn't watching it."* No backend.
3. **Auto-provision watchers on connector connect** — also gives missions a heartbeat and fills People for free.
4. **Mission altitude** — rings on HQ + mission detail. No schema change. This is the demo screen.
5. **The eight verbs + triage + ledger navigation** — makes volume survivable.
6. **Hand-off** — the only verb that makes the deck shorter.
7. **Trust surfaced everywhere** — tier chips tappable, act ledger reachable, spend on the deck.
8. **Day rail, waiting/chase, conditional Later.**
9. **Rhythms, search, batching, weekly review.**
10. **Corrections, interruption budget, a11y sweep, data/exit.**

Steps 1–2 need no backend at all and are the highest-value change available today: the product already delivers value it isn't claiming.
