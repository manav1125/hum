# Cue Alpha-Readiness Audit — GO/NO-GO (2026-07-19)

Scope: 50–100 alpha users invited next week. Per-owner Fly instances provisioned by HQ
(cue-hq, justcue.ai), magic-link signin, one iOS TestFlight app. Audit = code reading
(hq/, gateway/, assistant/, apps/) + safe live probes against prod (fly status/secrets
list, read-only prod hq.db query, DNS, HTTPS health). No changes made to prod.

---

## Executive call: **NO-GO today → CONDITIONAL GO in ~3–4 working days**

The architecture is in far better shape than the priors suggested — the FlyDriver 412
retry **exists**, the daemon **is supervised** on Fly, cross-tenant auth is
**cryptographically sound**, and the budget hard-stop engine **is wired in**. What
blocks the alpha is not the code: it is **prod configuration and two provisioning
gaps**. As deployed right now, a stranger who signs up would: receive **no email**
(Resend key unset + domain never DNS-verified), and if hand-provisioned would land on
a **1 GB machine that the entrypoint itself documents OOM-ing**, on a `.fly.dev` URL,
**unable to connect Gmail** (Composio creds never seeded), burning a **shared uncapped
OpenRouter key**, with **no backups** and **nobody alerted** when their instance dies.

Every P0 below is either an env/DNS change or a small, well-scoped code change in HQ
provisioning. Total estimated effort: **~3–4 focused days**, then a full E2E dry run
(fresh email → checkout → email → instance → Gmail → first task) before invites.

---

## P0 — MUST land before invites (est. 3–4 days total)

