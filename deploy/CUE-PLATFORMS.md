# Building Cue for each platform

Cue ships from one React SPA (`apps/web`) wrapped per platform. This is the
non-obvious build matrix — what flag/env each target needs.

## Web (self-hosted, served by the gateway)

The gateway serves the SPA same-origin under `/assistant/*` from `WEB_DIST_DIR`
(`/app/web-dist` in the container, committed to `deploy/web-dist`).

```bash
cd apps/web
VITE_CUE_SELF_HOST=1 bun run build      # base=/assistant/, local mode, self-host Connect screen ON
rm -rf ../../deploy/web-dist
cp -R dist ../../deploy/web-dist
# commit deploy/web-dist, push, redeploy cue-app on Render
```

`VITE_CUE_SELF_HOST=1` is what makes a fresh browser (no token) land on the Cue
**Connect** screen instead of the Vellum-Platform login. Without it the build is
a normal local-mode SPA. The Connect screen seeds the gateway token a user
pastes (minted out-of-band via `POST /v1/guardian/init`); it never weakens auth.

Reset/disconnect a device: `localStorage` keys `cue:selfHost`, `vellum:gw:token`
(see `apps/web/src/lib/self-hosted/cue-self-host.ts` → `clearSelfHostMode()`),
or load with `?cueConnect=1` to force the Connect screen on any build.

## macOS (Electron, local mode)

Bundles the SPA in **local mode** (no `VITE_CUE_SELF_HOST` — the Connect screen
must stay off; the desktop app spawns a local daemon via the `vellum` CLI).

```bash
cd apps/macos
bun run build:web                       # rebuild apps/web -> resources/web-dist (NO self-host flag)
bun run pack --environment production   # full signed build; CSC_IDENTITY_AUTODISCOVERY=false for unsigned local
```

Verify a built app without signing/screenshots: launch
`dist/mac-arm64/Cue.app/Contents/MacOS/Cue --remote-debugging-port=9222`, then
`curl http://127.0.0.1:9222/json` and eval over CDP (title should be "Cue",
`localStorage["cue:selfHost"]` must be null).

## Mobile (Capacitor — iOS + Android)

The shell loads the live SPA from `server.url` (set in `capacitor.config.ts`).
Point it at your Cue deployment with `VELLUM_ENVIRONMENT=cue`, overriding the URL
with `CUE_SERVER_URL` once you have a custom domain:

```bash
cd apps/web
CUE_SERVER_URL=https://cue.example.com/assistant VELLUM_ENVIRONMENT=cue bunx cap sync

# iOS  (needs Xcode + Apple signing; display name "Cue", bundle id unchanged):
bunx cap open ios            # build/sign/archive the "App" scheme in Xcode

# Android (needs Android SDK + a signing keystore; project scaffolded at apps/android):
cd ../android && ./gradlew assembleRelease
```

Bundle IDs / appId stay `vellum*` (signing & provisioning depend on them) — only
display names are rebranded to Cue.
