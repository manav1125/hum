# VentureVerse ↔ Cue — partner embed spec

**Audience:** the VentureVerse platform team.
**Goal:** let an approved partner host (Cue) run VentureVerse mini apps **inline**
inside its own product, exactly as they run inside the VentureVerse
marketplace — same SSO, same credits, same billing — without the partner ever
seeing a user's VentureVerse password or a mini app's API key.

This is a **small, well-scoped addition**: one new endpoint plus an origin
allowlist. Everything else already exists (the mini-app SDK, the SSO handshake,
`/sso/exchange`, `/sso/resolve`, `/sso/deduct`).

---

## Background — how a mini app authenticates today

From the mini-app SDK ("Getting Started v2", SDK 1.6.0-beta.2):

1. A user clicks an app in the VentureVerse marketplace.
2. VentureVerse mints two short-lived JWTs: an **`sso_code`** (≈60s) and an
   **`iframe_token`**.
3. VentureVerse renders `<iframe src="https://<app>?iframe_token=…&iframe_mode=true">`.
4. The app's SDK detects iframe mode, posts `{ type: "SDK_READY" }` to
   `window.parent`, and starts a 15-second timer.
5. The **parent** replies `{ type: "SSO_HANDSHAKE", sso_code, state, sso_url }`.
6. The SDK calls `POST /api/v1/sso/exchange` with the `sso_code` → `session_token`
   (30-min JWT), then `POST /api/v1/sso/resolve` → the user object.
7. `ssoAuthenticated` fires; the app runs. Credit deducts go
   app-server → `POST /api/v1/sso/deduct` with `X-App-Key`.

**Key observation:** the mini app talks only to its *direct parent* and only
needs the parent to hand it a valid `sso_code`. It does not care whether that
parent is the VentureVerse shell or another approved host. The parent never
needs the user's password or the app's API key — only the ability to obtain an
`sso_code` for *this user* and *this app*.

## Why Cue can't do this today

The `sso_code` is minted server-side by VentureVerse as part of the marketplace
launch flow. There is **no public/partner endpoint to originate one**. An app
API key (`X-App-Key`) authenticates *resolve* and *deduct*, both of which
require an already-existing session — it cannot start a session.

When Cue embeds the VentureVerse *shell* (`/apps?launch=…`) cross-origin, the
mini app ends up two iframes deep, the shell↔app handshake never reaches Cue,
and the app times out with "SSO handshake timed out — this app must be opened
from VentureVerse." Confirmed in testing. The clean fix is for Cue to embed the
**app directly** and play the parent — which needs exactly one thing: a way to
mint the `sso_code`.

---

## The ask — one endpoint

### `POST /api/v1/partner/launch-token`

Mint a launch token pair for a specific user + app, callable by an approved
partner host.

**Auth (two proofs, mirroring the existing model):**

- `X-Partner-Key: <partner_key>` — issued by VentureVerse to the partner
  (Cue). Identifies and authorizes the embedding host. Server-side secret.
- Proof of the **user's** VentureVerse identity. Pick whichever fits your
  auth model; any one is enough:
  - **(preferred) a VentureVerse-issued user token** Cue obtained when the
    user linked their VentureVerse account to Cue (an OAuth-style
    authorization-code grant, or a personal access token the user generates in
    VentureVerse settings), **or**
  - a `user_uuid` that the partner is authorized to act for under a
    per-user consent grant recorded on the VentureVerse side.

**Body:**

```json
{
  "app_id": 15,
  "allowed_origin": "https://manav.justcue.app"
}
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "sso_code": "<60s JWT>",
    "iframe_token": "<short-lived JWT>",
    "sso_url": "https://beta.ventureverse.com",
    "expires_in": 60
  }
}
```

**Semantics:** identical to what the marketplace launch flow already generates
internally — this endpoint just exposes that mint to an approved partner,
scoped to the `(partner, user, app)` triple, and stamped with the partner's
`allowed_origin` so the resulting session can only be used from Cue's origin.

**Errors:** `401` bad/absent partner key or user proof; `403` partner not
allowed to embed `app_id`; `429` rate limit.

### Origin allowlist

Add Cue's origin(s) to the set the SDK's postMessage layer and the
`/sso/exchange` CORS/referer checks accept as a valid parent:

```
https://manav.justcue.app
https://*.justcue.app
app://vellum.ai            # the Cue desktop (Electron) app origin
```

The mini app SDK already captures `parentOrigin`; this just needs Cue's origins
to be trusted the way the marketplace origin is.

---

## What Cue does with it (the host side)

Cue implements the **parent** role the SDK expects — this is already built on
Cue's side, gated behind a flag, ready to turn on:

1. Cue's daemon calls `POST /api/v1/partner/launch-token` (server-side, holding
   the partner key + the user's link) → `{ sso_code, iframe_token, sso_url }`.
2. Cue renders `<iframe src="https://<app-deployment>/?iframe_token=…&iframe_mode=true">`
   — the **app's own URL**, one level deep, inside Cue's chrome.
3. Cue listens for `{ type: "SDK_READY" }` from that iframe (origin-pinned to
   the app's origin) and replies
   `{ type: "SSO_HANDSHAKE", sso_code, state, sso_url }`.
4. The app's SDK exchanges/resolves as normal and runs — natively inside Cue.
5. Credits, billing, analytics all flow through your existing
   `/sso/exchange` · `/sso/resolve` · `/sso/deduct` unchanged. The user's
   credit balance and your top-bar counter stay correct.

No mini app changes. No new SDK version. Cue never sees a password or an app's
`X-App-Key`. Every credit event is still metered by VentureVerse.

---

## Security notes

- **Partner key** is server-only in Cue (same handling as an app's
  `VENTUREVERSE_API_KEY`), never shipped to the browser.
- **`allowed_origin`** binds the minted `sso_code` to Cue's origin, so a leaked
  code can't be replayed from another site.
- **User consent** should be an explicit, revocable link ("Connect Cue to your
  VentureVerse account") recorded on VentureVerse — so a user can see and
  revoke Cue's ability to launch apps on their behalf.
- The 60-second `sso_code` TTL and the 30-minute `session_token` TTL are
  unchanged; the partner path inherits them.

---

## Smallest possible version (if you want to ship incrementally)

If a full OAuth link is more than you want right now, the minimal unlock is:

1. Let a signed-in VentureVerse user generate a **personal access token** in
   their settings.
2. `POST /api/v1/partner/launch-token` accepts `X-Partner-Key` +
   `Authorization: Bearer <user PAT>` and returns the token pair.

That alone lets the account owner (you) run every VentureVerse app natively
inside Cue today, and generalizes to real users later.
