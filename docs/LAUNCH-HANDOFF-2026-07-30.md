# Cue launch handoff — 2026-07-30

**Goal:** alpha launch Saturday (50-100 users, each on their own `<name>.justcue.app` instance).
**How to use this:** paste this file's path into a fresh session and say "work the blockers in order."

---

## 0. READ THIS FIRST — how to verify in this codebase

Three failures happened in the previous session, all from the same root cause:
**verifying an assumption instead of the running system.** Do not repeat them.

1. **A fix present in a file is not a fix on the live path.** I added `clearIp()` to
   `rejectIfActorTokenRevoked`, grepped the deployed file, saw it, and declared the
   lockout fixed. It was on `auth: "edge"` control-plane routes only — the app's
   traffic goes through a *different* wrapper. **Trace the actual request path.**
2. **Tests that share the bug's assumption prove nothing.** My expiry tests built
   localStorage fixtures with `Date.now()` (ms) while the writer stores **seconds**,
   so fixtures agreed with the buggy reader and passed while prod looped forever.
   **Seed through the real writer, and re-introduce the bug to confirm the test fails.**
3. **Filtered shell output hides hard failures.** `timeout 300 flyctl …` silently did
   nothing (`timeout` is not installed) and my `grep` filters made it look like slow
   propagation. **Check exit codes; don't pipe a command's only error into grep.**

Two environment hazards:
- **`grep -r` silently returns nothing for 7 `.ts` files** under `assistant/src` that are
  byte-flagged as binary — incl. `work-items/work-item-store.ts`, `tasks/task-store.ts`,
  `cue-live/observation-capture.ts`, `spreadsheet-studio/tools/formula-eval.ts`.
  **Always use `grep -a`.** An audit that greps without `-a` will report "clean" on
  code it never read.
- **`timeout` is not available.** Use background runs (`run_in_background`) instead.
- `flyctl` lives at `~/homebrew/bin` (not `/opt/homebrew/bin`).

---

## 1. Current production state (all verified healthy)

| Thing | State |
|---|---|
| Instance app | `cue-manav-prod`, machine `48eed1ef1411e8`, image `01KYR5DZA5…` |
| Control plane | `cue-hq`, machine `d8d0795b113448`, image `01KYNP01GQ…` |
| Autonomy | **ON** — `CUE_DISABLE_WORKITEM_AUTORUN=false`, `CUE_DISABLE_MISSION_ORCHESTRATOR=false` |
| Disk | `/workspace` 12% used, 17G free |
| DB | `assistant.db` ~647MB; `autonomy_ledger` table exists (migration 316 applied) |
| Mac app | local build, bundle id `com.vellum.vellum-assistant-electron-local`, registers `vellum-assistant-local://` only. **Rollback copy: `/tmp/Cue-previous.app`** |

### Deploy recipe (instance app)
```
cd /Users/manavgupta/Cue
flyctl deploy . --config fly-release.toml --build-only --push --depot   # note the image ref
flyctl machine update 48eed1ef1411e8 --image <ref> -a cue-manav-prod --yes
```
Expect ~981MB. A wildly different size (e.g. 1.1GB) means the push didn't complete —
rebuild rather than retrying the machine update. Web changes need
`rm -rf deploy/web-dist && cp -R apps/web/dist deploy/web-dist` first.
HQ/site changes: same but `--config hq/fly.toml` and machine `d8d0795b113448`.

`apps/web/src/generated/` is **gitignored**, regenerated from `assistant/openapi.yaml`.
After a daemon route change: `cd assistant && bun run generate:openapi`, then
`cd apps/web && bun run openapi-ts`. If two changes both touch `openapi.yaml`,
regenerate rather than copying one over the other.

---

## 2. BLOCKERS, in the order to do them

### B1 — New instances' brain is hardcoded to `anthropic/*` (DO THIS FIRST)
**Impact:** the first message every newly provisioned user sends may fail. Config-only, minutes.
HQ provisions `OPENROUTER_API_KEY` and nothing else, so the daemon forces
`anthropic/claude-sonnet-4.5` / `haiku-4.5` — the family the OpenRouter key was
previously ToS-blocked from (see `cue-openrouter-tos-chat-outage` memory). Prod's
working Gemini brain is a *machine-level* env override that **no provisioned instance inherits**.
- `assistant/src/config/llm-resolver.ts:106,240-247`
- `assistant/src/config/seed-inference-profiles.ts:273-281`
- `hq/src/secrets.ts:71-75` — `TOOL_API_PASSTHROUGH_ENV_VARS` lacks `CUE_OPENROUTER_MODEL`
**Fix:** set `CUE_OPENROUTER_MODEL` + `CUE_OPENROUTER_FLASH_MODEL` on HQ, add both to
the passthrough list. **Verify by provisioning a fresh instance and sending one real message.**

