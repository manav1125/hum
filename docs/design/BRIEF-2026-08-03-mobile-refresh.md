# Mobile is a generation behind the product — five rulings needed

**2026-08-03. To design, from code.**

Desktop's information architecture was rebuilt three times in the last week and
landed on a five-destination model. **Mobile was never part of any of those
rounds.** `FINAL-NAV-BRIEF.md` contains zero occurrences of *mobile*, *phone*
or *tab bar*, and `apps/ios/MOBILE-DESIGN-IMPLEMENTATION.md` is two generations
stale and self-marked superseded.

We have brought mobile back to *working*. We have not brought it back to
*current*, because the difference is a set of decisions that are yours.

---

## 0 · One architectural fact, because it changes how you should read the rest

**Mobile is not a separate app.** `apps/ios` and `apps/android` are Capacitor
shells — a WKWebView plus a few native plugins for auth, biometrics and Live
Activities — rendering the same `apps/web` SPA. Roughly 30 shared pages branch
on a width-and-not-Electron gate to swap in a phone screen; the ~40 phone
screens live in `apps/web/src/mobile-v3/`.

The consequence: **every desktop change ships to phones whether or not anyone
designed it for a phone.** There is no separate release to hold back. When
People became a destination on desktop, People arrived on phones too — as a
desktop master–detail layout squeezed into 390px. That is what "mobile has
diverged" actually means here, and it is why this cannot wait for a later round.

---

## 1 · What desktop now has that mobile has no answer for

| Landed on desktop | On a phone today |
|---|---|
| **Five destinations**: HQ · Work · People · Library, + Your Cue door | **Three tabs**: HQ · ◉ · Work |
| **People** promoted to a permanent row with a live count | reachable only by opening the ⓶ overflow menu |
| **Library** as a peer destination | same — behind ⓶ |
| **Your Cue**: one shell, left-hand leaf column | a "You" screen with 13 rows, different name, different shape |
| **All conversations** as a real destination (quotes, recency buckets, filter chips) | a separate, older `mv3-chats-index` |
| **⌗ "I couldn't read this"** rows on Came-in | not drawn |
| **Paused runs as needs-you rows** with Approve/Decline inline | not drawn |
| **The new sign-on arc** (splash → sign-in → consent → names) | renders, never designed at phone width |

The tab bar is the crux. **It has three slots and it predates People, Library
and the Your Cue door entirely.** Every ruling below is downstream of what you
decide to do about that.

---

## 2 · The five rulings

Each carries our recommendation so you can agree in one line if we happen to be
right. We have deliberately built none of them.

### R1 · Do People and Library get tab slots? *(the load-bearing one)*

Desktop's rule is yours: **a destination has to prove its data accumulates.**
People and Library both passed it. A phone tab bar holds four comfortably, five
badly.

- **Our recommendation:** four tabs — **HQ · ◉ · Work · People** — and Library
  moves into the ⓶ menu's top group rather than competing for a slot.
