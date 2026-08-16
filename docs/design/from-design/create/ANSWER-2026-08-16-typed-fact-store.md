# Answer — the typed fact store: one store does not fix three surfaces

**Back to design · 2026-08-16 · answers v29 "Two questions back" #1 and §2 row 1**

> *"Typed fact store — agreed, roadmap it. It's not a Create feature, it's what
> lets People say "applied 14 times", lets a dashboard tile cite its source, and
> makes the fabricated-figures invariant enforceable rather than instructed.
> **One store fixes three surfaces.**"*

**Ruling: not built. Split into two tickets, one of which is blocked on a
decision that isn't ours.** The framing is right about why it matters and wrong
about it being one thing. Below is what is actually in the codebase today,
verified rather than assumed, and what each of the three surfaces really needs.

---

## The short version

The three surfaces do not share a blocker.

| Surface | What it needs | State |
| --- | --- | --- |
| **"applied N times"** | an append-only injection log per memory | **Buildable — small.** Blocked only on *which id space is a memory*, which is a memory-architecture call, not a Create one. |
| **dashboard tile cites its source** | figures to exist as structured values at generation time | **Not a store problem.** There is nothing today to attach a source to. |
| **fabricated-figures invariant, enforceable** | the same as the row above, first | **Downstream of it.** Cannot start earlier. |

A store gets you the first row. The second and third need a figure to be an
object rather than a substring of model-written prose, and no store creates
that. Building the store and calling the invariant enforceable would be the
more expensive mistake, because it would look finished.

---

## What exists today (verified in the tree, not inferred)

**There is no application count, and the near-miss field is not one.**
`nodeToPayload` in `assistant/src/runtime/routes/memory-item-routes.ts`
hardcodes `accessCount: null` and `lastUsedAt: null` for every memory — marked
"legacy fields — not applicable to graph nodes". `memory_graph_nodes` has no
such column. The neighbouring `reinforcementCount` counts times a memory was
**re-observed**, not times it was **applied**.

The phone's Memory screen already handles this correctly and should be left
alone: it renders `reinforcementCount` as what it is ("seen again twice"), only
above zero, and never claims an application count. That is the ruling in §2
row 1 already implemented — *the mock loses the line, absent, not a dash*.

**There is a per-node injection log. It is a window, not a history.**
This one looks like the answer and is worth writing down so nobody re-finds it
and reaches the wrong conclusion. `conversation_graph_memory_state` durably
persists the `InContextTracker` snapshot, and that snapshot contains
`log: { nodeId, turn }[]` — a real record of which node was injected on which
turn. But it is a per-conversation JSON blob rewritten every turn, and
`InContextTracker.evictCompactedTurns` **deletes entries** when context
compacts (`assistant/src/memory/graph/injection.ts`). Summing it across
conversations would produce a count that is silently low and *falls as a
conversation gets longer* — a usage metric that goes down when the memory is
used more. It cannot back this number.

**The only true usage history in the system is over a different id space.**
`memory_v2_injection_events` (migration `256-memory-v2-injection-events.ts`) is
a genuine append-only `(slug, injected_at)` log of every router selection, and
it was even backfilled. It is the right shape. It is keyed by **concept-page
slug** — `memory/concepts/<slug>.md`, `people/alice` — which is a different
identity space from `memory_graph_nodes.id`, the thing the Memory surface
renders. There is no join between them. It is also built for a 3-day-half-life
decay score, with an index reserved by its own comment "for time-range pruning
later": it is a routing signal, deliberately not a lifetime counter.

**The invariant is enforced on our prompts, not on the output.**
`apps/web/src/domains/create/no-fabricated-figures.test.ts` sweeps the Create
source for phrasings that *ask* a model to invent figures ("seed realistic
placeholder figures") and fails the build on them. That is a good guard and it
is doing real work — it caught two shipped prompts. But it constrains what we
ask for. Nothing constrains what comes back, because what comes back is prose.

---

## The decision that isn't ours

**Which id space is "a memory"?**

The Memory and People surfaces render graph nodes. The only real usage history
is over v2 concept slugs. You cannot serve "applied N times" from the second
against the first without picking one as canonical — and that choice reaches
well past this ticket, into extraction, consolidation and routing.

Neither branch is free:

- **Count graph-node injections.** Correct against what the surface shows.
  Requires a new append-only table written at the graph injection site. Every
  existing node starts at zero and stays there for weeks, so the line stays
  absent on the surface for a while after the work lands — honest, but the
  payoff is deferred.
- **Count v2 concept-page injections.** Data exists today, backfilled, so the
  number is real immediately. But it answers for a different object than the one
  on screen, so the surface would have to change what it lists.

This is Manav's call, or design's with Manav. It is the reason this is a
write-up and not a commit.

---

## What ticket one actually costs, once that's settled

Assuming the graph-node branch:

1. One migration adding `memory_node_injection_events (node_id, injected_at)`
   in the **memory** DB — that is where telemetry now lives (migrations 324 and
   326 moved it there; putting it in the main DB would need moving later).
2. A best-effort append at the graph injection site, in the same
   never-throw style as `recordInjectionEvents` — a SQLite write must not abort
   a turn.
3. A count on `nodeToPayload`, replacing the hardcoded `accessCount: null`.
4. The surface line, rendered **only above zero**, exactly as
   `reinforcementCount` is today.

Genuinely small — well under a day — and it is the one row in §2 where the
metric is load-bearing, so it is worth doing. It is just not worth doing before
step 0 is answered.

## And why ticket two is a different animal

For a dashboard tile to cite its source, a figure has to be a value with a
pointer, produced as a value. Today a figure is characters inside a string the
model wrote; there is no object, no field, and nowhere to hang provenance. That
is a change to how artefacts are generated, with its own design pass — not a
table. It should not ride along with ticket one, and the invariant cannot
become enforceable until it exists.

---

## One correction to §2 row 1

> *"One store fixes this, dashboard citations and the fabricated-figures
> invariant at once."*

It fixes the first. The other two share a blocker that a store does not
address. Everything else in that row stands — including the ruling that until
it lands the mock loses the line, which is what the surface already does.