### B2 — Rate-limit lockout is NOT fixed (my fix is on the wrong path)
**Impact:** users lock themselves out of their own instance; reloading re-arms it.
10 auth failures in 60s blocks the IP (`gateway/src/auth-rate-limiter.ts:4-5`).
`clearIp()` exists only in `rejectIfActorTokenRevoked` (`gateway/src/http/middleware/auth.ts:370`),
reached by `auth: "edge"` routes. **All app + SSE traffic** goes through the runtime-proxy
catch-all (`gateway/src/index.ts:1653-1658`, `auth: "track-failures"`) whose wrapper
(`auth.ts:557-585`) only counts up.
Multipliers:
- **`GATEWAY_TRUST_PROXY` is set nowhere** (absent from `hq/src/secrets.ts:97-132`) → behind Fly
  every client is one IP → **one device locks out all devices.**
- SSE retries 401 forever as if it were a network drop:
  `apps/web/src/lib/streaming/stream-transport.ts:207-222,369-385`; then `sse-service.ts:155-168`.
- `apps/web/src/utils/daemon-errors.ts:35` returns `true` for 401 in the retry predicate used at
  `domains/chat/transcript/use-history-pagination.ts:140` → 1 race becomes 4 gateway 401s.
- `/v1/guardian/refresh` records failures (`gateway/src/index.ts:983,993`) and never clears on success (`:1000`).
**Fix:** `clearIp(getClientIp())` in the `UPSTREAM_RESPONSE_MARKER_HEADER` success branch of
`wrapWithAuthFailureTracking` (covers HTTP + IPC); treat 401/403 as terminal in the SSE loop
(pattern exists at `domains/settings/components/panels/use-doctor-sse.ts:125-133`);
add `GATEWAY_TRUST_PROXY: "true"` to `buildInstanceEnv`.
**Verify:** force ~12 rapid 401s from a real client, then sign in and confirm the app loads.

