# Key rotation runbook

Several secrets were shared in plaintext chat / pasted during setup sessions and
should be rotated. This is the exact, ordered procedure. **You** generate the new
values at each provider (I can't log into your provider accounts); once you have a
new value, updating the Render env var can be done via the Render API or dashboard.

Service: `cue-app` (`srv-d8pb70s8aovs73edureg`, `cue-app-3yne.onrender.com`).
Render env vars apply **on next deploy** — rotate in a batch, then trigger one deploy.

> ⚠️ Never paste the new values into chat, a commit, or this file. Set them
> directly in the Render dashboard (Environment tab) or via the API from your own
> terminal.

## 1. Provider API keys (low risk — independent, rotate anytime)

Each: generate a new key at the provider, revoke the old one, update the Render env var.

| Secret (Render env var) | Where to regenerate | Revoke old |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | console.deepgram.com → API Keys | delete old key |
| `REPLICATE_API_TOKEN` | replicate.com/account/api-tokens | delete old token |
| `APIFY_API_TOKEN` | console.apify.com → Settings → Integrations | regenerate |
| `OPENROUTER_API_KEY` | openrouter.ai/keys | delete old key |

These back STT + image/video + scraping + the LLM brain. Rotating them only needs
the env var updated + a redeploy; nothing else references them.

## 2. Render API key (rotate + replace where used)

The `rnd_…` key was used this session for deploy automation.
- Regenerate: Render dashboard → Account Settings → API Keys → revoke the old, create new.
- It is **not** stored in the repo or as a service env var — it only lives wherever
  you/automation use it. Just revoking the old one closes the exposure.

## 3. Self-host auth secrets (HIGHER RISK — rotating invalidates live sessions)

These two sign/bootstrap the self-host owner auth (see
`memory/cue-selfhost-local-owner-auth.md`). Rotating them is **breaking**:

| Secret | Effect of rotation |
| --- | --- |
| `ACTOR_TOKEN_SIGNING_KEY` | invalidates **all** existing actor JWTs → every signed-in client (web, macOS, iOS) must re-auth |
| `GUARDIAN_BOOTSTRAP_SECRET` | invalidates the bootstrap path → re-bootstrap the owner binding |

Safe procedure (do during a quiet window):
1. Generate a new high-entropy value each (`openssl rand -hex 32`).
2. Set both as new Render env vars; deploy once.
3. After deploy, **re-authenticate** the macOS app + web (you'll be bounced to the
   connect/login screen — expected). Re-bootstrap if prompted.
4. Confirm a chat turn + an approval round-trip works (the local-owner auth path).

Only rotate these if you believe they actually leaked. If they were only ever in
Render env (never chat/commits), the exposure risk is low and you can defer.

## 4. After rotating

- Trigger one Render deploy so the new env vars take effect.
- Smoke-test: send a chat message (LLM key), generate an image (Replicate), run a
  meeting transcription (Deepgram) — confirm each still works with the new keys.
- The macOS app picks up backend changes automatically (it loads the cloud SPA); no
  rebuild needed unless you rotated the signing key and need users to re-auth.
