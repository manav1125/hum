# Night of 2026-08-01 — design handoff implementation

**What was asked:** implement the full design handoff (10 steps) and test it.
**What happened:** steps 1, 2, 3 and A1 are built, tested and deployed. Steps 4–10 are not.

This document is the honest ledger. Anything not listed as done is not done.

---

## Done, tested, deployed

### Step 1 — HQ leads with what Cue delivered
`apps/web/src/pages/hq/hq-deck.tsx` (new) + `hq-page.tsx`.

The greeting stated the user's obligations ("6 things I'd glance at"). It now states
delivery. `DeliveredBlock` renders **above** needs-you. This is §1's "single most
consequential change" and the rest of the deck follows canonical K1's reading order.

Invariants enforced **in code**, not left to call sites:
- **The deck never grows** — needs-you caps at 3, renders "3 of N", offers "Triage the rest ›".
- **Never a fake number** — `CensusBar` drops zero segments. A lane the product cannot
  answer is absent, not shown as `0`, because a zero reads as "none", which is a claim.
- **No colour-only state** — every state carries a glyph.

### Step 2 — honest empty states, three kinds
`EmptyState({kind})` in `hq-deck.tsx`.

- **not_set_up** — blue, actionable, carries the sentence the design calls the most
  important one in the product: *"Cue can see your inbox — but it isn't watching it."*
  Reads `useWatchers()`, so it **retires itself** the moment step 3 provisions a watcher.
- **nothing_yet** — grey, refuses to imply quiet: *"because nothing is watching — not
  because it's quiet."*
- **broken** — amber and named. The component supports it; the "718 memory jobs found
  nothing" instance is **not yet wired** (see gaps).

### Step 3 — connecting a connector now actually makes Cue watch it
`assistant/src/watcher/auto-provision.ts` (new).

Hooked at `recordActiveComposioToolkits` — there is no in-daemon connection-success
callback, because Composio owns the OAuth callback. All three observation paths funnel
through that one function, and because the signal is "current active set" rather than an
edge, it **back-fills every install that connected before this shipped**, which is all of
them.

**The blocker this uncovered is the most important find of the night.** Production has
**zero rows in `oauth_connections`** and **nine active Composio toolkits** — verified
directly. The watcher engine's pre-poll gate asked `hasCredentialConnection`, which reads
only the native table, so every auto-provisioned watcher would have skipped every poll
forever with "google is not connected". The whole "watchers unlock HQ" premise would have
failed silently. Fixed with `hasPollableCredential` (native **or** active Composio
toolkit), applied to both the engine gate and the Automations health dot.

Cadence: Gmail 5 min, Calendar 15 min, config floor `watchers.autoProvision.minPollIntervalMs`.
Idempotent via a durable ledger plus adoption of hand-made watchers. Disconnect is a
deliberate no-op — the watcher parks without incrementing `consecutive_errors`, so a
transient disconnect never trips the circuit breaker. **Slack is mapped but inert**: no
Slack watcher provider is registered, and a watcher on an unregistered provider
auto-disables after five failures, so the guard refuses to create one.

### A1 — the contrast token swap
Text legs across all three palette layers plus the shared `C` map. Dark/velvet text legs
are re-declared as *exactly* their fill value, so moving a call site to a text leg is a
no-op in dark **by construction**. 52 call sites across 33 files. Two genuine pre-existing
bugs found: `--mv3-fail-text` held the *fill* value under a text name, and `memory-row.tsx`
had dot values sitting in two text slots.

### Partial step 5 — one vocabulary
`work-vocabulary.ts` (new) + All work.

Found the literal cause of the `AWAITING REVIEW` badges: `item.status.replace("_", " ")` —
the database value with an underscore swapped, then uppercased. Both work surfaces now
read one module.

Also fixed a mislabel: queued items were labelled **"Came in"**. Those are different lanes.
Queued means Cue will run it itself; "came in" means something *arrived*. The old label
claimed things were flowing in from the user's channels while nothing was watching.

The eight verbs are landed **as data** (ids, keys, hints) with two load-bearing hints
asserted in tests: archive never deletes and never completes; done-elsewhere credits the
user, never Cue. **The verb UI is not built** — see gaps.

---

## Not done

