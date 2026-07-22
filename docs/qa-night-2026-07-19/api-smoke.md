# QA-NIGHT 2026-07-19 — API-level E2E smoke (Cue prod)

- **Target:** https://manav.justcue.app (Fly app `cue-manav-prod`, machine `48eed1ef1411e8`, iad, shared-cpu-2x / 4GB, image `deployment-01KXXCW5F6QPVN4H0ZER4F9J7Q`)
- **Run window:** 2026-07-19 ~14:42–14:55 UTC (22:42–22:55 Asia/Makassar)
- **Auth:** existing actor JWT at `~/.cue/qa-actor-token` (still valid against Fly prod)
- **Harnesses:** custom driver (scratchpad `qa-night.ts`, 27 checks) + existing `assistant/qa/prod-smoke.ts` re-run with `CUE_QA_BASE_URL=https://manav.justcue.app CUE_QA_SKIP_BROWSER=1`
- **Hygiene:** every created object was prefixed `QA-NIGHT — safe to delete` and removed afterwards (work item deleted 200, project deleted 200, knowledge removed 200, QA conversation archived 200, toggled schedule restored exactly). No real user data mutated.

## Verdict

**Platform is alpha-shippable from the API side: 27/27 custom checks PASS, all core loops green and fast.** Two medium-severity operational risks to close before the 50–100-user rollout (credential-vault drift, assistant.db regrowth), plus a harness bug producing a false heartbeat warning.

## Per-check results

### 1. Chat E2E — PASS
- POST `/v1/assistants/self/messages` (new conversation) → assistant reply **"4"** landed in **27.8s** (limit 180s). No hung turn.
- Conversation archived post-test (`conversations/:id/archive` → 200).

### 2. Work loop E2E (capture→run→review→complete) — PASS
- POST `work-items` → created queued, **triage stamped `priorityTier=1` at create** (1.1s).
- POST `work-items/:id/run` → 200 (0.96s).
- Landed **`awaiting_review` in 35s**; `work-items/:id/output` → 200 with output payload.
- POST `work-items/:id/complete` → 200 (awaiting_review → done). Deleted after.

### 3. Morning brief — PASS
- GET `brief/morning` → 200 in 2.6s; shape exact: `overnight[1]`, `ask` (kind=review), `day[4]`, `calendarAvailable=true`, `generatedAt`/`since` present.
- Config: `notifications.morningBrief = {"timezone":"Asia/Makassar"}` (via GET `config`).
- Scheduler armed: `startMorningBriefScheduler()` wired unconditionally in the **deployed image's** `src/daemon/lifecycle.ts` (verified on-machine), and the "Daily brief" schedule exists in `/schedules`. Note: the "Morning brief push scheduler started" INFO line is *not observable* in `/workspace/data/logs/assistant-*.log` because file logging drops INFO after the "loading config" startup stage (WARN+ only from then on) — verify by push arrival, not logs.

### 4. Schedules — PASS
- GET `schedules` → 5 schedules (387ms).
- Toggle round-trip on "Daily brief": true→false→true, **restored exactly**, both toggles 200 (1.46s total).

### 5. Projects — PASS
- List → 2 projects (703ms). Create QA project → 200; PATCH `context` → 200; knowledge add URL → 200; knowledge remove → 200; DELETE project → 200 (3.0s for the CRUD chain).

### 6. Read surfaces — 13/13 PASS (all 200, sane shapes)
| surface | latency | detail |
|---|---|---|
| memory-items | 1.8s | 20 items |
| contacts | 1.0s | 2 contacts |
| connector-apps | 1.3s | 500 apps, source=composio |
| skills | 2.1s | 49 skills |
| acts (ledger) | 351ms | 20 acts |
| acts/summary | 468ms | 33 acts, 2 reversed, 280 est-min saved |
| agents | 528ms | 4 agents |
| guardrails | 610ms | checkpoints incl. default-delete |
| pending-interactions | 302ms | `{"interactions":[]}` |
| outputs | 555ms | 1 output |
| home/state | 492ms | 200 |
| tools | 2.4s | 392KB registry |
| heartbeat/config | 557ms | enabled, 30m interval |

No 4xx/5xx/hangs anywhere.

### 7. Voice readiness — PASS
- GET `tts/providers` → 200 (ElevenLabs listed); GET `stt/providers` → 200 (Deepgram listed).
- GET `/v1/live-voice` without upgrade → **426 Upgrade Required** (WS endpoint live; WS not opened by design).
- Bonus E2E: POST `tts/synthesize` `{"text":"QA check"}` → 200, real 13KB MP3 in **1.2s** — the ElevenLabs key path works at runtime.

