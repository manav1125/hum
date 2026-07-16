# Cue — HQ work-loop: held decisions + design specs

_2026-07-17. What's shipped on dev, and the decisions I need from you before going further.
Two of these have a genuine either/or — I've mocked both (see the linked artifact)._

---

## Shipped on dev so far (no decision needed — FYI)

The autonomy work-loop design system is built as reusable design-library primitives (state
tokens + `StateBadge` / `AgentChip` / `WorkLoopCard`), verified light + dark, and the **live
HQ surface** now carries:
- `StateBadge` on the Review card and the Running "agents at work" items (unified state
  vocabulary, token-driven).
- `AgentChip` on those same cards, resolving each item's `assignee` to a named roster agent
  (Ops/Growth/Inbox → "Cue" for house work → nothing when it's yours or a contact's).

These are honest by construction and shipped behind no flag — they'll appear on the next
deploy. Everything below is what's **not** built because it needs your call or a backend change.

---

## Decision 1 — HQ's information architecture: **deck vs board** ⚠️ needs your pick

This is the big one. The approved v2 mock's centerpiece is a **five-lane Mission Control
board** (Inbound → Running → Needs you → Review → Done). But today's live HQ is a **bespoke
"deck"** — a rings hero, a came-in strip, a needs-you lane, a queued/scheduled section, a
done-today row, and a right rail of running agents. They're two different information
architectures for the same data.

**Option A — keep the deck, wear the design language** (the low-risk path I'm on).
The deck stays; we retrofit the state badges + agent chips into its existing cards. HQ keeps
its "one-glance: are we moving / what moved / what needs me" framing and the rings hero.
- _Pro:_ zero IA disruption; the rings hero (mission health) is genuinely good and the board
  doesn't have it; incremental and already partly shipped.
- _Con:_ never quite the clean "whole loop on one board" the mock promises; the loop states
  are scattered across deck sections rather than read left-to-right.

**Option B — make HQ the five-lane board** (the mock, literally).
Replace the deck's middle with the lane board; the loop reads left-to-right, every state in
one place. The unrouted `mission-control-page.tsx` already builds this — we'd modernize its
cards to the new primitives and route it (or embed it in HQ).
- _Pro:_ exactly the approved design; the loop is legible at a glance; one card component
  everywhere.
- _Con:_ loses (or must re-home) the rings hero + capture bar; bigger change; the board can
  feel emptier than the deck when volume is low.

**My recommendation: a hybrid** — keep the rings hero + capture bar at the top (the deck's
best parts), and put the **five-lane board underneath** as the body (the mock's best part).
Best of both; it's more work than A, less disruptive than a full B.

👉 **Mocked all three side-by-side in the linked artifact for you to pick.**

---

## Decision 2 — DONE card provenance: "auto-ran" vs "you approved" ⚠️ needs a backend change

The mock's Done cards distinguish _"Ops · you approved"_ from _"Inbox · auto"_ — a small
detail that does real trust work (it shows the autonomy actually happened, or that you were
in the loop). **We can't build this yet:** the work-item route carries `approvalStatus`
(`none | approved | denied`), but `none` covers _both_ "ran autonomously" and "never needed
gating" — there's no clean "this ran without you" signal, and the approve/deny record lives in
the guardian layer, not projected onto the work item the web app reads.

**Spec (backend):** project an autonomy-provenance field onto the work-item route —
`ranProvenance: "auto" | "you_approved" | "manual"` (or equivalent), derived at run
completion from whether a guardian approval gated the run. Then the Done card renders
"◆ Ops · auto" vs "◆ Ops · you approved" faithfully. Small, additive; no schema churn if
computed at read time from the existing guardian records.

_Until then:_ Done cards show the agent name only (no provenance suffix) — honest, just less
rich. **Decision:** worth the backend field now, or defer?

---

## Decision 3 — AgentChip on triage/inbound items ⚠️ needs a product call

Attribution rides entirely on the free-text `assignee` string. **Mission-planned** items get a
real roster name; **triage/inbound** items (a Slack commitment, an email) default to `"cue"`,
so they'd all read "◆ Cue". Three ways to handle it:
- **(a)** Show "Cue" for house work (what I built) — honest, but many cards read the same.
- **(b)** Route inbound items to the **Inbox** agent at capture time (backend: commitment-
  capture stamps `assignee: "Inbox"`), so channel work reads "✉ Inbox" — more meaningful, and
  matches the roster's intent.
- **(c)** Show no chip for house/triage work; reserve the chip for mission-assigned agents.

**My recommendation: (b)** — it's the truthful attribution (Inbox _is_ the triage agent) and
makes the roster visibly earn its keep. It's a one-line stamp in `commitment-capture.ts`.
**Decision:** (a) ship as-is, (b) stamp Inbox, or (c) chip only for missions?

---

## Decision 4 — the rest of the mock (buildable now, just confirm scope)

These are spec'd in the v2 mock and need no new decision — just your go-ahead on scope/order:
- **Empty/first-run states** (task #17): the calm "Nothing needs you," the "All caught up"
  inbound zero-state, and the 3-card first-run explainer. Buildable now with the primitives.
- **Failure card**: the `WorkLoopCard` failure variant is built; it just needs a live surface
  to appear on (depends on Decision 1's layout).
- **"Make it a rule"** Trust card: the in-context escalation after a confirmation. Needs a
  small backend endpoint to persist the rule (ties into the per-category autonomy policy).
- **Board motion** (motion-a, restrained): only relevant if Decision 1 goes to a board.

---

## What I need from you

1. **Decision 1** — deck (A) / board (B) / hybrid (recommended). _See the mockup._
2. **Decision 2** — build the DONE-provenance backend field now, or defer?
3. **Decision 3** — inbound attribution: ship "Cue" (a) / stamp Inbox (b, recommended) / chip
   missions only (c)?
4. **Decision 4** — green-light empties + first-run + "make it a rule" now, or after Decision 1?

I'll keep going on dev with whatever doesn't block on these (the empties and the Inbox stamp
are both safe to start regardless).