| Step | Status |
|---|---|
| 4 · Mission rings | **Blocked on data, not code.** `RingsHero` exists, is wired, and already honours ✓/!/◼. It does not render because prod has one mission and it is `abandoned`; the API filters abandoned rows server-side. Needs a data fix or a product call. |
| 5 · Verbs UI, triage, ledger nav | Verbs exist as data; no keyboard handling, no triage mode, no row `⋯`. |
| 6 · Hand-off | Needs `assignee_type` / `delegated_to` / leash record (§22). |
| 7 · Trust everywhere | Not started. `agent_acts` already carries `reversed` and `cost_cents`, so the receipts are queryable. |
| 8 · Day rail, waiting/chase, conditional Later | Needs calendar read + `waiting_on` + snooze storage (§22). |
| 9 · Rhythms, search, batching, weekly review | Needs `rhythm` record, decision record, batch decline memory (§22). |
| 10 · Corrections, interruption budget, a11y sweep, data/exit | Needs `act_correction`, interruption log (§22). |

Steps 6–10 each need schema the spec itself lists in §22. They are days, not hours.

---

## Decisions you owe

1. **`awaiting_review` — "Needs you" or "Review"?** Deliverable 07 (`work-state.ts`,
   design library) says **Review**. Deliverable 01 §3 says **Needs you**. This is the
   label on the deck's primary lane *and* the sidebar badge. The README gives canonical
   precedence over the packs but says nothing about 07, so it is a design ruling. Both
   modules exist side by side with the conflict documented at the top of
   `work-vocabulary.ts`; when you rule, one should delegate to the other so a third
   vocabulary can never appear.

2. **Missions.** Prod has one mission, `abandoned` since 2026-07-16 after logging
   `drift: true, idleCycles: 12`. Nothing auto-abandons missions, so it was set via the
   API. Rings stay dark until there are live missions. Do you want abandoned missions to
   keep a ring (design has the `blocked` tone for it), or is this purely a data fix?

3. **`--mv1-amber` is `#C98A1B`** (2.9:1) and is *not* the design system's needs-you
   bright `#B4770F`. Retoning a fill is a design call, not an accessibility one.

4. **`--mv1-danger` (`#DA491A`, 4.2:1)** has no row in the A1 table and is used as small
   error text in ~12 places. A darker stop would be inventing a hue. Real remaining
   contrast failure.

---

## Known gaps in what shipped

- **Pulse strip has no check count.** A2 wants *"1,851 checks since June"* — real evidence
  Cue has been working. The heartbeat endpoint returns a page plus a cursor, not a total,
  so `heartbeatRuns` is passed as `null` and the strip degrades honestly rather than
  inventing the number. Needs a small count endpoint.
- **The "broken" empty state is not wired to real data.** Rendering "718 memory jobs found
  nothing" requires the daemon to distinguish a no-op from a success (§24: *a no-op is not
  a success*). Today both are recorded as `completed`, which is why this was invisible for
  a month.
- **HQ's A1 swap is done** — `hq-page.tsx`, `assessment-kit.tsx` and `drift-nudge.tsx` now
  use `C.amberText`. `RING_META` was flagged but deliberately left bright: its label renders
  on the rings hero, a dark card in both themes, where the bright values already measure
  5.1–8.4:1. Swapping it would have darkened text against a dark ground. `use-missions.ts`
  timeline colours still want splitting into a colour + text pair — that one is outstanding.
- **Life lens is not built.** Needs `domain: work | life` on the work item (§22).
- **Watchers are not yet verified against production.** Deployed, but confirming that rows
  appear and the engine polls needs a live check after the deploy settles.

---

## Test state

Full isolated suite: **396 passed / 13 failed across 409 files** — identical to the
documented 13-file baseline, so **zero new failures**. Four new test files tonight
(`hq-deck`, `work-vocabulary`, `contrast-tokens`, `auto-provision` + `pollable-credential`
on the daemon side). Assistant-side watcher tests 19/19.

Use `bun scripts/run-tests.ts` in `apps/web` — plain `bun test` there yields ~1163 bogus
failures from `mock.module` pollution.

---

## Late addition — the watchers actually work now

After deploying step 3, both provisioned watchers failed every poll. Gmail
returned an entire HTML 404 page for `/profile`; Calendar returned no syncToken.

