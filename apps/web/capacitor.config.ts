import type { CapacitorConfig } from "@capacitor/cli";

// `server.url` is baked into `../ios/App/App/capacitor.config.json` (gitignored)
// by `cap sync`, so whatever URL resolves here at sync time is what the
// archived iOS build ships with. Defaults to dev; set `VELLUM_ENVIRONMENT=production`
// before `bunx cap sync ios` when archiving for TestFlight / App Store.
//
// The `/assistant` suffix is deliberate — booting on the bare host lands
// on the marketing page, whose CTA redirects to `www.vellum.ai/assistant`
// and bounces non-prod shells off their own host.
const env = process.env.VELLUM_ENVIRONMENT ?? "dev";

// The baked `server.url` — or `null` to serve the bundled `webDir` from
// `capacitor://localhost` instead.
//
// `server.url` is compiled into the archive, so it CANNOT be a shared build's
// default: every owner runs their own Cue (`cue-<name>.justcue.app`), and a
// baked URL would point every copy at one instance. So the `cue` env bakes a
// URL ONLY when `CUE_SERVER_URL` is set at sync time — an owner building their
// own single-instance app, or a dev pointing at a local server. With nothing
// set, it returns null and Capacitor serves the connect shell
// (`capacitor-shell/index.html`), which learns the instance at runtime and
// navigates the WebView onto it — the mobile mirror of the macOS app's
// runtime-connect (see apps/macos/.../self-host-connect.ts). The SPA
// authenticates same-origin, so the WebView must END UP ON the instance; the
// shell navigates there rather than proxying.
//
// The internal Vellum envs stay single-origin and baked.
const bakedServerUrl = (): string | null => {
  if (env === "cue") return process.env.CUE_SERVER_URL?.trim() || null;
  if (env === "production") return "https://www.vellum.ai/assistant";
  if (env === "staging") return "https://staging-assistant.vellum.ai/assistant";
  return "https://dev-assistant.vellum.ai/assistant";
};

const SERVER_URL = bakedServerUrl();

const SCHEME_NAMES: Record<string, string> = {
  production: "App",
  staging: "App Staging",
  dev: "App Dev",
  // Cue self-host reuses the distribution ("App") scheme; the user re-signs
  // with their own bundle id + provisioning when shipping their Cue build.
  cue: "App",
};

const config: CapacitorConfig = {
  // NOTE: Capacitor's CLI rejects hyphens in appId (Java-package form only).
  // The real iOS bundle ID is `ai.vocify-inc.vellum-assistant-ios`, set via
  // `PRODUCT_BUNDLE_IDENTIFIER` in the Xcode project — that is what gets
  // built, signed, and shipped. This value only exists to satisfy Capacitor
  // CLI validation during `cap add` / `cap sync`.
  appId: "ai.vocify.vellumassistantios",
  appName: "Cue",
  webDir: "capacitor-shell",
  // With a baked URL, load it directly. Without one (a shared `cue` build),
  // omit `server` entirely so Capacitor serves `webDir` — the connect shell —
  // from `capacitor://localhost`, and the shell navigates to the owner's
  // instance at runtime.
  ...(SERVER_URL
    ? {
        server: {
          url: SERVER_URL,
          // Allow plain http only when the target itself is http (a local dev
          // server for the simulator). https targets keep ATS enforced.
          cleartext: SERVER_URL.startsWith("http://"),
        },
      }
    : {}),
  ios: {
    // Native iOS project lives as a peer to `apps/web/` at `apps/ios/`,
    // not nested inside the web app. This keeps the Capacitor shell
    // alongside the other client apps (`apps/web`, future `apps/...`)
    // rather than burying it inside the web tree.
    path: "../ios",
    // Map to `WKWebView.scrollView.contentInsetAdjustmentBehavior = .never`.
    // Without this, iOS WKWebView defaults to `.automatic` and pads the
    // scroll content by the safe-area insets itself, which has two
    // unwanted effects inside the Capacitor shell:
    //   1. `env(safe-area-inset-*)` resolves to 0 because, from the
    //      webview's perspective, it already sits inside the safe area.
    //      That makes the CSS safe-area padding on `<Layout>` /
    //      `<AssistantShell>` a no-op — the header and composer end up
    //      covered by the notch and home indicator.
    //   2. The surface colour on the header stops at the safe-area line
    //      instead of extending into the notch, leaving a transparent
    //      strip at the top.
    // Setting this to `never` lets the page own the inset compensation via
    // `env(safe-area-inset-*)`, which is what PRs #4821 and #4832 assume.
    contentInset: "never",
    scheme: SCHEME_NAMES[env] ?? "App",
  },
  android: {
    // Native Android project lives as a peer to `apps/web/` at `apps/android/`,
    // mirroring the iOS layout. Loads the same SPA (server.url) in a native
    // WebView shell. Build with the Android SDK + a signing keystore:
    //   VELLUM_ENVIRONMENT=cue bunx cap sync android && (cd ../android && ./gradlew assembleRelease)
    path: "../android",
  },
};

export default config;
