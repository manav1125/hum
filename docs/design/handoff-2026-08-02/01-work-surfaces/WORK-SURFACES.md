# Cue — Work Surfaces Design Handoff
**Date:** 2026-07-31 · **From:** design · **For:** Claude Code
**Build target:** `canonical/cue-canonical.html` · **Rationale:** `packs/v2` … `packs/v6`

---

## 0 · How to use this package

```
cue-work-surfaces-handoff/
├── HANDOFF.md                        ← this file, read first
├── canonical/
│   └── cue-canonical.html            ← THE BUILD TARGET
└── packs/
    ├── v2-diagnosis-and-missions/    ← why, + mission detail
    ├── v3-life-lens-and-volume/      ← Life, triage, ledger, task detail
    ├── v4-clock-handoff-waiting/     ← day rail, hand-off, waiting, Later
    ├── v5-rhythms-search-batching/   ← rhythms, ⌘K, batching, weekly review
    └── v6-onboarding-errors-hygiene/ ← day one, corrections, interruptions, a11y, data
```

**Rules of precedence:**
1. `canonical/cue-canonical.html` is the build target for **HQ desktop** and **mobile Today**. If any pack disagrees with it, canonical wins.
2. The packs are the build target for every **other** surface (mission detail, task detail, triage, ledger, rhythms, search, batching, weekly review, day one, correction, interruption policy, multiplayer, reasoning, data/exit, bulk recovery).
3. Canonical's **K3 block** lists additive deltas to apply to pack frames that predate hand-off and reasoning. Apply those; don't redraw.
4. **v1 is superseded — it is not in this package.** It led with emptiness and followed a framing we corrected.

Every file is self-contained HTML. Open at full width. **The rendered HTML is the spec** — inspect inline styles for exact values rather than eyeballing.

---

## 1 · What changed, and why

The original engineering brief (`DESIGN-BRIEF-work-surfaces-2026-07-31.md`) was written by reading the `work_items` table. It was accurate about the data and wrong about the frame: it concluded HQ is a task queue with an inbound problem. The product we've designed — and the promise on justcue.ai — is **an org of agents moving your missions forward while you sleep**.

**The single most consequential change:** a headline of *"3 things need you"* makes Cue feel like another inbox. Every competitor's dashboard opens with your obligations. Ours opens with our receipts.

Six things the DB lens couldn't see:

| # | Missed | Correction |
|---|---|---|
| 1 | The **unit of work** is the work item | It's the **mission**. Missions read "abandoned" in prod because nothing feeds them, not because the concept failed. |
| 2 | Agents are attribution strings | Agents are **staff with charters, tiers and receipts** — the actual differentiator. |
| 3 | Trust lives in Settings | **Trust is the moat** and must be visible where work happens. |
| 4 | HQ can be read-only | The **capture bar** is core loop furniture. (Regressed twice; now an invariant.) |
| 5 | Arrival is the point | **Disposition** is the point — ✨ filed onto a mission, one-tap Move, teaching loop. |
| 6 | Today is empty | 78 of 93 items came from chat. Cue **already delivers**; only inbound is missing. |

---

## 2 · The information model

```
◎ Mission (why)   →  ▣ Project (what)  →  ▤ Work (how)
   standing goal        bounded body        the items
   rings live here      artifacts/threads   "All work" = this rung
```

**This replaces "HQ vs All Work."** They are not two pages or two lenses — they are two altitudes. You go **up** for judgement, **down** for execution. Every work row carries a `◎` mission chip as a permanent breadcrumb.

**Life is a lens, not a level.** Personal items ("renew the passport", "book the dentist") are time-directed, not goal-directed. Forcing them into missions turns Cue into a project tool.

- **Work groups by why** → mission
- **Life groups by when** → This week / Soon / Someday

Marked by the `⌂` glyph and a warm card ground (`#FAF7F2` light, `#26221E` family dark). **No new accent colour.** Privacy falls out free: one lens boundary means "hide Life" is a single switch for screen-sharing, and `export work only` is trivial.

**Schema:** `domain: work | life` on the work item + an optional `horizon` for life items. Everything else is rendering.

---

## 3 · Vocabulary (no raw enums ever reach the user)