**The cause was not a Composio architecture problem.** `buildProxyArgs` computed
`(req.baseUrl ?? "") + req.path`. The Gmail client passes only a path, because a
native OAuth connection carries its host from the provider seed and fills the
rest in. The proxy path had no such default, so the endpoint was the bare string
`/profile` — which Composio resolved against Google's web root. The request
authenticated perfectly and asked the wrong server for a page that does not
exist, which is why it read as a broken connector and was not one.

Fixed by supplying a per-toolkit host when the caller omits one, mirroring the
native seed. Explicit `baseUrl` still wins; with neither present the behaviour is
unchanged, so nothing that works today can start guessing a host.

**Verified on production:**

```
gmail           | err=NONE | watermark=100384294 | poll=5min
google-calendar | err=NONE | watermark=NOT SET   | poll=15min
```

That watermark is a real Gmail `historyId` from the live inbox — Gmail is
genuinely polling the API.

Two caveats, both real:

- **Calendar is still broken, and I first reported it as fixed.** A snapshot taken
  between poll attempts showed `err=NONE`, and I said both watchers were healthy. They
  were not — `consecutive_errors` was climbing. The correction, with evidence:

  `getInitialWatermark` paginates with `{ timeMin: now, maxResults: 250, singleEvents:
  true }` until a page carries `nextSyncToken`, which Google emits only on the **last**
  page. But `singleEvents: true` expands recurring events into individual instances, so
  with `timeMin: now` and no upper bound a single daily recurrence yields effectively
  unbounded future instances. Measured against the live API through the proxy:
  `timeMin=now, maxResults=2500` still returned 2500 items **with more pages**; without
  `timeMin`, still paginating after 8 pages × 2500 = 20,000+ events. The loop can never
  reach a last page, so the token never arrives and the watermark is never set.

  This is **not** the Gmail bug — Calendar always passed a correct `baseUrl`. It needs a
  strategy decision (drop `singleEvents` for the bootstrap only, bound the window and
  abandon sync tokens, or accept a narrow window), and I deliberately did not redesign a
  live sync path at 01:30 on inference. Left enabled so the circuit breaker bounds the
  wasted proxy calls, which is its designed job.
- **`watcher_events` is 0, and that is correct.** The first poll captures the
  current historyId as the watermark — "start from now" — so only mail arriving
  after 17:15 UTC creates events. HQ fills as new mail lands, not retroactively.

Both watchers had been disabled by the circuit breaker under the previous image
after five consecutive failures. That safety behaviour worked exactly as
designed; I re-enabled them by hand to test the fix.

---

# Second night — 2026-08-02

The instruction after reviewing the first night's work was blunt and fair: *"the
point of the designs was to have them all implemented not half done."* Two
things had gone wrong, and they are worth naming precisely because they are
different failures.

## What "half done" actually meant

**HQ was a retrofit, not a build.** I had added four modules to the existing
deck and reported the step complete. K1 specifies nine rows in a fixed reading
order, and six of its modules had no implementation at all — the trust chip,
the lens switch, the day rail, Life by horizon, agents-now, and waiting-on-
people. A layout that contains some of the specified modules is not the
specified layout, and calling it done was the error.

The deck now follows K1's order exactly, marked in the source so it cannot
drift back:

```
0 trust chip · 1 capture bar · 2 day rail · 3 missions BESIDE Life
4 delivered · 5 needs you · 6 census · 7 came in / agents / waiting · 8 pulse
```

**Vocabulary was decided and then not adopted.** `work-vocabulary.ts` defined
all eight verbs with their keys, hints and reversibility — and had zero
importers. The review page had two hand-rolled buttons and no keyboard at all.
Deciding a vocabulary and not adopting it is worse than not deciding one,
because it reads as done in every review of the file.

## The rule the K1 modules are built to

Every module renders, always. Where the data does not exist yet it states a
*specific reason* — "Cue can't see your calendar yet" — never silence and never
a zero.

This is enforced in the type rather than left to the caller: the modules take an
`Unavailable` carrying a required sentence, so a caller cannot make a module
vanish without saying why. A blank module is indistinguishable from a calm day,
and a calm day is a claim we are usually not entitled to make.

The calendar route was built the same way on the daemon side: when a calendar is
not connected, `bookedMinutes` and `unbookedMinutes` come back **null, never
zero**, so no client can render "9h unbooked" off an absent calendar without
first handling the null. The honesty is structural, not a convention.

