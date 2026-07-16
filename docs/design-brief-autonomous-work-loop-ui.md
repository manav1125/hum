# Design brief — making the autonomous work loop visible & trustworthy

_For: Claude Design. Come back with 2–3 options per section (low-fi is fine for round 1).
Owner: Manav. Context date: 2026-07-16._

## Why now

Cue's differentiator (justcue.ai) is the autonomous loop: **capture → triage → surface →
execute → hand off → review**. The backend for this loop was completed on 2026-07-15/16:
inbound messages auto-capture commitments, stalled work auto-resumes, skipped approvals
surface explicitly, background runs are guardrailed, and work is attributed to named
agents. **None of these new states has a designed visual language yet** — they render as
plain text notes on work-item cards. This brief asks for that language. It is NOT a
restyle of existing surfaces; it's net-new states inside the existing design system
(dark-v1 book, v0.3 surface mocks, Mission Control's five lanes:
Inbound / Awaiting you / In progress / Scheduled / Done).

## Design principles to hold

1. **Provenance is trust.** Every autonomous action must answer at a glance: *where did
   this come from, why did it act, what did it do?* No mystery motion.
2. **Autonomy must feel supervised, not spooky.** The user should feel like a manager
   with a great chief of staff, not a passenger.
3. **One glance = state.** Each work item's lifecycle stage must be readable from shape/
   color/badge without reading prose.
4. **Undo/redirect over confirm-everything.** Prefer visible reversibility to upfront
   friction (the backend supports dismiss/re-run/review gates).

## The six new states needing design

### 1. Auto-captured work ("Cue picked this up")
A work item created by the commitment extractor from a Slack/email/SMS/Telegram message —
no user action involved. Data available: source channel, sender name, the quoted ask,
due date (if any), triage tier.
**Need:** a card treatment that (a) marks it as auto-captured (vs user-created), (b) shows
"From **Rachel** via **Slack** — *'please send the signed NDA by Friday'*" provenance,
(c) offers one-tap **Confirm / Edit / Dismiss** (dismiss must feel cheap — false positives
will happen and dismissing trains trust), (d) shows what triage decided (tier, auto-run
or parked) and lets the user flip it.
**Where:** Inbound lane of Mission Control, Home feed, push notification variant.

### 2. Auto-started work ("the drainer ran it")
Queued items now start themselves (policy-gated, max 2 concurrent). Users will see items
move without touching them.
**Need:** an "auto-started" indicator distinct from user-started (subtle — this should
feel routine, not alarming), + a live progress affordance on In-progress cards (the
runner emits progress notes). Consider a small "why did this run?" hover/tap → "Auto-run
policy: research tasks run automatically."

### 3. Skipped-step / paused-for-approval ("⏸ needs you to finish")
A background run whose approval timed out completes with a skipped side-effect. Today:
a text note "⏸ Step skipped — approval for send_email timed out; approve and re-run."
**Need:** a first-class visual state — NOT a success checkmark, NOT a failure red. It's
"done-but-incomplete, needs one decision." Badge + card state + a prominent
**Approve & finish** action. This is the highest-stakes state in the product: if it reads
as "done," users ship silence; if it reads as "failed," they lose trust in autonomy.
**Where:** Awaiting-you lane (primary), Review lane cards, notification.

### 4. Review lane as the finish line (behavior change)
Background actions from Home now land in **awaiting_review** instead of popping a "Done"
card. The Review lane is now the single place work completes.
**Need:** (a) Review cards that make sign-off satisfying and fast — show the OUTPUT
(deliverable preview: doc/deck/app/research summary) not just metadata; one-tap
**Approve → done** / **Redo with notes**; (b) a lightweight "completed while you were
away" digest treatment (morning summary pattern) since results now accumulate here.
**Where:** Review lane, Home recap, mobile.

### 5. Agent attribution ("who did this")
Work runs under named agents (Ops/Growth/Inbox roster) with charters and scopes.
**Need:** a compact agent identity system — avatar/glyph + name on work-item cards, an
agent filter in Activity, and an agent detail view showing charter, scopes ("what it's
allowed to do"), spend, and recent work. Keep it human-scale: these are staff, not
settings rows.

### 6. Skill discovery moments (chat surface)
The assistant can now suggest marketplace skills it can't auto-install ("available in
the marketplace — ask the user to install").
**Need:** an inline chat card for "Cue found a skill that would help" → name, one-liner,
**Install** CTA (routes to marketplace), vs the plain-text suggestion today. Low
priority relative to 1–5.

## Also in scope (one pass, opportunistic)

- **Mission Control lane header counts + empty states** — with autonomy on, empty lanes
  are now GOOD news ("nothing needs you"); design empties that celebrate rather than
  look broken (relates to backlog task #17).
- **Trust console tie-in**: states 1–3 all have "change the policy" moments ("always
  auto-run these" / "never capture from this channel"). Provide the pattern for
  in-context policy edits so users tune autonomy where they feel it, not in settings.

## Constraints

- Existing system: dark-v1 design book (mobile), v0.3 surface mocks (desktop web),
  same SPA serves web + macOS Electron; mobile is Capacitor at 390px. Design within
  existing tokens/typography; new states may add semantic accents but no new palette.
- Everything must work in both themes and at 390px.
- All states are already emitted by the backend (work-item events: `approval_timeout`,
  actor `commitment-capture`, auto-start provenance, agent assignee) — no backend asks.

## Deliverables requested

Round 1 (options): 2–3 directions per state 1–5 as annotated low-fi frames — enough to
pick a direction per state. Round 2: one coherent set, desktop + mobile, both themes,
with the badge/state taxonomy documented as tokens.

## Success test

A brand-new user leaves Cue running for a day with Slack connected, opens Mission
Control, and can answer without help: What did Cue pick up? Why? What did it finish?
What needs me? What did it skip? — each in under 5 seconds.