| DB value | User-facing | Glyph |
|---|---|---|
| `awaiting_review` | Needs you | `‖` amber |
| `running` | Cue is doing | pulse, blue |
| `queued` | Waiting | `○` hollow ring, faint blue = will run itself |
| — (parked) | Parked | `○` **dashed** mono = waiting for you to press ▶ |
| `done` | Done | `✓` green |
| — | Came in / picked up | `↴` blue |
| — | Ready for review | `◱` violet |
| — | Blocked | `◼` grey |
| — | Auto-filed provenance | `✨` |
| — | Batch offer | `⧉` violet |

**Queued vs parked is a real distinction:** queued = will run on its own; parked = dormant until you act. Batch-added and manually-loaded items always arrive **parked** so bulk loading can never silently spend money.

---

## 4 · The eight verbs

Identical set in triage, the ledger row `⋯`, task detail, and mobile (swipe + long-press). Muscle memory must transfer.

| Key | Verb | Semantics |
|---|---|---|
| `↵` | **Approve** | Cue's proposal ships |
| `O` | **Open** | task detail |
| `L` | **Later** | conditional snooze (see §7) |
| `⌫` | **Archive** | never deletes, never completes; teaches relevance |
| `D` | **Done elsewhere** | completes for progress/ranking; ledger records "completed by you" — **never credits Cue** |
| `F` | **File** | move to another mission or to Life |
| `H` | **Hand off** | to an agent **or a human** (see §6) |
| `⌘Z` | **Undo** | always, whole session |

Mobile: swipe-right = Approve, swipe-left = Archive, long-press = full set.

---

## 5 · HQ reading order (load-bearing — build in this order)

0. Greeting stating **delivery** + trust chip + Life/Work lens
1. **Capture bar** — ring mark, input, `⌘K`, mic. *Fixed furniture; never remove.*
2. **Day rail** — commitments, now-marker, named free block + the offer to spend it
3. **Missions** (rings) beside **Life** (horizons)
4. **Delivered** — what Cue finished
5. **Needs you** — batch offer first, then rows capped at **"3 of 6"**
6. **Census bar** — the honest count and the door to the ledger
7. **Agents now** · **Waiting on people** · **Came in**
8. **Pulse strip** — watching N sources, last check, lifetime count

> **Interim state — before watchers land (step 3).** Three modules render differently; **ADDENDUM A2** draws the frame. Came-in → *"Nothing has arrived — because nothing is watching, not because it's quiet."* Census → "93 tracked", no arrivals segment. Pulse → greyed bars, *"watching nothing · heartbeat has run 1,851 times with nothing to check."* **Rings show `✓` / `!` / `◼`, not percentages** — metric-linked progress needs arrivals. Everything else on canonical K1 runs on today's data, which is why steps 1–2 are backend-free.

**The deck never grows.** At 31 open items or 300, only the census numbers change. Needs-you is always capped with "N of M" + "Triage the rest ›".

---

## 6 · Delegation (the verb that makes the deck shorter)

Three decisions in one sheet:
1. **Who** — an agent (with receipts + honest availability, e.g. "Growth: busy") or **a human** (co-founder, EA)
2. **How far it can go** — Draft only / Do it, ask before sending / Full autonomy, plus spend cap, check-in, deadline. *This is the trust dial scoped to one job, not globally.*
3. **When you hear back**

Handed items **leave the deck** and return only as a result, a question, or a failure. They stay counted in the census (5th segment).

**Handing to a human:** the item **never leaves your mission** — you keep the ring, they get the work, and "waiting on Jess" reuses the waiting surface. If they have Cue, they get the full thread + draft; if not, a plain email Cue then tracks. Visibility is explicit and narrow: **this item and its thread, nothing else, never Life.**

**Schema:** `assignee_type: agent | human`, `delegated_to`, leash record.

---

## 7 · Waiting and Later

**Waiting has four states, each with a different right answer:**
- **Going cold** — amber, age + "you asked twice" + the person's normal habit → drafted nudge, timed from relationship memory
- **On time** — green, "Cue will chase Thu" so you can forget it
- **Already chased** — the next question is *escalate*, not nudge again
- **Waiting on a system** — nothing to do; saying so is the value

"Always chase after 5 days" converts a one-off into a standing rule.

**Later is conditional, not chronological.** Most laters wait on an event: *after the Acme call · when Rachel replies · when the pricing decision lands*. Cue is the only tool that can know when those happen. Time options remain for genuine clock cases. The learned default is highlighted and explained.

