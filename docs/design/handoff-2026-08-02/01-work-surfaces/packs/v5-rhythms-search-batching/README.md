# Cue work surfaces v5 — second tier: rhythm, retrieval, batching, review

One self-contained file: **cue-work-surfaces-v5.html**. 4 frames. Completes the second tier flagged in v4. These are the four that stop the surface silting up over months of real use.

## Frames
- **Z1 · Rhythms** — recurring work as **one row per rhythm, not one per occurrence**. 4-bar sparkline run history (green = handled itself, amber = needed you, grey = skipped). A cycle enters the ledger **only while it needs a human**; handled cycles live in the rhythm's history and that day's delivered block. Critical row: *"you've skipped the last 5 — Stop this?"* — a product that generates work must notice when the work is unwanted. Cadence described in words, not cron.
- **Z2 · ⌘K search** — **answer first, sources under it**, but only for questions; a keyword query gets the typed list with no answer block (no fabricated confidence). Spans work · life · messages · files · people. **Decision records are a first-class result type** ("you decided Jul 31 · 4 items depended on it") — institutional memory nothing else has. Same ⌘K as the capture bar: **an instruction creates or delegates, a question retrieves**; Cue decides from phrasing, no mode switch.
- **Z3 · Batch card** — four items on one thread collapse to one send; a looser fourth is offered as a **rider** ("would ride along") not force-merged. Violet = review colour, correct because you're reviewing a synthesis. **Batching is always an offer** — dismissible, and declining twice stops it for that thread. May batch on: same thread / same person / same decision / same errand. **Never** across missions, work↔life, recipients, or two items needing separate judgements.
- **Z4 · Friday review** — the trust instrument. *What moved* uses real deltas (+$75K), not activity counts. *Who did what* splits credit (38 you / 61 Cue = 62% share) and reports the two figures that make it credible: real spend and **acts you reversed**. *What slipped* is framed as leverage, max three, never blame. And the section nothing else does: **Cue proposes its own leash change with evidence** ("you approved all 9 unchanged — I'd have saved you 9 interruptions"), asks to retire work you ignore, and volunteers its own mistakes. Progressive trust becomes a weekly conversation instead of a settings screen.

## Rules v5 adds
1. A rhythm's cycle enters the ledger only when it needs a human.
2. Answer-first only for questions; keywords get the list.
3. Batching is always an offer; declining twice stops it for that thread.
4. One ⌘K, two intents — instruction creates, question retrieves.
5. The weekly is where the leash changes; reversed-act count always shown.
6. "What slipped" is leverage, never blame — three items max.

## Schema cost
`rhythm` record + `rhythm_id` on generated items · a `decision` record (what / when / what depended on it — the act ledger can largely reconstruct this) · batch-decline memory per thread · a weekly rollup job alongside the daily brief. Search spans existing stores; answer synthesis rides the agent loop.

## Series map
v1 honest states · v2 missions + delivered-first · v3 Life lens + volume + task detail · v4 day rail + hand-off + waiting + conditional Later · **v5 rhythms + search + batching + weekly review**.
