# Cue mobile sign-on — design & architecture brief

Status: **proposed** (2026-07-18). Supersedes the bundled-connect-shell attempt
(`apps/web/capacitor-shell/index.html` + `capacitor.config.ts` runtime-connect),
which failed because a JS shell that navigates between origins loses Capacitor's
native bridge — see "Why the shell was wrong" below.

## Decisions (locked with the owner)

1. **One App Store app, connect to your instance.** Not per-owner builds.
2. **Email → magic link that opens the app.** No passwords, no URL pasting.
3. **Mock the screens first**, then build to the mocks.

## The product

One "Cue" app on the App Store. Every owner runs their own instance
(`cue-<name>.justcue.app`, provisioned by HQ). The app learns which instance is
yours at sign-in and remembers it.

## Why the shell was wrong (the constraint that shapes everything)

Capacitor injects its native bridge at exactly **one** origin — its configured
`server` (or `capacitor://localhost` for a bundled web dir). The bundled shell
navigated (`location.replace`) from `capacitor://localhost` to the instance, so
the SPA then ran at the instance origin with **no native bridge** — a plain
browser tab inside the app. That is the source of the reopen hang.

macOS doesn't hit this because Electron attaches its preload per-window
regardless of URL. Capacitor is built around a single fixed origin. So on
mobile the instance must **be** the server origin — chosen at launch, not
navigated to.

## Architecture

### Native launch-time instance selection

- On cold launch, native reads the saved instance from `UserDefaults`
  (iOS) / SharedPreferences (Android).
  - **Present** → Capacitor loads `<instance>/assistant/` as its `server.url`,
    so the bridge is injected at the instance origin and the SPA boots as the
    real app. localStorage at that origin persists the session (same mechanism
    the current prod build already relies on).
  - **Absent** → Capacitor serves the bundled sign-on web dir from
    `capacitor://localhost` (the email-entry screen).
- iOS: subclass `CAPBridgeViewController`, override `instanceDescriptor()` to
  set `.serverURL` from `UserDefaults`. Android: `BridgeActivity` analogue.
  ~20 lines each; the standard white-label Capacitor pattern.

### Sign-on flow (email → magic link)

1. **Enter email** (bundled screen). App `POST`s the email to HQ.
2. HQ looks up the owner's instance for that email and emails a magic link
   pointing at the **single** universal-link domain:
   `https://justcue.ai/m/<one-time-token>` (NOT the instance subdomain).
3. **Check your email** screen: "we sent a link to <email>."
4. User taps the link on the phone → universal link opens the app (associated
   domain `applinks:justcue.ai`, one stable domain, baked at build; HQ serves
   the AASA there). The app resolves the token with HQ → gets
   `{ instanceUrl, cueToken }`.
5. App writes `instanceUrl` to `UserDefaults`, then loads
   `<instanceUrl>/assistant/?cueToken=<cueToken>` as the Capacitor server. The
   SPA seeds its same-origin session from `?cueToken=` (existing behaviour).
6. Subsequent launches: native reads the saved instance and loads it directly;
   the SPA already holds its session.

Why one universal-link domain: associated domains are compiled into the app and
can't wildcard every future `cue-*.justcue.app`. Routing every link through
`justcue.ai` (which carries the instance identity in the token) needs only one
baked domain and one AASA file.

### Fallbacks / edge

- **Manual address** (advanced): "Enter your Cue address" → `cue-you.justcue.app`
  → same native-server-selection path, then normal in-SPA sign-in. Keeps power
  users and testers unblocked without email round-trips.
- **Sign out / switch instance**: clears `UserDefaults` + storage, returns to
  the email-entry screen. (The shell had no escape once navigated — this fixes
  that.)
- **Link opened on desktop / wrong device**: `justcue.ai/m/<token>` renders a
  web page that redirects into the instance in-browser.

## Vellum removal (separate, real bug)

Today the SPA's Connect screen "Sign in" hard-links to `justcue.ai/signin`
(`apps/web/src/lib/self-hosted/cue-connect-screen.tsx:31`), which is still
Vellum-branded — this is what the owner saw. On mobile the app owns email entry,
so the SPA's web sign-in handoff is bypassed entirely. HQ's `/signin` + the new
`/m/<token>` pages must be Cue-branded regardless (they're also the desktop /
web sign-in surface). No "Vellum" anywhere in any sign-on surface.

## Screens to mock (this brief's deliverable)

1. **Sign in** — email entry. Cue mark, "Sign in to Cue", email field,
   "Send sign-in link", small "Enter your Cue address" fallback link.
2. **Check your email** — envelope, "We sent a link to <email>", "Resend"
   (cooldown), "Use a different email".
3. **Connecting** — Cue mark + spinner, "Connecting to your Cue…".
4. **Errors** — email not recognized; link expired; offline.
5. **Manual address** (fallback) — "Enter your Cue address", input, Connect.

Tone: calm, first-run, trustworthy. Dark + light. Safe-area aware (notch / home
indicator). ≥16px inputs (no iOS zoom-on-focus). Single accent
(`--accent #3d6ee8`), red reserved for errors.

## Build order (after mocks approved)

1. HQ: rebrand `/signin`, add `/m/<token>` magic-link router + AASA at
   `justcue.ai/.well-known/apple-app-site-association`; `POST /signin` returns
   the email-sent state and maps email→instance.
2. Web: bundled sign-on screens (replace the placeholder shell) built to mocks;
   they call the native bridge to persist the instance + trigger the load.
3. Native: `CAPBridgeViewController`/`BridgeActivity` server-from-UserDefaults;
   associated-domains entitlement `applinks:justcue.ai`; deep-link handler.
4. Verify on device: cold-launch persistence, magic-link open, sign out.