### B3 — "Log Out" does not log out (shared-laptop security issue)
Click Log Out → Welcome screen → **reload signs you straight back in, no credentials.**
`clearSelfHostMode()` (`apps/web/src/lib/self-hosted/cue-self-host.ts:371-382`) has **zero call sites**.
`clearUserScopedStorage` (`lib/auth/session-cleanup.ts:25-40`) sweeps `vellum:` prefixes only;
the durable credential is `cue:selfHost:actorToken` and the flag `cue:selfHost` (`cue-self-host.ts:21,31`).
Next load, `rehydrateGatewayTokenFromActor()` (`:401-417`) re-stamps it.
**Fix:** call `clearSelfHostMode()` in the gateway-auth branch of `logout()` (`stores/auth-store.ts`),
then `hardNavigate` so boot renders Connect. Also: on a `X-Cue-Gw-Retry` request that 401s
*again* in self-host mode, clear and reload to Connect (otherwise a revoked/rotated token
bricks the install with no self-serve recovery — you'd support 50-100 people by hand).
Log Out is currently hidden for self-host anyway (`domains/settings/settings-layout.tsx:43`) — unhide it.

### B4 — Fresh desktop install dead-ends
A new user opening the app before clicking their email link sees "Meet Cue / **Log In** /
Continue without account". *Log In* runs WorkOS OAuth they have no account in;
*Continue without account* offers a hosting chooser with **Cue Cloud disabled ("Requires Account")**.
Cause: in the packaged app the origin is `app://vellum.ai`, `VITE_CUE_SELF_HOST` is absent
(`apps/macos/package.json:21`), and `selfHostUrl` is null → both branches of
`shouldShowCueConnectAsync()` false (`apps/web/src/lib/self-hosted/cue-self-host.ts:79-100,248-277`).
**Fix:** return true when `isElectron()` && the `selfHost` bridge exists && no stored gateway
token && the lockfile has no local assistants. **Do NOT** set `VITE_CUE_SELF_HOST=1` on the
macOS bundle — that kills the local-daemon path.

### B5 — HQ hero "Approve" never approves (landing surface every user sees)
`pages/hq/hq-modules.tsx:71-79` (button `:152-172`) sends **no request body**;
`handleConfirm` requires `requestId` (`assistant/src/runtime/routes/approval-routes.ts:44-46`)
so it 400s every time, and there's no error branch — silent.
`move.itemId` is `int:${requestId}` (`assistant/src/runtime/next-move.ts:137`) → strip `int:`;
map `approve→allow`, `decline→deny`. Correct implementations to copy: `hq-board.tsx:261-268`,
`mobile-v3/brief/brief-page.tsx:299-308`. **Same bug in the mobile twin:** `mobile-v3/today/mv3-today.tsx:131-139`.
Related: hero "Open ›" is inert for review items with no run conversation (`hq-modules.tsx:92-104`).

### B6 — macOS onboarding window is 440px → trips the mobile gate
`useIsMobile()` is a pure `(max-width: 767px)` query (`hooks/use-is-mobile.ts:8`) with no
platform guard; Electron forces 440×660 for onboarding (`apps/macos/src/main/main-window.ts:26`).
So desktop first-run renders the *phone* flow (`pre-chat-flow.tsx:266`) and takes the mobile
completion branch (`:191-200`) which **omits `markExpectingFirstMessage()`** — the user lands
on an empty HQ deck with **no assistant introduction at all**.
**Fix:** a `useMobileLayout()` = `isMobile && !isElectron()` and use it at `pre-chat-flow.tsx:191,266`
and `screens/google-connect-screen.tsx:402`. Same root cause: desktop chat pop-outs render the
phone UI (`apps/macos/src/main/popout-window.ts:37-38`, 720 < 767; and `chat-layout.tsx:658`
tests `isMobile` before `isPopout`) and Cmd+ twice turns the app into a phone (`menu.ts:225-227`).

### B7 — My handoff banner fires on iOS and mobile web
`shouldOfferDesktopHandoff()` excludes only Electron
(`apps/web/src/lib/self-hosted/open-in-desktop-app.ts:60-63`), but iOS loads
`<instance>/assistant/?cueToken=…` in the WebView (`apps/ios/App/App/CueNativePlugin.swift:42-56`),
which sets `seededFromMagicLink`. So the native app shows "Continue in the Cue app?" — under
the Dynamic Island, since the banner is `fixed top-0` mounted outside `RootLayout` (no safe-area
inset), firing a `vellum://` no-op.
**Fix (one line):** add `&& !isNativePlatform()` (`apps/web/src/runtime/native-auth.ts:78`).
Also drop the 1.2s second-scheme attempt on touch devices, and make it flow-layout, not fixed.

### B8 — Sign-in emails claim success when nothing was sent
- Client: `site/signin.html:110-117` reads `res.body.status`, but `apiCall` resolves for **every**
  HTTP status (`site/commerce.js:39-56`), so a 503 still shows "Check your inbox."
- Server: `hq/src/server.ts:1110-1124` returns `{ok:true,status:"sent"}` even when `sendEmail`
  returned `ok:false` (`hq/src/email.ts:221-232`) — a Resend outage reads as success to everyone.
- A consumed/expired link redirects to `/signin?error=link_expired` (`hq/src/server.ts:1182-1188`)
  but **no page reads `?error=`** — the user sees a pristine form with no explanation. Corporate
  link scanners consume one-time tokens, so this *will* happen on launch day.

---

## 3. SHOULD-FIX (after the blockers)

- **Mobile has no way to type to Cue from primary nav.** Tab bar is Today/Projects/Voice/You
  (`mobile-v3/tab-bar-v3.tsx:109-168`); Today has no composer; chat is behind an unlabeled `⋯`
  that renders on only 4 paths (`root-layout.tsx:132-143`).
- **Mobile Today's main CTA is a redirect loop.** `mobile-v3/empty-orbit.tsx:119` → `/assistant`
  → `conversation-redirect.tsx:34` → `/hq` → back to Today. Same at `connectors-page.tsx:1010`.
  Send to `routes.conversations` instead.
- **Review has no nav entry** on either platform though the badge counts it; the badge sits on HQ
  (`assistant-side-menu.tsx:565`) and `/assistant/review-queue` is contextual-only. This is where
  the core loop drops the thread.
- **Inline `<ui_show>` surfaces render live buttons wired to a no-op** and hang forever
  (`domains/chat/transcript/transcript-message-body.tsx:163`, `onAction={() => {}}`). Reachable
  because prod runs Gemini, which writes the tags as text. Stopgap: render as text, not a card.
- **macOS nav guard caches the allowed origin** (`apps/macos/src/main/main-window.ts:174-184`)
  so logout/review-terms in a connect session ejects the user into Chrome. Resolve inside the handler.
- **`agents-org-page.tsx:532` prints a hardcoded "1 OPEN ROLE"** — the only fabricated data in the app.
- **`integration-detail-modal.tsx:240-244`** footer "Confirm" is `onClose` — typed OAuth credentials
  silently discarded.
- **`organizer-remote-page.tsx:363-378`** "Undo all" has no handler but promises a real revert.
- **Three desktop surfaces are in no desktop nav:** Automations, Explore, Guardrails.
- **Aurora overflow re-introduced** in 3 inline copies, one on mobile onboarding step 1 with an
  autofocus input (`mv3-onboarding-shell.tsx:55-68`, `voice-mode-surface.tsx:1086-1098`,
  `brief/brief-page.tsx:636-650`) — use `AuroraBackdrop` or `overflow: clip`.
- **iOS allows all orientations** (`apps/ios/App/App/Info.plist:54-60`) → landscape iPhone is
  852pt → flips to desktop layout mid-session and `chats-index-page.tsx:76-78` navigates away.
  Cheapest alpha fix: portrait-only for iPhone.
- **4 dead "Enable microphone in Settings" buttons** use the iOS-only `app-settings:` scheme;
  `runtime/system-permissions.ts:45-51` already has the Electron API.
- **Mobile conversations can't be archived/renamed** — no affordance
  (`mobile-v3/chats/mv3-chats-index.tsx:435-466`); `SwipeArchiveRow` + `ConversationActionsMenu`
  both exist unused.
- **`/welcome` animates fake progress forever** on `state:"unknown"` (`site/welcome.html:98-131`).
- **Stripe top-up + waitlist forms have no in-flight guard** (`site/account.html:196-208`, `site/index.html:1627-1637`).

**Unverified, 2-minute manual check, high payoff:** `window.open("", "_blank", …)` at
`domains/settings/hooks/use-oauth-connect.ts:317` may be denied as `about:blank` by
`apps/macos/src/main/index.ts:591-593`, making **integrations unconnectable from the desktop app**.
Click "Connect Google" once in a packed build.

---

## 4. What is genuinely good — don't touch, and demo these

- **Magic-link web sign-in:** email → click → typing. Zero screens. The token layer behind it
  (durable actor token surviving 401s + key rotation) is well-built.
- **`spawned-work-slot.tsx`** — the best-designed file in the codebase; refuses to offer a
  "see the result" affordance for work that produced none. Use it as the honesty template.
- **HQ zero state** (`pages/hq/hq-page.tsx:673-960`) and the dismissible "SETTING UP · N OF 6" meter.
- **Impact page refuses to render** "gave you back 0 hours" over empty charts (`impact-page.tsx:214-217`).
- **Mobile Today's empty orbit** — best empty state in the app (fix its CTA first).
- **No fake data anywhere** except B-list item above. Every percentage null-guarded.
- **Guardrails now hold:** every path by which Cue can reach a third party requires a human —
  direct tools, Composio proxy (`tool_slug` in input), script-mode schedules, apify actors,
  browser/CU submit controls, coordinate clicks, ⌘+Enter, and AppleScript `tell application "Mail" … send`.
  Verified in the deployed daemon. See `cue-rogue-send-guardrail` memory.

---

## 5. Audit sources
Five audits, ~1,100 verified tool calls, full reports at:
`/private/tmp/claude-501/-Users-manavgupta-Cue/452abe70-b25e-4adf-8eae-c5394e4a110d/tasks/`
(`a2774f06f01a906aa`, `a601058bb693db5c7`, `acfeb029eb085f9fe`, `a00c8d961677cfc24`, `a0082b6fbddb8bbfc`).
The unit/format sweep came back **clean** — no siblings of the seconds/ms bug.

**Owner action still outstanding:** walk the first-10-minutes path on a clean account on web,
desktop and mobile. Five audits found 8 blockers; your own hesitation on that walk will find
what none of them can.
