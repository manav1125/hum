# assistant.db runaway regrowth — diagnosis, fix, morning prune runbook

**QA-night 2026-07-19 · follow-up to api-smoke.md finding M2 (446MB DB + 62MB WAL).**
Territory: `assistant/**`. Code fixes are in the working tree (NOT committed). Prod untouched (all queries read-only via `sqlite3 -readonly`).

---

## 1. Live diagnosis (prod, 2026-07-19 ~15:00 UTC)

DB file 446MB (`page_count` 108,932 × 4KB) + 62MB WAL. **This is NOT a repeat of the June conversation runaway** (795 conversations total, not 45k). The regrowth is telemetry amplification:

| table | size | rows | notes |
|---|---|---|---|
| `memory_v2_activation_logs` | **92MB** | **842** | avg **114KB/row**, max **579KB**. Recent rate **14–22MB/day** and accelerating |
| `messages` + FTS | 70MB + 86MB | 9,640 | 6,259 msgs (24MB) belong to `background` conversations |
| `memory_segments` | 40MB | 21,701 | ~1.4–3k rows/day |
| `llm_request_logs` | 16MB | 123 | **healthy** — all rows < 7h old (1h retention + 6h enqueue window works); 128KB write cap works; but ~16MB/day of churn feeds WAL + freelist |
| `activation_state` | 14MB | 648 | ~22KB/row, FK-cascades with conversations |
| freelist | **~64MB** | 16,292 pages | reclaimable only by VACUUM |
| `memory_jobs` | 3MB | 20,567 | terminal rows within the 7-day reaper window — bounded, working |

Conversations: 795 total → `background` 428 / `standard` 366. By source: **heartbeat 373**, user 309, live-voice 45, task 43, rest <10 each.

Activation-log rows by mode: `context-load` 648 rows × **avg 129KB** = 81MB (the bulk); `per-turn` 76 × 131KB; `router`/`errored` negligible.

### Prior-incident status (verified against current code)
- The June "2 root-cause bugs" (consolidation + retrospective persisting a background conversation per run) **were since fixed properly**: consolidation runs with `ephemeralConversation: true` (`src/memory/v2/consolidation-job.ts:335`, deleted by `runBackgroundJob` + stale sweep) and retrospective GC-supersedes + sweeps orphans (`memory-retrospective-startup-cleanup.ts`). Prod confirms: 0 consolidation conversations, 1 retrospective conversation.
- **`CUE_DISABLE_BACKGROUND_MEMORY` is NOT set on the Fly machine** — it was dropped in the Render→Fly env migration. With the proper fixes above this is no longer load-bearing; leave it off.
- The `llm_request_logs` 128KB payload cap (`serializeLlmLogPayload`, `llm-request-log-store.ts:140`) and 1h retention (`memory.cleanup.llmRequestLogRetentionMs`) are **deployed and working**.
- The `memory_jobs` reaper (7d, `jobs-store.ts pruneOldMemoryJobs`) is **deployed and working**.
- No periodic WAL checkpoint existed (only startup/shutdown TRUNCATE on the in-process connection) — hence the 62MB WAL between restarts.

## 2. Root cause of the regrowth (file:line)

