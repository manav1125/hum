# VentureVerse Apps — embedded app store

Cue embeds VentureVerse's app store (24 founder-focused AI apps, same parent
org — the `com.ventureverse.cue` iOS bundle id) as a navigable surface. Users
sign into VentureVerse inside the embedded frame; no Cue credentials cross the
boundary.

## What ships in Cue (Phase 1 — this repo)

Everything is gated by the `ventureverse-apps` assistant feature flag
(`defaultEnabled: false`). Flag off = zero surface, zero side effects.

- **Daemon catalog route** — `GET /v1/ventureverse-apps`
  (`assistant/src/runtime/routes/ventureverse-apps-routes.ts`). Fetches
  VentureVerse's public catalog API (`www.ventureverse.com/api/v1/apps`, no
  auth), caches 24h in the workspace, curated 24-app static fallback,
  404s while the flag is off.
- **Web surface** — Tier-2 "Apps" sidebar row →
  `/assistant/apps` gallery → `/assistant/apps/:slug` iframe of the
  VentureVerse shell with the app launched
  (`apps/web/src/domains/ventureverse/`).
- **Shell allowances** — Electron CSP `frame-src …ventureverse.com`
  (`apps/macos/src/main/csp.ts`); Capacitor `allowNavigation`
  `*.ventureverse.com` (`apps/web/capacitor.config.ts`).

QA'd 2026-08-10 against a local flip-on stack: the catalog route returned all
24 apps (`source: remote`, cache written), the sidebar row + gallery rendered,
and the embed page loaded the live VentureVerse sign-in inside the iframe.

## Security verification (2026-08-10)

The earlier open question was whether VentureVerse's per-launch `iframe_token`
(a 60-second JWT carrying `user_id`, `email`, `app_id`, `allowed_origin`) is
signed **client-side** (secret in the bundle → forgeable) or server-side.

**Resolved: server-side, safe.** The deployed client bundle mints the token via
`POST /api/iframe/token`, which requires authentication (401 unauthenticated) —
there is no HS256/HMAC/`jsonwebtoken`/`jose` signing anywhere in the client
JS. The secret is never exposed and `user_id` can't be forged. No change owed
on this front.

## Owed on the VentureVerse side (that repo, NOT this one)

`~/Projects/VentureHub` on this machine is a *different* Next.js app, not the
deployed ventureverse.com — the real source wasn't found locally, so these are
handoff items, not changes made here:

1. **`frame-ancestors` hardening (recommended).** Today Cue can embed
   ventureverse.com only because the site sends *no* `X-Frame-Options` /
   `frame-ancestors` — embeddability rests on the absence of a header, which a
   future infra change could silently break. Add an explicit allowlist via
   `vercel.json` headers (or Next.js `headers()`):
   `Content-Security-Policy: frame-ancestors 'self' https://*.justcue.ai https://*.justcue.io https://*.justcue.app app://vellum.ai;`
   Then confirm the `app://vellum.ai` ancestor works in the Electron shell.
2. **Terraform platform flag.** Provision `ventureverse-apps`
   (`defaultEnabled: false`) in `vellum-assistant-platform` so hosted instances
   can flip it centrally (tracked in
   `meta/feature-flags/PENDING_PLATFORM_PRS.md`). That repo isn't on this
   machine.

## Phase 3 head start — VentureVerse already ships a parent↔iframe SDK

The deployed bundle contains a full `postMessage` SDK between the VentureVerse
shell (parent) and each app (child). Cue can adopt the **same protocol** to
become a second parent shell rather than inventing a bridge. Observed message
types (child → parent request, parent → child `_RESPONSE`):

- `SDK_READY` — child handshake; parent then flushes a queued `SSO_HANDSHAKE`
  (`pendingSsoPayloads` keyed by origin) — i.e. **SSO is already handed to the
  app over postMessage**, which is exactly the auth path Cue-as-parent needs.
- `REQUEST_CREDIT_BALANCE` / `CHECK_CREDIT_BALANCE` → `CREDIT_BALANCE_RESPONSE`
- `DEDUCT_CREDITS` → `CREDIT_DEDUCTION_RESPONSE`
- user profile request → `USER_PROFILE_RESPONSE`
- `TRACK_ACTIVITY` → `ACTIVITY_TRACKING_RESPONSE`
- `NAVIGATE_BACK` / navigation → `NAVIGATION_RESPONSE`
- `ERROR`

Inbound messages are origin-gated (`isValidAppOrigin`, a `coreOrigins` set +
per-app validated origins). **Implication for phase 3:** the data bridge is
mostly a matter of Cue implementing this parent side (minting `iframe_token`
via `/api/iframe/token` and answering `SDK_READY`/`SSO_HANDSHAKE`), plus a
Cue-side listener pinned to `https://www.ventureverse.com` — NOT a bridge built
from scratch. The Developer Portal is stale; do not build on it.
