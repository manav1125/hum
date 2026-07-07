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
| `HQ_CANONICAL_HOST` | Canonical public host, e.g. `justcue.ai`. When set, GET/HEAD requests on any other host (justcue.io, www.justcue.ai, cue-hq.fly.dev) 301 to `https://<canonical><path>`. POSTs (Stripe webhook!), `/healthz`, and instance-domain hosts are exempt. Unset ⇒ no redirects |
| `HQ_INSTANCE_DOMAIN` | Customer-instance domain, e.g. `justcue.app` — each provision gets `https://<fly-app-name>.<domain>` (see Domains). Also exempts those hosts from the canonical redirect |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with DNS-edit on the instance zone (custom instance domains) |
| `CLOUDFLARE_ZONE_ID_INSTANCES` | Cloudflare zone id of `HQ_INSTANCE_DOMAIN`. All three custom-domain vars must be set or the feature is skipped entirely |
| `HQ_HEALTH_TIMEOUT_MS` | Provision health-poll budget (default 5 min) |
| `HQ_STAGING_INSTANCE_ID` | Instance id of the designated staging instance. When set, `POST /admin/fleet/update` refuses until that instance already runs the target image (staged rollout) |
| `RENDER_API_KEY` | Render REST API key |
| `RENDER_OWNER_ID` | Render owner/team id new services are created under |
| `HQ_RENDER_IMAGE` | Container image for new instances (per-provision override: `image` in the POST body) |
| `HQ_RENDER_REGION` / `HQ_RENDER_PLAN` | Defaults `singapore` / `standard` (matches prod) |
| `FLY_API_TOKEN` | Org-scoped Fly token (`flyctl tokens create org <slug>`) |
| `FLY_ORG_SLUG` | Fly org new apps are created in |
| `CUE_IMAGE_REF` | Image for new Fly instances, e.g. `registry.fly.io/cue-releases:v<sha>` (built by `scripts/fly-release.sh`; per-provision override: `image` in the POST body) |
| `HQ_FLY_REGION` | Default Fly region (default `iad`) |
| `HQ_FLY_VM_SIZE` / `HQ_FLY_VM_MEMORY_MB` | Guest preset (default `shared-cpu-1x` / `1024`) |
| `HQ_FLY_VOLUME_SIZE_GB` | /workspace volume size (default `10`, matching render.yaml) |
| `STRIPE_SECRET_KEY` | `sk_…` — checkout session creation |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` — webhook HMAC verification |
| `STRIPE_PRICE_ASSISTANT` | Monthly price id for the `assistant` tier ($49) |
| `STRIPE_PRICE_CHIEF_OF_STAFF` | Monthly price id for the `chief_of_staff` tier ($99) |
| `STRIPE_PRICE_OPERATOR` | Monthly price id for the `operator` tier ($249) |
| `STRIPE_PRICE_TOPUP_1000` / `STRIPE_PRICE_TOPUP_5000` | One-time top-up price ids ($10 / $40) |
| `STRIPE_PRICE_FOUNDING` / `STRIPE_PRICE_FOUNDING_BYO` | Legacy price ids for the founding aliases |
| `OPENROUTER_PROVISIONING_KEY` | OpenRouter provisioning key — mints/limits/disables per-customer child keys at `api/v1/keys` |
| `OPENROUTER_SHARED_KEY` | Fallback runtime key when no provisioning key is set (guardrails caps only — logged loudly) |
| `HQ_PUBLIC_SITE_URL` | Marketing-site base URL; wins over `HQ_PUBLIC_URL` for checkout success/cancel redirects and emailed links. HQ serves the site itself, so point this at HQ's own origin |
| `HQ_SITE_DIR` | Directory of the static marketing/commerce site (default: repo-root `site/`) |
| `HQ_SESSION_SECRET` | HMAC key for the customer `/account` session cookie + enables `/signin`. Unset ⇒ site auth routes answer 503 |
| `HQ_DOWNLOADS_DIR` | Directory HQ serves app downloads from (default `/data/downloads`). `GET /downloads/cue-macos.dmg` streams `cue-macos.dmg` from here; a missing file answers a friendly branded 404 |
| `RESEND_API_KEY` | Resend secret for transactional email. Unset ⇒ log-only mode: every would-be email (incl. its action link) is printed at info level |
| `EMAIL_FROM` | From header for transactional email (default `Cue <hello@justcue.ai>`) |
| `KLAVIYO_PRIVATE_KEY` | Klaviyo private API key (`pk_…`) for lifecycle event sync (see "Klaviyo sync"). Unset ⇒ no-op: every would-be event is logged at info level, nothing is sent |
| `CUE_TAVILY_API_KEY` / `CUE_FIRECRAWL_API_KEY` / `CUE_SERPER_API_KEY` | Platform keys for the bundled web-research/web-scrape skills, passed through verbatim to every instance env by `buildInstanceEnv()`. Unset ⇒ the corresponding tools on instances report a clean "not configured" message (that IS the off state) |

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
`POST /redeem {code,email,name,plan?}`, `POST /webhooks/stripe`,
`GET /welcome/status?session_id=`, `POST /signin {email}`, `GET /auth?token=`.

Customer (signed `cue_hq_session` cookie set by `/auth`; 30-day TTL,
httpOnly, SameSite=Lax, Origin-checked on POSTs):

- `GET /account/summary` — `{plan, renewalDate, credits: {balance,
  grantedThisCycle, usedThisCycle, refreshDate}, usage: {days: last-30-days
  daily credit totals}, instanceUrl}`. Top activities are not derivable
  from the credit ledger yet and are omitted (the site handles absence).
- `POST /account/topup {pack}` — `topup_1000 | topup_5000` → payment-mode
  Stripe Checkout returning to `/account?topup=success` (honest
  `checkoutUrl: null` + reason when Stripe isn't configured).
- `GET /account/portal` — 302 to a Stripe Billing Portal session
  (invoices, payment method, cancel), back to `/account`.

Anything else on GET/HEAD falls through to the **static site** (below).

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
- `POST /admin/instances/:id/update {image}` — roll one live instance to a
  new image (fly: per-machine config round-trip with only the image
  swapped, wait for `started`, poll `/healthz`). On success
  `instances.imageRef` advances; on health failure the 502 carries the
  previous image ref — no automatic rollback in v1, roll back by updating
  to that ref. Render answers 501 (deploys come from the blueprint).
- `POST /admin/fleet/update {image, batchSize?}` — roll every live
  instance of the active driver, oldest first, in sequential batches
  (default 3 concurrent per batch). Skips suspended/deleted instances and
  any already on the target image (re-running a halted roll resumes), and
  halts on the first failed batch (`fleet_update_halted` event + 502).
  With `HQ_STAGING_INSTANCE_ID` set, refuses (409 "roll staging first")
  until the staging instance's `imageRef` equals the target image.

## Domains

The domain layout (all registered; cuedesk.ai is parked and unused):

- **justcue.ai** — canonical marketing site + HQ (this server).
- **justcue.io** — redirect-only to justcue.ai.
- **justcue.app** — customer instances: `https://<fly-app-name>.justcue.app`.

