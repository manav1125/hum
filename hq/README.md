# Cue HQ

The commercial control plane for productizing Cue: waitlist → invite →
checkout → provision a single-tenant Cue instance → hand the customer a
magic link → keep the fleet healthy. Self-contained workspace — nothing
here imports from `assistant/`, `apps/`, or `deploy/`.

## Run locally

```bash
cd hq
bun install          # dev-only deps (@types/bun, typescript)
HQ_ADMIN_TOKEN=$(openssl rand -hex 16) bun run src/server.ts
# → http://localhost:8790/admin?token=<that token>
```

- `bun run test` (or `bash scripts/test.sh`) — each test file in its own Bun
  process, mirroring `assistant/scripts/test.sh`.
- `bun run typecheck`
- `bun run fleet:sweep` — one fleet health pass (cron this nightly).

With no provider/Stripe env set, HQ boots with the **mock driver** and Stripe
in "not configured" mode — every route works; provisioning creates fake
instances at `*.mock.local`.

## Env contract

| Var | Purpose |
| --- | --- |
| `HQ_ADMIN_TOKEN` | Bearer token guarding all `/admin` routes (required for admin) |
| `HQ_PORT` | Listen port (default `8790`) |
| `HQ_DB_PATH` | SQLite file (default `./hq.db`) |
| `HQ_PUBLIC_URL` | Base URL for Stripe checkout success/cancel redirects |
| `HQ_DRIVER` | `render` or `fly` to use that driver (default: mock) |
| `HQ_HEALTH_TIMEOUT_MS` | Provision health-poll budget (default 5 min) |
| `RENDER_API_KEY` | Render REST API key |
| `RENDER_OWNER_ID` | Render owner/team id new services are created under |
| `HQ_RENDER_IMAGE` | Container image for new instances (per-provision override: `image` in the POST body) |
| `HQ_RENDER_REGION` / `HQ_RENDER_PLAN` | Defaults `singapore` / `standard` (matches prod) |
| `FLY_API_TOKEN` | Org-scoped Fly token (`flyctl tokens create org <slug>`) |
| `FLY_ORG_SLUG` | Fly org new apps are created in |
| `CUE_IMAGE_REF` | Image for new Fly instances, e.g. `registry.fly.io/cue-releases:v<sha>` (built by `scripts/fly-release.sh`; per-provision override: `image` in the POST body) |
| `FLY_REGION` | Default Fly region (default `iad`) |
| `FLY_VM_SIZE` / `FLY_VM_MEMORY_MB` | Guest preset (default `shared-cpu-1x` / `1024`) |
| `FLY_VOLUME_SIZE_GB` | /workspace volume size (default `10`, matching render.yaml) |
| `STRIPE_SECRET_KEY` | `sk_…` — checkout session creation |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` — webhook HMAC verification |
| `STRIPE_PRICE_FOUNDING` / `STRIPE_PRICE_FOUNDING_BYO` | Price ids per plan |

Per-instance provider secrets (`OPENROUTER_API_KEY`, `REPLICATE_API_TOKEN`, …)
are passed at provision time via the POST body's `providerEnv` object — HQ
generates the instance-internal secrets itself (`GUARDIAN_BOOTSTRAP_SECRET`,
`ACTOR_TOKEN_SIGNING_KEY`, `GATEWAY_JWT`, `CES_SERVICE_TOKEN`,
`ASSISTANT_API_KEY`) and stores them in the instance row's `secretsJson`
(never returned over the API).

## Routes

Public: `GET /healthz`, `POST /waitlist {email,name,plan?}`,
`POST /webhooks/stripe`.

Admin (Bearer `HQ_ADMIN_TOKEN`, or `?token=` for the browser dashboard):

- `GET /admin` — server-rendered dark dashboard (waitlist, customers +
  instances, invites, audit trail; buttons for every action below).
- `POST /admin/customers/:id/invite` — mints a `CUE-XXXXXXXX` code, flips
  waitlist → invited.
- `POST /admin/customers/:id/checkout` — Stripe Checkout session URL.
- `POST /admin/customers/:id/provision` — generate secrets → `driver.provision`
  → poll `/healthz` → one-time `POST /v1/guardian/init` (learns the
  `guardianPrincipalId`) → instance `live`.
- `POST /admin/customers/:id/magic-link` — mints a 30-day actor JWT with the
  instance's signing key and returns
  `<instanceUrl>/assistant/?cueToken=<jwt>`.
- `POST /admin/instances/:id/suspend|resume|destroy`.

## Fly release flow (build once, deploy many)

The fly driver runs one prebuilt image in every customer app; it never
builds. Cut a release with:

```bash
FLY_ORG_SLUG=<org> hq/scripts/fly-release.sh   # from the repo root
```

The script builds `assistant/Dockerfile` (repo-root context, same as
render.yaml) on Fly's remote builder against a dedicated never-deployed
registry app (`cue-releases` by default) and pushes
`registry.fly.io/cue-releases:v<git sha>`. Images in one app's registry
are pullable by every app in the same org. Point HQ at the ref via
`CUE_IMAGE_REF`; per-customer provisions are one machine + one 10GB
`/workspace` volume behind a shared IPv4 + dedicated IPv6, with Fly's edge
terminating TLS in front of the gateway on port 10000.

**Qdrant on Fly (v1):** the driver deliberately provisions no Qdrant and
sets no `QDRANT_URL`. The daemon treats Qdrant as a non-blocking subsystem
(`assistant/src/daemon/lifecycle.ts`): without `QDRANT_URL`,
`QdrantManager` self-spawns a local qdrant binary — downloaded on first
boot into `/workspace/data`, so it lands on the persistent volume — and if
that ever fails the daemon retries 3× then continues with memory features
disabled. Chat never blocks on it. If per-instance vector search later
needs isolation from the app machine, add a second small machine running
`qdrant/qdrant` in the same app and set
`QDRANT_URL=http://<machine-id>.vm.<app>.internal:6333`.

