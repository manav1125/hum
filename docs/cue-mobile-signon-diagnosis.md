# Cue iOS sign-on diagnosis — why the app shows the old Vellum screen, not the Gravity shell

_Investigation only. Date: 2026-07-18. Repo HEAD: `f5b32ebf4e`._

## TL;DR

The device is running a **stale TestFlight binary that predates the Gravity shell**
(and predates the Cue splash rebrand). Nothing in the current code is broken. The
two things the user sees are:

1. **"Vellum splash graphic"** = the *native iOS LaunchScreen* asset baked into
   that old binary. Before commit `746e063f2d` (2026‑06‑21) the
   `Splash.imageset` was a **white "V" on green — the Vellum mark**. Every build
   after that ships the Cue "C." aperture. Seeing the "V" ⇒ the installed binary
   was archived **before 2026‑06‑21**.
2. **"Sign in to Cue / This is your Cue…"** = `cue-connect-screen.tsx` served by
   the *live, current* instance `manav.justcue.app`. The old binary has a baked
   `server.url` and loads the instance origin directly, so it never runs a shell
   and lands on the instance's own connect screen.

The Gravity shell + native bridge only came into existence **today**
(`58df305347`, `4302d9f3d9`, `b88dc11ae4`, all 2026‑07‑18). The build on the
device cannot contain them. **Fix = archive + upload a fresh TestFlight build
from current HEAD and update the device.** No repo asset needs replacing.

---

## Evidence

### 1. Where the "Vellum graphics" come from

- **Current native splash is Cue, not Vellum.**
  `apps/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png`
  (and `LaunchScreen.storyboard` → `image="Splash"`) is the white **C. aperture**
  on a dark‑navy gradient. Verified by rendering the PNG. No Vellum branding.
- **The pre‑rebrand splash WAS the Vellum "V".** Extracting the same file at the
  parent of the rebrand commit:
  `git show 746e063f2d~1:apps/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png`
  renders a **white "V" on a green field** — the Vellum mark. This is exactly the
  "Vellum splash graphic" the user reported.
- **Rebrand commit:** `746e063f2d "feat(mobile): Cue mobile design + iOS
  distribution config"` — 2026‑06‑21 20:32. It swapped the splash to Cue and
  added the web boot splash.
- **Web boot splash is Cue, never Vellum.** `apps/web/public/boot-splash.js`
  ("paints the Cue aperture") was *introduced* in `746e063f2d`; it has no Vellum
  history (`git log -S "Vellum"` on it is empty). Before that commit
  `apps/web/index.html` had **no** boot splash at all (only a favicon), so an old
  web build would flash white, not a Vellum graphic.
- **The live instance is Cue‑branded.** `curl https://manav.justcue.app/assistant/`
  returns `<title>Cue</title>`, references `boot-splash.js`, and serves the same
  `resolved-assistants-store-DcDSRi7r.js` chunk as the local `deploy/web-dist`.
  The only "vellum" strings are the `__VELLUM_CONFIG__` config blob and internal
  URLs — not a graphic.

**Conclusion:** the "Vellum graphics" is the **native LaunchScreen of the old
binary**, not any web content and not the current repo. The current repo has no
Vellum splash asset to replace.

### 2. Why the app loads the remote instance and bypasses the shell

The current build is wired correctly for the shell:

- `apps/ios/App/App/capacitor.config.json` (synced 2026‑07‑18 16:22) has a
  `server` block with **only `allowNavigation` and no `url`** → Capacitor serves
  the bundled shell from `capacitor://localhost`.
- `apps/ios/App/App/public/index.html` (the synced web dir) **is** the Gravity
  shell — contains "One Cue", "Sign in to Cue", "Check your email".
- `apps/ios/App/App/MyViewController.swift:46‑52` `instanceDescriptor()` only sets
  `serverURL` from UserDefaults `cue.instanceUrl`; `CueNativePlugin.swift:32`
  defines that key and it is written **only** by `connect`/`load`
  (`CueNativePlugin.swift:42,59`).

So on the current build a clean install shows the shell. The device does not —
because it is not this build. The old build's config was different:

- `git show 746e063f2d~1:apps/web/capacitor.config.ts` shows the pre‑shell config
  **always** baked a server URL: `const SERVER_URL = …` then `url: SERVER_URL`
  unconditionally (line 48). For the `cue` env it defaulted to
  `CUE_SERVER_URL ?? "https://cue-app-3yne.onrender.com/assistant"`. There was no
  "serve the shell" branch — the shell, `CueNativePlugin`, and the
  `instanceDescriptor()` override did not exist yet.

**Enumeration of how `serverURL` gets set (task 2):**

- **(a) UserDefaults `cue.instanceUrl` from a prior connect** — *does not apply
  here.* The old binary never had `CueNativePlugin`, so it never wrote that key.
  (This path only matters *after* the new build ships: an in‑place update that
  reuses a UserDefaults value from a first connect would skip the shell — so a
  clean reinstall is the safe way to first see the shell.)
- **(b) A baked `server.url` in the archive's `capacitor.config.json`** — **this
  is the actual cause.** The installed archive is an older build whose
  `capacitor.config.ts` baked `url: SERVER_URL` → the WebView boots straight onto
  the instance origin.