**Return contract (non-negotiable):**
1. Items return **with their reason** ("you asked for this back after the Acme call")
2. Conditions that never fire **surface anyway** ("this never happened — still want it?")
3. Snoozed work stays counted in the census and a `Later · N` filter
4. Snoozing defers **your attention**, not the agent — handed work keeps running

**Schema:** snooze stores *either* a timestamp *or* a condition reference.

---

## 8 · Volume: the four jobs

| Job | Surface | Rule |
|---|---|---|
| **Glance** | HQ | capped at 3; never grows |
| **Triage** | one card, keyboard | a Monday pile is not a longer list |
| **Hunt** | All work | collapse, filter, search, bulk |
| **Finish** | Cleared state | completion must feel like something |

**Triage:** one item fills the screen, "Cue already did" trust block so you're approving not doing, five keys, next-up peek, consequence-free exit. Work and life interleave by urgency.

**All work at 31+:** collapsible mission groups · filters (state + agent + time + Handed off + Later) · `⌘F` search · multi-select bulk bar · per-row `⋯` with all eight verbs · an explicit **"Not on a mission yet"** bucket so unfiled work is homeless but never hidden. Switching to `⌂ Life` regroups the identical rows by horizon.

**Cleared:** zero is a destination — ring completes with a spring, credit splits honestly ("14 you cleared / 11 Cue finished"), and the copy actively releases you: *"go do something else… if anything lands, it'll be here — you don't need to check."* Silent completion is a retention bug.

---

## 9 · Arrivals and filing

- Arrivals compress to **one digest row regardless of volume** ("27 arrived — Cue filed 24, kept 3"), expandable. 40 Monday arrivals must not become 40 cards.
- Every auto-filed item carries a **✨ provenance pill** naming its destination + a one-tap **Move ›**.
- The re-file sheet closes with 🧠 *"Moving teaches Cue — the next one files itself."*
- **Below-confidence arrivals are never guessed.** They get an amber `?` and stay in triage.
- The expanded view leads with a **disposition bar broken down by mission**, and the promise **"0 lost"**.
- **Batch add:** multiline entry live-parses into rows; **per-row** project assignment (confident → pre-filled chip; ambiguous → open chips + ＋New; no signal → *"Leave unfiled — Cue will sort it"*). Footnote: shield + *"Added parked — nothing runs or spends until you say so."*
- **Partial failure:** the sheet never closes. Succeeded rows collapse to a ✓ summary; failed rows stay as editable drafts with the reason; "Retry N failed" targets only failures.

---

## 10 · Rhythms (recurring work)

> **Relationship to the existing Schedules page — three surfaces, all survive (ADDENDUM A3).**
> · **↻ Rhythms** — *user-authored* recurring work (weekly update, Friday sweep, car service). Mission-attached, **produces work items**. Main nav. This section.
> · **◈ What Cue does** — *system-authored* jobs (heartbeat, consolidation, decay, filing, extraction). No mission, **produces no work items**. This is your existing Schedules data, promoted out of Settings and reframed as evidence (v2 W4).
> · **⚙ Settings → Schedules** — survives as the raw config/debug view (cron strings, enable/disable, run now).
>
> **Test:** did a human write its charter, and can it produce something needing review? Then it's a Rhythm. "Run now" appears on both user-facing surfaces; the no-op-is-not-a-success rule applies to both.

**One row per rhythm, not one per occurrence.** 52 weekly sweeps a year is one line here and zero lines in the ledger.

- 4-bar sparkline history: green = handled itself, amber = needed you, grey = skipped
- **Ledger rule:** a cycle enters the ledger **only while it needs a human**; handled cycles live in history and that day's delivered block
- **A product that generates work must notice when it's unwanted:** *"you've skipped the last 5 — Stop this?"*
- Cadence described in words, never cron

**Schema:** `rhythm` record (cadence + charter + agent) + `rhythm_id` and cycle date on generated items.

---

## 11 · Search (⌘K)

**One box, two intents:** an instruction **creates or delegates**; a question **retrieves**. Cue decides from phrasing — no mode switch.

- **Answer first, sources under it — but only for questions.** A keyword query gets the typed list with **no answer block**; never fabricate confidence.
- Spans work · life · messages · files · people
- **Decision records are a first-class result type**: *"Decision — 24-month term at $47/seat · you decided Jul 31 · 4 items depended on it."* This is institutional memory and the honest source for synthesised answers.
- `↑↓` move, `↵` open, `⌘↵` ask Cue about the selection

---

## 12 · Batching

