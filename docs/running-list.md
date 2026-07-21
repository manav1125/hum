# Cue — running list to alpha (living doc, updated 2026-07-22)

Legend: ✅ proven working · 🟡 shipped, not yet proven/activated · 🔧 needs build/fix · 👤 needs you · 🎨 needs design

## Task-execution intelligence — the moat (shipped 2026-07-22)
**The problem:** HQ ran every task the same way. A one-line errand and a fully-briefed
project task both went straight to an agent turn, so ~half the user's real tasks
("Buy oat milk", "Pay Architect", "Call the dentist") were "run" into `awaiting_review`
with plausible output and no way to see what Cue had understood.

**Shipped:** a cheap pre-run assessment reading exactly what the run reads (title/notes,
the assembled context preamble, a live capability snapshot, the prior run). Four verdicts —
`execute` (+ plan shown before it starts), `clarify` (one question, parks), `not_ai_task`,
`blocked` (names the missing thing). Non-execute parks the item; the turn is never spent.
Money movement and signing are always the user's own action. UI renders it on HQ, the
project board, All work, Activity→Cued and the task drawer; the trail reads as sentences.
Rollback lever: `workItems.assessment.gate=false` (assess + narrate, never block).

**Evidence (real model, real tasks on prod — `assistant/qa/assessment-eval.ts`):**
- 14/14 assessed (was 5/14 before the reliability fix), 13/14 verdicts defensible.
- "wire the aef fund capital call" / "Pay Architect" → `not_ai_task`, conf 1.0
- "Send Q3 invoice to AEF fund" → `blocked`: "a linked email or messaging account"
- "Call the dentist" → `blocked`: "a linked phone or messaging account"
- "List co-working spaces in Canggu" → `execute` → ran → completed.

**Two defects this evaluation caught that no unit test could:**
1. A burst of 14 dispatches left 9 silently unassessed — one slow flash reply was the end
   of it, and the failure logged at `debug`. Now 30s per attempt, one retry, warn on giving up.
2. The capability snapshot claimed "can place phone calls" because a tool *name* matched,
   so Cue planned to "speak with the receptionist" with no Twilio account. Capability
   claims now require the thing behind them to be configured — the assessor turns every
   claim into a promise.

**Known limits:** `not_ai_task` precision is judged by one flash model — over-asking is the
safe direction and the guards enforce it; memory isn't retrieved at assessment time, so a
task answerable only from memory can over-clarify; the mobile task sheet still offers ▶ on
a held task (mobile pass outstanding).

## Cue Live — interaction model (decided 2026-07-21, user)
**Purpose:** Cue watches your screen/life to *capture tasks & todos* and *help complete them* — ambient chief-of-staff, not a remote-desktop tool.
**Model:** watch and take-control are NOT exclusive modes. **Watch runs ambiently** (background, opt-in, time-bounded → files captured todos into Came-in, parked). **Take control is invoked conversationally — by voice OR text, like asking Claude.**
**Already true in code:** voice turns carry `userMessageInterface:"macos"` (live-voice-session.ts:797) and `macos` is the interface that unlocks host-proxy computer-use — so voice AND text can both reach the proven computer_use path. No new invocation plumbing needed.
**Still to do:** (a) Cue Live "act" re-platform off the old pixel loop onto the grounded computer_use tools; (b) mode UX must stop being an exclusive radio picker (watch = ambient toggle, take-control = always-available on request, trust-dial capped); (c) live proof of a voice-asked take-control driving the screen.
**Precedent/trust:** consented screen control is established (Claude computer use et al). The only hard rule: never ship copy that contradicts what the product does — the "no frames leave your Mac" line is being rewritten in the same change as streaming (user chose real streaming + input relay).

## Proven working (evidence in hand)
- ✅ Desktop-organizer on the Mac (plan/apply/undo, move-never-delete) — docs/mac-verification-2026-07-21.md
- ✅ Computer-use on the Mac (helper read live screen + wrote to TextEdit; 19+82 tests)
- ✅ Plugins registry live on prod (ships + flag on + search returns real entries)
- ✅ Crash recovery, connector health, vision routing, filing, brief, deploys 1–4 healthy

## Shipped but NOT yet proven / activated
- 🟡 **Advisor** — wired on kimi-k3 but the gate was too narrow (keyed on static tool risk; bash=Medium so destructive shell never triggered it). FIX in flight to fire on per-command-high bash. Re-test after deploy.
- 🟡 Send-path turn-finalize deferral — flag OFF, unmeasured. Enable + measure.
- 🟡 Watchers/Playbooks — deployed; no real watcher has fired end-to-end yet. Needs a live watcher run.
- 🟡 Voice endpointing/spoken-acks — flag OFF pending device QA (mic).
- 🟡 Organizer live-mirror — renders; live progress needs a stdout-emission hook (small).

## Needs build / fix (mine)
- 🔧 **Cue Live "act" re-platform** onto the proven computer_use path (currently the old pixel loop) + native overlay UI to the locked design.
- 🔧 **Advisor gate breadth** (in flight).
- 🔧 **Plugins: replace the vellum seed catalog with a Cue-curated set** (mechanism works; content is upstream examples).
- 🔧 Organizer live-mirror emission hook.
- 🔧 Chrome extension: browser-execution.ts still points at the old vellum CWS URL (fix post-item-creation); feedback endpoint unserved.

## Needs design (🎨 — brief: docs/design/briefs/discovery-and-clarity.md)
- 🎨 Cue Live control-vs-viewer clarity (highest — the "it did nothing" confusion)
- 🎨 Capability discovery / first-run for the new powers
- 🎨 Plugins mental-model + Cue-curated catalog framing

## Needs you (👤)
- 👤 Twilio creds (SID + auth token + number) → activates the phone channel
- 👤 Create the Chrome Web Store item (zip + icon + copy staged; sideload works meanwhile)
- 👤 TestFlight: ASC contact phone + reviewer demo story → submit Beta App Review
- 👤 Wave-1 invite emails
- 👤 **Rotate the ANTHROPIC API key** (exposed earlier, still unrotated)
- 👤 Voice device QA (needs a real mic session)

## Known backend gaps flagged for follow-up
- Connector health probe exists but Composio only exposes "linked" not live health (real probe = future)
- DSML history leak filter (old DeepSeek markup in some transcripts) — sanitizer shipped, verify coverage
- Plugin install `inspect` uses marketplace.json (provenance layer) while browse uses registry.json (by design; consistent for the UI)
