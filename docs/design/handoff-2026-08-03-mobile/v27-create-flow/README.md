# v27 — Create, the full flow (2026-08-03) · supersedes v26

All four directions from the options canvas, sequenced so each does its actual job.

## The routing rule
```
1a  tap a type      ──→  1c gallery for that type  ──→  J3 fill
1a  tap a suggestion ─────────────────────────────→  J3 fill  (template known)
1a  type or speak   ──→  1d stream  ──→  asks only what's missing
1a  "not sure"      ──→  1b five questions  ──→  1c
```
- **1a is always the entry** — one door to learn.
- **1c is scoped, never global.** You arrive filtered to Slides or Docs; type chips let you switch without going back.
- **1d triggers on free text**, typed or spoken. If Cue infers the type it skips 1c.
- **1b is a rescue, not a step** — reached from "not sure what you need", never forced.

## The surfaces
- **J1 Entry** — 1a plus one line at the bottom: *"Not sure what you need? Talk it through ›"*
- **J2 Scoped gallery** — 1c arriving pre-filtered, with **"Blank deck" in the grid**, not below it.
- **J3 Fill** — **the 8-field form becomes 2 questions.** Cue states the 6 it knows as a checkable block, asks the rest. Same completeness, a fifth of the typing.
- **J4 Building** — slides appear **as they're made** (real thumbnails, filled and dashed), narrated current step, live composer for mid-build redirects, and *"You can leave — I'll put it in this thread."*
- **J5 Done** — artefact card with a real cover, **says where it filed**, remix chips, then **one adjacent offer** from what Cue touched while working.
- **J6 Not sure** — reframed from 1b: the question is **"what's it for?"** not "what kind of file?", because someone unsure doesn't know the format either. Two steps → drops into 1c filtered.

## Rules for code
1. **Fill is always 1d-shaped.** Never render 8 empty fields. If Cue knows everything, skip J3 and build.
2. **Building is narrated and non-blocking.** Anything over 30s must survive backgrounding.
3. **Every artefact card says where it filed** — that line is why Create lives in Cue.
4. **One adjacent offer**, only from what it touched. Two is nagging; unrelated is creepy.
5. **Remix chips are type-specific** — Slides: shorter / different look / add a slide · Docs: tone / length / restructure · Images: restyle / variations / upscale.
6. **Blank is first-class everywhere** — in the grid, not below it.

## Still needed from code, per type
Field list and kinds · which fields pre-fill from memory or connected sources · whether a style step comes before or after the fields · what Preview renders · whether App Builder is a type or a mode on Docs.
