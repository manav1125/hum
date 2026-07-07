# Cue Guardrails — Claude Design brief

Hand this to Claude Design. It asks for the screens that evolve Cue's **Trust console into
"Guardrails"** — one authoring surface where the user sets the rules their AI agents work
under, and sees the evidence those rules produced. This neutralizes the competitive
"guardrails/checkpoints" story by *showing* what others only promise: named rules, per-agent
scopes, spend caps, model routing, and the live ledger underneath.

## About Cue (context)

Cue is an AI chief-of-staff: it captures inbound, triages, and hands work to **agents**
(Ops / Builder / Growth + the house agent "cue") that run missions and background tasks.
Today the control machinery is real but scattered: a Trust console (permission policy +
trust rules), approval dialogs (allow once / always / never), per-agent spend + caps (an
agents registry with tier + cap), mission "never-lines" + budget hard-stops, and an
**act-ledger** (every autonomous act recorded, reversible). Guardrails unifies these into
one legible surface.

**Visual language (match exactly):** `--mv1-*` token system, dark-first + light; serif
display headings; DM Mono microlabels (uppercase, letter-spaced); ~15px-radius cards,
hairline borders, restrained blue accent; every screen desktop + **390px mobile**.

## Screen set 1 — The Guardrails surface (replaces the Trust console)

One page, three bands:

1. **CHECKPOINTS — "Cue always asks before…"** A list of named, plain-English rules, each
   a card/row with an on/off state and scope chip:
   - "Sending any email or message" (on · everywhere)
   - "Spending over $10 in one action" (on · everywhere)
   - "Posting or publishing publicly" (on · everywhere)
   - "Deleting anything" (on · everywhere)
   - "Contacting investors" (on · Growth agent only)
   Plus an **"+ Add a checkpoint"** composer: pick a template (send / spend / publish /
   delete / contact / custom pattern) → scope it (everywhere · one agent · one mission) →
   name it. Show the composer open state.
2. **AGENT SCOPES — one card per agent** (Ops ⚙ / Builder ▲ / Growth ✦ / cue):
   - What it may touch: tool/skill scope chips (e.g. "email · calendar · research" with an
     edit affordance).
   - **Spend cap** with a live spend-vs-cap bar (e.g. "$3.10 of $20/wk") — amber near cap,
     red over.
   - **Model pin**: which model this agent runs on (e.g. "Sonnet 4.5 · balanced") with a
     small picker — options like Best (Sonnet) / Fast (Haiku) / Custom. A one-line
     cost/quality hint per option. This is the visible "route by task/cost/policy" feature.
   - Paused state variant.
3. **THE LEDGER — "what your rules did this week."** A compact evidence feed: recent
   autonomous acts (icon · what happened · agent · when · $ cost · model used), items where
   a checkpoint fired ("Held for your approval — email to J. Chen"), and a small honest
   rollup ("14 acts · 2 held for approval · $4.12 · everything reversible"). Each act row
   has a "reverse" affordance where applicable.

Header: serif title ("Guardrails"), a one-line promise ("Cue works autonomously — inside
lines you draw."), and the rollup stats.

## Screen set 2 — Rules born in the moment

The approval dialog (existing pattern: Allow once / Always allow / Never) gains a
**"Make this a rule →"** affordance that opens a small pre-filled sheet: the checkpoint
template inferred from the action ("Sending email to external contacts"), scope selector,
save. Design the dialog with the new affordance + the pre-filled mini-sheet. This is how
most rules will actually get authored.

## Screen set 3 — Transparency rollup (the honest pricing story)

A compact **"Usage & spend"** panel (inside Guardrails or linked from it): per-agent $ this
week/month, per-mission $, model mix ("82% Haiku · 18% Sonnet"), and the cap lines. Plus a
small share-able summary card ("This week Cue did 14 things for $4.12"). Desktop + mobile.

## States to cover
- Empty state (fresh user: sensible default checkpoints pre-seeded, marked "default").
- A checkpoint firing (the held-for-approval item in HQ/inbox referencing its rule).
- Over-cap state (agent paused by its cap, with a one-tap raise/keep decision).

## What NOT to touch
Existing HQ deck, Missions, Create, People, Voice surfaces; the `--mv1-*` tokens; nav
structure (Guardrails replaces the Trust console's slot, no new top-level item).

## Deliverable
Dark-first mocks (+ light where it matters), desktop + 390px mobile, static HTML like
previous rounds (Cue-HQ-Build / Cue-Create-Studio format).
