# Back to design — the ritual slot is built, nine questions, and the seven

**16 August 2026 · answers `design-answers-2026-08-16` and the v43 rituals ruling**

The ritual slot is **built and committed** (`b4a35024fe`), to the rendered HTML's values. D1 (Slack
action row), D3 (vendor names) and D4 (wide tables → split) are all implemented as ruled. D2's hex
is applied, and the slot's tint goes through ground/role tokens rather than retyped hexes — your
"third ground" point landed in the first component that needed it.

What follows is only what the specs did not cover, and what we owe you.

---

## Part 1 — Five rules the ritual slot needed that v43 did not state

These are **encoded and shipped**. Each is a reading of your ruling rather than an invention, but
each is now behaviour, so it should be confirmed or corrected.

### R1 · Saturday and Sunday mornings open both windows — the Brief wins before 11:00
The Brief's window is "morning until read or 11am". The Weekly's is "Friday from noon, persisting
through the weekend unread". On a Saturday or Sunday morning both are open.

**Encoded:** before 11:00, the Brief. After, the Weekly.
**Derived from:** your "Friday morning shows the Brief; Friday noon swaps to the Weekly", plus your
own frame being labelled `SATURDAY · YOUR BRIEF`.

### R2 · A read ritual collapses; it does not vacate
When the Brief is read on a Saturday morning, the slot collapses to its one-row face rather than
disappearing and letting the Weekly take the space.

**Why:** vacating would mean reading the Brief silently produces the Weekly one tap later — "both at
once", spread over time rather than side by side. The rule you set seemed to be about the *user's
attention*, not just simultaneous pixels.

### R3 · An all-quiet brief still renders
A night with nothing to report shows the slot with "All quiet overnight." rather than omitting.

**Why:** the push goes out on a quiet night. If the slot omitted, the two doors would disagree about
whether there *was* a brief — which is the specific bug the one-door rule exists to close. We read
omit-rather-than-fake as being about *absent data*, not *uneventful data*. Tell us if that is wrong.

### R4 · Read and dismissed are device-local
Neither contract carries a read receipt. Rather than invent an endpoint for a one-consumer fact, the
state lives in local storage.

**Consequence, which may be a design problem:** reading the Brief on your phone does not collapse
the slot on the Mac. We think that is right — a ritual is read on a device — but it is a visible
inconsistency and it is now behaviour.

### R5 · The slot does not appear under Today's not-set-up takeover
`EmptyOrbit` early-returns and owns the whole screen for a fresh instance.

**We are least confident here.** The reasoning: in that state every lane is empty and nothing is
watching, so a ritual would have nothing behind it and the omit rule would nearly empty it anyway.
But the first morning is arguably exactly when a ritual should introduce itself. **Please rule.**

---

## Part 2 — Two things we could not build as specified

### N1 · There is no real dated archive, because there is no brief history
"Briefs & reviews" exists in ⋯ and at `/assistant/rituals`, but it lists only the two real, dated
rows and states the absence in a line.

**The constraint:** the daemon has no brief store. `/brief/morning` composes today's brief from a
sliding lookback and takes no date argument; the weekly is the same over seven days. So "Tuesday's
brief" would recompute *today's* numbers under a Tuesday heading — a fabricated artefact wearing a
date, which is the omit rule's exact prohibition.

**What it needs:** a snapshot store, written when a ritual is composed. Then the page gains rows and
changes nothing else. **Is the archive worth that backend work, or does the slot alone carry it?**

### N2 · The push and the slot share their numbers, not their characters
Your rule was "the push payload *is* the slot's copy". What is built: both compute the same three
figures from the same rule, with a test that reads the daemon's composer and fails if they drift. But
the push body is still a status line — *"3 finished overnight · 1 needs your OK"* — while the slot is
the serif sentence.

Making them character-identical means the **push adopts the serif sentence**. That is a copy change
in the notification, which is yours. **Do you want the push to become the sentence?**

---

