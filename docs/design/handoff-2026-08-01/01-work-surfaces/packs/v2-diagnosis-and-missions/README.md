# Cue work surfaces v2 — correcting the DB-lens brief (2026-07-31)

One self-contained file: **cue-work-surfaces-v2.html**. 5 frames + diagnosis + delta + sequencing. Supersedes v1 (`exports/work-surfaces/`), which followed the engineering brief's frame.

## The problem with the brief's frame
It was written by reading `work_items`, so it concluded HQ is a task queue with an inbound gap. Accurate about data, wrong about product. The design we've built across ~30 rounds — and the promise on justcue.ai — is **an org of agents moving your missions forward while you sleep**.

**Biggest usability consequence:** a headline of "3 things need you" makes Cue feel like another inbox. Every competitor's dashboard opens with your obligations. Ours should open with our receipts.

## THE ORDERING RULE (applies to every surface)
`1 What Cue delivered → 2 What needs you → 3 What's in motion → 4 What came in`
Value first, cost second. "Needs you" keeps its single definition (`awaiting_review` + assigned to you) and its badge — it just stops being the first thing read.

## What the brief missed (and v1 inherited)
1. **The unit of work** — brief's atom is the work item; ours is the **mission**. Missions read "abandoned" in prod because nothing feeds them, not because the concept failed. Rings (%, ✓, !, ◼ — never a fake number) are the locked, reviewed hook.
2. **The agents** — Ops/Growth/Inbox with charters, tiers, receipts ("128 acts · 0 reversed"). Staff you can watch working is what a task list can never be.
3. **Trust is the moat** — autonomy dial, tier chips, act ledger were built over three rounds then absent from the deck they govern. Trust chip now lives in the HQ header.
4. **The capture bar** — round-2 fix, regressed in v1. HQ can't be read-only; ⌘K + voice on the deck.
5. **Arrival ≠ the point** — disposition is: ✨ auto-filed → mission, one-tap Move, "moving teaches Cue". Disposition bar breaks the day down *by mission*.
6. **Today isn't empty** — 78 of 93 work items came from chat. v1 overstated the void; honest-today now leads with **93 tracked / 78 started in your conversations / 1,851 background checks**, then names the one gap.

## Frames
- **V1 HQ target** — greeting states delivery; capture bar; mission rings; delivered → needs-you (each row names its ◎ mission) → agents in motion → came-in provenance card; trust chip in header; pulse strip; sidebar restores Missions/Agents/Automations/Guardrails and a watching rail incl. Cue Live + Halo.
- **V2 Mission detail** — the altitude the brief has no concept for: charter, owning agent + tier, projects beneath, "what moved this week" with real deltas (+$75K), scoped Ask-Cue.
- **V3 Came in, expanded** — disposition bar by mission, ✨ provenance + Move on every row, amber "?" for below-confidence, "0 lost", 🧠 teaching line.
- **V4 HQ today** — leads with 93 tracked / 78 from your conversations / 1,851 background checks, then the one blue "Start watching" card, then the quiet "nothing yet" + amber "broken" rows. **Every figure on this frame is queryable against prod today** — it ships against live data, so no number appears unless engineering can pull it; anything needing new instrumentation gets a NEEDS BACKEND tag or is cut. ("93 finished" and "18 documents made" were corrected out — 93 is the created count, and the documents figure had no source.)
- **V5 Mobile Today** — same order one-thumb: delivery headline, 40px rings, delivered block above needs-you, trust pill, capture bar docked above the tab bar.

## Three altitudes (replaces "HQ vs All Work")
`◎ Mission (why) → ▣ Project (what) → ▤ Work (how)`. "All Work" is the bottom rung, where a flat filterable list is correct. Tells the user *when to use which* — the thing the brief says they can't tell today. **Schema cost: none** — missions, projects, work items all exist; this is rendering + navigation.

## Revised sequencing
0. **Reorder HQ this week** — delivered-first + capture bar + the queryable stat row needs no backend. (Argues against the brief's "don't design until things arrive": the product already delivers value it isn't claiming.)
1. Auto-provision watchers — also gives missions a heartbeat and fills People for free.
2. Mission altitude — rings + mission detail; no schema change; this is the demo screen.
3. Trust surfaced everywhere — tier chips tappable, ledger reachable, spend on the deck.

## Unchanged from v1 and still right
One "needs you" definition · no raw enums (`awaiting_review→Needs you · running→Cue is doing · queued→Waiting · done→Done`) · one-row arrival density budget · a no-op is not a success (amber, never green) · SSE degrades legibly · the three empty kinds.
