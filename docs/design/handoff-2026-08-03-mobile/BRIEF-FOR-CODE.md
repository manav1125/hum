# Cue Mobile — Final Handoff for Code

**Date:** 2026-08-03 · **From:** design · **Status:** signed off, ready to build

This is the complete mobile spec. Every HTML file is self-contained — open at full width. **The rendered HTML is the spec**: inspect inline styles for exact values rather than eyeballing.

```
cue-mobile-final/
├── BRIEF-FOR-CODE.md            ← this file, read first
├── v22-mobile-refresh/          ← native iOS foundation, the three-tab model
├── v23-mobile-complete/         ← the remaining core surfaces
├── v24-mobile-final/            ← Library sheet, ⓶ screen, weekly, person, watching, memory
├── v25-chat-modes/              ← chat + create + voice + THE KEYBOARD SPEC
├── v27-create-flow/             ← Create end to end (entry → gallery → fill → build → done)
├── v28-states/                  ← offline, push, day one, search, reach audit
└── _rationale/                  ← explored-and-rejected options; not build targets
```

**Build order:** v22 → v25 (keyboard spec is a prerequisite for every text surface) → v23 → v24 → v27 → v28.

---

## 1 · Navigation — three tabs, and that's the ceiling

```
◈ Today          ◉ (the mark)          ▤ Work
```

- **The centre mark IS the home tab** — real destination, real active state, and it **pulses while agents are working**. Not a duplicate of a tab beside it.
- **Voice is a mode, not a place** — the mic lives in the composer; long-press the mark for hands-free.
- **You / config → the ⓶ screen** (press the mark when already home).
- **The tab bar is full.** A new destination displaces one or becomes a view inside an existing tab (the Library precedent). Never a fourth tab.

**The rule:** a *mode* changes how you say something; a *destination* changes what you're looking at. Modes live in the composer.

---

## 2 · The keyboard spec — v25 G3, build exactly

**The bug in the current build:** the whole window scrolls, so the header leaves and the thread jumps. **The window must never move.** Only the composer position and the thread's viewport height change.

1. **Layout, not scroll.** Thread is a fixed-height flex child between a pinned header and the composer. Keyboard appears → the container shrinks; the page never translates.
2. **Bottom-anchored thread** (`justify-content:flex-end`) — short threads sit against the composer, not floating at the top.
3. **Composer sits on the keyboard.** Bottom inset = keyboard height, animated with the system curve (`0.25s easeInOut`) so it rises *with* the keys.
4. **Tab bar hides while typing**, returns on dismiss.
5. **Header stays and compacts** — never scrolls off.
6. **Scroll position preserved on dismiss** — no snap to bottom.
7. **Multiline grows to 5 lines**, then scrolls internally.
8. **Interactive dismiss** — dragging the thread down dismisses proportionally.

**Test to pass:** type in a 2-message thread *and* a 200-message thread. In both, the newest message must be visible above the composer and the header must not move.

---

## 3 · Sheets vs pushes

- **A surface earns a sheet only when you need it without leaving what you're doing.** Library and Create qualify. People doesn't — you browse it deliberately. Config never does.
- **Sheets open contextually and say so** — Library from a thing leads with that thing's files.
- **Create uses two detents** — 42% peek (fires the common case in two taps) and 94% full (all ten types, reference drop, template rows).
- **Stage two is always a push, never a nested sheet.** A sheet inside a sheet loses the back gesture.

---

## 4 · Create — the routing rule (v27)

```
1a  tap a type       ──→  scoped gallery  ──→  fill
1a  tap a suggestion ──────────────────────→  fill  (template known)
1a  type or speak    ──→  stream  ──→  asks only what's missing
1a  "not sure"       ──→  "what's it for?"  ──→  scoped gallery
```

**Six rules:**
1. **Fill is never an empty form.** State what's known as a checkable block, ask only the gaps. If Cue knows everything, skip fill and build.
2. **Building is narrated and non-blocking** — real thumbnails as they render, current-step line, live composer for redirects, "you can leave". Anything over 30s survives backgrounding.
3. **Every artefact card says where it filed** — *"Filed onto Close the seed · in Library"*. That line is why Create lives in Cue.
4. **One adjacent offer after delivery**, only from what it touched. Two is nagging; unrelated is creepy.
5. **Remix chips are type-specific** — Slides: shorter / different look / add a slide · Docs: tone / length / restructure · Images: restyle / variations / upscale.
6. **Blank is first-class** — in the gallery grid, not below it.