| # | Blocker | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| P0-1 | **Email is fully dead on prod HQ.** `RESEND_API_KEY` is not set on cue-hq (verified: `fly secrets list` + machine env — absent), so `sendEmail` runs in log-only mode. Worse, log-only returns `ok:true` (`hq/src/email.ts:176`) and the server records `signin_email_sent` (`hq/src/server.ts:982`) — prod events show 11 "sent" signin emails (latest ~16h ago) that never left the box. AND the domain was never verified: `resend._domainkey.justcue.ai` and all TXT on justcue.ai are empty (no DKIM/SPF at all). | live probe + `hq/src/email.ts:160-198` | Add DKIM/SPF records in Cloudflare, verify domain in Resend, set `RESEND_API_KEY` secret on cue-hq. Also change log-only mode to return `sent:false` distinctly so events stop lying. | 0.5 day (mostly DNS propagation wait) |
| P0-2 | **Gmail connect is impossible on a provisioned instance.** HQ provisioning never seeds `connectors.json` (Composio key + userId): `buildInstanceEnv` (`hq/src/secrets.ts:97-132`) passes only Tavily/Firecrawl/Serper (`secrets.ts:71-75`); nothing in hq/ or deploy/ writes it. Fresh instance → connect endpoint throws "Connectors are not configured" (`assistant/src/runtime/routes/connector-apps-routes.ts:376-381`), Connect button disabled (`apps/web/src/mobile-v3/you/connections-page.tsx:217-222`). Both first-value CTAs on the empty Home ("Connect Gmail") dead-end here. | agent trace | Seed `{composioApiKey, userId:<guardian/instance id>}` into `/workspace/connectors.json` during `provisionCustomer` (env passthrough + entrypoint write, or a provision-time API call). | 0.5–1 day |
| P0-3 | **Runaway LLM spend: shared uncapped OpenRouter key.** cue-hq has only `OPENROUTER_SHARED_KEY` (verified live); `OPENROUTER_PROVISIONING_KEY` unset → `provisionLlmKey` hands every instance the same key with **no provider-side limit** (`hq/src/openrouter.ts:207-216`, warns "spend is capped ONLY by the instance's own guardrails"). And those guardrails default OFF: budget hard-stop engine is wired (`assistant/src/work-items/work-item-runner.ts:424`) but migration 302 defaults `hard_stop_enabled=0` / budgets NULL, and it only gates work-item runs, not chat turns. 100 strangers × one uncapped key = unbounded bill. | live probe + `hq/src/openrouter.ts:193-216`, `hq/src/provisioning.ts:99-103` | Set `OPENROUTER_PROVISIONING_KEY` on cue-hq — the per-customer child-key-with-hard-limit mechanism is already built and sized to plan credits. Optionally seed default `task_budget_cents` for alpha. | 0.5 day |
| P0-4 | **Instances provision at 1 GB RAM — documented OOM territory.** Default `HQ_FLY_VM_MEMORY_MB ?? 1024` (`hq/src/providers/fly-driver.ts:335-338`); prod cue-hq env has no override (verified). The entrypoint itself documents OOM-kills on 1 GB machines during first-boot (`assistant/docker-cue-app-entrypoint.sh:28-31`). manav's own instance runs 4 GB; the one test provision got 2 GB only because it was provisioned from a local dev HQ. | live probe + fly-driver.ts:337 | `fly secrets set HQ_FLY_VM_MEMORY_MB=2048 -a cue-hq`. (~$5/user/mo extra — see Cost.) | minutes |
| P0-5 | **No backups anywhere.** (a) Instance-level: backup worker exists and is scheduled but `enabled` defaults false (`gateway/src/backup/backup-worker.ts:89`) and its offsite target is a macOS iCloud path meaningless on Linux (`:66-83`); local snapshots land on the same volume as the live DB. (b) HQ-level: `hq.db` (customers, **every instance's signing key in plaintext** — `hq/src/db.ts:402`) lives on one SQLite file on one volume on one 512 MB machine, zero backup/replication. Lose that volume → cannot mint magic links for any existing customer, unrecoverable. Only safety net today = Fly's default crash-consistent volume snapshots (unconfigured, unverified). | agent traces | (a) Enable `backup.enabled=true` per instance with a Linux offsite — the GCS export path already exists (`assistant/src/runtime/routes/migration-routes.ts:487-581`); set `snapshot_retention` on volume create (`fly-driver.ts:428-432`). Note the export path is safe (streamed + `wal_checkpoint(FULL)` subprocess — the old resetDb deadlock is restore-only). (b) Litestream or nightly `hq.db` snapshot to object storage; snapshot before deploys. | 1–1.5 days |
| P0-6 | **Zero observability — nobody finds out an instance is broken.** No Fly `checks` block in the machine config (`fly-driver.ts:472-497`; live machines show empty CHECKS); gateway `/healthz` returns ok unconditionally, even when the daemon is unreachable (`gateway/src/index.ts:1810-1843`) — a gateway-only zombie reports healthy; the real dependency check `/readyz` (`index.ts:1882-1899`) is called by nothing; the nightly fleet sweep (`hq/src/fleet.ts` — health probe + usage debit + credit freeze) is **never scheduled** (hq Dockerfile CMD is just the server; no cron anywhere). No Sentry/alerting in hq or gateway. | agent + live probe | Minimum viable alerting (see §7): add Fly HTTP check on `/readyz` to `createMachine`; schedule `bun run src/fleet.ts` nightly (GitHub Actions cron or a Fly scheduled machine) and make it email/Slack on `failed[]` or `*_email_failed` events; external uptime ping on justcue.ai + each instance. | 1 day |
| P0-7 | **Alpha invite mechanics: signin silently no-ops for unknown emails.** `/signin` only sends if the email is already a customer (`hq/src/server.ts:966-987`) but always returns `{ok:true}` — a stranger sees "check your email" and nothing arrives. Provisioning only fires from a Stripe checkout (100%-off invite codes = the intended free-alpha path, `hq/src/server.ts:606-711`) or the admin route. | agent trace | Process decision, not code: either pre-provision all alpha emails via admin, or send each invitee an invite-code /redeem link and let checkout auto-provision. Do a dry run of whichever path. Also set `HQ_INSTANCE_DOMAIN=justcue.app` on cue-hq (currently unset — verified — so new provisions get off-brand `.fly.dev` URLs despite Cloudflare creds being present). | 0.5 day |

Also required this week for iOS timing (process, not code): **submit the TestFlight build
for external Beta App Review now** — CI uploads but does nothing with external groups
(`.github/workflows/release-ios.yaml:239-282`); first external review takes ~1–2 business
days. AASA + universal links are READY (correct appID `XU8BLQACGU.com.ventureverse.cue`
served live from justcue.ai, verified by probe; entitlement `apps/ios/App/App/App.entitlements:7-9`).

---

## P1 — first week of alpha

1. **/signin rate limiting** — none today (`hq/src/server.ts:957-988`); unbounded Resend sends + inbox-bombing. Per-email + per-IP limiter. (0.5 day)
2. **Provisioning races** — no concurrency cap on parallel provisions (`server.ts:243-249`) and no unique index on `instances.customerId` (TOCTOU double-provision, `provisioning.ts:85-131`). Queue with limit ~5 + partial unique index. (0.5 day)
3. **/auth during provisioning** — magic link silently redirects to bare `/account` if the instance isn't live yet (`server.ts:1027,1036`); add a "your Cue is being set up" state. (0.5 day)
4. **Conversation runaway guard off** — prune job exists (`assistant/src/memory/job-handlers/cleanup.ts:170`) but `conversationRetentionDays` defaults 0=disabled (`memory-lifecycle.ts:124`); the 500 MB assistant.db incident will recur across 100 instances. Set a default. (hours)
5. **Vault key drop on restart** — still real for BYO keys (`assistant/src/providers/inference/resolve-auth.ts:52-78`); env fallback masks it for managed keys. Idempotent credential re-seed. (1 day)
6. **Region fallback** — placement retries (4×, jittered — `fly-driver.ts:405-462`) stay in `iad`; add `iad→ewr→bos` fallback for capacity droughts. (0.5 day)
7. **Fleet sweep as billing enforcement** — once scheduled (P0-6), verify `syncUsage`/credit-freeze works against a real instance; it is the only thing that debits credits. (0.5 day)
8. **Hung-turn UX** — interrupted turns are marked + surfaced on boot (`assistant/src/daemon/turn-recovery.ts`, wired `daemon/lifecycle.ts:611`) but never auto-resumed, and channel-inbound messages queued behind a dead turn are lost (in-memory queue, persisted at drain — `turn-recovery.ts:30-36`). Persist at enqueue. (1 day)

## P2 — can wait

- Per-instance claim in actor JWTs (isolation currently rests solely on per-instance HMAC keys — sound, but add `iid`/aud-host for defense in depth; `hq/src/secrets.ts:168`, `gateway/src/auth/token-service.ts:203`).
- Drop HQ admin `?token=` query-param auth + constant-time compare (`hq/src/server.ts:167-175`).
- Gateway binds 0.0.0.0 → reachable on org 6PN by sibling instances (auth holds; bind public interface only — `gateway/src/index.ts:1654-1657`).
- Assert `DISABLE_HTTP_AUTH` never injectable via `providerEnv` at provision time.
- WAL hard-caps: `wal_autocheckpoint` + `journal_size_limit` (`assistant/src/memory/db-connection.ts:79-84`).
- 30-day bearer cueToken in email inboxes — consider shorter TTL + refresh, revocation story.
- Android hardcodes `manav.justcue.app` (`apps/android/.../capacitor.config.json:6`) — before any Android ship.
- Delete `apps/web/cdp-*-tmp.mjs` dev scripts; HQ leak-reconciliation sweep for orphaned Fly apps.

---

## Area-by-area verdicts

### 1. Provisioning E2E — **READY** (priors were stale)
Full trace: Stripe `checkout.session.completed` → unawaited `autoProvisionOnPayment`
(`hq/src/stripe.ts:673`, `hq/src/provisioning.ts:302`) → secrets + OpenRouter child key →
`FlyDriver.provision` (`hq/src/providers/fly-driver.ts:327`: app → IPs → volume+machine →
wait started → poll `/healthz` → Cloudflare CNAME) → welcome email with
`<instance>/assistant/?cueToken=`. **The "no 412 retry" gap is already fixed**:
`placeVolumeAndMachine` (`fly-driver.ts:405-462`) retries 4× with jittered backoff,
classifies 412/429/5xx as capacity (`isCapacityError:129-140`), and deletes the pinned
volume to re-roll hosts. Failure path tears down cleanly (`:363-366,775-818`). Verified
live: the one real provision (`cue-manav-gupta-a1b2a026`) is healthy, custom domain
resolves, `/healthz` 200. Sizes: shared-cpu-1x, 1 GB (P0-4), 10 GB volume, `iad`.
Prod DB state: 7 customers, 4 instances (2 e2e-test on .fly.dev, 1 real provision,
1 registered = manav-prod); 1 historical `auto_provision_failed`, 1 `welcome_email_failed`.

### 2. Daemon resilience — **READY on supervision; BLOCKER on memory sizing**
The "unsupervised zombie" prior is outdated: Fly machines boot
`docker-cue-app-entrypoint.sh` (override at `fly-driver.ts:480`), which respawns a dead
daemon with backoff (5 restarts/600 s — `:143-201,352-368`), refuses respawn on
port/DB-lock contention, and exits (→ Fly `restart: always`) on gateway death. Remaining:
1 GB sizing (P0-4), no continuous health check (P0-6), LLM request-log writes now capped
at 128 KB (`llm-request-log-store.ts:140` — the 357 KB sync-write bug is fixed, writes
still sync but bounded), WAL/conversation-prune gaps (P1-4, P2).

### 3. Email — **BLOCKER** (P0-1). Signin token flow itself is solid: 15-min single-use
hashed tokens (`hq/src/sessions.ts:23`, `db.ts:679-696`), no account enumeration,
re-request any time.

### 4. Auth/security — **READY, no cross-tenant blocker**
Per-instance random HMAC keys (`hq/src/secrets.ts:56-63`) mean a token minted for user A
fails signature verification on user B's gateway (`gateway/src/auth/token-service.ts:184-193`).
Bootstrap secrets are per-instance, one-time, locked after consume
(`channel-verification-session-proxy.ts:183-232`). Runtime binds 127.0.0.1; public surface
is gateway-only with `RUNTIME_PROXY_REQUIRE_AUTH=true` (`secrets.ts:120`,
`runtime-proxy.ts:65-95`). `local:` principal gotcha does NOT hit alpha users — magic links
carry real actor principals (`subject.ts:44-52`). Hardening items in P2.

### 5. iOS distribution — **READY code / RISK timing**
AASA correct and live; universal link → `POST justcue.ai/auth?native=1` → `{instanceUrl,
cueToken}` → in-app connect (`apps/ios/App/App/public/index.html:685-704`). No hardcoded
instance. Gap = process: external TestFlight group + Beta App Review not automated — submit now.

### 6. Cost — ~$12–15 infra + $3–50 LLM per user/month; guard = P0-3
At 2 GB: machine ~$10.7/mo + 10 GB volume $1.50 + IPs ≈ **$12–13/user/mo infra** →
~$1.2–1.3k/mo at 100 users. LLM: deepseek ~$0.088/turn → light user (5 turns/day) ~$13/mo,
heavy (20/day) ~$53/mo; heartbeat is negligible (default OFF for new workspaces, 60-min
cadence, hard cap 2 LLM calls/day — `assistant/src/config/schemas/heartbeat.ts:11,17,67`;
the 15-min prior was wrong). Budget hard-stop engine: **wired, not inert**
(`work-item-runner.ts:424`, run-boundary, failed+reason — commit bb06105b0d5) but off by
default and work-items-only. The real cap is the OpenRouter child-key limit — P0-3.

### 7. Observability — **BLOCKER** (P0-6); minimum viable proposal
Today: nothing will tell you an instance is down; `/healthz` lies. Ship this week:
(a) Fly `[checks]` on `/readyz` in `createMachine` — platform restarts real zombies;
(b) schedule the already-written fleet sweep nightly + alert on failures/exhausted;
(c) external uptime monitor on justcue.ai/healthz + a sample of instance /readyz;
(d) alert on `signin_email_failed` / `welcome_email_failed` / `auto_provision_failed`
events. Morning-after debugging: `fly logs -a cue-<name>` works per instance today;
document the runbook (logs, ssh, read-only db query pattern used in this audit).

### 8. Backups — **BLOCKER** (P0-5). Data-loss story today = unconfigured Fly default
snapshots, both for instances and for HQ's signing-key database.

### 9. Known bugs re-verified
- Vault anthropic key drop: **still exists** (P1-5), env-fallback masks managed keys.
- Task-add intermittent: handler robust; malformed tool args rejected with retry prompt
  (`tool-approval-handler.ts:254-273`) but no server-side repair/auto-retry; severity low
  if alpha stays on a Claude-class model (`llm-resolver.ts:96-106` defaults Claude via
  OpenRouter for self-host).
- SKILL.md YAML boot error: **fixed/defended** — parse failures are caught and the skill
  skipped (`assistant/src/skills/frontmatter.ts:34-53`, `config/skills.ts:242-249`);
  all 1,140 SKILL.md files in-repo currently parse clean.
- Hung-turn: partial — interrupted turns surfaced, work-items requeued
  (`lifecycle.ts:611,630`); no auto-resume; channel-message loss residual (P1-8).

### 10. Onboarding UX — **two P0s (email, Gmail), otherwise clean**
Connect screen is Cue-branded email-first (JWT paste demoted to advanced fallback);
`?cueToken=` consumed + stripped from URL at boot (`cue-self-host.ts:277-314`); no
user-visible Vellum/manav strings in the web app. No onboarding wizard — stranger lands
on empty Home, whose two CTAs are "tell Cue what's on your plate" (works) and "Connect
Gmail" (dead until P0-2). Nothing auto-runs for first value; acceptable for alpha if
Gmail connect works and the invite email sets expectations.

---

## Recommended sequence (5 working days to invites)
Day 1: P0-1 (DNS+Resend), P0-3, P0-4, P0-7 env (`HQ_INSTANCE_DOMAIN`), submit TestFlight external review.
Day 2: P0-2 (connectors.json seeding), P0-6a (Fly checks).
Day 3: P0-5 (backups: instance GCS offsite + HQ litestream), P0-6b (fleet sweep + alerts).
Day 4: E2E dry run with a fresh external email on a clean browser + phone; fix fallout.
Day 5: Invite wave 1 (10 users), watch fleet sweep + logs for 24 h, then scale to 50–100.
