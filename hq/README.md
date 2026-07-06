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

With no provider/Stripe/OpenRouter env set, HQ boots with the **mock
driver**, Stripe in "not configured" mode, and the managed-LLM layer in
shared-key/none fallback — every route works; provisioning creates fake
instances at `*.mock.local`.

## Plans & credits (the managed-LLM model)

Cue is sold fully managed — customers never bring an LLM key. The money
model (single source of truth: `src/plans.ts`):

- **1 credit = $0.01 of retail LLM usage value.** COGS = retail / 4
  (300% margin on model spend), so $1 of provider-reported cost consumes
  **400 credits**, and N credits of grant translate to an OpenRouter
  child-key limit of `creditsToCogsUsd(N)`.
- **Tiers:** `assistant` ($49/mo, 4,000 credits/mo), `chief_of_staff`
  ($99/mo, 10,000), `operator` ($249/mo, 30,000). Legacy
  `founding`/`founding_byo` rows are aliases resolving to
  `chief_of_staff`. Feature flags per tier live on the plan spec
  (channels, createStudio, people, voice, videoStudio, fanoutKits,
  agentsOrg, prioritySupport) and are served verbatim by `GET /plans`.
- **Top-ups:** 1,000 credits/$10 and a 5,000-credit pack/$40 (one-off
  payment-mode checkouts).

**Money flows:**

1. **Subscribe** — `POST /redeem` (or admin checkout) → Stripe Checkout
   (subscription mode, plan in metadata) → `checkout.session.completed`
   flips the customer active and records the plan.
2. **Grant** — every `invoice.paid` grants the plan's monthly credits,
   idempotent per `(stripeSubId, periodStart)` (Stripe retries no-op), and
   re-points the OpenRouter child-key limit at
   `spend-so-far + creditsToCogsUsd(balance)`.
3. **Meter** — the nightly fleet sweep calls each live instance's
   Guardrails usage rollup (`GET <instanceUrl>/v1/assistants/self/guardrails`
   with an HQ-minted actor token), converts reported cost to credits at 4x,
   and appends `usage_sync` ledger entries. A per-instance cumulative
   cursor (`instances.usageSyncedCents`) makes re-syncs idempotent.
4. **Top-up** — payment-mode checkout with `topup` metadata →
   `checkout.session.completed` applies credits (idempotent per session id)
   and raises the child-key limit.
5. **Freeze** — when a customer's balance hits ≤ 0, the sweep records
   `credits_exhausted` and sets the child-key limit to exactly what's been
   spent: in-flight turns finish, nothing new burns money. Customers with
   no ledger history are never frozen.
6. **Churn** — `customer.subscription.deleted` suspends instances and
   disables the child key.

At provision time HQ mints the child key (limit = the plan's monthly COGS
budget), passes it as `OPENROUTER_API_KEY` in the instance env, and stores
**only the key hash** (`instances.openrouterKeyHash`). Instances also get
`CUE_MANAGED=1` so the SPA can later hide BYO surfaces. Without
`OPENROUTER_PROVISIONING_KEY`, provisioning falls back to
`OPENROUTER_SHARED_KEY` (loudly logged: guardrails caps are then the only
spend control), or to no key at all (BYO via `providerEnv` still works).

The credit ledger (`credit_ledger`) is append-only with a running
`balanceAfter`; kinds are `grant | topup | usage_sync | adjustment`.
Everything HQ creates on Stripe carries `metadata[app]=cue` and products
set statement descriptor `CUE`; `POST /admin/catalog/ensure` provisions
the products/prices idempotently (stable `lookup_key`s) and prints the
price-id → env-var mapping to paste into the environment.

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
| `STRIPE_PRICE_ASSISTANT` | Monthly price id for the `assistant` tier ($49) |
| `STRIPE_PRICE_CHIEF_OF_STAFF` | Monthly price id for the `chief_of_staff` tier ($99) |
| `STRIPE_PRICE_OPERATOR` | Monthly price id for the `operator` tier ($249) |
| `STRIPE_PRICE_TOPUP_1000` / `STRIPE_PRICE_TOPUP_5000` | One-time top-up price ids ($10 / $40) |
| `STRIPE_PRICE_FOUNDING` / `STRIPE_PRICE_FOUNDING_BYO` | Legacy price ids for the founding aliases |
| `OPENROUTER_PROVISIONING_KEY` | OpenRouter provisioning key — mints/limits/disables per-customer child keys at `api/v1/keys` |
| `OPENROUTER_SHARED_KEY` | Fallback runtime key when no provisioning key is set (guardrails caps only — logged loudly) |
| `HQ_PUBLIC_SITE_URL` | Marketing-site base URL; wins over `HQ_PUBLIC_URL` for checkout success/cancel redirects |