Cue noticing that several items are one item is the clearest signal it understands the work.

- **Always an offer**, never automatic, always dismissible
- Looser members are offered as **riders** ("would ride along"), not force-merged
- **Declining twice stops it for that thread**
- May batch on: same thread · same person · same decision · same errand
- **Never** across missions, work↔life, different recipients, or two items needing separate judgements

---

## 13 · The weekly review (the trust instrument)

Friday 4pm, push + email, one screen, four minutes, three decisions.

- **What moved** — real deltas (+$75K), not activity counts
- **Who did what** — 38 you / 61 Cue = 62% share, **real spend**, and **acts you reversed** (the two figures that make it credible). *Source: the **Act ledger** — `agent_acts`. See ADDENDUM A4.*
- **What slipped** — max three, framed as leverage, never blame
- **What Cue wants to change** — and this is the part nothing else does:
  - proposes **more autonomy for itself, with evidence** ("you approved all 9 unchanged — I'd have saved you 9 interruptions")
  - asks to **retire work you ignore**
  - **volunteers its own mistakes** ("I got 2 things wrong this week")
- Add: handed-off summary ("you gave me 14 things; 12 came back done") and any corrections from §15

Progressive trust becomes a weekly conversation instead of a settings screen nobody opens.

---

## 14 · First run (the first ten minutes)

**No tour, no tooltips. The model is taught by doing one real thing.**

- One question — *"What's the biggest thing you're trying to get done this quarter?"* — produces the first mission **without using the word first**
- Three cards then explain mission → watching → hand-off in **experience order, not schema order**
- **Setup meter, non-shaming by construction:** 5 steps, 2 pre-completed, *"no rush — Cue works either way"*, and the final two steps are the moments that convert (**first hand-off**, **first weekly review**) — not profile busywork
- Disappears permanently at step 5

**Honest empty states — three kinds, three treatments, never one generic shrug:**
- **Not set up** — blue, actionable, owns the screen. The most important sentence in the product right now: ***"Cue can see your inbox — but it isn't watching it."***
- **Nothing yet** — grey, and refuses to imply quiet: *"because nothing is watching — not because it's quiet"*
- **Something's broken** — amber and **named**: *"718 memory jobs found nothing"*

**Before watchers exist**, HQ leads with what's queryable today (93 tracked / 78 from your conversations / 1,851 background checks), then the one blue "Start watching" card. **Never lead with emptiness** — it reads as a broken product.

> ⚠ Any figure on a ships-now frame must be queryable against prod. If it needs new instrumentation it gets a `NEEDS BACKEND` tag or it is cut.

---

## 15 · When Cue gets it wrong, in public

Not a failed tool call — *it worked and it shouldn't have*. This is the trust cliff. **Five rules, in this order:**

1. **Cue reports itself** — always before the user discovers it, even at 3am. Discovering it yourself is the unrecoverable version.
2. **Show the artefact verbatim** — "a message may have been inappropriate" is worse than the message.
3. **Own it in the first person** — *"I didn't have the call, so I chased her anyway."* Never passive voice, never "an error occurred."
4. **Bring a drafted fix** — plus the right to decline it ("Leave it" / "I'll handle it" are equal options).
5. **Narrow its own authority** — scoped to the failure class, reversible, with the root cause offered as the real fix.

It pushes the rest of the deck down, **always breaks quiet hours**, and lands in the act ledger + the weekly reversed-act count. **Red is reserved for this.**

**At scale (bad watcher run):** same shape. *"I filed 41 things wrong"* — counts by destination, and the number that defuses it: **"anything sent or spent — none."** One button undoes all 41; the offending rule is already paused; root cause offered as a fix.

**Schema:** `act_correction` type linking the bad act, the correction and the leash change, feeding the existing reversed-act count. Filing-run grouping so 41 acts undo as one.

---

## 16 · The interruption budget

Written as **promises about volume**, not per-event toggles. At 30 items/day the wrong policy makes the app uninstallable in a week.

| Tier | What | Limit |
|---|---|---|
| **Right now, always** | Cue did something wrong · spend cap hit · about to be irreversible | **breaks quiet hours** |
| **Within the hour** | needs you before a meeting · deadline moves inside 2h | **max 2 a day** |
| **Morning brief** | everything else that needs you · finished overnight · came in | 7:30 daily |
| **Never** | filing · research finishing · anything Cue handled · clean rhythms | silent |

