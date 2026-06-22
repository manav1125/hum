// @ts-check

const env = process.env.VELLUM_ENVIRONMENT || "local";
const bucketEnv = env === "production" ? "prod" : env;
const targetArch = process.env.ELECTRON_TARGET_ARCH || "arm64";

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

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId,
  productName,
  publish: {
    provider: "generic",
    url: `https://storage.googleapis.com/vellum-ai-${bucketEnv}-releases/mac-electron/${targetArch}/`,
  },
  directories: {
    output: "dist",
  },
  extraResources: [
    { from: "resources/bun", to: "bun" },
    {
      from: "resources/vellum-mac-helper.app",
      to: "bin/vellum-mac-helper.app",
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
    icon: "build/icon.icns",
    category: "public.app-category.productivity",
    hardenedRuntime: true,
    entitlements: "./scripts/entitlements/app.plist",
    entitlementsInherit: "./scripts/entitlements/inherit.plist",
    extendInfo: {
      CFBundleIconName: "AppIcon",
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
