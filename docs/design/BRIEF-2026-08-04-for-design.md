# Request to design — 2026-08-04, from code

Your HQ redesign is **built and live**. This is what we learned building it, three
places we deviated from your frames and why, four surfaces that now exist with no
spec, and eight decisions we need from you.

Everything below is measured against the owner's real production instance, not a
sample. Where a number appears, it is that account's actual figure.

---

## 1 · Your HQ brief shipped, with three deviations

C1 the valve, and the Glance/Deck toggle, are both in. The hinge is enforced
rather than intended: Glance's strip and Deck's rail are literally the same
object in memory, and a test asserts identity, not equality — so they cannot
drift apart. Every lane declares where it renders in each density, and neither
declaration has a "nowhere" member, so deleting a lane throws.

**Where we did not follow the frames, and why. Each of these is a place your
spec asked for something the data cannot support. We would rather you changed
the design than we faked the number.**

### 1a · "348 → ~6" is half true

Your 348/day is **real** — measured 279 raw watcher events on a clean day, 207
arrivals, 94 surfaced, 67 work items minted, and **131 open work items standing
in the queue**.

Your ~6/day is **not reachable today**. Real rules replayed over real rows:

| stop | items that interrupt |
|---|---|
| Everything | 94 |
| **Needs you** (default) | **57** |
| after ~20 taps of teaching | 45 |
| Only urgent | 0 |

So the surface renders **57 · 37 · 57**, not your frame's 6 · 4 · 12. The
biggest single reduction came from a *structural* rule — nine messages from one
machine are one stream, so all but the newest collapse — not from guessing at
content. We deliberately refused to demote transactional automated mail, because
that class is where approvals and payment failures live.

**The residue is upstream of the valve.** The ~37/day still arriving is bank and
vendor mail that the relevance judge should be resolving; it answered 5 times out
of 161 before a timeout fix. That is a code problem, not a layout problem.

**Question 1:** does the valve's default stop stay where it is, knowing it
delivers 57 rather than 6? Or do you want a fourth, tighter stop?

### 1b · "FILED TODAY" became "FILED · 24H"

The arrivals summary is a **trailing window** with no `since` parameter, so the
surface cannot say "today" truthfully. The label is now built from the window
the response itself reports.

**Question 2:** do you want us to add a `since` parameter so it can genuinely say
"today", or is a rolling 24h the more useful number anyway?

### 1c · The mission rings are status, not percentage

Your frame shows 74% / 36%. **Mission progress has no connected metric** —
there is no field that means "36% done". The rings render status only
(on-track / moving / blocked).

**Question 3:** either (a) rings stay status-only and you redraw them without
percentages, or (b) you tell us what would make a percentage real — tasks
closed over tasks planned? days elapsed over days budgeted? — and we build the
metric. We cannot draw a number that nothing computes.

---

## 2 · Four surfaces now exist with no design

Built in response to the owner's testing, without a spec. They work; they have
not had your eye.

### 2a · Full-screen voice — **the biggest one**

The owner asked for it directly: *"i do like the real life voice mode like chat
back and forth but if its hard we could consider full screen lets find a way to
do both?"* So both exist. Inline stays the default and remains the single
controller; full screen swaps what it renders, so expanding or collapsing
mid-sentence touches neither socket nor mic.

Full screen draws the whole call and has **no composer at all** — mute, collapse,
hang up. It currently shows a Realtime/Companion engine toggle, a listening
state, and the live exchange as text.

**Question 4:** this is the surface most likely to define how Cue *feels*, and it
was designed by an engineer at 3am. Please redraw it. Specifically: what does
listening vs thinking vs speaking look like; what happens to the transcript when
a call ends; and should the engine toggle be there at all.

### 2b · Library — a scope statement, not a file list

Library was reading the **work-run registry** — a table with 2 rows — while the
account holds **115 real assets** (66 apps, 13 documents, 34 files). It now
composes them, and states its scope in the header rather than implying
authorship: *"115 things made with Cue · 3 this week"*, with a footer
*"Files, docs and apps you made with Cue. Things you sent it stay in their chat."*

Uploads are deliberately **out** of Library, matching the desktop line. Filter
chips are now All · Docs · Images · **Video** · **Apps** — the account has 8
videos that previously had no chip at all, which quietly asserted the owner
owned none.

**Question 5:** is "made with Cue, uploads live in their chat" the right cut? The
owner may reasonably expect a PDF he sent to be findable in Library.

### 2c · Thread navigation — the top-left door

There was **no way back to conversations**. The owner has 420 reachable threads
and the menu label said "151", which turned out to be the size of a client
cache. The top-left `☰` now opens a thread switcher on HQ, Work and the
conversations index, and sits *beside* the back chevron inside a thread —
folding them together would have deleted an exit.

**Question 6:** we put 7 recents in the sheet before "All conversations". Is a
sheet the right shape here, or do you want a persistent rail on desktop?

### 2d · The valve's own control

C1 exists in the daemon with three stops, per-mission override, and a learning
signal fed by the ✕. **The stop control has no designed home.** Today it is
reachable but not composed.

**Question 7:** where does the stop live? Your brief says "one global control,
per-mission override" but not where a person changes it, or how the
per-mission override is discovered.

---

## 3 · The standing backlog — eight decisions

1. **The `⌗` un-comprehended arrivals rows.** These are items Cue could not read.
   They are excluded from All work by design, so a count of them has no honest
   destination. We removed the rows rather than leave a number that goes nowhere.
   **Where should unreadable arrivals live?**
2. **Your Cue — one shell, 18 leaves.** Settings and Your Cue duplicate four
   things between them. Needs a single information architecture.
3. **Final navigation.** Sidebar as one column, five rows, with Your Cue as a
   door — specified, not built, and now partly overtaken by the HQ redesign.
   Please reconcile against what shipped.
4. **The action board.** The owner agreed to retire it. It still runs a daily
   builder that writes cards nothing renders, and emits the 07:30 push.
   **Confirm it dies, and say what inherits the morning push.**
5. **Going-quiet has no data.** The People tab wants a "going quiet" signal, but
   **no outbound mail is recorded**, so the product cannot know who has gone
   quiet. Either the slot changes meaning or we build outbound capture.
6. **A calendar conflict is work** — the dark token slot for it should be deleted.
7. **Second-device first run.** A valid session on a new device is told *"Nothing
   has happened here yet"* on an instance with 420 conversations. Being fixed;
   **what should a returning person on a new device actually see?**
8. **Six confirmations** from the previous mobile pack are still open.

---

## 4 · Two constraints worth holding on to

**Never a fake number.** Tonight alone we found and removed: a count that was the
size of a client cache; a calendar "15m free" chip still offered eleven hours
after that slot closed; a "Last hit" label reading the *poll* clock, so 0 hits in
320 polls displayed as "Last hit 2m ago"; and a pending query rendering as a
confident zero. Please keep drawing frames that show the *unavailable* state —
they are the ones that stop this.

**The valve fails open by construction.** An item with no band is treated as
urgent, so an empty valve is a valve wide open, and turning the feature off makes
Cue noisier rather than quieter. If a frame ever implies "filtered" as the safe
default, it inverts this — worth knowing before you draw it.

---

## 5 · What we would most like back

In priority order: **the full-screen voice surface** (2a), **the valve's control
placement** (2d), **the rings decision** (1c), then the eight-item backlog.
