# Cue Learn — operations runbook

Cue Learn is the OpenMAIC fork embedded behind the gateway's `/learn/*` proxy.
This is the operator's map: where everything lives, how to update it, and the
cadence that keeps it healthy.

## Topology

| Piece | Where | Notes |
|---|---|---|
| Fork (working clone) | `~/OpenMAIC`, branch `cue-learn` | The build source for Manav's own sidecar |
| Fork (in-repo mirror) | `learn/` (git subtree, squashed) | What fleet sidecar images build from |
| Manav's sidecar | Fly app `cue-learn-manav` (iad, private) | Full build: Postgres persistence + Pro workbench |
| Fleet sidecars | Fly apps `cue-learn-<slug>-<id8>` | Browser-persistence build ONLY (see security note) |
| Gateway proxy | `gateway/src/http/routes/learn-proxy.ts` | Env-gated on `LEARN_UPSTREAM_URL` |
| Chat skill | `assistant/src/config/bundled-skills/learn/` | Flag-gated on `learn-app` |
| Usage bridge | `assistant/src/learn/usage-sync.ts` | 5-min poll → `llm_usage_events` (`actor='learn'`) |
| HQ provisioning | `hq/src/learn-sidecar.ts` + fly-driver | Gated on `HQ_LEARN_IMAGE_REF` + `HQ_LEARN_GOOGLE_API_KEY` |

## Security invariants (do not relax casually)

1. **Sidecars get no public IPs.** Reachable only as `http://<app>.internal:3000`
   from the same 6PN network; the customer's gateway cookie (`cue_learn`) is
   the auth boundary.
2. **The fleet image must NOT enable `NEXT_PUBLIC_PERSISTENCE`.** Server
   persistence compiles a bearer token into the client bundle; a shared fleet
   image would share that token across tenants on one private network.
   Per-customer server persistence requires per-customer builds (future work).
3. `HOSTNAME="::"` everywhere — Fly private networking is IPv6-only.

## Release procedures

**Manav's sidecar** (from `~/OpenMAIC`):

```bash
cd ~/OpenMAIC && env -u DOCKER_HOST flyctl deploy --remote-only --depot=false \
  --app cue-learn-manav --ha=false \
  --build-arg NEXT_PUBLIC_PERSISTENCE_TOKEN="$(cat ~/.cue/learn-persistence-token)"
```

**Fleet sidecar image** (from the repo, uses `learn/`):

```bash
FLY_ORG_SLUG=personal hq/scripts/learn-release.sh
```

**Cue app image** (gateway/daemon/web with the Learn pieces): the normal
`hq/scripts/fly-release.sh` flow. Remember `deploy/web-dist` must be rebaked
(`VITE_CUE_SELF_HOST=1 bun run build` in `apps/web`, copy to `deploy/web-dist`)
when web code changed.

Build gotchas: Fly's depot builder OOM-kills the Next build silently — always
`--depot=false`; a stray `DOCKER_HOST` env breaks the classic builder — always
`env -u DOCKER_HOST`; a `flyctl deploy` resets machine env to fly.toml `[env]`,
so durable env lives in fly.toml, never in one-off `machine update --env`.

## Upstream cadence (monthly, or when upstream ships something we want)

```bash
cd ~/OpenMAIC
git fetch upstream && git log --oneline cue-learn..upstream/main | head -30
git merge upstream/main        # resolve; our patch surface is deliberately small
# then refresh the in-repo mirror:
cd <repo> && git subtree pull --prefix=learn ~/OpenMAIC cue-learn --squash
```

(If `upstream` is missing: `git remote add upstream https://github.com/THU-MAIC/OpenMAIC`.)

Our permanent patch surface, kept small on purpose: `next.config.ts` basePath,
`Dockerfile` (ARG plumbing, heap ceiling, /app/data chown), `fly.toml`,
`lib/brand/brand-config.ts` + `public/logos/cue-learn-*`, display strings +
i18n brand lines, TTS/ASR server-provider promotion in `lib/store/settings.ts`,
the ElevenLabs Scribe ASR provider, `/api/usage/records`, and the Ask-Cue
header button. Everything else should track upstream clean.

## Enabling Learn for the fleet

1. `FLY_ORG_SLUG=personal hq/scripts/learn-release.sh` (builds + pushes the
   fleet image, points `HQ_LEARN_IMAGE_REF` at it).
2. `flyctl secrets set -a cue-hq HQ_LEARN_GOOGLE_API_KEY=… \
   HQ_LEARN_ELEVENLABS_API_KEY=… HQ_LEARN_TAVILY_API_KEY=…`
3. New provisions get a sidecar + `LEARN_UPSTREAM_URL` + the flag
   automatically. Existing customers: `POST /admin/learn-backfill` (admin
   token; `{"dryRun":true}` to preview) sweeps live instances without a
   `learnAppName` — provisions a sidecar, patches the machine env
   (RESTARTS the machine), records the row. Idempotent; an instance whose
   env already names a `http://<app>.internal:<port>` upstream is ADOPTED,
   never re-pointed. Ran clean across the fleet 2026-09-03.

## Backups

`cue-learn-db` (all course documents, yours + fleet) relies on Fly volume
snapshots (5-day retention). Offsite baseline + refresh:

```bash
flyctl ssh console -a cue-learn-db -C "sh -c 'PGPASSWORD=$OPERATOR_PASSWORD pg_dumpall -h localhost -U postgres | gzip -c > /data/learn-backup.sql.gz'"
flyctl ssh sftp get /data/learn-backup.sql.gz ~/.cue/backups/learn-backup-$(date +%Y%m%d).sql.gz -a cue-learn-db
```

Automating this on a schedule is still open.

## Known gaps

- Every Learn sidecar now mounts a `learn_data` volume at `/app/data`
  (classroom JSONs + generated media survive image rolls; the provisioner
  chowns it to `nextjs` once via machines exec). A redeploy can still lose
  the last few minutes of unpolled usage rows.
- Tenant isolation: each sidecar enforces a per-customer access secret
  (`OPENMAIC_ACCESS_SECRET` middleware) — only the customer's own gateway
  (which injects `x-openmaic-access`) can reach it across the shared 6PN;
  the co-located daemon is trusted on the raw loopback socket at the
  gateway. Fleet server persistence is ON: per-customer database + role on
  the shared `cue-learn-db` cluster (HQ_LEARN_PG_ADMIN_URL, direct port
  5433 + sslmode=disable — the 5432 haproxy leg trips Bun.SQL), with
  `OPENMAIC_TRUST_PROXY_AUTH` so the shared image needs no compiled-in
  token. `OPENMAIC_FIXED_OWNER_ID=cue-owner` gives browser, gateway, and
  daemon one course owner (chat can tutor from wizard-made courses).
  cue-learn-db runs on 1GB — 256MB OOM-killed postgres during the rollout.
- Non-LLM ledger pricing uses estimate tables in `usage-sync.ts` — revisit
  when providers change.
- In-classroom deep links sync to `?p=` by polling; sub-second navigations
  between polls aren't captured (cosmetic).
