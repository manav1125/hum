# Brief for Claude Code — everything since your six questions

**Date:** 2026-08-02 · **From:** design · **Covers:** packs v9 → v12
**Your last input:** `BRIEF-2026-08-02-back-to-design-v7-v8.md` (six questions)
**Read with:** `README.md` (package map) · `INDEX.html` (coverage matrix) · `01-work-surfaces/WORK-SURFACES.md` (the 24-section spec)

---

## 0 · TL;DR — what changed while you were building

Your six questions got answered, and answering them exposed four structural problems we then fixed. Net result:

| | Before | Now |
|---|---|---|
| **Mobile tabs** | Today / Projects / + / Voice / You | **HQ · ◉ · Work** (3) |
| **Desktop sidebar** | HQ / Missions / All work / Agents / … | **Talk to Cue · HQ · Work** (+ Things/Everything, then deeper surfaces) |
| **The ledger** | "All work", its own destination | **A view inside Work** |
| **Top-level nouns** | mission, project, work item, Life | **thing, task, goal, professional/personal** |
| **Landing** | HQ deck | **Composer**, HQ one tap away |
| **Never designed** | the conversation itself | **Drawn (v12 P1)** — highest build priority |

**Nothing about the eight verbs, the taxonomy, the tiers, or the honesty invariants changed.** Those all survived intact.

---

## 1 · Your six questions, answered (pack v9)

### Q1 · Sender identity — **you were right, your rule is adopted**
A stack groups by **registrable domain AND a structurally-automated local part** (`no-reply@`-shaped). Your constraint is now the rule: **a stack can never contain a human's message.**