- **(c) Any other path** — none. `instanceDescriptor()` reads only UserDefaults;
  no other code sets `serverURL`.

### 3. Does a cold visit to the instance show the Cue screen or a Vellum page?

Cold visit shows the **Cue** connect screen. The `*.justcue.app` self‑host check
is in the shipped bundle:

- `apps/web/src/lib/self-hosted/cue-self-host.ts:61‑64` — `isCueSelfHostDeploy()`
  returns true when `host.endsWith(".justcue.app")`.
- Verified in the minified live/deploy bundle:
  `resolved-assistants-store-DcDSRi7r.js` contains
  `…location.hostname;return e.endsWith(\`.justcue.app\`)||e.endsWith(\`.justcue.io\`)…`
  and the `?cueConnect=` escape hatch. `manav.justcue.app` serves this exact
  chunk. So `shouldShowCueConnect()` → true → `CueConnectScreen` (Cue‑branded),
  **not** the Vellum‑Platform login. Task‑3 claim verified.

### 4. Is the connect screen the right thing to reach un‑authenticated?

Reaching the instance's own connect screen means the **shell was skipped
entirely** (the old build's baked‑`server.url` path), **not** that the shell ran
and the magic‑link token failed to apply. In the current code the token path is
intact:

- shell `capacitor-shell/index.html`: `resolveAndConnect()` (line 366) → HQ
  `/auth?native=1` → `connectToInstance()` (line 328) → `CueNative.connect(url,
  token)`.
- `CueNativePlugin.connect` (`CueNativePlugin.swift:36‑50`) saves the instance
  and loads `…/assistant/?cueToken=<token>`.
- The instance SPA consumes it in `bootstrapCueSelfHost()`
  (`cue-self-host.ts:277‑314`) → seeds the session → boots authenticated.

So with the correct build, the user should never see the instance's connect
screen after a successful magic‑link sign‑in. The current symptom is purely the
old build never entering that flow.

---

## Root cause, ranked

1. **(Definitive) Stale TestFlight binary — built before the Gravity shell and
   before the Cue splash rebrand.** It ships the Vellum "V" native LaunchScreen
   and a baked `server.url` → loads `manav.justcue.app/assistant` directly →
   instance's own `cue-connect-screen.tsx`.
   **Fix:** From current HEAD run
   `VELLUM_ENVIRONMENT=cue bunx cap sync ios` **with `CUE_SERVER_URL` unset** (so
   no URL is baked and the shell is served from `capacitor://localhost`), then
   archive in Xcode with the "App" scheme and upload to TestFlight. Update the
   app on device. Confirm `apps/ios/App/App/capacitor.config.json` has a `server`
   block with **no `url`** and `public/index.html` is the shell *before*
   archiving.

2. **(Applies only after #1 ships) In‑place update can bypass the shell via a
   persisted `cue.instanceUrl`.** Once a user connects on the new build,
   `instanceDescriptor()` loads the instance directly on next launch — correct by
   design. To *first* verify the shell after shipping, do a **clean
   install** (delete + reinstall), since UserDefaults survives an app update but
   not a delete. Does **not** explain the current report (old build never wrote
   the key).

3. **(Ruled out) Instance serving a Vellum page / missing self‑host check.**
   Live `manav.justcue.app` serves `<title>Cue</title>`, the Cue boot splash, and
   the bundle containing the `.justcue.app` self‑host check. A cold visit shows
   the Cue connect screen. No action needed.

## Splash / LaunchScreen assets — do they contain Vellum branding?

**No — not in the current repo.** `apps/ios/App/App/Assets.xcassets/Splash.imageset/`
is the Cue "C." mark (all three `splash-2732x2732*.png`, since 2026‑06‑21), and
`LaunchScreen.storyboard` references `image="Splash"`. `boot-splash.js` and
`favicon.svg` are the Cue aperture. **No asset replacement is required.** The
Vellum "V" exists only inside the already‑archived old binary; shipping a current
build eliminates it.

## Key files

- `apps/ios/App/App/capacitor.config.json` — synced iOS config; current one has
  no `server.url` (correct; serves shell).
- `apps/ios/App/App/public/index.html` — synced Gravity shell.
- `apps/ios/App/App/MyViewController.swift:46‑52` — `instanceDescriptor()`
  serverURL from UserDefaults.
- `apps/ios/App/App/CueNativePlugin.swift:32,36‑62` — persists/loads
  `cue.instanceUrl`.
- `apps/ios/App/App/Assets.xcassets/Splash.imageset/` — Cue "C." splash (current).
- `apps/web/capacitor.config.ts` — current: bakes URL only when `CUE_SERVER_URL`
  set, else serves shell. (Old `746e063f2d~1` version baked unconditionally.)
- `apps/web/capacitor-shell/index.html` — Gravity shell source + magic‑link flow.
- `apps/web/src/lib/self-hosted/cue-self-host.ts:51‑72,161‑163` — self‑host
  detection + connect gate.
- `apps/web/src/lib/self-hosted/cue-connect-screen.tsx` — the "Sign in to Cue"
  screen.
- `apps/web/public/boot-splash.js` — Cue aperture web boot splash.