**Site hostnames (one-time manual setup).** HQ runs as the `cue-hq` Fly
app, so the apex/www/redirect hosts all point at it and Fly needs a cert
per hostname:

| Record | Zone | Type | Value | Proxy status |
| --- | --- | --- | --- | --- |
| `justcue.ai` (apex) | justcue.ai | `A` / `AAAA` | `cue-hq`'s public IPv4 / IPv6 (`flyctl ips list -a cue-hq`); use CNAME/ALIAS flattening to `cue-hq.fly.dev` if the DNS host supports it | DNS-only |
| `www.justcue.ai` | justcue.ai | `CNAME` | `cue-hq.fly.dev` | DNS-only |
| `justcue.io` (apex) | justcue.io | `A` / `AAAA` or ALIAS | same as apex above | DNS-only |
| `www.justcue.io` | justcue.io | `CNAME` | `cue-hq.fly.dev` | DNS-only |

Then mint the certs on the `cue-hq` app:

```bash
flyctl certs add justcue.ai      -a cue-hq
flyctl certs add www.justcue.ai  -a cue-hq
flyctl certs add justcue.io      -a cue-hq
flyctl certs add www.justcue.io  -a cue-hq
flyctl certs check justcue.ai    -a cue-hq   # repeat per hostname
```

Set `HQ_CANONICAL_HOST=justcue.ai` and every GET on justcue.io / www /
cue-hq.fly.dev 301s to the canonical host — no separate redirect service.
Keep the Stripe webhook endpoint pointed at whichever URL was registered;
POSTs are never redirected.

**Per-instance domains (automated).** With `HQ_INSTANCE_DOMAIN=justcue.app`
+ `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID_INSTANCES` set, the fly
driver finishes every provision (after `/healthz` passes on `.fly.dev`) by:

