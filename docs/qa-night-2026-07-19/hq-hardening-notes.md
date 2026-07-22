# HQ hardening — ops notes for the morning deploy wave (2026-07-19)

Code-side fixes for the P0 alpha blockers in `alpha-readiness.md`, all in
`hq/**`. **Nothing was deployed and no live Fly env/secrets were touched** —
this note lists exactly what the coordinator must set on **cue-hq** before/at
deploy, and which items are human account actions.

Verification done tonight: `cd hq && bunx tsc --noEmit` clean; full test
suite green (27 files, 273 tests, incl. new suites `signin-invite-gate`,
`provisioning-hardening`, `db-backup`, `fleet-alert`); live smoke boot with a
scratch DB confirmed the boot banner, sweep scheduling, boot snapshot,
`/admin/status`, and the signin invite gate.

---

## 1. What changed (per audit item)

### P0-1 — Email honesty + readiness
- `signin_email_sent` / `welcome_email_sent` are now recorded **only when
  Resend actually accepted the send**. Log-only mode (no `RESEND_API_KEY`)
  records `signin_email_skipped_no_key` / `welcome_email_skipped_no_key`
  instead — prod events can no longer claim deliveries that never left the box.
- Boot now prints a loud `██ EMAIL IS IN LOG-ONLY MODE ██` banner when
  `RESEND_API_KEY` is unset.
- New `GET /admin/status` (Bearer `HQ_ADMIN_TOKEN`) reports email readiness,
  including a **live Resend domain-status probe** (`?probe=0` to skip): it
  shows Resend's own `verified/pending` state for the From-domain — no
  fabricated DNS claims.

### P0-2 — Connectors seeded on provision
- `provisionCustomer` now writes `/workspace/connectors.json` =
  `{"composioApiKey": <HQ_COMPOSIO_API_KEY>, "userId": <customerId>}` onto the
  instance volume via a new `driver.writeWorkspaceFile` (Fly Machines `exec`
  API, base64-safe, mode 600). This is the exact shape
  `assistant/src/oauth/composio-oauth.ts` reads, so "Connect Gmail" works from
  first boot. Best-effort: audit events `connectors_seeded` /
  `connectors_seed_failed` / `connectors_seed_skipped` (never fails a healthy
  provision).
- The Composio key is **platform-level** (one Composio project for the whole
  fleet); per-customer isolation comes from `userId = customer id`, which
  scopes Composio connected accounts per user.

### P0-3 — Per-customer capped LLM keys + budgets
- Capped child-key path verified with mocks (existing + new tests).
- Shared-key fallback now screams **per provision**: console error block +
  `llm_key_shared_fallback` audit event.
- Budget hard-stop default is now ON for newly provisioned instances: after
  guardian init, HQ PATCHes every seeded agent on the instance
  (`/v1/agents/{id}`) with `hardStopEnabled: true` and a weekly `capCents`
  sized to the plan (monthly COGS ÷ 4 — e.g. chief_of_staff → 625¢/agent/wk).
  The flag alone is a no-op in the WS1 engine (needs a cap), hence the sized
  cap. Events: `budget_defaults_applied|failed|skipped`. Opt out with
  `HQ_BUDGET_HARD_STOP_DEFAULT=0`.

### P0-4 — 2 GB instances
- `HQ_FLY_VM_MEMORY_MB` default changed **1024 → 2048** in the Fly driver.
  No env change strictly needed on cue-hq (unset now means 2048 after this
  deploy), but setting it explicitly is harmless and self-documenting.

### P0-5 (HQ half) — hq.db protection
- Boot + every 6 h: WAL checkpoint (`TRUNCATE`) then a `VACUUM INTO`
  timestamped snapshot with rotation (default keep 28) into
  `HQ_DB_BACKUP_DIR` (default `/data/backups` — same Fly volume; survives
  redeploys and rides in Fly volume snapshots, NOT volume loss — offsite is
  the documented follow-up). Events `db_backup_completed|failed`, surfaced on
  `/admin/status`.
- Instance volumes now pin Fly automatic snapshot retention at create
  (`snapshot_retention: 14`, `HQ_FLY_VOLUME_SNAPSHOT_RETENTION_DAYS`).

### P0-6 — Observability
- New machines get a real Fly `checks` block: HTTP `/readyz` on port 10000
  (gateway **and** daemon; `/healthz` lies), 30 s interval, 300 s boot grace.
  NOTE: applies to **newly provisioned machines only** — existing instances
  keep their config until reprovisioned (image `update` round-trips existing
  config verbatim, so it neither adds nor removes checks).
- The fleet sweep is now actually **scheduled**: in-process on HQ boot, first
  run ~2 min after boot then every 6 h; health failures / exhausted customers
  email `HQ_OPS_ALERT_EMAIL` (event `ops_alert_sent|failed`). Manual
  `bun run src/fleet.ts` still works and now also alerts.
- HQ's own `/healthz` exists (unchanged); `/admin/status` is the new
  operator readiness endpoint.

### P0-7 — Invite mechanics
- `POST /signin` no longer silently no-ops: response now carries
  `status: "sent" | "invited_no_account" | "invite_required"` with honest
  copy ("Cue is in private alpha — request an invite at hello@justcue.ai.").
  Deliberate trade-off: leaks whether an email is recognized (alpha-only).
