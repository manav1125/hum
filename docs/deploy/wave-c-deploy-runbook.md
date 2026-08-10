# Wave C deploy runbook — the memory-DB split boot migration

Audience: whoever merges and deploys `cue/upstream-wave-c` (written for the review/deploy
thread; Manav does not need to do anything by hand beyond saying go).

## Why this deploy is different

Commit `9c2c049553` moves the memory subsystem's high-churn tables out of `assistant.db`
into a new `assistant-memory.db`. On the FIRST boot after this deploys, migrations 324–328
copy those tables' rows and drop the originals. On Manav's prod instance that is a
few-hundred-MB, minutes-long one-time copy. The migration is idempotent (crash mid-copy →
safe re-run), but the backup taken BEFORE it runs is the only cheap rollback.

## Order of operations (prod: `cue-manav-prod` on Fly)

1. **Merge** `cue/upstream-wave-c` into the main line, normal review. Nothing in the wave
   is flag-on risky: voice narration/acks are flag-off; the import flow and design polish
   are additive; the split is the only boot-behavior change.
2. **Pick a quiet window.** The copy holds the daemon busy at boot; avoid a moment when
   schedules/watchers are mid-burst. Overnight WITA is fine.
3. **Backup with the daemon OFF** — our Fly backups deadlock against a busy daemon
   (established incident): stop the daemon process, take the volume/tar backup of
   `/workspace/data/db/` (all files: `assistant.db*` — the WAL and SHM too), then proceed.
   Do NOT skip this: it is the rollback for the whole deploy.
4. **Check free disk on the volume first**: the copy needs headroom roughly equal to the
   moved tables' size (graph + logs + jobs). Prod has had disk-full incidents; verify
   `df` on `/workspace` shows at least 2× the current assistant.db size free.
5. **Deploy the image** (standard flow: build from a detached worktree at the ship commit,
   `openapi-ts` first, per the release-build convention). First boot runs the migrations;
   watch logs for the five `migrateMoveMemory*` steps and the final
   `DB migration steps complete`.
6. **Verify after boot:**
   - `assistant-memory.db` exists next to `assistant.db` and is growing/settled.
   - `assistant.db` no longer contains the moved tables:
     `sqlite3 assistant.db ".tables" | grep memory_graph` → empty.
   - The app works: open the Memory page (graph loads = the moved graph cluster reads),
     send a chat turn (activation state writes), check a schedule fires (memory job queue).
   - The next nightly snapshot produces BOTH families: `assistant-*.db` and
     `assistant-memory-*.db` in the snapshot dir.
7. **Rollback, if needed** (before meaningful new writes accumulate): stop daemon, restore
   the step-3 backup of the db directory, deploy the previous image. After users have
   written real data post-migration, rolling back loses it — prefer forward-fixes.

## Not in this deploy / follow-ups

- `llm_request_logs` stays in the main DB (the logs-DB split is a planned follow-up).
- The voice re-platform is NOT in this wave; narration/acks ship flag-off pending device QA
  (`liveVoice.frontModel.spokenAcks`, `liveVoice.frontModel.progress.enabled`).
- Design-polish surfaces (bookmarks relocation, system cards, decided approvals, import
  flow) are ordinary web/daemon changes with no deploy caveats.

## ⚠️ DEPLOY LINEAGE RULE (2026-08-10, standing)

Prod deploys MUST come from the `cue/voice-replatform` lineage (or merge it
into your branch first). The voice hybrid (H-1/H-3, engine migration, idle
re-arm, preflight env fallback) lives there; a wave-c-only deploy SILENTLY
UN-SHIPS VOICE — this happened on 2026-08-10 13:12Z and burned a full QA
round. `cue/voice-replatform` already contains all of wave-c (merged at
3c6a16ea25 and continuously); when in doubt, merge it and deploy the result.
Before diagnosing any prod symptom, confirm the running image tag is the one
you think it is: `fly machine list -a cue-manav-prod`.