1. creating a **DNS-only** CNAME `<app>.justcue.app → <app>.fly.dev` on
   Cloudflare (`proxied: false` is required — Cloudflare's proxy breaks
   Fly's TLS handshake/ACME validation for custom hostnames),
2. requesting an ACME cert for the hostname via the Machines API
   certificates resource (`POST /apps/<app>/certificates/acme`),
3. briefly polling issuance — slow issuance never fails the provision.

The instance row then stores `url = https://<app>.justcue.app` (magic
links, welcome status, and the account page use the branded URL) and
`flyUrl = https://<app>.fly.dev` as the ops/fallback URL; the fleet sweep
probes `url` first and falls back to `flyUrl`. `destroy` deletes the
CNAME again. With any of the three vars unset, provisioning behaves
exactly as before (`.fly.dev` only).

## The website (served by HQ)

HQ is the production origin for the marketing/commerce site: `site/` at
the repo root (override with `HQ_SITE_DIR`). Static serving lives in
`src/site.ts` — GET/HEAD only, API routes always win, clean URLs
(`/pricing` → `pricing.html`, `/` → `index.html`), and the Stripe
checkout-redirect contract is mapped onto the designed pages
(`/checkout/success` → `welcome.html`, `/checkout/cancel` →
`pricing.html`). Set `HQ_PUBLIC_SITE_URL` to HQ's own origin.

The commerce pages call HQ same-origin through `site/commerce.js`. The
full purchase loop is hands-off:

1. `/redeem` POSTs the invite → Stripe Checkout.
2. `checkout.session.completed` (subscription mode) marks the customer
   active, records the checkout session id, and **auto-provisions** the
   instance asynchronously (same path as the admin provision route —
   `src/provisioning.ts`; webhook retries no-op once an instance exists).
3. Stripe redirects to `/checkout/success?session_id=…` (the designed
   `/welcome` page), which polls `GET /welcome/status` every 5s:
   `provisioning` → `ready` (response carries a freshly minted magic
   link) or `delayed` (provision failed or >10 min).
4. When provisioning completes, HQ emails the **welcome** template with
   the magic link.

**Emails** (`src/email.ts`, Resend via plain fetch; templates extracted
from the designed `site/emails.html`): *welcome* fires when
auto-provisioning completes; *sign-in link* fires from `POST /signin`;
*payment failed* fires on `invoice.payment_failed`; *credits low* is
built but not yet wired to the fleet sweep (TODO below). Without
`RESEND_API_KEY` every send logs the recipient, subject, and action link
at info level — the whole flow is testable keyless.

## Klaviyo sync

Every commercially meaningful lifecycle event is mirrored to Klaviyo
(`src/klaviyo.ts`, Events API via plain fetch, revision `2026-04-15`) so
marketing flows can trigger off real product state. Fire-and-forget:
callers never await the send — a Klaviyo outage cannot slow or fail a
checkout, webhook, or sweep — and failures land as `klaviyo_sync_failed`
audit events. Each emission carries a stable `unique_id`, so Stripe
webhook retries and nightly re-sweeps dedupe on Klaviyo's side. Without
`KLAVIYO_PRIVATE_KEY` the whole layer no-ops (logged at info level).

The metric catalog (build flows off these names verbatim):

| Metric | Trigger | Event properties | Profile properties |
| --- | --- | --- | --- |
| `Cue Waitlist Joined` | `POST /waitlist` creates a new customer | `plan` | `plan` |
| `Cue Invited` | Invite minted (`POST /admin/customers/:id/invite`) | `code`, `percentOff` | `plan` |
| `Cue Checkout Started` | Successful `POST /redeem` that returned a Stripe checkout URL | `plan`, `code` | `plan` |
| `Cue Subscribed` | `checkout.session.completed` (subscription mode) webhook | `plan` | `plan` |
| `Cue Instance Ready` | Auto-provision completed after payment | `instanceUrl` | `plan` |
| `Cue Credits Low` | Fleet sweep: balance crosses below 15% of the plan's monthly grant — once per billing cycle (`unique_id` keyed on customer + grant period) | `balance`, `threshold` | `plan`, `credit_balance` |
| `Cue Credits Exhausted` | Fleet sweep: balance ≤ 0, child key frozen | `balance` | `plan`, `credit_balance` |
| `Cue Topped Up` | Top-up applied (Stripe payment-mode webhook or admin topup) | `credits` | `plan`, `credit_balance` |
| `Cue Payment Failed` | `invoice.payment_failed` webhook | `invoiceId` | `plan` |
| `Cue Cancelled` | `customer.subscription.deleted` webhook | `stripeSubId` | `plan` |
| `Cue TestFlight Interest` | `POST /testflight` (first submission per email) | — | — |

Profiles are keyed by email; `first_name` rides along wherever we know
the customer's name. `unique_id` conventions: entity-scoped stable keys
(`waitlist:<customerId>`, `invite:<code>`, `checkout-started:<sessionId>`,
`subscribed:<sessionId>`, `instance-ready:<instanceId>`,
`credits-low:<customerId>:<grant note>`, `topup:<ref>`,
`payment-failed:<invoiceId>`, `cancelled:<subId>`, `testflight:<email>`).

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
- **`GET /auth?token=…`** — consumes the emailed one-time sign-in token,
  sets the session cookie, and 302s **into the customer's instance** via a
  freshly minted magic link (`…/assistant/?cueToken=…`); customers without
  a live instance land on `/account` instead. Bad/expired tokens bounce to
  `/signin?error=link_expired`.
- **`GET /account/open`** (session cookie) — the account page's "Open Cue"
  button. 302 to a freshly minted instance magic link; no live instance ⇒
  302 `/account?error=no_instance` (the page shows a quiet notice).
- **`POST /testflight`** — body `{email}` → `{ok}` (repeat submissions:
  `{ok, existing: true}`). Records a `testflight_interest` event,
  idempotent per email — the account page's "Join the TestFlight" capture.
- **`GET /downloads/cue-macos.dmg`** — the macOS app image, streamed from
  `HQ_DOWNLOADS_DIR` (default `/data/downloads`) with
  `application/x-apple-diskimage` + `Content-Length`. Missing file ⇒
  branded 404 page. The DMG is uploaded to the Fly volume out-of-band:

  ```bash
  flyctl ssh console -a cue-hq -C "mkdir -p /data/downloads"
  flyctl ssh sftp put ./Cue.dmg /data/downloads/cue-macos.dmg -a cue-hq
  ```

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

**Capacity placement retries.** Fly hosts fill up mid-provision: volume
create can be rejected with `capacity hold failed: insufficient CPUs
available`, and machine create can 412 with `insufficient resources to
create new machine with existing volume` — a volume pins its machines to
one physical host, so a volume placed on a host that fills up before
machine-create can never receive its machine. The driver retries the
volume+machine pair up to 4 times (~15s apart); on a machine-side capacity
rejection it deletes the pinned volume and recreates it so the retry rolls
a fresh host. Non-capacity errors still fail fast and tear the app down as
before; if every attempt is rejected the provision fails with "placement
failed after 4 attempts" (carrying Fly's last rejection) and the standard
teardown runs.

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

### Weekly ship (staged rollout)

How product updates reach the fleet — staging gets the new image first,
the fleet follows:

```bash
# 1. Build + push the release image (prints the ref).
FLY_ORG_SLUG=<org> hq/scripts/fly-release.sh
IMG=registry.fly.io/cue-releases:v<git sha>

# 2. Roll the staging instance (HQ_STAGING_INSTANCE_ID) first.
curl -X POST "$HQ/admin/instances/$STAGING_ID/update" \
  -H "Authorization: Bearer $HQ_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"image\":\"$IMG\"}"

# 3. Verify staging by hand (open it, run a turn, check /healthz).

# 4. Roll the fleet — refused with 409 until step 2 landed.
curl -X POST "$HQ/admin/fleet/update" \
  -H "Authorization: Bearer $HQ_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"image\":\"$IMG\",\"batchSize\":3}"
```

Each instance's update fetches the machine's current config and swaps
**only** the image (env/services/mounts/init/guest ride along verbatim),
waits for `started`, then polls the instance's public `/healthz`. A
failure halts the roll and the error message names the previous image
ref; recover by fixing the image and re-running (already-updated
instances are skipped), or roll the failed instance back with
`POST /admin/instances/:id/update {image: <previous ref>}`. The admin
dashboard's instances column shows what each instance currently runs
(`instances.imageRef`).

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
  effect on the next invoice; no mid-cycle credit proration). The
  /account page's "Change plan" chooser is visual-only until a
  plan-change endpoint exists.
- **Credits-low email** — the designed template is built
  (`email.ts creditsLowEmail`) but not yet fired by the fleet sweep when
  a balance crosses 15% of the cycle grant.
- **Account usage "top activities"** — the credit ledger only stores
  sync cursors, not per-activity attribution; `/account/summary` omits
  the field and the site hides the section.
- **Usage sync trusts the instance's self-reported rollup** (estimated
  cost from `llm_usage_events`); reconcile against OpenRouter's per-key
  `usage` field periodically once real traffic exists.
- **SPA managed-mode UI** — instances get `CUE_MANAGED=1`, but the web UI
  hiding of BYO key surfaces is not built yet.
- **Admin dashboard auth via `?token=`** is a bootstrap convenience; put HQ
  behind a VPN/oauth proxy before exposing it.