**The counter-intuitive rule, stated on screen:** more autonomy = fewer interruptions. *19 interruptions/week on Assist vs 3 on Autonomous.* Trust isn't a risk you take, it's how you get your attention back.

**Schema:** interruption log to enforce the ceiling.

---

## 17 · Judgement transparency

Provenance for *filing* already exists. This is provenance for **judgement** — available on anything Cue decided.

Every line is a decision + a **clickable real source**: the mission charter, the brand voice, a specific memory, the trust setting. **No model-internals language, no confidence percentages, no "based on patterns."**

Key row: *"I didn't send it — anything leaving in your name asks first. That's your current trust setting, not a limitation of mine."* Turns a restriction into a visible choice.

**"Correct me" edits the rule, not the draft** — the difference between an assistant that learns and one you keep fixing.

**Schema:** reasoning trace stored per generated artefact. Provenance draws on the **Act ledger** (`agent_acts`), not `autonomy_ledger` — see ADDENDUM A4 for the two-ledger split.

---

## 18 · Continuity (spec, no new screen)

- **Triage position is server-side.** Clear 7 of 18 on the phone, open desktop, resume at 8 with "you started this on iPhone, 11 left."
- **Drafts follow you.** An unsent edited reply shows as "editing on Mac"; opening it takes over rather than forking.
- **Voice requests finish anywhere** — "from your voice note, 8:12" at the top of the deck.
- **Never two live copies** — soft banner + Take over. No silent last-write-wins.
- **Read state is shared** — dismissing a push on one device clears it everywhere.

**Schema:** server-side triage cursor + draft locks.

---

## 19 · Accessibility (ship blockers)

- **Never colour alone.** The glyph-first taxonomy *is* the accessibility answer — no state may be conveyed by tint only.
- **Rings need text.** "Close the seed, 68 percent, on track." A metric-less ring announces **state, never a number**.
- **The deck is keyboard-complete.** `J`/`K` move, `↵` opens, the eight verbs are single keys, `⌘K` captures, `Esc` exits. Every pointer affordance has a key.
- **Live regions rate-limited** — SSE announces at most once per 20s, focused region only.
- **Motion is decoration** — pulses, sweeps and the completion spring all have static equivalents under `prefers-reduced-motion`.
- **Contrast, both themes. Neutral text tokens:**
  - light `#6B6B60` (5.4:1 on white) — **never** `#8A8A7E` (3.1:1) or `#A8A89C` (2.4:1); those are ground/hairline colours only
  - dark `#9A9AA8` — **never** `#5B5B68` for text
- **Accent text — two values per state (ADDENDUM A1).** Text below 16px uses the **text variant**; fills, borders, glyph marks, progress strokes, ring arcs and display type ≥16px keep the bright value.

  | State | Fill / glyph / ≥16px | Text <16px |
  |---|---|---|
  | Accent / link | `#3D6EE8` | `#2B53C4` |
  | Needs you | `#B4770F` | `#8A5A08` |
  | Life / time | `#0E8C8C` | `#0A6A6A` |
  | Review | `#534AB7` | `#453C9E` |
  | Done | `#277E41` | `#277E41` (passes) |
  | Error | `#C24E42` | `#A63A2F` |

  **The one escape:** a bright value may carry small text *only* when an adjacent glyph carries the same fact (e.g. `‖` beside "Needs you"). **If the colour is the only carrier of the information, it must be the text variant — this is the ship gate.** Dark theme needs no change; bright values already measure 5.1–8.4:1 on `#0A0C12`/`#1E2027`.

---

## 20 · Data and leaving

A product that reads your email must be unusually clean here.

- **Export everything** (work, memories, decisions, files, act ledger — JSON + originals)
- **Export work only** — leaves `⌂ Life` out; the lens makes this trivial and handovers demand it
- **Forget a person** — removes their memories, stops Cue learning about them
- **Auto-forget after N months** — raw messages/transcripts age out, memories persist
- **Close your Cue** — agents stop immediately, 30 days to export, then real deletion including memories and ledger. **No retention beyond that, no reactivation offer, no exit-survey wall.**
- **"Pause everything instead"** sits beside closing as a genuine equal, not a retention trap

---

## 21 · Visual system (do not invent)

**Type:** Instrument Serif (display/headings) · DM Sans (body/UI) · DM Mono (microlabels, counts, IDs, keyboard chips). Mobile uses **SF Pro** (system) with iOS large-title physics.

