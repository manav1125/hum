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

// Cue self-host target: the mobile shell loads the SPA from the owner's own
// Cue deployment, so the instance MUST be named at sync time:
//   CUE_SERVER_URL=https://cue-ada-1234.justcue.app/assistant/ VELLUM_ENVIRONMENT=cue bunx cap sync
//
// There is deliberately no default. `server.url` is baked into the archived
// binary, so a default here ships inside every copy of the app — a build with
// one owner's instance in it points every OTHER owner at that instance. It
// used to default to exactly that, which is why this throws instead.
//
// This makes a `cue` build single-instance by construction: fine for the
// owner's own build, wrong for the App Store. Shipping to strangers needs the
// shell to bundle the SPA and let each owner connect to their own instance at
// runtime (the macOS app does this — see `app-config.ts`
// `setPersistedSelfHostUrlReader` + `self-host-connect.ts`); the SPA
// authenticates same-origin, so the WebView has to end up ON the instance
// rather than proxying to it.
const cueSelfHostUrl = (): string => {
  const url = process.env.CUE_SERVER_URL?.trim();
  if (!url) {
    throw new Error(
      "VELLUM_ENVIRONMENT=cue requires CUE_SERVER_URL — the Cue instance this " +
        "build loads (e.g. https://cue-ada-1234.justcue.app/assistant/). It is " +
        "baked into the binary, so there is no safe default: every owner has " +
        "their own instance.",
    );
  }
  return url;
};

const SERVER_URL =
  env === "cue"
    ? cueSelfHostUrl()
    : env === "production"
      ? "https://www.vellum.ai/assistant"
      : env === "staging"
        ? "https://staging-assistant.vellum.ai/assistant"
        : "https://dev-assistant.vellum.ai/assistant";

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
  server: {
    url: SERVER_URL,
    // Allow plain http only when the target itself is http (local dev server
    // for the simulator, e.g. CUE_SERVER_URL=http://localhost:3000/assistant).
    // Production https targets keep ATS enforced.
    cleartext: SERVER_URL.startsWith("http://"),
  },
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
