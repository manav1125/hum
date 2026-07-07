# Render → Fly cutover runbook (Manav's production instance)

**Status (2026-07-07):** migration PREPARED. Full verified backup captured; the
final cutover is a coordinated ~15-min window (below). Render stays fully live
until you run it.

## Why this isn't already done autonomously

Two things genuinely need a human-in-the-loop moment:

1. **Native clients point at the Render URL.** The iOS TestFlight build and the
   macOS app are compiled against `cue-app-3yne.onrender.com`. Repointing them
   is a rebuild + redistribute, not an API call. The web SPA can be repointed
   instantly; the native apps ride the next build.
2. **Clean cutover wants a brief Render freeze** so the final data copy is
   consistent (no writes mid-copy). That's a deliberate downtime window, not
   something to trigger blind while you're away.

Good news that de-risks it: your Render instance runs **connectors disabled**
(CES off), so there are no live email/calendar watchers — no double-acting
hazard if both instances are briefly up.

## What's already captured

- **Full essential workspace backup**: `~/.cue/render-backup/workspace-20260707.tar.gz`
  (190 MB gz, 96,769 entries, sha `5a8b3d0da8f954ff…`). Contains `data/db/assistant.db`
  (+ wal/shm), conversations/, gateway-security/ + gateway-security-v2/ (the
  guardian binding — so migrated instance keeps the SAME identity), media/,
  projects/, attachments/, apps/. Skipped: embedding-models (re-downloads),
  migrate.vbundle (stale), logs.
- **Render env snapshot**: `~/.cue/render-env.json` (28 vars incl. signing key,
  bootstrap secret, all tokens).
- **SSH access proven**: `ssh -i ~/.ssh/cue-render-migrate srv-d8pb70s8aovs73edureg@ssh.singapore.render.com`
  (note: Render instance is in **Singapore**, not US).

## Cutover sequence (run when ready; ~15 min, ~5 min user-facing downtime)

```bash
export FLY_API_TOKEN=$(cat ~/.cue/fly-org-token)
export RENDER_API_KEY=rnd_...   # from ~/.cue or Render dash

# 1. Create the target app + volume (US, 2GB — the OOM-safe size)
flyctl apps create cue-manav-prod --org personal
flyctl volumes create workspace -a cue-manav-prod --region iad --size 20 --yes

# 2. Set env = Render's env (from ~/.cue/render-env.json), with the SAME
#    ACTOR_TOKEN_SIGNING_KEY + GUARDIAN_BOOTSTRAP_SECRET so existing device
#    pairings keep working. Set QDRANT_URL EMPTY (self-spawns on the volume).
#    (script: hq/scripts/render-env-to-fly.ts — reads render-env.json, strips
#    Render-only keys, flyctl secrets set)

# 3. FREEZE Render writes: scale the Render service to 0 (or suspend) so no
#    new writes land during the final copy.
#    Render dashboard → cue-app → Suspend  (or `render` API)

# 4. Final delta copy off Render → into the Fly volume:
ssh -i ~/.ssh/cue-render-migrate srv-...@ssh.singapore.render.com \
  "cd /workspace && tar czf - data/db conversations gateway-security gateway-security-v2 media projects data/attachments data/apps" \
  | flyctl ssh sftp ... # or: boot the machine with an init that untars from a mounted backup

# 5. Boot cue-manav-prod on image registry.fly.io/cue-releases:v23c00db656
#    (supervision fix + managed-mode). Verify:
flyctl ssh console -a cue-manav-prod -C "sh -c 'ls -la /workspace/data/db/assistant.db'"
curl https://cue-manav-prod.fly.dev/healthz          # 200
# conversation count matches Render's pre-freeze count

# 6. Repoint clients:
#    - Web SPA: it's served by the same image, so cue-manav-prod.fly.dev works immediately.
#    - Custom domain (optional): add manav.justcue.app CNAME + Fly cert.
#    - iOS/macOS: next build points at the new URL (task — not blocking web use).

# 7. Verify a live chat turn + your memories/conversations are all present.

# 8. Only after 3–5 days of confidence: delete the Render services
#    (cue-app + cue-qdrant), cancel the plan. Keep the local backup regardless.
```

## Rollback

If anything's off after step 5, un-suspend Render — it still has all data (we
only froze it, never deleted). Clients that were still pointed at Render just
resume. Zero data loss.

## Follow-up to make this one-command later

`hq/scripts/render-env-to-fly.ts` + a restore-on-boot init would turn steps 1–5
into a single script. Deferred — the manual sequence above is safe and the
backup is the thing that mattered.
