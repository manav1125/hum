# Cue — running list to alpha (living doc, updated 2026-07-22)

Legend: ✅ proven working · 🟡 shipped, not yet proven/activated · 🔧 needs build/fix · 👤 needs you · 🎨 needs design

## "Slow, then it randomly disconnects" — root-caused 2026-07-22
Four independent faults produced one experience. Two server, two client.

**S1 · Embedding worker starved the daemon of CPU (the big one).** ONNX Runtime defaults to
one intra-op thread per core, so a single embedding batch took BOTH vCPUs of the
`shared-cpu-2x` and the daemon's single event loop was not scheduled — measured during a
stall window: **CPU steal 91.3%, idle 1.1%**, daemon on 2.4% of one core, `blkio` delay **0**
(so NOT disk), 0 major faults. Fix: pin `intraOpNumThreads=1` + `interOp=1` + sequential
(`CUE_EMBED_ONNX_THREADS`), renice workers to +10 (`CUE_EMBED_WORKER_NICENESS`), bump
RUNTIME_VERSION so installs regenerate. Measured on the real worker: parallelism 3.97x → 1.00x
and **15% less total CPU**. After deploy: **steal 91.3% → 4.3%, idle 1.1% → 46.2%**, worker
running `NI 10`.
*Two suspects were ruled OUT with evidence — don't re-chase them:* the 64MiB WAL is the
configured `journal_size_limit` reuse ceiling, not a checkpoint storm; and
`memory_v2_activation_logs` at ~113KB/row is its 300-concept cap working, not runaway
telemetry.

**S2 · `git status` killed at 1MiB every heartbeat.** `/workspace` held 46,408 untracked
conversation scratch dirs → 1.3MiB of porcelain vs child_process's 1MiB default → killed
mid-walk, **86 consecutive heartbeat failures**, ~1s of wasted tree walk paid twice per turn.
Fix: `conversations/` added to `/workspace/.gitignore` (runtime data, like `data/`/`logs/`;
the 7 tracked files stay tracked) + explicit `workspaceGit.maxOutputBytes` (64MiB) and a named
`git_output_overflow` error. **46,421 lines → 240; ~1000ms → 15ms; 86 failures → 0.**

**C1 · The SSE transport retired itself permanently.** The reconnect budget was refunded only
on a *data* frame, but an idle stream carries only heartbeat comments — five flaps across
*hours* burned it for good. Any frame now refunds it.
**C2 · Recovery existed only on the chat page.** `sse.closed`'s sole subscriber was mounted in
the chat view, so on Library/Home/Projects a give-up was terminal for the session. The service
now owns a capped never-give-up timer, cancelled on hidden/suspend.
Also: "Failed to open app" was a one-shot POST whose error was thrown as a parsed body (not an
`Error`), so the message never survived — now retryable and honest; and an intentional
local-mode `AbortError` was read as lost connectivity, degrading the app on every visibility
resume.

**S3 · The host was starving us (RESOLVED 2026-07-22).** After S1 removed our own CPU
contribution, steal was still **58.7% sustained** on `shared-cpu-2x` with our worker at 9%
and niced — neighbours, not us. A single-threaded daemon that is not scheduled cannot answer
inside the gateway timeout, which is the 504 / "Gateway Timeout" users hit. Resized to
**`shared-cpu-4x`** (4 vCPU, kept 4GB): **steal 58.7% → 1.4%, idle 34.1% → 90.6%**, and the
endpoints that were 504ing (`next-move`, `home/state`, `brand-profiles`, `missions`) all
return 200 in 0.37–0.44s. Cost ≈ **+$2/mo**. `performance-2x` (+$41/mo) was NOT needed — the
daemon needs ONE free core, not two, so more shared cores beat dedicated ones here. Do not
roll this to the fleet without measuring steal per instance; this was a sample of one.

**Still open:** ~46k conversation scratch dirs remain on disk — but they are NOT debris: only
7 are truly empty, 4,721 hold real messages and 103 attachment files hold 412MB. Do not
bulk-delete. The embedding worker's unexplained ~30-min post-boot CPU burst has no matching
`memory_jobs` rows — some caller outside the job queue.

## 🔴 THE DESKTOP STORY IS DEAD ON SELF-HOST (found 2026-07-22 night)
**Every desktop capability — computer-use, desktop-organizer, Cue Live look/act, Desktop
control — is non-functional against a self-hosted instance, and always has been.** Measured on
prod: `GET /v1/assistants/self/clients` returns only `interfaceId:"web"` clients with
`capabilities:[]`; `?capability=host_bash` returns `[]`; `organizer/session` returns
`targets:[]`. The Mac app log shows continuous `[host-proxy-router] no assistant connected`,
including for `/cuelive/act` and `/cuelive/look` at the exact moment the user tried Cue Live.