---

## 5 · States (v28) — the four that were missing

- **Offline** — three honest blocks: what's queued (**each undoable**), what still works, what doesn't. Composer recedes with a reason; **no spinner ever appears offline**.
- **Push** — three tiers on the lock screen: a correction that breaks quiet hours · one time-critical approval with **Send it inline** · the 7:30 brief. **Three a day is the ceiling** unless something breaks.
- **Day one** — no tour, no empty deck. One question that produces the first thing; connectors come *after* the first real answer.
- **Search** — **pull down from any screen**. Answer-first for questions, typed list for keywords, **decision records as a first-class result**.

---

## 6 · Two rules to honour early (cheap now, expensive to retrofit)

**Reach.** Every primary action sits **below 60% of viewport height**. Back chevrons and ⋯ may sit top-side as escapes — **provided every screen has swipe-back**, so the chevron is never the only way out.

**Haptics.** `.light` on selection and swipe-reveal · `.medium` on send / approve / hand-off · `.success` only on completion blooms · `.error` only on a real failure. **Never on scroll, never on appear.**

---

## 7 · Colour — the rule that kept breaking

Nine recurrences of one failure class across this project. The pattern is always **a light-theme muted token applied to a dark ground**.

**Text tokens:** dark ground → `#9A9AA8` · light ground → `#6B6B60`.
**Never as text:** `#5B5B68` · `#8A8A7E` · `#A8A89C` — ground and hairline colours only.

**Accent text below 16px uses the text variant:**

| Role | Fill / glyph / ≥16px | Text <16px |
|---|---|---|
| Accent | `#3D6EE8` | `#2B53C4` |
| Needs you | `#B4770F` | `#8A5A08` |
| Life / time | `#0E8C8C` | `#0A6A6A` |
| Review | `#534AB7` | `#453C9E` |
| Error | `#C24E42` | `#A63A2F` |
| Done | `#277E41` | `#277E41` |

**A coloured fill carrying white text is a text context** — it takes the text variant, never the bright value.

**Never dim a container to express disabled.** An `opacity` wrapper is receding by contrast through the back door. Use the muted token plus a recessed background, and keep explanatory copy at full strength.

**The structural fix — please do this:** name tokens for **ground and role** (`--muted-on-dark`, `--violet-on-fill`) rather than exposing bare hexes. Nine attempts at vigilance is enough evidence that the wrong value will keep being typed into the right slot.

---

## 8 · Desktop-only, named on the ⓶ screen rather than hidden

Schedules · Models · Usage & spend · Preferences · Marketplace · Plugins · Brand · Agent network · System access.

**Nine surfaces genuinely better with a keyboard.** The phone links out instead of shipping them cramped.

---

## 9 · Deliberately not drawn

iPad (a different layout problem, not a scaled phone) · Watch (needs its own interaction model) · Live Activities beyond the v3 frame · home-screen widget. **All post-launch; none blocks the build.**

---

## 10 · The one open question

**Create's per-type stage two.** I've drawn Slides as the pattern. For each of the other nine types I need:

1. **The field list and kinds** (chip-select, text, number, url, tags, metric)
2. **Which fields pre-fill** from memory or connected sources
3. Whether a **style/preset step** comes before or after the fields
4. **What "Preview" actually renders** — a sample, the template skeleton, or a real generation
5. **Is App Builder a type or a mode on Docs?** Desktop shows it as a badge on the templates header, which reads like neither.

Everything else is specified.

---

## Invariants — true on every screen

- Lead with what Cue delivered, not what it needs.
- "Needs you" = `awaiting_review` assigned to you. One definition, everywhere.
- Eight verbs: Approve · Open · Later · Archive · Done-elsewhere · File · Hand off · Undo.
- The deck never grows — needs-you caps at 3 with "N of M".
- Never a fake number — a ring with no computable metric shows `✓` / `!` / `◼`.
- A no-op is not a success.
- Archive never deletes; "done elsewhere" never credits Cue.
- Cue reports its own errors first, verbatim, first person. Red is reserved for this.
- No colour-only state — every state carries a glyph: `‖ ◱ ✓ ↴ ◼ ○ ✨ ⧉`.
- Provenance everywhere: every artefact, arrival and answer says where it came from and where it filed.