`OPENROUTER_API_KEY` is minted by HQ at provision time (a limit-capped
child key — see the plans & credits section). Other per-instance provider
secrets (`REPLICATE_API_TOKEN`, …) are passed via the POST body's
`providerEnv` object, which can also override the OpenRouter key
explicitly — HQ generates the instance-internal secrets itself
(`GUARDIAN_BOOTSTRAP_SECRET`,
`ACTOR_TOKEN_SIGNING_KEY`, `GATEWAY_JWT`, `CES_SERVICE_TOKEN`,
`ASSISTANT_API_KEY`) and stores them in the instance row's `secretsJson`
(never returned over the API).

## Routes

Public: `GET /healthz`, `GET /plans`, `POST /waitlist {email,name,plan?}`,
`POST /redeem {code,email,name,plan?}`, `POST /webhooks/stripe`.

Admin (Bearer `HQ_ADMIN_TOKEN`, or `?token=` for the browser dashboard):

- `GET /admin` — server-rendered dark dashboard (waitlist, customers +
  instances with plan + credit balance columns, top-up/adjust buttons,
  invites, audit trail; buttons for every action below).
- `POST /admin/catalog/ensure` — idempotently creates the Stripe products
  and prices for the 3 tiers + 2 top-up packs; returns the priceId → env
  var mapping.
- `POST /admin/customers/:id/invite` — mints a `CUE-XXXXXXXX` code, flips
  waitlist → invited.
- `POST /admin/customers/:id/checkout` — Stripe Checkout session URL.
- `POST /admin/customers/:id/provision` — generate secrets → mint the
  OpenRouter child key (limit = the plan's monthly COGS budget) →
  `driver.provision` (env includes `OPENROUTER_API_KEY` + `CUE_MANAGED=1`)
  → poll `/healthz` → one-time `POST /v1/guardian/init` (learns the
  `guardianPrincipalId`) → instance `live`.
- `POST /admin/customers/:id/topup` — `{credits}` or `{topupId}` (idempotent
  per optional `{ref}`), or `{kind:"adjustment", delta, note}` for signed
  manual corrections.
- `GET /admin/customers/:id/credits` — `{balance, ledger}`.
- `POST /admin/customers/:id/magic-link` — mints a 30-day actor JWT with the
  instance's signing key and returns
  `<instanceUrl>/assistant/?cueToken=<jwt>`.
- `POST /admin/instances/:id/suspend|resume|destroy`.

## Website integration contract

Everything the marketing site needs from HQ (hand this section to whoever
wires the site):

- **`GET /plans`** — the pricing catalog as JSON:
  `{ plans: [{id, name, priceUsd, monthlyCredits, features, …}],
  topups: [{id, name, credits, priceUsd, …}], creditModel }`. Render the
  pricing page from this — never hardcode prices in the site.
- **`POST /waitlist`** — body `{email, name, plan?}` → `201 {ok,
  customerId}` (or `200 {…, existing: true}` for a repeat email). `plan`
  is one of `assistant | chief_of_staff | operator` (optional).
- **`POST /redeem`** — body `{code, email, name, plan?}`. Validates the
  invite (`404 invite_unknown`, `410 invite_expired|invite_exhausted`),
  creates/updates the customer, and returns
  `{ok, customerId, plan, checkoutUrl}` — send the user to `checkoutUrl`
  (Stripe Checkout, invite `percentOff` pre-applied as a Stripe promotion
  code). When Stripe isn't configured yet, `checkoutUrl` is `null` and
  `reason` says why.
- **Checkout redirects** — Stripe sends the user back to
  `<HQ_PUBLIC_SITE_URL>/checkout/success?session_id={CHECKOUT_SESSION_ID}`
  or `<HQ_PUBLIC_SITE_URL>/checkout/cancel`. The site must serve those two
  pages (`HQ_PUBLIC_URL` is the fallback base when the site URL is unset).
- **Stripe webhook** — point the Stripe endpoint at
  `POST <hq>/webhooks/stripe` with `STRIPE_WEBHOOK_SECRET` set. Events HQ
  consumes: `checkout.session.completed`, `invoice.paid`,
  `customer.subscription.updated`, `customer.subscription.deleted`.

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
- **Fleet sweep is health-ping + usage metering** — wire the real smoke
  suite (`assistant/qa/prod-smoke.ts` with a per-instance actor token)
  later.
- **Stripe proration** on plan changes is not handled (upgrades take
  effect on the next invoice; no mid-cycle credit proration).
- **Public redemption page** — `POST /redeem` is live (invite `percentOff`
  becomes a Stripe promotion code), but the site page that calls it is the
  marketing site's job (see the website integration contract above).
- **Usage sync trusts the instance's self-reported rollup** (estimated
  cost from `llm_usage_events`); reconcile against OpenRouter's per-key
  `usage` field periodically once real traffic exists.
- **SPA managed-mode UI** — instances get `CUE_MANAGED=1`, but the web UI
  hiding of BYO key surfaces is not built yet.
- **Admin dashboard auth via `?token=`** is a bootstrap convenience; put HQ
  behind a VPN/oauth proxy before exposing it.
