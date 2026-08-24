# Always-on companion — brief for design

**Date:** 2026-08-24 · **From:** Manav · **Decision status:** direction locked, screens open

---

## What I'm asking for

**Design the always-on Cue companion, end to end, as a finished set of screens.**

Not a variant of the floating corner we spec'd in the Notes & floating-corner pack — a
different product decision, made deliberately. I want the creature that lives on the
desktop.

Read this brief, then `01-UPSTREAM-OVERVIEW.md`, then the real upstream source in
`upstream-source/` alongside it. The overview is a reading of that code, not a summary of a
summary — everything in it is checkable against the files sitting next to it.

## Why — the decision, and what changed

We spec'd and part-built a **summoned corner**: one exchange on `⌥C`, then finished. It is a
coherent product. It is not the one I want.

Upstream (vellum-assistant) went the other way and shipped an **always-on companion to
everyone** on 2026-08-20 — they deleted the feature flag entirely; a tray preference is now
the only thing that decides whether it appears. In the ten days to 2026-08-24 they also
found and fixed five distinct bugs in it, three of which ended with the floating window
**eating clicks meant for other applications**.

That matters for two reasons:

1. **They have done ~6× the work** — 3,438 lines against our 580 — and, more valuably, ten
   days of finding out how a floating always-on-top surface actually fails.
2. **Every one of those five bugs is a property of the class, not of their design.** Any
   always-on surface we draw will have the same five problems available to it.

So: I want us on the always-on side, and I want us to start from what they learned rather
than rediscover it.

### What this decision retires

**The floating corner as a separate surface.** Whether the `⌥C` summon survives *inside* the
companion is an open question for you (Q1 in the overview) — but we are not maintaining two
floating surfaces.

Engineering note: our code currently contains the opposite rule —
`isCompanionEnabled()` returns `false` whenever the corner is on. That is being inverted as
part of this decision.

### What this decision does **not** retire

- **Notes**, in full. The Notes & floating-corner pack's Notes half (`01a`, `01b`, `N1–N5`,
  `R1–R6`, `S1–S6`) stands and is being built to those screens now.
- **Our product rules.** Nothing files without acceptance; "nothing to file" is never the
  same sentence as "I couldn't read it"; confidence is drawn, never a percentage; a summary
  always says it is one. These are ours, upstream has no equivalent, and they hold whatever
  the surface is.
- **The consent line.** A live green dot, "Reading this window only, while it's open", and a
  Stop — in the product, every time. Upstream's ring says *that* a capture is running; ours
  says *what it can and cannot see*. I want both.

## What I need back

A complete screen set for the always-on companion, at the same fidelity as the Notes pack:
every phase, every transition, the introduction, the menu, and the states where it is
wrong or waiting.

The five questions at the end of the overview are the ones I think are genuinely open. Q2 —
**what is Cue's creature?** — is the biggest. Upstream's is a composed mascot with traits
(body shape, eye style, colour) that blinks and breathes. Ours is a wordmark. An always-on
surface is a *presence*, and a presence needs a character.

## What's in this folder

| File | What it is |
|---|---|
| `00-BRIEF.md` | This. The ask, the decision, the reasoning. |
| `01-UPSTREAM-OVERVIEW.md` | What upstream built, what it cost them, what we keep, what's open. |
| `upstream-source/` | The actual upstream code the overview is read from. |

### Reading the source

Nothing in `upstream-source/` is ours and none of it has been merged — it is reference. It
is unusually worth reading directly because upstream document their *reasoning* in the code,
not just the behaviour. The header comment of `companion-surface.tsx` is the single most
useful thing in the folder.

| File | Lines | Read it for |
|---|---|---|
| `companion-surface.tsx` | 1,640 | The surface itself: phases, geometry, why solid not glass |
| `companion-window.ts` | 1,249 | Placement, sizing, hit-testing, the tray menu, the introduction |
| `ipc-contract-companion-types.ts` | 401 | Sizes, intro beats, the cross-process geometry constant |
| `use-companion-mirror.ts` | 265 | How the conversation reaches the surface |
| `companion-intro.tsx` | 284 | The four-beat first-run |
| `companion-surface.ts` | 226 | Link handling out of the surface |

Provenance: `upstream/main` at `0b02d016`, 2026-08-24.
