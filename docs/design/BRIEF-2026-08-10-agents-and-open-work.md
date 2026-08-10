# Brief for design — the agent programme, and everything else open

**Date:** 2026-08-10 · **From:** code · **Status:** ready for a design turn

Two things in here. **Part 1** is a new programme — agents that own work — and it
needs real design thinking; it's the bulk of this document. **Parts 2–4** close
out everything else currently open, so this can be reviewed and actioned in one
pass rather than in fragments.

---

# Part 0 — Where Cue is right now

## What shipped this week, with measured effect

The volume valve was fixed and deployed. It had one clause treating a **filing**
decision as evidence of **urgency**, which made the three stops meaningless.
Before and after, on the owner's live instance:

| | Before | After |
|---|---|---|
| `urgent` band | ~104 | **4** |
| `needs_you` | — | 260 |
| `everything` | — | 7 |

Two rules that had been **unreachable code** now fire: `direct_person` (225
firings) and `automated_sender` (7). Someone had already diagnosed the
over-firing correctly and written the cure; an earlier branch shadowed it.

Also shipped and verified: schedules now inherit the owner's timezone (two had
been firing 8 hours off their stated time for months); a rate limit no longer
renders as an empty state; the Morning Brief no longer says "All quiet" over
seven waiting items; the People interactions panel no longer prints a count
beside copy denying it; a self-hosted owner is no longer told to log in on ten
surfaces.

## The standards in force

Four were already standing. The fifth is design's own, from v38, and it turned
out to name the pattern behind three of this week's fixes:

1. **Never a fake number.** A pending value is an em-dash, never a confident zero.
2. **A no-op is not a success.**
3. **A failed fetch is an error state, not an empty one.**
4. **The valve fails open** — if Cue can't score something it treats it as urgent.
5. **A surface may only claim what a rule can produce.** "Needs you" outran its
   rule at 264 items. "Going quiet" had a slot and no signal. The action board
   displayed a verb it couldn't perform. Same defect, three shapes.

Design's suggested review question, now adopted: **which rule produces this
label, and what does it say when the rule returns nothing?**

## The finding that frames Part 1

**271 arrivals a day is the real problem.** No valve stop makes that pleasant.
The valve is triage, not a fix — the fix is Cue handling more without asking,
which is the autonomy story, which is what agents are for.

---

# Part 1 — The agent programme

## The defect that started it

The Agents surface shows **"$31 spent this week · 0 acts"** across all four
agents. The agents are not idle — `agent_acts` holds 68 rows, 14 in the last
week. The zero is a lookup miss.

Every work item is assigned to the literal string `"cue"` (586 of them). Acts
inherit that. The four agent ids (`ops`, `builder`, `growth`, and a UUID for
`Inbox`) match nothing, so every per-agent count renders 0 while spend — a
global sum — still shows money.

**Nothing routes work to the four agents.** They exist as rows, the cadence
engine runs, and no rule assigns anything to them.

Worth noting: `assignee: "cue"` isn't really wrong. It's the generalist owning
everything — we just never modelled the generalist as an agent. That makes the
migration much cheaper than it first appears.

## What a Cue agent is — and isn't

**It is a preset over the runtime we already have**, not a new execution engine:

- a harness — system prompt, guidelines, worked examples
- a subset of skills it may reach for
- connector scopes it needs
- a capability tier (cost follows from this)
- guardrails — what it may do unattended, and its spend ceiling
- optionally, memory scoping — what it may see

**It is NOT an A2A agent.** A2A is the interop standard for talking to agents
*outside* Cue. Cue's agents run *on* Cue. Both may exist; they are different
things and should not share a surface without a very deliberate reason.

Because an agent composes skills, connectors and tiers, its extensibility story
is identical to those — which is the point.

## Why it should exist — the case, ranked by evidence

Three of these are grounded in problems Cue has already measured.

**1 · Context economy — this is already our ceiling.** Tool-schema pruning took
us 93k → 36.6k tokens, and the SkillOpt work concluded the ceiling is *context
overflow, not prompt quality*. A generalist carrying every skill is structurally
capped. A specialist carrying six isn't. **A specialist is not a better model —
it's a smaller problem.**

**2 · Narrow scopes are how autonomy becomes safe.** A generalist that can do
anything needs approval for everything, because you can't grant "send email"
narrowly to something that can also move money. After the rogue-send incident,
this is the only credible path to more autonomy: not "trust Cue more", but
"trust this narrow thing completely, and nothing else at all."

**3 · Attribution.** Unowned work is unaccountable work — the "$31 · 0 acts" bug
generalised. You can't ask "was that worth it" about a generalist.

**4 · Improvement needs somewhere to attach.** A generalist's learning is
diffuse and tuning it risks regression everywhere. A specialist's harness is
bounded, versionable, evaluable, rollback-able.

**5 · Encoded expertise.** Real, but the weakest on its own — and the one every
failed agent store led with.

## Competitive position — and one security finding that matters

