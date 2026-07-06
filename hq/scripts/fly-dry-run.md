# Fly driver — live dry-run checklist

The fly driver (`hq/src/providers/fly-driver.ts`) is unit-tested against a
mocked Fly API only. Run this checklist once against a real Fly account
before pointing HQ at it for customers. Budget: ~30 min, a few cents of
usage (everything is destroyed at the end).

## 0. Prerequisites (human provides)

- [ ] A Fly.io account with **billing set up** (credit card on file — Fly
      won't create machines/volumes without it).
- [ ] An organization for the fleet (or use `personal`); note its slug:
      `flyctl orgs list`.
- [ ] `flyctl` installed and logged in (`flyctl auth login`).
- [ ] An **org-scoped deploy token** (broader than a single-app token — the
      driver creates apps): `flyctl tokens create org <org-slug>`. This is
      `FLY_API_TOKEN`. (App-scoped tokens will NOT work.)
- [ ] An `OPENROUTER_API_KEY` for the instance — without it the instance
      boots and answers `/healthz`, but a chat turn has no LLM to run on
      (the brain routes Claude via OpenRouter; see the LLM-routing memory).

## 1. Build + push the release image

```bash
cd /Users/manavgupta/Cue
FLY_ORG_SLUG=<org> hq/scripts/fly-release.sh          # → registry.fly.io/cue-releases:v<sha>
```

- [ ] Script completes; note the printed image ref.
- [ ] Sanity: `flyctl image show` is not applicable to a never-deployed app —
      instead verify the push succeeded from the script output.

## 2. Boot HQ with the fly driver

```bash
cd hq
HQ_ADMIN_TOKEN=$(openssl rand -hex 16) \
HQ_DRIVER=fly \
FLY_API_TOKEN=<org token> \
FLY_ORG_SLUG=<org> \
HQ_FLY_REGION=iad \
CUE_IMAGE_REF=registry.fly.io/cue-releases:v<sha> \
bun run src/server.ts
```

- [ ] Boot log says `driver: fly` (if it says `mock`, FLY_API_TOKEN or
      FLY_ORG_SLUG didn't reach the process).

## 3. Provision a scratch customer

Open `http://localhost:8790/admin?token=<token>`.

- [ ] Add a scratch customer: `curl -X POST localhost:8790/waitlist -H
      'Content-Type: application/json' -d '{"email":"scratch@cue.test","name":"Scratch"}'`
- [ ] Provision **with the LLM key** (the dashboard button sends `{}`, so
      use curl to pass providerEnv):

```bash
curl -X POST "localhost:8790/admin/customers/<id>/provision" \
  -H "Authorization: Bearer $HQ_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"providerEnv":{"OPENROUTER_API_KEY":"sk-or-..."}}'
```

- [ ] Response is `ok: true`, instance `live`, url `https://cue-scratch-….fly.dev`.
      Provisioning legitimately takes a few minutes (image pull + first boot).
- [ ] `curl https://cue-scratch-….fly.dev/healthz` → 200.
- [ ] Cross-check in Fly: `flyctl apps list` shows the app;
      `flyctl machine list -a <app>` shows 1 started machine;
      `flyctl volumes list -a <app>` shows a 10GB `workspace` volume;
      `flyctl ips list -a <app>` shows a shared v4 + dedicated v6.
- [ ] Check the daemon booted sanely: `flyctl logs -a <app>` — expect the
      gateway on :10000 and the daemon on 127.0.0.1:3001. Qdrant note: no
      QDRANT_URL is set by design; expect either a self-spawned qdrant
      (binary downloaded to /workspace/data) or a "memory features will be
      unavailable" warning — both are acceptable, chat must work either way.
- [ ] Watch for the render.yaml caveat: bubblewrap sandboxing may be
      unavailable on Fly's runtime — daemon should boot in degraded
      (sandboxing off) mode, not crash.

## 4. Magic link + a real chat turn

- [ ] `POST /admin/customers/<id>/magic-link` → returns
      `https://<app>.fly.dev/assistant/?cueToken=…`.
- [ ] Open it in a browser: SPA loads, self-host bootstrap consumes the
      token (URL bar loses the `?cueToken=` param).
- [ ] Send a chat message and get a model reply (proves OPENROUTER_API_KEY
      reached inference).

## 5. Suspend / resume

- [ ] `POST /admin/instances/<iid>/suspend` → machine state `stopped`
      (`flyctl machine list -a <app>`), healthz stops answering.
- [ ] `POST /admin/instances/<iid>/resume` → machine `started`, healthz 200
      again, magic link still works (volume + tokens survived the stop).

## 6. Destroy + verify nothing leaks

- [ ] `POST /admin/instances/<iid>/destroy` → 200.
- [ ] `flyctl apps list` no longer shows the app; `flyctl volumes list -a
      <app>` errors (app gone). **Volumes are the billing leak to check.**
- [ ] Fly dashboard → billing shows no lingering resources.

## 7. Aftercare

- [ ] Record real timings (image pull → healthz) and bump
      `HQ_HEALTH_TIMEOUT_MS` if 5 min was tight.
- [ ] Rotate the org token if it was pasted anywhere it shouldn't live.
- [ ] Delete the scratch customer row from hq.db (or keep it as a canary).

## Dry-run results — 2026-07-06 (PASSED)

Executed against org `personal`, image `registry.fly.io/cue-releases:v9ce28d3dfd`:

- Provision → live: **2m32s** end-to-end (image pull 16s, machine boot 19s, rest is daemon first-boot + health). Default 5-min timeout is fine; first run used 15 min out of caution.
- **Gotcha found + fixed**: the machine must override the image CMD with `init.cmd = ["/app/assistant/docker-cue-app-entrypoint.sh"]` (the combined daemon+gateway entrypoint render.yaml uses via dockerCommand). The image default runs the daemon only — nothing listens on :10000 and health never passes. Teardown-on-failure worked (no leaked resources).
- Auth probe with HQ-minted magic-link token: 200. **Live chat turn: assistant replied** (OpenRouter key seeded from providerEnv, Fly iad egress accepted by OpenRouter).
- Suspend: machine `stopped`, healthz dark. Resume: healthy after **~75s** (full daemon boot — relevant to future wake-on-demand UX). Token + volume survived.
- Destroy: app + volume gone, only `cue-releases` remains. No billing leaks.
- Boot warnings observed (non-fatal, same class as Render): embedding-worker retries, one gateway→daemon IPC timeout during warmup.