Before first real use, walk `scripts/fly-dry-run.md` against a scratch
customer (needs a Fly account + org token; nothing here has touched the
live API yet).

## How auth compatibility works

Tokens are minted byte-compatible with the daemon/gateway JWT layer
(`assistant/src/runtime/auth/token-service.ts`,
`gateway/src/auth/guardian-bootstrap.ts`): HS256, `iss: vellum-auth`,
`aud: vellum-gateway`, `sub: actor:Cue:<guardianPrincipalId>`,
`scope_profile: actor_client_v1`, `policy_epoch: 1`. The gateway's
revocation lookup is fail-open for unknown token hashes, so HQ-minted
tokens verify; the guardian principal itself is created by the one-time
`guardian/init` call during provisioning (HQ knows the bootstrap secret it
generated).

**Magic-link finding:** the SPA's URL bootstrap is the `?cueToken=` query
param consumed by `bootstrapCueSelfHost()` in
`apps/web/src/lib/self-hosted/cue-self-host.ts` (it seeds
`cue:selfHost=1` + `cue:selfHost:actorToken` in localStorage and strips the
credential from history). There is **no** `#selfHostToken=` fragment path —
the query param is the supported mechanism, and HQ's magic links use it.

## What's stubbed / TODO

- **Render and Fly drivers are untested against the live APIs** (unit-tested
  via mock fetch shape only). Render: creates an image-backed web service
  mirroring render.yaml's `cue-app`; the blueprint itself can't be
  instantiated via API — validate against a scratch Render workspace first.
  Fly: walk `scripts/fly-dry-run.md` before first real use.
- **No per-instance Qdrant on Render**: render.yaml provisions a private
  `cue-qdrant` pserv; the Render driver currently only creates the web
  service. Pass a shared `QDRANT_URL` via `providerEnv`, or extend the
  driver with a second create. (On Fly this is intentional — see the Fly
  release-flow section: the daemon self-hosts qdrant on the volume.)
- **Fleet sweep is health-ping only** — wire the real smoke suite
  (`assistant/qa/prod-smoke.ts` with a per-instance actor token) later.
- **Stripe**: no proration/discount application yet (invite `percentOff` is
  recorded but not converted into a Stripe coupon/promotion code).
- **Waitlist/invite public redemption page** — invites are minted and
  tracked (`redeemInvite` is implemented + tested) but there is no public
  signup-with-code page yet; checkout is admin-initiated.
- **Admin dashboard auth via `?token=`** is a bootstrap convenience; put HQ
  behind a VPN/oauth proxy before exposing it.
