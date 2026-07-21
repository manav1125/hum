# Cue Chrome Extension (Cue Browser Relay)

MV3 Chrome extension that lets your Cue assistant act inside the browser you're
already signed into. It drives tabs via the Chrome DevTools Protocol
(`chrome.debugger`) on behalf of your assistant, pairing with a Cue gateway and
maintaining a persistent, auto-reconnecting background relay.

Single connection mode: the extension pairs with a **Cue gateway** — the desktop
app on loopback (`http://127.0.0.1:7830`), or any gateway URL you provide — using
the gateway's own `POST /v1/pair` flow. There is **no external sign-in and no data
collection**; the extension only executes what your assistant explicitly requests.

> Protocol identifiers stay `vellum` on purpose (the `X-Vellum-*` headers, the
> `x-vellum-interface-id: chrome-extension` handshake, the `Vellum.*` synthetic
> CDP methods, and the `vellum.*` storage keys). Only user-facing display strings
> are rebranded to Cue. See the repo rebrand-boundary note.

## Install

**Alpha (sideload):** load the packaged zip in Developer mode — see below. This is
the day-one path; alpha users are never gated on Chrome Web Store review.

**Chrome Web Store:** once the Cue item is published, install it from the store
listing (no developer mode required). The store-assigned extension id must be
reconciled into [`extension-environments.json`](./extension-environments.json) and
`gateway/src/chrome-extension-origins.ts` if it differs from the embedded
production key's id.

## Development

### Prerequisites

- Bun installed and on `PATH` (`export PATH="$HOME/.bun/bin:$PATH"`)
- Chrome 120+ with Developer mode enabled (`chrome://extensions`)
- A running Cue assistant (the desktop app, or a gateway URL you can reach)

### Build & Load (dev)

```bash
cd clients/chrome-extension
bash build.sh          # env defaults to `dev`
```

Then in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `clients/chrome-extension/dist`

`bash build.sh run` rebuilds on change (watch mode).

### Packaged builds

```bash
# Production sideload / store-submission zip → cue-browser-relay.zip
VELLUM_ENVIRONMENT=production VERSION=<x.y.z> bash build.sh build
```

`build.sh` also signs a `.crx` when a private key is present at `privatekey.pem`
in this directory (or `CRX_KEY_PATH`). The Cue production private key is NOT
committed — supply it to sign a CRX, and keep it as the Chrome Web Store signing
key so the sideload and published ids match.

## Usage

1. Open the extension popup and click **Connect to Cue**.
2. The extension pairs with the gateway URL (default `http://127.0.0.1:7830`) and
   opens the relay. Change the gateway URL in the popup if your assistant runs
   elsewhere.

The extension auto-reconnects on browser restarts, network drops, and assistant
restarts (SSE reconnect with exponential backoff). Click **Disconnect** to stop
the relay; it stays quiet until you connect again.

## Environment selector

The popup can switch between `local`, `dev`, `staging`, and `production` without
rebuilding. This controls the toolbar icon tint and the (WS-D follow-up) feedback
endpoint host. Precedence:

| Priority | Source | Description |
|---|---|---|
| 1 (highest) | Popup override | Persisted in `chrome.storage.local` |
| 2 | Build-time default | Injected via `--define process.env.VELLUM_ENVIRONMENT=...` |
| 3 (fallback) | Hard-coded default | `production` |

## Extension IDs (deterministic per environment)

Each environment embeds a fixed public `key` in the manifest (from
[`extension-environments.json`](./extension-environments.json)), so every build of
the same environment gets the same stable 32-char id. These ids are allowlisted by
the gateway's pairing origin check (`gateway/src/chrome-extension-origins.ts`) —
**keep the two files in sync.** Cue owns its own keys (regenerated from Vellum's).

| Environment | Extension ID |
|---|---|
| production | `mhgllmdapjpfdnfnmdihjffclnjknhmc` |
| dev | `fgjdoijjdaknpebalabagkblfchpebkp` |
| staging | `andfdpliflikfgnejjeokmcofpnochic` |
| local | `mlkohkopfacnbiajpnajjmphoahogfcc` |

The production id is derived from the embedded production key. If the Chrome Web
Store assigns a different id at item creation, add that id to both files.

## Debugging

- **Service worker logs:** `chrome://extensions` → extension card → **Service worker**
- **Popup logs:** open the popup → right-click → **Inspect**

## Tests

```bash
cd clients/chrome-extension
bunx tsc --noEmit
bun test
```
