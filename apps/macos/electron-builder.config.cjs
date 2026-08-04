// @ts-check

const env = process.env.VELLUM_ENVIRONMENT || "local";
const targetArch = process.env.ELECTRON_TARGET_ARCH || "arm64";

// Auto-update feed: GitHub Releases on a dedicated PUBLIC releases-only repo.
// The source repo (manav1125/hum) is private, and electron-updater can only
// read private-repo release assets with a runtime token — a non-starter for
// distributed builds. A public releases repo needs no token to read; only
// publishing (electron-builder --publish) needs GH_TOKEN. This config is baked
// into the app as app-update.yml, which electron-updater picks up by default.
const releasesOwner = process.env.CUE_RELEASES_OWNER || "manav1125";
const releasesRepo = process.env.CUE_RELEASES_REPO || "cue-releases";

// "Cue" is the canonical product name. `production` and the default `local`
// build (what `bun run pack` produces, and the handoff/self-host artifact)
// both ship as plain "Cue" → `Cue.app`. Only the genuinely-separate
// side-by-side builds (`dev`, `staging`) keep an env suffix so they can be
// installed alongside a real "Cue" without colliding in the Dock / Finder.
const productName =
  env === "production" || env === "local"
    ? "Cue"
    : `Cue ${env.charAt(0).toUpperCase() + env.slice(1)}`;

const appId =
  env === "production"
    ? "com.vellum.vellum-assistant-electron"
    : `com.vellum.vellum-assistant-electron-${env}`;

const schemes =
  env === "production"
    ? ["vellum", "vellum-assistant"]
    : [`vellum-assistant-${env}`];

// Signing identity for the whole app. pack.sh resolves the local
// "Apple Development" identity (when present in the keychain) and exports it as
// CUE_MAC_SIGN_IDENTITY; on hosts with no identity (CI) it stays unset and we
// leave electron-builder's ad-hoc arm64 fallback in place. A stable, team-based
// signature is what makes the TCC Accessibility grant for the bundled helper
// persist across launches. "Apple Development" is a `development`-type cert
// (found via the "Mac Developer" type by the afterSign re-sign pass); it runs
// on the signing machine and needs no notarization.
// A Developer ID build is a different kind of signature, not a different name.
// `type: "development"` above is right for the local Apple Development identity
// and wrong for Developer ID: that is electron-builder's `distribution` type,
// and it also rejects an `identity` carrying the "Developer ID Application:"
// prefix ("appropriate certificate will be chosen automatically"), because the
// type already tells it which certificate class to look in. Hardcoding
// development meant the repo could not produce a distributable build at all —
// every local pack was signed with a certificate that Gatekeeper refuses on any
// Mac but the signing one.
//
// The bare common name is deliberately what we hand over: "Manav Gupta
// (TEAMID)" is ambiguous to `codesign` on a machine holding both an Apple
// Distribution and a Developer ID cert, but electron-builder disambiguates by
// certificate type before it ever shells out.
const rawSignIdentity = process.env.CUE_MAC_SIGN_IDENTITY || undefined;
const isDeveloperId = /^Developer ID Application:\s*/i.test(
  rawSignIdentity ?? "",
);
const signIdentity = isDeveloperId
  ? rawSignIdentity.replace(/^Developer ID Application:\s*/i, "")
  : rawSignIdentity;
const macSigning = signIdentity
  ? {
      identity: signIdentity,
      type: isDeveloperId ? "distribution" : "development",
    }
  : {};

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId,
  productName,
  publish: {
    provider: "github",
    owner: releasesOwner,
    repo: releasesRepo,
    releaseType: "release",
  },
  directories: {
    output: "dist",
  },
  extraResources: [
    { from: "resources/bun", to: "bun" },
    {
      from: "resources/cue-mac-helper.app",
      to: "bin/cue-mac-helper.app",
    },
    { from: "resources/web-dist", to: "web-dist" },
    { from: "resources/cli-lockfile", to: "cli-lockfile" },
    { from: "build/icon.icns", to: "icon.icns" },
  ],
  afterPack: "./scripts/afterPack.js",
  afterSign: "./scripts/afterSign.js",
  protocols: [
    {
      name: "Cue Deep Links",
      schemes,
    },
  ],
  fileAssociations: [
    {
      ext: "vellum",
      name: "Cue Bundle",
      role: "Viewer",
    },
  ],
  mac: {
    ...macSigning,
    icon: "build/icon.icns",
    category: "public.app-category.productivity",
    hardenedRuntime: true,
    entitlements: "./scripts/entitlements/app.plist",
    entitlementsInherit: "./scripts/entitlements/inherit.plist",
    extendInfo: {
      NSMicrophoneUsageDescription:
        "Cue uses the microphone to record voice input for chat.",
      NSCameraUsageDescription:
        "Cue uses the camera to capture photos when you ask your assistant to use the camera.",
      NSSpeechRecognitionUsageDescription:
        "Cue uses speech recognition to transcribe dictated voice input.",
      NSAppleEventsUsageDescription:
        "Cue uses Automation to paste dictated voice input into the app you are using.",
      NSUserNotificationAlertStyle: "alert",
      // Register the .vellum UTI so Quick Look extensions can provide
      // thumbnails and previews for .vellum bundle files in Finder.
      UTExportedTypeDeclarations: [
        {
          UTTypeIdentifier: "com.vellum.app-bundle",
          UTTypeConformsTo: ["public.data", "public.content"],
          UTTypeDescription: "Cue App Bundle",
          UTTypeTagSpecification: {
            "public.filename-extension": ["vellum"],
            "public.mime-type": "application/x-vellum",
          },
        },
      ],
    },
    target: [
      {
        target: "dmg",
        arch: [targetArch],
      },
      {
        target: "zip",
        arch: [targetArch],
      },
    ],
  },
};
