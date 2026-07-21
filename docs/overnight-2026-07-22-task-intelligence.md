# Overnight 2026-07-22 — task-execution intelligence, and the three surfaces

You went to bed with two things: mobile screens overflowing, and the deeper one —
*"the hq shows a series of tasks and it gives you the ability to run them but then in running
them i really don't know what it does or how it does it… we need to see how the ai is smart
enough to understand, ask etc or just execute correctly."*

## The diagnosis, in your own data

Your instance's work-item table made the problem concrete. Roughly half the real tasks in it
should never have been run by an AI, and Cue ran every one of them into `awaiting_review`:

| Real task in your instance | What Cue did | What it should do |
|---|---|---|
| Buy oat milk, spinach, and coffee beans | ran it → awaiting_review | not an AI task |
| Pay Architect / wire the aef fund capital call | ran it | never — human + money |
| Call the dentist to book a cleaning | ran it → awaiting_review | blocked (no phone creds) |
| Follow up with Brinc founders on metrics | failed | clarify — who, and via what |
| Research fun activities for kids in Berawa | ran it | genuinely execute |

The context plumbing you built on web *was* wired in — project brief, attached knowledge
files and task context were all reaching every run. What was missing was any **judgement**
between "user taps ▶" and "agent turn starts".

## What shipped

A pre-run assessment that reads exactly what the run reads (title/notes, the assembled
context preamble, a live capability snapshot, how the last run went) and returns one of four
verdicts. Non-`execute` **parks** the item — the turn is never spent.

- **execute** — with a plain-words plan shown *before* the work starts
- **clarify** — one high-value question; answering it re-opens assessment
- **not_ai_task** — no ▶ at the front; "Mark it done" leads, override stays available
- **blocked** — names the one missing thing, with a real fix destination

Money movement and signing are hard-coded as always your own action, whatever accounts get
connected later. Preparing the groundwork stays normal work.

Visible on: the task drawer, HQ "Came in", project boards, All work, Activity → Cued, and
every mobile equivalent. The run trail now reads as sentences instead of tool names.

**Rollback lever:** `workItems.assessment.gate=false` assesses and narrates without ever
blocking. `enabled=false` restores the old behaviour entirely.

## Evidence (real model, real tasks, on prod)

Harness: `assistant/qa/assessment-eval.ts` — the fixtures are your actual task titles.

- **14/14 assessed**, 13/14 verdicts defensible.
- "wire the aef fund capital call" / "Pay Architect" → `not_ai_task`, confidence 1.0
- "Send Q3 invoice to AEF fund" → `blocked`: *"a linked email or messaging account"*
- "Call the dentist" → `blocked`: *"a linked phone or messaging account"*
- "List co-working spaces in Canggu" → `execute` → ran → completed

**The context claim, proven end to end:**

| | verdict | behaviour |
|---|---|---|
| Bare task ("Draft the Q3 LP update") | clarify | *"which fund, and what points?"* |
| Same task inside the briefed AEF project | clarify | knows fund, format, topics — asks only for the figures |
| After answering the question | **execute** | plan names the figures, then ran |

That is the loop you asked for: understand → ask → execute.

## Two defects the real-model run caught that 51 unit tests could not

1. **Silent drop-outs.** A burst of 14 dispatches left **9 unassessed** — one slow reply was
   the end of it, and the failure logged at `debug`, so the feature looked healthy while most
   tasks ran with no verdict. Now 30s per attempt plus a retry, and giving up warns with the
   reason. 5/14 → 14/14.
2. **Capability overclaim.** The snapshot claimed "can place phone calls" because a tool
   *name* matched, so Cue planned to *"call the dentist's office and speak with the
   receptionist"* on an instance with no Twilio. Capability claims now require the thing
   behind them to be configured. **The assessor turns every capability it is told about into
   a promise** — overclaiming is always the costlier direction.

## Mobile

- The reported screen: the sheared "Take ov[er]" and the ~390px dead gap above the actions
  are fixed — the trail takes the slack, the buttons wrap instead of clipping.
- Systemic: long unbroken strings from the daemon (URLs, tokens) no longer run past the
  viewport on **any** mobile-v3 surface (one inherited rule in `mv3.css`).
- Every touched surface measured at 390px with `scrollWidth === clientWidth`, including a
  paragraph-length question and an unbreakable URL. Chat and Cue Live could not be mounted in
  the harness — reviewed statically, not measured.
- A held row's inline ▶ now **opens** the task instead of firing it: a row has nowhere to
  show the question Cue is waiting on.

## Mac

Rebuilt, signed, helper bundled, installed, connected to your instance with history intact.
Your previous app is preserved at `/Applications/Cue-backup-2026-07-17.app`.

Two things worth knowing:
- I first packed with `--env production`, which reads a *different* userData directory
  (`@vellumai/macos`) than your install uses (`@vellumai/macos-local`) — it booted to a
  Connect screen. My error; repacked to match. **The env name partitions all app state.**
- My own Cue Live check-in loop was logging ~15 warnings/minute into an idle log. Fixed
  (0 in 4 minutes), via an injected probe rather than an import that dragged the router's
  module graph into unrelated tests.

## Honest gaps

- **The restart window.** For the first minutes after a deploy the assessment call fails and
  the task runs **unassessed** (fail-open is deliberate). Reproduced twice: "Pay the architect
  invoice" ~30s after a deploy ran with no verdict; identical task warm → `not_ai_task`,
  parked. I tried spacing the retries and **reverted it** — it could not be validated and made
  the suite sleep. Fix options are in `docs/running-list.md`. Until then: after a deploy, give
  it a few minutes before running anything irreversible.
- `not_ai_task` precision rests on one flash model. The guards push it toward over-asking,
  which is the safe direction, but it has not been evaluated at scale.
- Memory isn't retrieved at assessment time, so a task answerable only from memory can
  over-clarify.
- "Advisor never logged a `call_site=advisor` row" — resolved, not a defect: `llm_request_logs`
  only records `mainAgent`/`compactionAgent`; all side-chain calls are absent by design.
  Deliberately not adding side-chain logging (those writes caused the assistant.db runaway).

## Still yours

Twilio creds · Chrome Web Store item · TestFlight reviewer story · wave-1 invites ·
**rotate the ANTHROPIC key (still unrotated)** · voice device QA (needs a real mic).