**Amplifier — unbounded activation telemetry.** `memory.v2.ann_candidate_limit` defaults to `null` = *unlimited* (`src/config/schemas/memory-v2.ts`), so `selectCandidates` (`src/memory/v2/activation.ts:107`) returns **the entire concept-page collection** as the per-turn candidate set (collection grew with skills/marketplace-in-embedding-space). `finalizeInjection` (`src/memory/v2/injection.ts:497`) then serializes **one telemetry row per candidate** into `memory_v2_activation_logs.concepts_json` via `recordMemoryV2ActivationLog` (`src/memory/memory-v2-activation-log-store.ts`) — ~114KB average, 579KB max, **every turn of every conversation**, with **no cap and no retention**, and the table has no FK so even conversation deletion orphans its rows (`pruneOldConversationsJob` didn't cover it either).

**Driver — heartbeat persists a conversation per run, forever.** `HeartbeatService.executeRun` (`src/heartbeat/heartbeat-service.ts:~800`) calls `runBackgroundJob` *without* `ephemeralConversation` (intentional — the conversation is user-visible and referenced by run history), and nothing ever reclaimed old ones: `memory.cleanup.conversationRetentionDays` defaults to 0 (disabled, and would prune *user* conversations too — unusable as-is). At a 30–60min heartbeat: ~25–50 background conversations/day, each dragging messages (+FTS), memory_segments, activation_state, and a ~129KB `context-load` activation-log row. 373 heartbeat conversations accumulated in 3 weeks.

**Secondary — WAL/freelist.** ~16MB/day of `llm_request_logs` write-then-delete churn + no runtime checkpoint → 62MB WAL and 64MB freelist between restarts.

Combined ≈ 20–30MB/day → 25MB → 446MB in ~3 weeks. Reproduces exactly the observed regrowth.

## 3. Fixes (in working tree, assistant/**)

1. **Write-time cap on activation telemetry** — `capConceptRowsForLog` in `src/memory/memory-v2-activation-log-store.ts`: serialize at most `memory.v2.activation_log_max_concepts` rows per log row (new config, **default 300**, `null` = old behavior; `src/config/schemas/memory-v2.ts`). Rows with a meaningful status (`injected`/`in_context`/`page_missing`/`corrupt`) are always kept (bounded by `top_k`=25); the budget fills with highest-activation `not_injected` candidates. Wired through the only production writer (`src/memory/v2/injection.ts:497`). Bounds a 579KB row to ~55KB worst case, typical far less.
2. **Retention for activation/recall telemetry** — new job `prune_old_activation_logs` (`src/memory/job-handlers/cleanup.ts`) deletes `memory_v2_activation_logs` + `memory_recall_logs` rows older than `memory.cleanup.activationLogRetentionDays` (**default 14**, 0 disables). Batched (1000/batch) via `runAsyncSqlite` (sqlite3 subprocess — off the event loop), self-re-enqueuing, scheduled by the existing cleanup scheduler (`jobs-worker.ts maybeEnqueueScheduledCleanupJobs`, 6h cadence).
3. **Retention for background conversations** — new job `prune_old_background_conversations` (`src/memory/job-handlers/cleanup.ts`): same batched/re-checked transaction shape as the existing conversation prune but filtered `conversation_type = 'background'`; `memory.cleanup.backgroundConversationRetentionDays` (**default 30**, 0 disables). User (`standard`) conversations are never touched. Deletes non-cascading children explicitly — and the shared core now also deletes `memory_v2_activation_logs` + `memory_recall_logs` rows (fixing the orphan gap in the pre-existing `prune_old_conversations` job too).
4. **Hourly PASSIVE WAL checkpoint** — `maybeCheckpointWal` (`src/memory/jobs-worker.ts`), on the daemon's own in-process connection, per the CLAUDE.md WAL rules (PASSIVE never blocks and can never unlink the WAL under peers). Bounds intra-day WAL growth without waiting for restart.
5. Config watcher (`src/daemon/config-watcher.ts cleanupSettingsChanged`) now resets the cleanup throttle when the new retention knobs change.

Not changed on purpose: heartbeat conversations stay persistent (user-visible, referenced by run history) — retention bounds them instead; `ann_candidate_limit` left `null` (retrieval-quality decision, not mine to make tonight — the telemetry cap removes its DB cost; flagging separately that `null` also costs per-turn scoring work).

**Tests** (all green, run per-file per repo convention):
- `src/memory/__tests__/memory-v2-activation-log-store.test.ts` — cap keeps meaningful rows + highest-activation fillers; `null` = unlimited; default cap applies (3 new tests).
- `src/__tests__/prune-old-background-conversations-job.test.ts` — stale background pruned with all dependent telemetry; fresh background and stale *user* conversations untouched; 0 disables.
- `src/__tests__/prune-old-activation-logs-job.test.ts` — both telemetry tables age-pruned; 0 disables; payload override wins.
- Updated default-shape expectations: `config-schema.test.ts`, `config-watcher-cleanup-throttle.test.ts`, `schemas/__tests__/memory-v2.test.ts`.
- `bunx tsc --noEmit` clean. Pre-existing unrelated failures noted: 4 `permissionTimeoutSec 300→3600` expectations stale since commit 957487fe3f; whole-directory `bun test` runs show cross-file `mock.module` pollution (all files pass individually — 31/31 in `src/memory/__tests__/`).

### Expected steady state after deploy
Activation logs ≤ ~14 days × ~40 rows/day × ≤55KB ≈ **≤30MB hard ceiling** (typically <10MB); background conversations ≤ ~30 days ≈ 750–1500 convs with their messages/FTS/segments bounded; llm_request_logs already bounded; WAL bounded hourly. Daily VACUUM (`db-maintenance.ts`, quiet-period-gated) reclaims freed pages.

## 4. Morning prune runbook (coordinator — do NOT run from this session)

Order matters: **deploy the fixed image first**, then let the daemon's own cleanup do the age-based deletes in safe batches, then reclaim space. Manual SQL is only needed for the one-shot backlog + VACUUM.

### Step 0 — backup (known-good daemon-off method)
The daemon backup API deadlocks on a busy daemon — use the machine-level copy:
```sh
# graceful restart first = clean-shutdown TRUNCATE checkpoint (WAL folds into the db file)
env -u DOCKER_HOST flyctl machine restart 48eed1ef1411e8 -a cue-manav-prod
env -u DOCKER_HOST flyctl ssh console -a cue-manav-prod -C \
  "cp /workspace/data/db/assistant.db /workspace/data/db/assistant-pre-prune-2026-07-19.db"
```
(1.9G used of 20G — room is fine. Delete the copy after verification.)

### Step 1 — deploy the fixed assistant image
Normal image-bake + `machine update` flow. **Re-pass the full env set** (`WEB_DIST_DIR` outage lesson — bare-machine app, env only via `machine update --env`).

### Step 2 — one-shot backlog prune (on-machine, sqlite3 CLI)
The deployed retention jobs will drain the backlog themselves in 100-conv/1000-row batches, but the coordinator can do it in one shot. **Gotcha: the sqlite3 CLI has `foreign_keys` OFF by default — deleting `conversations` rows does NOT cascade; delete children explicitly (orphan-sweep pattern below handles every child table).** zsh gotcha from the prior recipe: generate multi-table SQL with python, not a shell for-loop over an unquoted var.

```sh
env -u DOCKER_HOST flyctl ssh console -a cue-manav-prod
# on the machine:
sqlite3 /workspace/data/db/assistant.db <<'SQL'
-- ages in ms; retention mirrors the new config defaults
-- 1) background conversations older than 30d (heartbeat/task/watcher scaffolding; NEVER standard)
DELETE FROM conversations
 WHERE conversation_type='background'
   AND updated_at < (CAST(strftime('%s','now') AS INTEGER) - 30*86400)*1000;
-- 2) telemetry older than 14d regardless of conversation
DELETE FROM memory_v2_activation_logs
 WHERE created_at < (CAST(strftime('%s','now') AS INTEGER) - 14*86400)*1000;
DELETE FROM memory_recall_logs
 WHERE created_at < (CAST(strftime('%s','now') AS INTEGER) - 14*86400)*1000;
-- 3) terminal job history (reaper handles future ones)
DELETE FROM memory_jobs WHERE status IN ('completed','failed');
SQL

# 4) orphan-sweep every table carrying conversation_id (CLI deletes above did not cascade)
python3 - <<'EOF'
import sqlite3
db = sqlite3.connect('/workspace/data/db/assistant.db')
tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name != 'conversations'")]
for t in tables:
    cols = [r[1] for r in db.execute(f"PRAGMA table_info({t})")]
    if 'conversation_id' in cols:
        n = db.execute(f"DELETE FROM {t} WHERE conversation_id IS NOT NULL AND conversation_id NOT IN (SELECT id FROM conversations)").rowcount
        if n: print(t, n)
db.commit(); db.close()
EOF

# 5) FTS rebuild after the mass message delete, then reclaim
sqlite3 /workspace/data/db/assistant.db "INSERT INTO messages_fts(messages_fts) VALUES('rebuild');"
sqlite3 /workspace/data/db/assistant.db "PRAGMA wal_checkpoint(FULL); VACUUM;"
```
VACUUM needs the write lock — if it returns `database is locked`, retry when chat is idle (or immediately after another graceful machine restart). **Never `wal_checkpoint(TRUNCATE)` from the CLI while the daemon runs** (ghost-WAL split-brain, see assistant/CLAUDE.md); FULL is safe.

### Step 3 — verify
```sh
env -u DOCKER_HOST flyctl ssh console -a cue-manav-prod -C \
  "sh -c 'ls -la /workspace/data/db/; sqlite3 -readonly /workspace/data/db/assistant.db \"SELECT COUNT(*) FROM conversations; SELECT COUNT(*) FROM memory_v2_activation_logs;\"'"
```
Expect: db well under 100MB (valuable data was ~25MB three weeks ago + ~3 weeks of real use); standard conversation count unchanged (366 as of tonight); memory_graph_nodes/edges/embeddings untouched (no conversation_id — the sweep can't touch them). Then send a chat message end-to-end, check the sidebar still shows user conversations, and delete the pre-prune backup copy.

### Watch-list for the following days
- `assistant.db` size stays flat (±llm_request_logs churn); WAL stays <10MB between restarts.
- Log lines: `"Pruned old background conversations"`, `"Pruned old memory-v2 activation/recall telemetry"`, `"Database maintenance complete"` (WARN+ file-logging caveat from api-smoke L3 — these are INFO; verify via DB counts, not logs).
- Config escape hatches if anything misbehaves: `memory.cleanup.backgroundConversationRetentionDays=0`, `memory.cleanup.activationLogRetentionDays=0`, `memory.v2.activation_log_max_concepts=null`.

## 5. Open follow-ups (not done tonight)
- Consider a finite `memory.v2.ann_candidate_limit` (e.g. 150) — unlimited also costs per-turn embedding/scoring work, independent of the now-bounded telemetry.
- `scheduled`-type conversations (1 row today) aren't covered by the background prune; revisit if schedules proliferate.
- Stale `permissionTimeoutSec` test expectations (commit 957487fe3f) fail unrelated to this work.