## The thing that was actually wrong

The sharpest note was this: *"it's now pulling 101 things from email and
assuming they are all relevant — the whole point of your chief of staff is to
filter the crap."*

That was correct, and worse than it looked. Tracing the full path from "Gmail
watcher polls" to "work item exists" found **no relevance filter of any kind**:

- the only test applied to an arriving message is `labelIds.includes("INBOX")`
- `watcher-intake.ts` then creates a work item unconditionally — no predicate,
  no score check, no `continue`
- every scoring mechanism that exists (triage urgency, auto-file confidence,
  pre-run assessment) runs *after* the row is committed, and only ranks, files
  or gates execution. None of them can stop an arrival from becoming something
  the user must look at.

So Cue was forwarding the pile and calling it surfacing.

Two separate fixes follow, and it is worth keeping them apart:

- **Presentation** — 40 Monday arrivals must not become 40 cards. The arrivals
  digest is now one row that says what Cue *did* with the pile, and the only
  number framed as needing attention is the one Cue was genuinely unsure about.
- **Substance** — Cue must actually decide. That work is in progress: a
  relevance gate at the arrival→work-item boundary, deterministic header rules
  before any model call, a safety floor that can never file away mail from a
  known contact or a thread the user is in, and reversal recorded as a training
  signal. Fails open: a model outage surfaces the item rather than swallowing it.

**A correction to my own work.** The arrivals digest I shipped was dishonest. It
read `filed` from `autoFiledBy`, which in this codebase means "assigned to a
project" — those items are still sitting in the user's lane. The digest was
therefore claiming Cue had handled things it had merely categorised. `filed` has
to mean *handled and out of your way*, and that distinction did not exist in the
schema until the relevance work introduced it.

## Undo, and why it is session-wide

§4 promises undo "for the whole session", and that promise is what makes the
other seven verbs safe to press. A user who suspects Archive might be permanent
will read every row before acting — which is precisely the inbox behaviour the
deck exists to end.

So the stack is module-level and survives navigation: archive on the review
pager, walk to HQ, press ⌘Z, and it works. It is deliberately **not** persisted
across reloads, because an entry closes over a live mutation function and a
restored stack would offer buttons that resolve to nothing. A reload is a
legible boundary; a silently dead button is not.

## One bug found on the way

`listWorkItems` chained a `.where()` per filter. Drizzle's `.where()` *assigns*
rather than appends, so only the last one survived — filtering by status and
project together had been silently returning the whole project regardless of
status. Found while adding the Life lens, which would have been thrown away by
the same bug.

## Shipped and verified on production

Image `deployment-01KYZB3C6E11QMYMX8YSHKEDKD` (981 MB), machine `48eed1ef1411e8`.
Rollback target if needed: `deployment-01KYZ4BCVCR4P9ZCACY51P4SPD`.

**The bundle served is the bundle built.** `index-Col30-At.js` at
`manav.justcue.app/assistant/` matches `apps/web/dist/assets/` exactly. Chunk
names are content hashes, so a match is proof rather than inference.

**The gate is working on real Gmail.** This was the single biggest unverified
surface — the gate had never seen a real inbox, only synthetic payloads. The
first real arrival after deploy:

```
filed | rule | list_mail | "newsletter from Reframe Team"
work_item_minted: NONE
```

A newsletter, filed by the deterministic `List-Unsubscribe` rule with no model
call, with a reason in the owner's words — and crucially **no work item was
minted**. Before tonight that email would have become something to look at.

Schema confirmed live: the `arrivals` table exists and `work_items` carries all
five new columns (`domain`, `horizon`, `waiting_on`, `last_chased_at`,
`arrival_id`).

Both watchers healthy: `gmail consec=0`, `google-calendar consec=0`. Calendar is
genuinely fixed — it had been failing every poll and could never establish a
sync token.

### A verification error worth recording

I first reported that migration 318 had not applied, on the strength of a query
returning zero. It had applied. The real database is
`/workspace/data/db/assistant.db`; `/workspace/assistant.db` did not exist, and
my own first `sqlite3` call **created it as an empty file** and then dutifully
answered questions about it.

The lesson is the same one as the test baseline: a tool that answers confidently
is not a tool that answers about the right thing. Check the size of what you are
reading before you believe what it says — a 0-byte database will tell you
anything you want to hear.