**Desktop (serif HQ):** page `#F4F3EF` · card `#fff` · window chrome `#DDDAD2` · sidebar `#EFEDE7` · ink `#1A2230` · hairline `rgba(26,34,48,.07)` · Life ground `#FAF7F2`
**Desktop dark:** page `#15161B` · card `#1E2027` · inset `#282A32` · chrome `#1D1E24` · ink `#F4F4F6` · hairline `rgba(255,255,255,.08)`
**Mobile:** `#0A0C12` base, glass cards `rgba(28,32,44,.72)` + backdrop-blur over a drifting aurora, floating tab bar with raised `+`
**Accent:** `#3D6EE8` everywhere, theme-invariant

**The Cue mark:** open ring — `circle r=150 cx=232 cy=256`, `stroke-dasharray="707 236"`, `rotate(42)`, plus a blue dot at `cx=392 cy=372`. **Never a closed circle, never a letter C.** It is the heartbeat: capture bar, sidebar, mobile tab bar, Dynamic Island.

**Corner badges over thumbnails are always opaque** — solid light chip on dark art, dark glass (`rgba(10,12,18,.78)` + blur + hairline) on light or busy art. Never a translucent white chip over content.

---

## 22 · Full schema delta

| Area | Change |
|---|---|
| Life lens | `domain: work \| life` + optional `horizon` on work items |
| Delegation | `assignee_type: agent \| human`, `delegated_to`, leash record (mode, spend cap, check-in, deadline) |
| Waiting | `waiting_on` contact ref + last-chased timestamp |
| Later | snooze storing *either* timestamp *or* condition reference |
| Rhythms | `rhythm` record (cadence, charter, agent) + `rhythm_id` + cycle date on generated items |
| Decisions | `decision` record (what, when, what depended on it) — largely reconstructible from the act ledger |
| Corrections | `act_correction` (bad act + correction + leash change) feeding reversed-act count |
| **Two ledgers** | **Act ledger = `agent_acts`** ("what did Cue do?") is what §13 and §17 mean. **Trust history = `autonomy_ledger`** ("when did authority change, and why?") is a separate concern, currently unpopulated — the weekly review's leash proposals are what should fill it. Deriving it from typed `agent_acts` entries is acceptable provided both questions stay separately answerable. |
| Filing runs | grouping so N acts undo as one |
| Interruptions | log, to enforce the daily ceiling |
| Reasoning | trace per generated artefact |
| Continuity | server-side triage cursor + draft locks |
| Batching | per-thread decline memory |
| Onboarding | setup-progress record |
| Calendar | read access (exists via connector) |

Everything else — grouping, collapse, filters, bulk, triage, detail, census, rings — is **rendering over data that already exists**.

---

## 23 · Suggested build order

1. **Reorder HQ** — delivered-first + capture bar + the queryable stat row. **No backend.** The product already delivers value it isn't claiming; this is shippable this week.
2. **Honest empty states** — the three kinds, especially *"Cue can see your inbox — but it isn't watching it."* No backend.
3. **Auto-provision watchers on connector connect.** Small change; also gives missions a heartbeat and fills People for free.
4. **Mission altitude** — rings on HQ + mission detail. No schema change. This is the demo screen.
5. **The eight verbs + triage + ledger navigation** — makes volume survivable.
6. **Hand-off** — the verb that makes the deck shorter.
7. **Trust surfaced everywhere** — tier chips tappable, ledger reachable, spend on the deck.
8. **Day rail, waiting/chase, conditional Later.**
9. **Rhythms, search, batching, weekly review.**
10. **Corrections, interruption budget, a11y sweep, data/exit.**

---

## 24 · Things to never do

- Never show a raw enum (`AWAITING_REVIEW`, `QUEUED`) to a user.
- Never lead a surface with what needs the user when you could lead with what Cue delivered.
- Never remove the capture bar from HQ.
- Never show an invented number — a ring with no computable metric shows `✓` / `!` / `◼`.
- Never record a no-op as a success.
- Never let ✕ complete something, or "done elsewhere" credit Cue.
- Never auto-batch, auto-file below confidence, or auto-enable a plugin.
- Never let the deck grow with volume.
- Never hide an error Cue made, and never report it in passive voice.
- Never say "reconnecting…" when nothing is retrying.
- Never convey state by colour alone.
- Never promise something the system can't do ("as Cue meets people across your channels…" when nothing is watching).
