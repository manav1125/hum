# Cue — the always-on companion · design handoff

**Date:** 2026-08-24 · **For:** code · **Answers:** `00-BRIEF.md` + the five questions in `01-UPSTREAM-OVERVIEW.md`

Two files: this README and `cue-companion.html` (self-contained; **the rendered HTML is the spec** — inspect inline styles for exact values). Frames C1–C12. Per your own process rule: **render every frame and state your read before writing code.**

---

## The five questions, ruled

- **Q1 · The summon survives, inside the companion.** `⌥␣` opens the typing card where the creature sits; holding it starts talk; summoning with text selected opens the card already quoting it. The corner retires as a surface; its rules (one exchange, sourced answers, local Undo, selection quoted, never a thread) migrate onto the typing card.
- **Q2 · The creature is the ring, alive** (C1). The satellite dot expresses **whose turn it is** — seated = waiting on you, travelling = working. The blink is the arc closing (90ms/110ms, never while working); the gaze is the dot rolling toward the pointer — the one personality gesture. Traits: accent · ring weight · blink rate, composed live.
- **Q3 · Solid, not glass.** Upstream paid for the finding (vibrancy fills the oversized canvas; backdrop-filter can't sample the desktop). Body `#101321`, hairline `rgba(255,255,255,.13)`, identity carried by the creature and its glow. UX-INTENT's purple glass applied to the retired corner.
- **Q4 · The companion carries Notes capture, as capture only.** Hold-to-talk + `⌘↵` keep-as-note, "New note here" in the menu. The full recording session stays a Notes surface; the companion mirrors it (C11) and never becomes the editor.
- **Q5 · Watching keeps our sharper line.** One window, once, while it's on — our consent line (green dot · "Reading this window only, while it's open" · Stop) rendered the whole time, inside upstream's amber `#FF9F45` ring. Cue Live stays a separate continuous session; when either runs, creature ring and menu-bar tint agree — one fact, two surfaces.

## Frame index

| Frame | What it settles |
|---|---|
| C1 | Creature anatomy: rest, gaze, working orbit, listening breathe |
| C2 | Seven phases + precedence (typing/call > watching > summary > hover); call reuses the v37 voice ladder — no second voice surface; connecting/ending render as idle |
| C3 | Geometry: fixed avatar x, cross-process near-edge constant (44/2+24), grows away from edges, 5 named sizes (medium default), asymmetric canvas · solid-not-glass ruling · the five-bugs engineering notes |
| C4 | Four-beat introduction (meet/talk/type/menu), Next + Dismiss only |
| C5 | Right-click menu — hide never buried, "Read this window" asked on second use, character traits, quiet hours |
| C6 | Couldn't-read (question kept) · waiting-on-okay (raises app, badges ‖) · offline (dims to slate, notes still save) |
| C7 | **The nudge** — Cue moves first: one line + Open + ✕, never buttons that act; ~8s auto-retract; ignored → held dot-glint replayed on hover; shares the push budget (replaces, never doubles); never while typing/quiet hours/twice |
| C8 | Motion spec (240/180/280/320ms, width-only, text fades, Reduced Motion → 80ms fades) · parking (edges only, 200ms settle, per-display memory) · one creature, never chases focus, **never over fullscreen** · quiet hours visible |
| C9 | First approval — the one-time longer sentence: "the companion talks; only the app acts" |
| C10 | Drop targets — the arc's mouth is the slot; caught chip names what arrived; read/file/note only; unanswered drops let go unkept |
| C11 | Recording mirror (red reserved for it; Stop stops the real session; can't hide while live) · menu-bar icon's four states, menu carries Stop |
| C12 | Keyboard/VoiceOver (⌥␣ family; turn-change announcements only; ≥44pt targets) · the 5-sizes × phases QA matrix; type caps at large, stroke scales at half rate |

## Build order

1. **The window discipline first** — `setIgnoreMouseEvents(true,{forward:true})` from day one; hover is a phase main publishes; drags end on global mouse-up; `draggable={false}` **and** `-webkit-user-drag:none` on every image; hit-test recompute on any card removal. The five upstream bugs are properties of the class — build against them before drawing anything.
2. **C2 phases on the fixed-point geometry (C3)** — resting/hover/typing first, then listening/working.
3. **C6 wrong-and-waiting + C9** — the approval raise is the live candidate for the dropped-approval bug; wire it early.
4. **C4 intro + C5 menu + C11 menu-bar icon.**
5. **C7 nudge** — after the valve wiring, since it consumes the same budget.
6. **C10 drops, C12 access pass, QA matrix sweep.**

## Invariants (the ones that don't move)

Nothing files without acceptance · "nothing to file" ≠ "I couldn't read it" · confidence drawn, never a percentage · a summary says it is one · the mic never outlives your finger · approvals raise the app window; the companion badges until answered · **the companion talks, only the app acts** (no send/spend from any companion surface) · **the companion is silent, always** — sound belongs to calls alone.

## Tokens

Muted-on-ground set per the standing rule (`--muted-on-dark #9A9AA8` on companion surfaces). New reserved values: **watching ring `#FF9F45`** (agrees with the host capture tint, deliberately not our accent) · **recording `#E5675B`** (reserved for the recording phase alone). `-on-` tokens never in `background`.