Rejected: display name (breaks on `HSBC` vs `HSBC eStatement`) and bare domain (folds a colleague into their employer's robot). Your false-positive argument decided it — **a bad merge hides an obligation; a bad split merely shows it twice.**

The three grouping concepts are cleanly separable, and your existing code already handles two of them:
- **Stack** = inbound robots. Domain + automated shape. Never human.
- **Thread** = one human conversation, many replies → one task. Exact address + thread id — **already built.** (v7's BA example was a thread, not a stack.)
- **Batch** = an *outbound* offer you accept. Human, but never a merge Cue performs.

### Q2 · HQ order before the landing ships — **neither (a) nor (b)**
Don't hold, and don't reorder blind. **Ship the reorder together with the delivery sentence** — which is a strict subset of the landing work (one line, already specified, no new surface, no new data).

Interim HQ, top to bottom: **delivery sentence → composer → needs-you → delivered → rest per v7.**

Delivered-first survives in compressed form, so HQ never opens on obligations alone. When the landing surface ships, the sentence lifts out of HQ and becomes the door — and HQ needs no further reorder, because by then v7's justification is literally true.

### Q3 · Comprehension failure — **new state, and it is not a task** (frame N1)
You were right that inventing an action is worse than keeping the subject. Two distinct admissions need two distinct treatments:

- *"I don't know where this goes"* → filing confidence → amber `?` (already specified)
- *"I don't know what this is"* → comprehension → **the new `⌗` state**

An un-comprehended arrival **stays in arrivals and never enters the task list** — it hasn't earned a task row. Render: `⌗` glyph, subject in **italic quotation marks** (the typographic signal for *their words, not my summary*), and one honest line — *"I couldn't tell what this needs."* The only action is **Open it**; Cue has no opinion so it doesn't manufacture one. The `⋯` still carries all eight verbs, so you can file, archive or hand off something Cue never understood.

**Header counts it separately** — "2 I couldn't read" beside filed and dropped — so the comprehension failure rate is watchable.

**Stack line: "1 I couldn't read"** — never merged with "1 may matter". One is a claim about the content; the other is a claim about Cue.

### Q4 · Read-only — **don't wait on Composio** (frame N2)
The promise was mine to fix and the fix is better. **Scope is Composio's; behaviour is ours.**

Even with a full OAuth grant, Cue starts in an **app-enforced watch-only mode**:

> *"Cue starts by watching only — it reads, files and drafts. It will not send, reply, book or spend anything until you turn that on."*
> …plus the ledger as proof, and where to change it.

More honest than a scope claim, because a read-only scope was never the protection people actually want — the protection is *it won't act without asking*. **Ship this regardless of what Composio comes back with.** If read-only scope turns out to be available it's a quiet bonus, not the headline.

### Q5 · Missions don't start anything — **the recruit moment** (frame N3)
Auto-recruiting on save would be the most alarming thing in the product; sitting inert is the second. The missing control is a **recruit screen** shown immediately after the charter is written. Before Cue may move it states three things:

1. **Who** — the agent, with receipts and tier ("128 acts · 0 reversed · Tier 3")
2. **The first three actions** — *including where it will stop and ask*
3. **What it costs** — cadence and rough spend

Then one **Go**. "Save it, don't start yet" reuses the existing **parked `○`** — no new state needed. This solves your control gap and a trust checkpoint in the same screen.

### Q6 · Tab bar — **took three passes; final answer below**
Covered in §2, because it changed twice more after v9.

---

## 2 · Navigation — the part that changed most (v9 → v10 → v11)

### The mobile tab bar, final: `HQ · ◉ · Work`

Three iterations, and the reasoning matters more than the answer:

1. **v8 dropped the centre `+`** — correct reason (the composer *is* the plus), but priced the muscle-memory cost at zero.
2. **v9 put it back as a floating mark** — wrong reason. Asked *"what does the C point to?"* the answer was **nothing**: a no-op on home, a duplicate of the home tab everywhere else.
3. **v9.2 final** — **centre the mark and make it the home tab itself.** Real destination, real active state, fastest route back to talking, **and it pulses while agents are working.** One element doing three jobs instead of one doing none.

**Everything else moved by frequency of use:**

| Frequency | What | Where |
|---|---|---|
| Many × day | Talk to Cue | **◉ centre tab** |
| Glanced constantly | Is Cue working? | **◉ pulse** |
| Daily | Review what needs you | **HQ tab** |
| Daily | Get into the work | **Work tab** |
| A mode, not a place | Voice | **mic in the composer** (+ long-press ◉) |
| Weekly-ish | Past conversations | **☰ top-left** |
| Rarely | Trust, brand, connections, data, settings | **avatar top-right** |

Two of the old five slots went to things touched weekly or less, which is what squeezed the actual work.

**Context capture stays contextual, not global** — *"Ask about this thing…"* sits at the bottom of every detail screen and carries context a global button would throw away.

### Desktop sidebar, reconciled (v11 frame C1)

v10 was drawn phone-only, so the two platforms briefly disagreed about the information model — worse than either being wrong alone. Now:

```
◉  Talk to Cue          ⌘K
◈  HQ                   3
▤  Work                 5
     ◱ Things
     ≣ Everything       31
   ── deeper ──
◆  Agents
↻  Rhythms
👤 People
✧  What Cue does
🛡  Trust & guardrails
```

Top three match the phone's three tabs exactly. Desktop shows more, but the model is identical.

---

## 3 · HQ vs Work — what each is for (v10)

**This was the hardest question and it's worth stating precisely, because you'll be tempted to merge them.**

| | ◈ HQ | ▤ Work |
|---|---|---|
| Cuts | **across** all things | **into** one thing |
| Shows | only what's true today | everything, urgent or not |
| You come to | **clear** | **dig in** |
| It | **empties** | never empties |
| Answers | "what should I do next?" | "where is everything about X?" |

**Neither can do the other's job.** HQ can't answer "where's everything about Acme" because it deliberately hides the 8 things that aren't urgent — and those 8 are exactly what you need when you sit down to work on Acme. Work can't answer "what's next" because urgency is cross-cutting; your 10:30 deadline doesn't care which container it's in.

This is inbox/folders, Today/projects, my-issues/board. Nobody experiences those as two dashboards, because **one empties and the other doesn't.**

### Navigation depth: two levels, never three
```
▤ Work                                  the list of things
  └ Renew Acme                          the room: tasks, artifacts, people, spend
      └ Confirm the 24-month position   the task
```
**It is NOT Work → mission → project → task.** There is no mission level to click through. **Two taps to anything**, from either surface.

If Cue later groups things under one goal, that grouping is a **collapsible header inside the Work list** — you still tap the thing beneath it, never the header. It adds no depth. That's the entire reason grouping is an offer rather than a level.

### The Work row must be a doorway, not a tile
Every row carries **"1 needs you · 2 running · 9 total"** plus the agents on it. A ring and a status word alone reads as a dashboard; counts and agents make it a door you can see a room behind. This was a direct correction — the first version read as a portfolio summary and the owner called it.

---

## 4 · Vocabulary — settled, and two collisions removed (v10, v11)

| Word | Means |
|---|---|
| **thing** | What you're trying to get done. Finishing or ongoing. Holds the charter, agents, budget. |
| **task** | One piece of work inside a thing. What the eight verbs act on. |
| **goal** | An optional header grouping 2+ things. **Offered, never imposed.** This is what "mission" becomes. |
| **professional / personal** | The domain. Lives on the **thing**; tasks inherit. |

**Retired:** `mission` → goal (label only, never a level) · `project` → thing *in UI copy* (the table name can stay) · `All work` → Work → Everything · `Life` → Personal.

### Why "mission" was retired
Our own mocks named the same three things twice — `Close the seed`/`Seed raise`, `Renew Acme`/`Acme renewal`, `Ship Halo`/`Halo launch`. **We built a two-level hierarchy and never once produced example data that respected it.** Your prod data agreed: 1 active mission, 1 abandoned, while projects are what people actually make.

What survives is the real distinction, as a **property rather than a level**:
- **Finishing** — has an end. Ring shows progress. (What `projects` already holds.)
- **Ongoing** — doesn't end. Shows **health, never a percentage** — "68% of keep-the-pipeline-warm" is exactly the fake number our own rule forbids.

### Two naming collisions we caused and fixed
1. **Work tab / work-vs-life filter.** "Work tab, filtered to Work" is nonsense → renamed to **Professional / Personal**, which is the owner's own phrasing from your bug report.
2. **Work tab / "All work" ledger.** Both called work → **merged**, not renamed. Work now has two views: **Things** (containers) and **Everything** (the flat ledger, with all its filters, search, bulk select and the "Not in anything yet" bucket). Grouping headers in Everything are the same things listed in Things, so the two views are provably the same data.

**Process rule added to the spec:** *a rename is only finished when nothing else answers to the old word.* Both collisions came from reusing a word that was already load-bearing.

### Where the domain classifier lives
```
thing (finishing | ongoing)
  domain: professional | personal    ← lives here
  charter, agents, budget
task
  inherits domain from its thing
  unattached → carries its own
```
Already how your build works — `domain` shipped on projects, which is why "move a project from personal to professional" is the open request. Moving the container moves everything inside it.

**Two hard rules:** a **goal can never span domains** (otherwise "hide Personal" half-hides a group and the screen-sharing promise breaks), and an **un-comprehended arrival has domain unset, not defaulted** — guessing Professional would leak a personal item into a shared export.

---

## 5 · Work's day one (v11 frame C2)

Every v10 frame showed a populated account; a new user's Work tab is empty and nobody drew it. The empty state:

- **Teaches the word "thing" in a sentence**, not a tooltip — *"A thing is whatever you're trying to get done — a deal, a launch, a raise."*
- **Two starts**, and says the second is usually better: *Name one yourself* / *Tell Cue what you're working on*
- **Does the move only Cue can** — reads what's already arriving and proposes three candidates with evidence: `＋ Acme · 14 emails` · `＋ Halo · 9` · `＋ Seed round · 6`
- **Stays honest** — *"Until then Cue still answers, drafts and files — it just won't have anywhere to put the results."*

---

## 6 · The four gaps that matter most (v12) — **read this section even if you skip the rest**

Reading twelve versions back as a user rather than an author, the system is unusually careful and still not yet a partner. Four findings, in build priority order.

### 6.1 · The conversation surface — **the biggest hole in the product** (frame P1)

**The app opens on a composer and we never designed what happens after you type into it.** Every frame in v1–v11 shows the moment before a conversation or the artefacts after it. The most-used surface in the app — and the only one where Cue's character is visible — was blank.

Four things must happen that don't happen in a chatbot:

1. **Answer from the user's data, sources collapsed underneath.** "$47 a seat, 24 months" first; *"from your pricing model, Dana's last email, and the Northwind deal"* as a quiet expandable line. **Confidence lives in the willingness to be checked, not in hedging language.**
2. **Ask when it's genuinely ambiguous — never to seem careful.** *"Dana's thread or Rachel's?"* One clarifying question is partnership; three is a form. If Cue can pick right 90% of the time it should pick and say which.
3. **Work arrives as an artefact, not prose.** Anything sendable/savable/schedulable renders as a card with its verb on it. **Never make someone copy text out of a chat bubble.**
4. **Volunteer at most one adjacent thing, only from what it just touched.** *"While I was in there — the security questionnaire is still open with Rachel, six days now. Chase it too?"* **That bubble is the whole product.** Two is nagging; unrelated is creepy.

Plus: **a conversation belongs to a thing** (header shows `▤ Renew Acme`, so output lands in the right place and the thread is findable later from the thing itself), and **long work leaves the chat** — anything over ~30s becomes a task with a live line, never a spinner. The conversation must never block.

### 6.2 · Cue's voice — the spec we never wrote

Cue speaks on every surface now and our own copy drifts: *"40 arrived · 31 filed · 9 dropped"* is a log line; *"You're clear. Go do something else."* is a person. Both are ours. **Pick the person.**

- **Brief, not curt.** Ten words where a form uses three. "Nothing needs you" beats "0 items".
- **First person for its own actions, always.** *"I chased Sarah" · "I couldn't read this one" · "I let it slip."* **Passive voice is where products hide**, and it's the fastest way to stop feeling like a partner.
- **Never enthusiastic about its own work.** No "Great news!", no "I'd be happy to". Praise from a tool about its own output is the tell that nobody's really there.
- **Warm at the edges, plain in the middle.** Greetings, completions and apologies carry warmth; lists, counts and states stay flat — a cheerful status row is exhausting by the fortieth read.
- **Has opinions and gives them once.** *"I'd put pricing in Dana's thread"* — then does what you say without restating.
- **Never apologises twice, never grovels.** One clean *"that was my call, and it was wrong"*, the fix, the narrowed leash, back to work.

**Cheapest item on this list and the largest change in how the product feels.** No new screens — a spec page and a copy pass over what exists.

### 6.3 · Welcome back, and the states we never designed for (frame P2)

A week away is the moment a partner proves itself and the one the current design serves worst — "3 need you" becomes "47 need you" and the deck's honesty turns into an accusation.

**312 arrivals rendered as three numbers and one button:** handled 297 · needs you 4 · **I let slip 2**.

The move that makes it a partner: **Cue leads with what it got wrong, unprompted, before you could discover it** — *"Two I should have escalated: the CIPA annual return was due Tuesday, and Sarah asked twice about the data room. Both my call, both wrong."* Then offers to walk you through the rest conversationally rather than dumping a queue.

**Four user states, all using signal you already have:**
- **Away** — know it from the calendar, batch instead of interrupt, escalate only the genuinely urgent, hold the rest. **One setting, no new UI.**
- **Slammed** — back-to-back calendar shrinks the deck to one item.
- **Avoiding something** — skipped 5×, stop re-showing it identically: *"You've passed on the Halo pricing all week — is it the wrong question, or the wrong time?"*
- **Quiet** — say it. *"Nothing's urgent today. Good day to do the thing you keep pushing."*

The deck currently renders identically regardless of the user's state. A partner adjusts **how much it asks of you** based on the kind of day you're having.

### 6.4 · Show the relationship deepening

Day 200 looks like day 1 with more rows. Cue accumulates memory, receipts and trust and never mentions it. Three moments, no new surfaces:

- **Notices patterns out loud** — *"You've never once done admin on a Friday. I'll stop putting it there."* A memory surfaced as a behaviour change. Data exists today.
- **Milestones, sparingly and specifically** — *"Acme renewed. 47 days, 61 things, 3 of them yours."* Not confetti — a real number showing what it carried. Once per finished thing, **never per task**.
- **Trust growth narrated** — *"Three months ago you checked everything I sent. Now you check the ones over £1,000."*

**The discipline that stops this becoming slop:** every one is a specific checkable fact. The moment it becomes "You're doing great this week!" it's worse than silence. **Same rule as everywhere: never a fake number.**

---

## 7 · Build order

| # | What | Backend? |
|---|---|---|
| 1 | **Reorder HQ** — delivery sentence + composer + needs-you + delivered | **None** |
| 2 | **Honest empty states** — the three kinds, esp. *"Cue can see your inbox — but it isn't watching it"* | **None** |
| 3 | **Voice spec + copy pass** — §6.2 | **None** |
| 4 | **The conversation surface** — §6.1 | Yes, and it's the priority |
| 5 | Auto-provision watchers on connect → swaps the three interim modules (ADDENDUM A2) | Yes |
| 6 | Work tab: Things + Everything views; retire "All work" as a destination | Small |
| 7 | Mobile tab bar → `HQ · ◉ · Work`; Voice → mic; You → avatar; history → ☰ | Small |
| 8 | Recruit moment (§Q5) · watch-only default (§Q4) · `⌗` state (§Q3) · stack rule (§Q1) | Mixed |
| 9 | Welcome back + the four user states | Yes |
| 10 | Pattern-noticing, milestones, narrated trust | Yes |

**Steps 1–3 need no backend at all** and are the highest-value change available today — the product already delivers value it isn't claiming.

---

## 8 · Schema delta since your last brief

| Area | Change |
|---|---|
| Domain | `domain: professional \| personal` on the **thing** (was `work \| life` on the item). Tasks inherit; unattached carry their own; **unset when un-comprehended.** |
| Things | One object with `completion: finishing \| ongoing`. Ongoing stores **health**, never a percentage. |
| Goals | Optional grouping over 2+ things. Cannot span domains. |
| Stacks | Group key = registrable domain **+** automated-local-part test. Never groups a human. |
| Comprehension | An arrival can be `un_comprehended` — keeps its subject verbatim, mints **no task**. |
| Watch-only | App-enforced starting mode, independent of OAuth scope. |
| Recruit | A thing has `started: bool`; unstarted renders as parked `○`. |
| Conversations | Belong to a thing (nullable). Long work spawns a task and returns a live line. |

Everything else — grouping, collapse, filters, bulk, triage, census, rings — is **rendering over data you already have.**

---

## 9 · Invariants (unchanged, still binding)

1. Lead with delivered, not needed — except on the deck reached *via* the delivery sentence, where needs-you leads because receipts were already given.
2. One "needs you" definition: `awaiting_review` + assigned to you. Badge, headline and rows are the same set.
3. Eight verbs everywhere: Approve · Open · Later · Archive · Done-elsewhere · File · Hand off · Undo.
4. The deck never grows — needs-you caps at 3 with "N of M".
5. The composer is fixed furniture. **It has been accidentally dropped twice.**
6. Never a fake number — `✓` / `!` / `◼` when there's no computable metric.
7. A no-op is not a success.
8. Cue reports its own errors first, in the first person. **Red is reserved for this.**
9. Archive never deletes; "done elsewhere" never credits Cue.
10. No colour-only state — every state carries a glyph: `‖ ◱ ✓ ↴ ◼ ○ ✨ ⧉ ⌗`.
11. Three tiers, not "always render". Honesty lives in the statement, not the card.
12. Collapsing never buries a live item.
13. A row gets three slots: verb phrase · thing chip · one timing fact. Provenance lives behind it.
14. Personal never leaves — not in exports, shared links, or work handovers.
15. **Banned text tokens:** `#5B5B68` is never text (regressed 4×). Dark muted = `#9A9AA8`, light muted = `#6B6B60`. Never `#8A8A7E` or `#A8A89C`.
16. Accent text under 16px uses the text variant: `#3D6EE8→#2B53C4` · `#B4770F→#8A5A08` · `#0E8C8C→#0A6A6A` · `#534AB7→#453C9E` · `#C24E42→#A63A2F`.

---

## 10 · Still open — six mobile gaps

Named in `INDEX.html` and unchanged by v9–v12:

**interruption budget** (worst — a push-notification policy with no phone screen) · **search** · **reasoning panel** · **rhythms** (read-only is enough) · **data/export/leaving** · **multiplayer**.

Plus two **deltas rather than gaps**: mobile batching exists in canonical K2 but predates v7's rules, and the mobile onboarding arc is split across the sign-on pack and frames 26–28 without v7's connector gate.

---

## 11 · Precedence — which file wins

1. **v12** — the conversation surface, voice, welcome-back, relationship moments.
2. **v11** — vocabulary, desktop sidebar, Work's two views, day one.
3. **v10** — HQ vs Work, the detail screen, the domain classifier.
4. **v9** — the six answers; its tab-bar first pass is superseded by v9.2 in the same file (shown as rejected).
5. **v7 / v8** — three tiers, landing, stack rows, connector gate, mobile + web rules. Still stand except where above supersedes.
6. **canonical** — HQ *structure* (nine-row order, modules, K3 leaf deltas). v7 changed its render policy, not its order.
7. **ADDENDUM** — overrides §19 tokens, §10 rhythms scope, §13/§17 ledger naming everywhere.
8. **v1 is absent by design.**

**Tie-breaker:** if mobile and desktop disagree about whether something deserves weight, **mobile is probably right** — the phone forces the question desktop can dodge.
