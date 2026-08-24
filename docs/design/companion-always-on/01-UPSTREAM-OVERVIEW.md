# The always-on companion — what upstream built, and what Cue's should be

**Read from** `upstream/main` at `0b02d016` (2026-08-24) — 3,438 lines across four files
plus the shared IPC contract. Every claim below is checkable against `upstream-source/`.
No upstream code has been merged, cherry-picked or written.

---

## 1 · Where the two trees stand

| | Upstream | Cue, today |
|---|---|---|
| The surface | Always-on companion, shipped to everyone | Corner: one exchange on `⌥C`, then finished |
| Gate | Flag deleted; tray preference only | `desktop-corner` / `desktop-companion` client flags |
| Introduction | Four-beat coachmark on first meeting | None |
| Size | 3,438 lines | 580 lines |

Upstream deleted the `companion-surface` flag in `64e3eead` (2026-08-20). Our own
`desktop-surface-flags.ts` says the opposite in as many words — *"The legacy always-on orb,
**which the corner replaces**"* — and `isCompanionEnabled()` returns `false` whenever the
corner is on. **That rule is being inverted as part of this decision.**

---

## 2 · What the companion actually is

Not a launcher and not a shrunken app. **One object that changes shape.** Every geometry
decision follows from that one commitment.

### The avatar is the fixed point

A **44pt disc holding one x-position in every state.** The body unfurls out of it; only
`width` animates. That is what makes it read as one creature changing shape rather than
three surfaces that share a colour — and it gives the eye and the cursor the same target in
every state.