### 8. Daemon health — PASS with observations
- Machine `started`, HostStatus ok. Restarted 14:38Z today (user-initiated `machine update`, i.e. tonight's deploy) — 7 daemon boots today, 4 yesterday, consistent with the deploy waves, **no crash/OOM signatures**.
- Memory: 1.3GB/3.9GB used; daemon RSS 718MB (`bun --smol`), embed-worker 486MB, gateway 158MB, qdrant 101MB.
- Disk: `/workspace` 1.9G/20G (11%) — the `VELLUM_MINIKUBE_STORAGE_SIZE=20Gi` fix is in effect.
- **DB: `/workspace/data/db/assistant.db` = 446MB, WAL = 62MB** (see finding M2).
- 6h error scan (Fly stdout buffer + on-machine `/workspace/data/logs/assistant-2026-07-19.log`): **zero ERROR lines, zero** `event_loop_blocked` / `llm_request_log_persist_slow` / OOM / unhandled. WARNs only: per-boot `gateway-ipc-client` socket-error bursts (transient during restart) and a recurring `memory-db` warning (finding L2).

### 9. Existing `qa/prod-smoke.ts` re-run — 10 pass · 2 warn · 1 fail
- PASS: spa-served (bundle `index-CQTuih2m.js`, push registration present), auth-api, tools-registry (all 7 flagship tools), marketplace (7 sources), research-tools, connector-apps, push-devices (4 devices), sse (first bytes 289ms), workitem-triage, **live-turn (assistant replied)**.
- FAIL `credentials`: openrouter missing from secure store → finding M1.
- WARN `heartbeat`: false alarm → finding L1.
- Note: on failure the harness **auto-filed a "QA smoke: investigate prod failures" work item** via the `qa-prod-smoke` thread (its designed alerting) — that item in the queue is from this run.

## Issues, severity-ranked

### M1 (medium) — Credential vault does not hold the inference/voice keys; everything leans on env vars
`credentials/list` shows: `openrouter` **absent entirely**; `elevenlabs`, `tavily`, and all 3 `slack_channel` rows present but **`hasSecret=false`**; only `anthropic` and `replicate` have secrets. Chat (Gemini via `CUE_OPENROUTER_BASE_URL` masquerade) and TTS work anyway because env fallbacks carry the keys — but the vault's restart-survival invariant is broken, and this is the known "vault key drops on restart" bug family (QA 2026-07-14). Risk for alpha: any `machine update --env` that omits a var (exactly how the `WEB_DIST_DIR` outage happened) silently kills chat or voice. Fix: re-seed the vault + make the entrypoint re-seed idempotently, or formally declare env the source of truth and update `REQUIRED_CREDENTIALS` in the harness.

### M2 (medium) — assistant.db regrown to 446MB (+62MB WAL)
The conversation-runaway incident pruned this DB to ~25MB; it is now **446MB** again with a 62MB WAL. The two root-cause bugs from the runaway (background memory jobs persisting conversations) were never fixed per the memory notes, and the 2026-07-18 latency incident was WAL/request-log flushes. No user-visible slowness tonight (chat 27.8s incl. LLM; reads sub-second), but at this growth rate the "chat takes minutes" incident recurs mid-alpha. Fix before rollout: root-cause the writer, re-prune, and add a size watchdog.

### L1 (low) — prod-smoke harness has stale expectations (false heartbeat warn, questionable credentials list)
Heartbeat runs report `status: "ok"` (+ `superseded`/`skipped`/`pending`), but `checkHeartbeat()` searches for `"completed"` → permanent false WARN. Reality: 4 `ok` runs in the last 4h (last finished ~13:54Z). Same file: `REQUIRED_CREDENTIALS = ["openrouter", "replicate"]` predates the Gemini-direct/env-key era (see M1) and default `BASE` still points at the retired Render URL. File: `assistant/qa/prod-smoke.ts`.

### L2 (low) — recurring boot warning: memory-db migration checkpoints "from a newer version"
Every daemon boot logs `[memory-db] Database contains 37 migration checkpoint(s) from a newer version. Data may be incompatible.` Likely residue of the Render→Fly migration/version skew. Harmless so far, but it will alarm anyone reading logs during an alpha incident; worth clearing the checkpoint rows or downgrading the message.

### L3 (low/informational) — INFO-level daemon logs invisible after startup config load
File transport drops to WARN+ once config loads, so operational INFO lines (scheduler starts, morning-brief ticks) never reach `/workspace/data/logs/*.log`, and Fly's stdout buffer only holds seconds. Debugging the morning-brief push on a live incident will be blind; consider file-logging INFO for the notifications component or keeping a small ring buffer route.

### Informational
- 7 restarts today were deploy-driven (`launch user` events), each with a brief gateway-IPC reconnect burst — expected; no crash loops.
- prod-smoke's auto-filed "QA smoke: investigate prod failures" work item is sitting in the queue from this run (deliberate harness behavior; relates to M1).

## Latency snapshot
Chat E2E 27.8s · work item run→review 35s · brief/morning 2.6s · TTS synth 1.2s · SSE first bytes 289ms · typical reads 0.3–1s · heaviest reads (tools 392KB, skills) 2.1–2.4s.