Upstream Vellum (65 repos, `vellum-assistant` at 1,032 stars) has built:

- **`agent-hq`** — "Notion-backed team hub for sharing assistant skills."
- **`level-up`** — append-only log of every self-edit the assistant makes to its
  own skills/plugins, with byte-accurate diffs.
- **`evals`** — "a benchmark runner to evaluate various Agent Harness profiles
  against each other."
- **subagents** — ephemeral, spawned per task, `pending → running → completed`,
  no persistent identity.
- **A2A agent cards** — `skills[]` of `{id, name, description, tags}`.

**Their unit of composition is the SKILL. Ours is the AGENT.** They are building
*one assistant that acquires skills*; Cue is building *a team of agents that own
work*. Not a gap in their product — a different product. Their primitives
transfer only partially.

**The finding design should know about:** `agent-hq` has **no registry, no
capability manifest, no permissions, and no review before install.** Its stated
security model is *"treat hub content with the same trust you give a teammate's
Notion page."*

That is entirely defensible **because their shared thing cannot act** — the
publishing rule is explicit: *"instruction-only: `SKILL.md` and `references/*.md`
travel; scripts and other executables never do."*

**Cue's agents act.** They send email, spend money, and run under Guardrails.
A Cue marketplace agent arriving with "trust it like a teammate's Notion page"
is the rogue-send incident, productised and distributed. **The layer Vellum
deliberately skipped is the layer Cue must build** — and Guardrails already
exists to enforce it, so we're closer to it than they are. That layer is
simultaneously our obligation and our moat.

Worth stealing outright: their **instruction-only** rule. Even with review,
executables should never travel.

## Both creation and pre-built — and why that's one mechanism

The owner wants agents created on demand *and* a catalogue of pre-built ones
that demonstrably already do the work. These are closer than they look:

- **Creation** = an empty preset that narrows to your work
- **Pre-built** = a preset with a head start, narrowing the same way

If a pre-built agent is **static**, it will underperform on any specific owner's
real work — the template-gallery failure. If it **adapts after install**, it's
just creation with a seed. One mechanism, seeded differently. Build the
adaptation path first; the catalogue sits on top.

**What reads as expertise is depth, not breadth.** An invoices agent that knows
about duplicate submissions, PO mismatches and vendors who suddenly change bank
details has done the job. One that says "I process invoices" is a wrapper. Each
pre-built agent is a promise we have to keep, and one bad one poisons trust in
all of them.

**Make "it already does the work" falsifiable** — ship each pre-built agent with
its own eval set. "94% on 40 invoice cases, here they are" is a
category-different claim from "I handle invoices", and it satisfies rule 5.

---

## ▶ DESIGN ITEM 1 — The specialist, end to end

One agent, complete, as a single flow that both creation and install produce.

Questions to answer:

- **What is an agent to the owner?** A worker with a workload? A capability the
  assistant gains? A named colleague? This decides whether the surface leads
  with throughput, capability, or identity — and whether "install an agent"
  reads as hiring, upgrading, or subscribing.
- **How does an owner create one?** "Make me an invoices agent" — what does Cue
  ask, and what does the owner see being assembled?
- **How does it declare what it owns?** This is the routing input. It must be
  matchable deterministically (see constraints below).
- **What does the owner see before granting autonomy?** Scopes, tier, cost
  ceiling — and how is granting expressed?
- **What does its card show once running?** Items taken, completed, handed back?
  Cost against cap?
- **What happens when it declines or fails?** Handoff back to the generalist
  must be *visible* — a silent handoff is work that looks owned but isn't, which
  is the failure class we spent this week removing.
- **How can the owner see it got better?** This is where a `level-up`-style
  append-only record and an eval set attach.

## ▶ DESIGN ITEM 2 — The agent card at first meeting

The trust moment, and the part with **no precedent to borrow** — upstream
deliberately skipped it.

A pre-built agent on day one has **no history with this owner**: no acts, no
cost, no track record. Rule 1 forbids inventing them. So:

- What does the card show *before it has done anything*?
- Our position: **what it claims, what it needs, and how it performed
  elsewhere** — declared scopes, capability tier, expected cost, eval results.
  Honest, and more useful than a zero.
- How is "this agent needs to send email on your behalf" presented so the owner
  can actually weigh it?
- What distinguishes a Cue-authored agent from a third-party one, visually and
  in terms of trust?
- What does the owner see when an agent asks for *more* than they want to give?
  Partial grants — install it but withhold sending — need a shape.

## The first three specialists, and why

Chosen from **measured volume in Cue**, not from categories that sound
impressive. Each has a number behind it:

1. **Triage / inbox** — 271 arrivals a day, the loudest real problem.
2. **Scheduling** — `calendar_action` fires on real conflicts and invites
   needing answers.
3. **Follow-up / relationships** — the responsiveness signal already specced for
   "Quiet lately" and the valve's fourth stop.

Three agents each solving something countable beats twelve gesturing at a
market.