- Allowlist = new `invite_emails` table (migration 8) **plus**
  `HQ_ALPHA_ALLOWLIST` env CSV. Admin routes (same auth as
  `/admin/register-instance`):
  - `POST /admin/invites/emails {"emails":["a@x.io"], "note":"wave 1"}`
  - `GET  /admin/invites/emails`
  - `DELETE /admin/invites/emails {"email":"a@x.io"}`
- **Frontend gap (out of hq/ territory):** `site/signin.html` (+
  `site/commerce.js`) still shows the unconditional "check your email" state;
  it should branch on the new `status` field and render the invite-required /
  invited-no-account copy. Small copy change in `site/` — the hq image
  bundles `site/`, so it can ride the same deploy.

---

## 2. EXACTLY what to set on cue-hq before deploy

Set env on the bare machine via `fly machine update --env` (memory: cue-hq
has no Fly release, so `fly secrets set` fails — env only), or bake into the
deploy.

### Required for alpha (user/account actions marked ⚠)
| Var | Value | Notes |
|---|---|---|
| `RESEND_API_KEY` | `re_…` | ⚠ Resend account: verify domain `justcue.ai` (add the DKIM/SPF records Resend shows, in Cloudflare) **before** relying on it. `/admin/status` shows Resend's live domain status. |
| `OPENROUTER_PROVISIONING_KEY` | provisioning key from OpenRouter | ⚠ OpenRouter account action. Without it every provision uses the shared key and fires `llm_key_shared_fallback`. |
| `HQ_COMPOSIO_API_KEY` | `ak_…` | ⚠ Composio account key (platform-level). Without it Gmail connect stays dead (`connectors_seed_skipped`). |
| `HQ_OPS_ALERT_EMAIL` | e.g. `manav@brinc.io` | Fleet-sweep failure/exhausted alerts land here (needs RESEND_API_KEY to deliver). |
| `HQ_INSTANCE_DOMAIN` | `justcue.app` | Audit P0-7 env: new provisions get branded URLs (Cloudflare creds already present per audit). |

### Recommended / defaults already correct after deploy
| Var | Default | Notes |
|---|---|---|
| `HQ_FLY_VM_MEMORY_MB` | **2048** (new code default) | Set explicitly only if you want a different size. |
| `HQ_FLY_VOLUME_SNAPSHOT_RETENTION_DAYS` | 14 | Fly min 5. |
| `HQ_DB_BACKUP_DIR` | `/data/backups` | Keep on the /data volume. |
| `HQ_DB_BACKUP_INTERVAL_MS` / `HQ_DB_BACKUP_KEEP` | 21600000 / 28 | 6-hourly, ~7 days retained. |
| `HQ_DB_BACKUP_DISABLED` | unset | `1` disables (dev only). |
| `HQ_FLEET_SWEEP_INTERVAL_MS` | 21600000 | 6-hourly sweep. |
| `HQ_FLEET_SWEEP_INITIAL_DELAY_MS` | 120000 | First sweep 2 min after boot. |
| `HQ_FLEET_SWEEP_DISABLED` | unset | `1` disables (dev only). |
| `HQ_BUDGET_HARD_STOP_DEFAULT` | ON (unset) | `0` opts new instances out of enforced budgets. |
| `HQ_AGENT_WEEKLY_CAP_CENTS` | plan-derived | Integer override of the per-agent weekly cap. |
| `HQ_ALPHA_ALLOWLIST` | unset | Optional CSV fallback for the signin allowlist; prefer the admin route/table. |
| `EMAIL_FROM` | `Cue <hello@justcue.ai>` | Must match the Resend-verified domain. |

### Post-deploy checklist
1. `curl -H "Authorization: Bearer $HQ_ADMIN_TOKEN" https://justcue.ai/admin/status`
   — confirm `email.mode: "live"`, `email.domainProbe.status: "verified"`,
   `llm.mode: "per_customer_capped"`, `connectors.composioKeyConfigured: true`,
   `instanceDefaults.memoryMb: 2048`, `backups.lastCompletedAt` non-null.
2. Load the alpha allowlist: `POST /admin/invites/emails` with the wave-1 emails.
3. Existing instances (e.g. `cue-manav-gupta-a1b2a026`): connectors.json and
   the Fly `/readyz` check only apply to NEW provisions. To retrofit an
   existing instance's connectors:
   `fly ssh console -a <app> -C "sh -c 'umask 077; printf %s '\''{\"composioApiKey\":\"<key>\",\"userId\":\"<customerId>\"}'\'' > /workspace/connectors.json'"`.
4. Migration 8 (`invite_emails`) applies automatically on first boot.
5. Frontend copy: update `site/signin.html`/`commerce.js` to branch on the
   new `/signin` `status` field (see §1 P0-7) — not done tonight (outside
   the hq/deploy territory of this pass).

### Explicitly NOT done (per audit: human account actions / other territory)
- Resend DNS records + domain verification (⚠ account action).
- Creating the OpenRouter provisioning key / funding (⚠ account action).
- TestFlight external Beta App Review submission (process).
- Instance-side backup worker enablement + GCS offsite (gateway/assistant
  territory; Fly volume snapshot retention was the hq-side piece).
- External uptime monitor (third-party service signup).