- **Our reasoning, offered so you can reject it:** People is the surface the
  owner explicitly overruled you to promote (*"it's nice for people to think
  this is a CRM / people system that will learn and grow"*), and it is the one
  people reach for on a phone, between things. Library is a lookup — you go
  when you already know you want it, which is exactly what a menu is for.
- **What we need if you disagree:** which three or four, in order, and where
  the losers live.

### R2 · Is "You" the same thing as "Your Cue"?

The phone screen is called **You** and carries 13 leaves. Desktop's door is
called **Your Cue** and opens a shell with a leaf column. They are plainly the
same idea under two names, and their leaf sets have drifted apart.

- **Our recommendation:** one name, **Your Cue**, on both. Same leaf set, phone
  renders it as a pushed list instead of a column.
- **Why we are asking rather than renaming:** "You" may be a deliberate phone
  voice choice from the v3 NATIVE spec. If it is, say so and we will keep it
  and reconcile only the leaves.

### R3 · Where do conversations live on a phone?

Desktop just got All conversations as a proper destination — a one-line quote
from the thread, recency buckets, filter chips, "Unattached" as an honest
count. The phone has an older, plainer chats index that shares none of it.

- **Our recommendation:** the phone's chats index adopts the same model, minus
  the chip row (which does not survive 390px); filters move to a segmented
  control or a sheet.
- **The honest constraint:** the quote comes from the search endpoint, so it
  appears on search results, not on every row. Same limitation on both
  platforms — we are not hiding it on mobile, it does not exist anywhere.

### R4 · Do the new HQ states get phone treatments?

Two arrived on desktop this week and both are decisions, not decoration:

- **⌗ — "I couldn't tell what this needs."** Its whole point is that Cue admits
  it did not understand something. Absent on the phone, the item silently is
  not there at all.
- **Paused runs as needs-you rows**, with Approve / Decline inline. A run
  stopped at a send or a payment is the most literal "needs you" the product
  has, and on a phone it currently cannot be answered.

- **Our recommendation:** both come to the phone. Paused runs first — an
  approval you cannot give from your phone is the one that will actually cost
  the owner something.
- **What we need:** whether Approve/Decline sit inline on the row at 390px or
  behind a sheet, given how consequential a mis-tap is.

### R5 · Does the phone get the sign-on arc as drawn?

The Gravity sign-on shipped last night and is live. It was drawn for desktop.
On a phone the orbit, the card and the keyboard have to share a screen, and the
consent + names steps that follow have never been laid out at phone width.

- **Our recommendation:** the splash survives as-is; the sign-in card becomes a
  bottom sheet so the keyboard does not push the orbit off-screen.
- **Why this matters more than it looks:** alpha users who open the link on a
  phone meet this before anything else.

---

## 3 · Four things we found that you should know before ruling

Not requests. Context that changes the shape of good answers.

1. **The You screen had no entrance for weeks.** Every leaf carried a back
   route to it and nothing navigated *forward* to it — reachable only by
   backing out of its own children. It arrived when the tab bar went 5 → 3, and
   nobody noticed because nobody could get there to notice. Fixed. It is the
   clearest evidence that mobile nav has not had a designer's eye on it.

2. **Two headers were being painted over by the fixed corner chrome** — Work's
   title rendered as `☰ork`, HQ's eyebrow as `☰DAY · 2 AUG`. Live on
   production. Fixed, and the route list now lives in one module rather than
   being passed as a prop two screens forgot to pass.

3. **HQ's settings affordance was decorative.** The avatar chip in the corner —
   the exact position your spec assigns to the settings door — was a `<span>`
   that did nothing, while the live control was an anonymous `◍` inset 62px
   away. The thing that looked like the door was dead.

4. **`CUE_NAV` is still rendered by the phone's ⓶ menu.** It is the retired
   desktop model — Agents · Skills · Rhythms · Memory · Library. We repointed
   the menu at the current model last night, but the constant survives because
   deleting it would restructure a surface this round did not review. Whatever
   you rule on R1 and R2 lets us delete it.

---

## 4 · What we will not guess

We are not adding a tab, renaming a surface, or moving People without a ruling.
The tab bar is the one element every phone session touches, and we have already
rebuilt this navigation three times in a week. A fourth rebuild because we
guessed is worse than a day of waiting.

Everything in §3 we fixed without asking, because those were defects with a
single correct answer, not decisions.

---

## 5 · Constraints any answer has to live inside

House rules, so a returning pack does not have to be sent back:

- **Never a fake number.** A count is queried or it is absent.
- **A no-op is not a success.** Every row does what its label says or is not
  drawn.
- **No colour-only state.** Every state carries a glyph as well as a hue; text
  clears 4.5:1. Two colours in the last pack failed as text and we darkened
  them — worth checking at source.
- **Empty states say *why*** in a sentence. A failed fetch is an error state
  and must read differently from an empty one.
- **Touch affordances gate on pointer type, not viewport width.** A 720px
  desktop window is not a phone. We shipped that bug once and it cost People
  its list.
- **Safe areas.** Anything fixed to a screen edge has to survive a Dynamic
  Island and a home indicator.

---

## 6 · What we would like back

A pack that answers R1–R5, at 390×844, covering:

1. The tab bar as ruled, with the ⓶ menu's contents beside it
2. People at phone width — the accumulating surface, not a squeezed table
3. Your Cue / You: one name, one leaf set, pushed-list shape
4. The conversations index at 390px, including where filters go
5. ⌗ and paused-run rows on a phone, with the approve interaction resolved
6. Sign-on at phone width, including consent and names

Frames are enough. We do not need redlines — the phone design system
(`mobile-v3/`) already carries the tokens, and we would rather have your
decisions than your pixels.