**Root cause:** `apps/macos/src/main/host-proxy-router.ts` opens host-proxy connections ONLY
from `handleLockfileChange()` over `lockfile.assistants` — the local-CLI-daemon model. A
self-host install (the alpha model) has no lockfile entry at all (`~/.vellum/` has no
assistants file), so the main process never connects. The renderer connects fine — it is the
web SPA, which is why it registers as `web`, not `macos`.
**Watch out:** `organizer-routes.ts` (~118) filters targets on
`actorPrincipalId !== undefined && === callerPrincipalId` and FAILS CLOSED, so a connection
that authenticates but carries no principal still yields zero targets.
**Note:** earlier "Mac E2E proven" results were against a LOCAL daemon, not the cloud
instance — which is why this was never caught.

## Watchers claimed capabilities they never had (fixed 2026-07-22 night)
Creating a Gmail watcher on an instance with **no Google account connected** succeeded,
reported `enabled:true`/`status:idle`, polled immediately, and stored Google's raw **404 HTML
page** as its `lastError`. Cause: `checkCredentialForProvider()` returns `null` for two
opposite cases — "healthy" and "no connection exists" — so the engine's pre-poll gate read
"no account" as healthy and called the API anyway, and the UI showed health `unknown` (and,
for `reauth`, the copy "Token expired — reconnect to resume" for an account never connected).
Added `hasCredentialConnection()`; the engine now skips the poll, and a new `not_connected`
health state says the true thing on both surfaces.
**Also:** the browser-extension install hint pointed at `vellum-assistant-browser` — a
DIFFERENT publisher's extension. Now points at Cue's own deterministic id.

## Connector reality on this instance (2026-07-22)
`oauth_connections` is **empty**; `provider_connections` holds only LLM providers; no channels
configured; exactly **one** inbound channel event ever (Slack, 20 Jun). So Watchers/Playbooks
cannot be proven end-to-end without the user connecting an account (an OAuth action only they
can take). Any product claim about inbox/calendar watching is currently unbacked.

## Verify in the real app, not with curl (2026-07-22)
`assistant/qa/e2e-app-pass.ts` drives the **signed-in desktop app over CDP** across every
route (desktop + 390px) and reports console errors, failed requests, dead-end screens and
overflow. It exists because the previous habit could not find what it found: Automations had
been 401ing on **every** call since WS-F shipped — all nine watcher/playbook operations went
out with no Authorization header, because the self-hosted interceptor only rewrites
`/v1/assistants/{id}/{segment}` and the hooks used bare `/v1/watchers/*`. The surface then
rendered a confident "WATCHERS · 0". **curl returns 200 for those endpoints and the component
tests mock the client — both were green the whole time.** Same root shape fixed in
`getAssistant()` (platform listing that can only 401, and which returned instead of falling
through to local) and the Settings picker/upgrade card.

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

**KNOWN LIMIT — the restart window (measured, not theoretical).** For roughly the first
minutes after a daemon restart (i.e. after every deploy), the assessment call fails and the
task runs **unassessed**, because fail-open is deliberate. Reproduced twice on prod: "Pay the
architect invoice" dispatched ~30s after a deploy ran with no verdict; the identical task on
a warm daemon returned `not_ai_task` and parked. Both retries fire back-to-back into the same
cold provider, so they do not help. Spacing the retries was tried and reverted — it could not
be validated (the observed failure outlasted ~60s of attempts) and it made the suite sleep.
Options for a real fix, in preference order: (a) hold dispatch until a provider resolves
rather than assessing against a cold one; (b) mark an item that ran unassessed so the UI can
say "Cue did not get to check this" instead of it being indistinguishable from a cleared run;
(c) longer retry horizon. **Until then: after a deploy, avoid running money/irreversible
tasks for a few minutes.**

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

## Resolved loose ends
- **"Advisor never showed a `call_site=advisor` row"** — not a defect. `llm_request_logs` only
  records `mainAgent` / `compactionAgent`; every side-chain call (advisor, assessment,
  conversation titles) is absent by design. The daemon-log `advisor_consult_applied` line is
  the real evidence. Deliberately NOT adding side-chain request logging — those writes were
  the root cause of the assistant.db runaway.

## Known backend gaps flagged for follow-up
- Connector health probe exists but Composio only exposes "linked" not live health (real probe = future)
- DSML history leak filter (old DeepSeek markup in some transcripts) — sanitizer shipped, verify coverage
- Plugin install `inspect` uses marketplace.json (provenance layer) while browse uses registry.json (by design; consistent for the UI)