## Part 3 — Two questions from the wide-table work (D4)

The split is built to your rules: row boundaries, header repeated on every part, "Pricing · 1 of 3"
in the title, the sentence said once with the document offer still available. Verified by opening
five real decks in PowerPoint. Two things your ruling left open.

### Q1 · When Cue refuses, should the data still appear?
Today a refusal emits **only** the sentence — *"This is a document, not a slide"* — and no grid at
all. The reasoning was that refusing means not fabricating. The alternative is a best-effort split
**and** the sentence, so the deck still carries the content while telling the truth about it.

One line either way. **Which?**

### Q2 · The refusal threshold is very strict
A row must *literally* not fit on a slide. In testing, a three-column table with ~1,400-character
cells still split into four parts rather than refusing; it took ~3,000-character cells to trigger.

That follows "refuse only past the point splitting helps" literally. But a row taking three-quarters
of a slide is arguably already a document. **Refuse earlier?**

---

## Part 4 — The seven thin-vs-mock surfaces

You asked for these with our reasons so you can rule per row: *the mock loses the metric*, or *the
metric earns a backend ticket*. Your three pre-rulings are carried through; the four you held are
below with what we know.

| # | Surface | The metric | Why it is absent | Your pre-ruling |
|---|---|---|---|---|
| 1 | Memory | "applied N times" | See below — worse than reported | held |
| 2 | Review pager | `IN YOUR BRAND ✓` | Outputs carry no brand metadata | held |
| 3 | Watch live | Redirect control | No endpoint exists | **ticket** |
| 4 | Identity | Working style row | No config key backs it | **mock loses it** |
| 5 | Skills | Per-skill runs / reversals / spend | No per-skill data source | held |
| 6 | People | "you owe a reply" | Needs sent-mail capture | **mock keeps, NEEDS BACKEND** |
| 7 | Watching | Complete census | API caps at 200 rows, and says so | held |

### On #1, Memory — the situation is worse than the audit said, and it changes the ruling
We built the counter this week and it surfaced two facts:

- The Memory screen renders **graph records** (4,496 of them on the live instance). The only place
  usage history was believed to live is a **different id space** — concept-page slugs — with **no
  join** between them.
- **Both stores are empty.** The slug-keyed injection log has **0 rows**. So the "real numbers
  immediately" option we thought existed does not.
- The write site we wired into does not fire under the shipped default, because the v2 memory path
  short-circuits the older graph branch. The code states the split deliberately: *concept pages
  drive per-turn injection, graph nodes drive the Memory page.*

So this is not "a number with no source". It is **two parallel memory stores that were never
reconciled**, and the metric is downstream of that. Under omit-rather-than-fake the surface is
honest today — it shows nothing — but the metric cannot arrive without an architecture decision.

**Our recommendation for your ruling: the mock loses it for now**, with the reconciliation raised as
its own piece of work rather than a backend ticket hanging off a UI label.

### On #2, Review's brand label and #5, Skills' per-skill stats
Both are genuinely "no source exists". Neither has a partial signal to build on. We have no reason to
argue for either, so we would take *mock loses it* unless you see a reason to invest.

### On #7, Watching's capped census
Different in kind: the API returns real data and **states its own 200-row cap in-product**. So it is
not fabricated, just incomplete and honest about it. **Our view: the mock keeps it, and the cap
copy is the design object** — how a truthful "showing 200 of many" reads, rather than whether to
show it.

---

## Part 5 — Confirmations, no action needed

- **v29 is the Create reference, not v27.** Understood, and the grep exposure you flagged is real —
  the spine's state machine and the tile list both trace to the v27 entry. Diff order noted:
  behaviour first, then tiles, then CSS. Not yet done.
- **Organizer remote** — entry to be withdrawn, code kept, as ruled.
- **Create gallery accessibility** — fixed. The keyboard path is now in the badge rule's test set, as
  you asked.
- **Slack action row (D1)** — implemented; provenance no longer changes what a gesture means.
