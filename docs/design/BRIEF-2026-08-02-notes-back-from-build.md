# Notes back from building v7–v12

**2026-08-02.** Three things design should rule on, and three findings from
driving the real signed-in app that are worth having.

---

## 1. Mobile ends up with 9 rail lines, not 4 — the invariant produced this

M2 names four Tier-3 lines: arrivals, waiting, rhythms, pulse. But M2 also says
**"at 390px there is no Tier 2 — a lane is a card or a line, never between."**
Those two statements cannot both hold, because every Tier-2 lane has to become
*something*, and on mobile the only other option is a line.

So the phone shows nine: the named four, plus in-motion, day, Life, batch and
correction demoted down from Tier 2.

We took the invariant over the frame, on the theory that the invariant is the
load-bearing decision and the frame was drawn before it. **Two ways to make it
four, if four was meant literally:**

- **Fewer lanes on mobile.** Say which of the five demoted lanes simply do not
  exist at 390px. This is the honest version if the answer is "a phone does not
  need a batch offer".
- **A second grouping below the rail.** The named four stay prominent; the
  demoted five collapse behind one line ("5 more lanes are quiet"). This keeps
  the never-silently-absent invariant and costs one line instead of five.

Our instinct is the first — the phone forcing the question is the whole point of
your own tie-breaker — but it is a product call about what a phone is for, not
an engineering one.

## 2. Where multi-approve landed, and a correction

Retiring `hq-board.tsx` was right; those were cards wrapped around a sentence.
But the cards were doing something the frames do not describe, and it took
reading the deleted file to see it.

**They were not approving work items.** They decided *pending interactions* — a
run stopped mid-flight because it reached a high-consequence action (send,
payment, publish, delete), which the daemon hard-checkpoints regardless of trust
level. Until someone answers, the run does not continue.

After the retire, desktop could **count** them and not answer them. The
remainder rendered as a line reading *"N more approvals are paused for your
decision · Decide ›"* — and the door pointed at the review queue, which
completes work items and has no confirm call at all. A label promising the one
thing the destination cannot do.

**A correction worth carrying, because it was stated wrongly elsewhere:** that
door was *not* triage and *not* the ledger. Neither of those can decide an
interaction either — the ledger has bulk select, but only for adding tasks to a
project. Mobile's Today screen was the only surface that could still answer one.

**What we built:** the line stays a line and opens. Collapsed, it is one
sentence. Expanded, it approves and declines in place, capped at four with
"N of M", so at three paused runs or thirty only the number moves. No card
returns to the deck.

**What we would like you to rule on:** whether a paused run deserves more than
this. It is the only thing in the product where *nothing proceeds* until the
owner answers — arguably the strongest claim on attention any lane has, and it
is currently quieter than a newsletter digest. If it deserves Tier 1, say so and
we will promote it.

## 3. Three findings from the live app

Worth having because they change what the frames are drawn against.

**The volume problem was one safety rule, not the design.** Six of eight
consecutive live filtering decisions surfaced on `direct_human` — "you're a
direct recipient and it's from a person". A bank's marketing promo passes it:
`notification@` sender, display name, addressed directly, and no
`List-Unsubscribe`, `Precedence` or `Auto-Submitted` headers at all. Every
bulk test said "not bulk". That single rule was the dominant reason the lane
stayed full after all the filtering work landed. Fixed by treating the sender's
address as evidence, with a carve-out for anything actionable — approvals and
expiring credentials come from exactly those addresses.

**Nothing had been converting mail into work.** All 134 Gmail-sourced items were
titled `Email from <sender>: <subject>`. Comprehension now produces verb phrases
("Renew Brinc Innovation Africa's annual return"), which is what makes v7 §B's
three-slot row possible at all — the row spec assumes a verb phrase exists, and
until this week none did.

**A calendar event is not a task.** Fixing the calendar sync produced 111 work
items, including meetings from 2020 and 2021 (one present-day edit to a
long-running recurring series rewrites `updated` on every stored exception, and
the sync feed keys on the resource rather than the event date). Calendar
arrivals are now recorded and never minted as work; the day rail is where the
calendar reaches the owner. If any frame assumes a meeting appears in the queue,
it should not.

## 4. Two smaller things

- **The Came-in `?` is now per §B** — a small amber `?` where a filed item shows
  its thing chip, picker behind it. It had been rendering a full panel with six
  target chips on every unfiled row, which is the same "provenance on the line"
  mistake §B exists to prevent.
- **`#5B5B68` reached the app twice as a text colour** before v8's ban — the Cue
  Live viewer's `t3` token and a voice label, both ~2.5:1 on near-black. Fixed,
  and the tertiary slot now holds the *same* value as secondary rather than
  something merely dimmer, on the theory that an available wrong value gets used
  eventually. Worth considering whether the design system should stop shipping a
  slot that dark at all.