Placement is therefore a *position* (`left: 50%` plus the avatar's own half-width), not a
transform. The avatar's distance from the canvas edge is a **cross-process constant** both
sides derive from one formula:

```ts
export const COMPANION_NEAR_EDGE =
  COMPANION_BASE_AVATAR_BOX / 2 + COMPANION_BASE_CANVAS_PAD;   // 44/2 + 24
```

> Main places the window by it and the renderer anchors the avatar by it, so the two
> agreeing is what makes the avatar appear where the window was put. Derived once rather
> than on each side, because two copies of this formula drifting is the avatar drawn
> somewhere other than where main believes it is.

### Six phases, in precedence order

| Phase | What holds it open |
|---|---|
| `resting` | Nothing. The circle, with a pulsing glow. |
| `hover` | The pointer. Lowest rank — it's a hint. |
| `watching` | A session reading the screen. Open **regardless of the pointer**. |
| `summary` | The account being written after a watch ends. |
| `call` | A live voice session. |
| `typing` | Becomes a card. The only phase that grows vertically. |

Precedence: `typing` / `call` > `watching` > `summary` > `hover`. A half-typed sentence and
a live call are both something the user is in the middle of.

`watching` staying open regardless of the pointer has a sharp reason:

> A screen reader that hides itself when the pointer leaves is one the user cannot see, and
> a capture nobody can see is one nobody can stop.

And `summary` exists because a session ends *twice*:

> The socket closes when the user presses stop, and the account of what they narrated is
> written afterwards by a turn that runs for the better part of a minute. Collapsing to rest
> across that gap reads as the recording having been discarded.

### The mascot expresses whose turn it is

Not the fine-grained phase — the coarse one:

> What the mascot expresses is whose turn it is, which is the distinction a glance actually
> needs: the creature is either waiting on you or working. The finer phase is in the words
> beside it, where the reading is deliberate.

`connecting` and `ending` are neither turn, and read better as the ordinary idle creature
than as one straining.

### Two rings, and they must not be confused

**Working** — a ring **travelling** around the edge. Travel rather than another pulse,
because the resting surface already has a pulsing glow and the two must read as different
things from the corner of an eye.

**Watching** — a fixed `#FF9F45` amber ring, deliberately *not* the assistant's accent:

> The ring in the accent already means "a turn is running" and a screen being read is a
> different fact about the machine. Amber is the tone the host burns for a live capture, so
> the surface agrees with the menu bar above it.

### Size is a named step, not a number

| Step | Avatar box | Note |
|---|---|---|
| `small` | 44pt | The size the layout is authored at; everything scales from it |
| `medium` | 66pt | **Default** |
| `large` | 88pt | |
| `huge` | 110pt | |
| `ridiculous` | 220pt | The joke at the end of the scale — and a real step, drawn by the same code |

> A continuous scale would be a layout nobody had ever looked at; five steps are five
> layouts, each checkable in Storybook.

Default is the **second** step, not the third:

> The companion arrives on the desktop without anyone having asked for it, over whatever the
> user was already working in, so it arrives at the size of an uninvited guest: big enough
> to be recognised as the creature it is, small enough that nobody has to move it before
> they can carry on.

A stored choice is never overridden.

### It grows away from the edge it runs into

The pill needs `width − 44` of clearance — 228pt expanded, 316pt at its widest. Parked by
the right edge it doesn't have that, so **it flips and grows the other way, the way a menu
does**. The typing card grows *up* by default (it lives by the Dock) and flips *down* near
the top of a display.

Main decides both, because main owns the window position and is the only side that knows
which display it is on.

### Solid, not glass — and that is forced

> The only real blur available is the window's native vibrancy material, and a window's
> material fills the window. This one is a canvas many times the size of the pill, so asking
> for glass frosts a rectangle across the desktop. Sizing the window to the pill would buy
> real glass at the cost of resizing it on every expansion, which is the thing the fixed
> canvas exists to avoid. `backdrop-filter` is no help either: it samples what is behind it
> within the page, and the desktop is not in the page.

**This contradicts our own UX-INTENT**, which asks for "purple-gradient glass" on the
floating surface. Upstream tried and the platform refused. See Q3.

### The four-beat introduction

Shown once, the first time the creature appears.

| Beat | Title | Body |
|---|---|---|
| `meet` | "I'm {name}" | I stay on your desktop, even when Vellum isn't visible. |
| `talk` | "Talk" | Start a voice conversation. |
| `type` | "Type" | Send a message from here and read the reply here too. |
| `menu` | "Right-click me" | That's where you hide me or change my size. |

Two actions only — `next` and `dismiss` — because the renderer doesn't hold the running
position; main does. A stale press from a renderer a beat behind then lands where the user
could see it would.

---

## 3 · What it cost them to learn

Five bugs in ten days. Every one is a property of an always-on-top, frameless,
drag-by-its-own-body window — which is what any version of this is.

**Three of the five ended in the window eating clicks meant for other applications.**

### An abandoned drag bricks the surface — `56405459`

The surface is its own drag handle, so a press is a grab until the hand moves. That press
ended only on `mouseup` over the canvas — and that event never arrives when the button comes
up over *another app*. A fast drag outruns a window moved one IPC message at a time, so the
release lands where the page is not.

The press then never ends: every later move reads as a drag frame, the surface chases a
pointer with no button held, and the first move after the pointer returns carries the whole
distance travelled in between. Hit-testing never resumes either, so the window stays
clickable across a canvas many times the size of the pill — **swallowing presses meant for
whatever is behind it**.

### A custom avatar cannot drag it — `4e9f2133`

An uploaded avatar renders as a bare `<img>`, which is natively draggable — so pressing it
starts the platform's own HTML5 image drag, which takes the pointer and ends the mousemove
stream the drag runs on. Needs **both** `draggable={false}` and `-webkit-user-drag: none`,
because WebKit honours the CSS on paths where it ignores the attribute.

### It could not be dragged to the top of the screen — `c634722e`

Confirmed against the window server rather than guessed: macOS declines any window origin
above the top of the work area, whatever the window level. With the avatar pinned to the
centre of a 584pt canvas it stopped **270pt short** — the clamp was asking correctly and
being overruled. The canvas is asymmetric now: it only reserves the card's height on the
side the card grows into.

### Growing leftward teleported it — `db9392ef`

Growing leftward is two halves — anchor by the right edge, **and** mirror the row so the
avatar lands on the point main positioned the window by. An earlier refactor wrapped the
avatar and body in a row of their own, so `flex-row-reverse` had a single in-flow child and
ordered nothing. The avatar drew 128pt from where main believed it was, and up to 316pt in
the card.

### The introduction leaked click-through — in `64e3eead`

Skip, "Got it", and an incoming call all remove the intro card from under the pointer
*without a mouse-move*, so nothing recomputed the hit-test and the window stayed clickable
across the whole canvas.

### The technique underneath all of it

```
setIgnoreMouseEvents(true, { forward: true })
```

The pointer is tracked without capturing clicks meant for what is behind. Hover therefore
becomes a phase the main process publishes, not internal renderer state — which is also why
their surface renders identically in Storybook and in the real panel.

**We call this in no production code at all today.**

---

## 4 · What Cue keeps

Upstream has the surface. We have the product rules, and they are the harder half to invent.

**The honesty rules.** Nothing files without acceptance. "Nothing to file" is never the same
sentence as "I couldn't read it". Confidence is drawn, never a percentage. A summary always
says it is one. Upstream has no equivalent.

**The consent line.** A live green dot, "Reading this window only, while it's open", and a
Stop — in the product, every time, not on a privacy page. Upstream's watching ring says
*that* a capture is running; ours says **what it can and cannot see**. Keep ours, take their
ring.

**Selection as the primary input.** Highlight, summon, and the panel quotes back what it
received. Precise, nearly free on consent, already muscle memory — and it makes
screen-reading an upgrade rather than a gate. Upstream jumps straight to reading the window.

**Approvals raise the app window.** Theirs, and worth taking on its own merits:

> A confirmation is the one thing the assistant cannot get past on its own, and the card
> that answers it is drawn in the app's window. The turn that raised it need not have
> started there — a message typed on the companion is sent from a surface floating over
> whatever the user is actually working in, and a scheduled run is started by nobody at all.
> In both cases the request lands in a window that is behind something else, and **the
> assistant reads as having gone quiet when it is in fact waiting.**

This is a live candidate for our open dropped-approval bug — the one that survived three
repair passes. If the card rendered into a window behind another app, every server-side
check would correctly report it as delivered.

---

## 5 · Questions design needs to answer

**Q1 · Does the `⌥C` summon survive inside the companion?**
Always-on answers "is it there". A summon answers "come here now, where I'm looking". They
can coexist — or the companion absorbs the summon. We are not maintaining two floating
surfaces either way.

**Q2 · What is Cue's creature?** *(the big one)*
Upstream's is a composed mascot with traits — body shape, eye style, colour — that blinks
and breathes, rendered live rather than shipped as a still. Ours is a wordmark. An always-on
surface is a **presence**, and a presence needs a character. This is the largest genuinely
new design question in the set.

**Q3 · Glass or solid?**
Our UX-INTENT asks for purple-gradient glass. Upstream proved real blur is unavailable on an
oversized canvas. Either size the window to its content — and pay a resize on every
expansion — or paint the gradient and accept it isn't real glass.

**Q4 · Does the companion carry Notes capture?**
The Notes recording session (`01b`) is designed as a full-window surface. If a thought can be
spoken into the companion, then "start a recording" and "keep this as a note" both belong on
it — and the relationship between the two surfaces needs drawing.

**Q5 · What does *watching* mean for us?**
Upstream's watch is a continuous screen-reading session with a summary afterwards. Ours
currently reads one window, once, while the panel is open — a deliberately sharper line we
drew to keep it distinct from Cue Live. Always-on may move that line, and if it does, the
Cue Live boundary needs restating.