## Constraints from code (design should not design around these)

- **Routing must be deterministic, not a model call.** It runs at intake, which
  is hot and already fragile — an arrival-comprehension timeout on that exact
  path was this week's #66. Matching on declared tags is a string operation.
- **The generalist is always the default owner.** A specialist takes work only
  when it positively claims it *and* the owner has granted it. **Never
  auto-route to an installed agent.** Conservative selection is cheap; a wrong
  one is a trust event.
- **Cost is an ask, not a grant.** An agent declares what it *needs*; the owner
  grants what it *gets*. The budget hard-stop engine (Paperclip WS1) is built
  and inert — this is its use case. Never let a third party set the owner's cap.
- **Agents declare a capability tier, never a provider.** The owner ruled this
  week that provider names come out and capability tiers stay. An agent
  advertising "powered by X" breaks that ruling *and* makes quality legible as
  model choice rather than harness quality, which is the opposite of where we
  want competition.
- **Act attribution already works.** `agent-act-store.ts:288` writes
  `agent: workItem.assignee`. Fix the assignee and the ledger fixes itself —
  no changes to act recording.

## The question code cannot answer

**Is "agent" a distinct enough noun for the owner?** Cue already ships skills,
plugins, connectors, missions, playbooks, watchers and standing agents. Design
killed the action board this week precisely for being a second name for one
thing.

If an owner can't instantly answer *"why would I install an agent instead of a
skill?"*, the store adds confusion rather than capability.

Proposed line, offered for design to accept, sharpen or reject:
**a skill is something Cue can do; an agent is someone who owns work.** Skills
are verbs, agents are owners. An agent with no ownable stream of work has no
reason to exist — which also gives the store an admission test: *if it doesn't
own work, it's a skill, and it belongs in the skills marketplace.*

---

# Part 2 — Specced and ready to build (no design input needed)

Listed so the review is complete. All are actionable today.

- **"Quiet lately"** (People tab 4) — design's own v38 §2 spec, fully
  sufficient: eligibility ≥5 inbound over ≥30 days; **median** gap over 180 days
  as baseline; quiet at >3× median AND >14 days; sorted by distance past *their
  own* normal; every row showing its arithmetic; four states.
- **Delete the action board**, fold into Work — v38 §3, owner confirmed. Gated
  on first verifying the 07:30 push is wired to the daily brief, so nothing goes
  silent in the handover.
- **Composer model picker** — remove provider names, keep capability tiers,
  Cue-brand them, **keep Assistant Access visible**. Implementation ruled:
  mark tier-ness as data in config rather than string-matching vendor names, so
  an owner's own custom profile isn't silently hidden.
- **49 sub-AA contrast nodes** across HQ, Work, Agent network. (The 18 Library
  hits in the original count were false positives — white on a dark gradient the
  scanner couldn't see.)
- **Gateway blast radius** — a 401 on one route currently locks out every route
  for that IP. The desktop lockout fix removed the *cause*; this is the *weapon*,
  still loaded for any other client.

# Part 3 — Rulings made this round, for the record

- **Agent routing:** capability-based. A generalist handles ~80% of
  non-specialised work; specialists sharpen over their own harness; marketplace
  opens BYOA later.
- **Provider disclosure:** capability tiers stay, Cue-branded; provider names go.
- **Self-hosted platform gate:** classify as `gated`, not `disabled`. *(Shipped.)*
- **"Quiet lately":** build it.
- **Action board:** delete it.
- **Valve stops:** relabelled so each name states its rule. *(Shipped.)*

# Part 4 — Open threads

- **The valve's fourth stop — "People you answer" (~40, becomes default).**
  Needs one fact not yet stored: *have I ever replied to this sender?* Derived
  from sent mail. **Same signal "Quiet lately" needs for "you owe a reply".
  One build, three surfaces** — worth sequencing together.
- **Google Sheets shows no health status** while nine others do. Root cause
  found: no `googlesheets` entry in `LIVENESS_PROBES`. Deliberately not patched —
  the Sheets API has no scope-free "me" endpoint, so a wrong probe would show
  **"failed" on a healthy connector**, which is worse than blank. Needs either a
  scope check first, or an honest "not actively checked" state.
- **Guardrails coach-mark** — filed as ""Got it" doesn't dismiss". Traced fully:
  Guardrails registers exactly one step, so "Got it" resolves to `tour.dismiss`,
  the *identical* handler the ✕ uses, in the same clickable card. **Does not
  reproduce in code.** Needs one live observation before any change.

---

## Suggested order for the design turn

1. **Design item 1** (the specialist end to end) — everything else in the
   programme is downstream of it.
2. **Design item 2** (the card at first meeting) — the trust moment, no
   precedent, highest risk of getting wrong quietly.
3. The noun question — can be answered alongside 1, but should be answered
   *explicitly* rather than assumed.

The store layout, categories and browse surface are a listing over the above and
are cheap once these settle. **Do not start there.**
