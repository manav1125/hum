// Notarization step for the Cue macOS app (chained from afterSign.js).
//
// Runs AFTER the afterSign re-signing pass so the notarized seal covers the
// final nested signatures. Uses Apple's notarytool via @electron/notarize,
// then staples the ticket so the app passes Gatekeeper offline.
//
// Credentials come from the environment, in preference order:
//
//   ASC API key (preferred — the key already used for TestFlight uploads):
//     APPLE_API_KEY        path to the AuthKey_*.p8 (defaults to the Cue key
//                          at ~/.appstoreconnect/private_keys/AuthKey_753495X7A6.p8
//                          when that file exists)
//     APPLE_API_KEY_ID     key id (default 753495X7A6)
//     APPLE_API_ISSUER     issuer id (default cc10286d-1b31-4cfb-ae74-811ff064b75e)
//
//   Apple ID fallback:
//     APPLE_ID                     Apple ID email used for notarization
//     APPLE_APP_SPECIFIC_PASSWORD  app-specific password for that Apple ID
//     APPLE_TEAM_ID                team id (defaults to XU8BLQACGU, the Cue team)
//
// When no credentials resolve (local unsigned/dev builds) this is a clear,
// logged no-op — packing keeps working exactly as before.

const { execFileSync } = require("child_process");
const { existsSync } = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_TEAM_ID = "XU8BLQACGU";
const DEFAULT_API_KEY_ID = "753495X7A6";
const DEFAULT_API_ISSUER = "cc10286d-1b31-4cfb-ae74-811ff064b75e";
const DEFAULT_API_KEY_PATH = path.join(
  os.homedir(),
  ".appstoreconnect",
  "private_keys",
  `AuthKey_${DEFAULT_API_KEY_ID}.p8`,
);

/** Resolve notarytool credentials: ASC API key first, Apple ID fallback. */
function resolveNotaryAuth() {
  const keyPath =
    process.env.APPLE_API_KEY ||
    (existsSync(DEFAULT_API_KEY_PATH) ? DEFAULT_API_KEY_PATH : undefined);
  if (keyPath && existsSync(keyPath)) {
    return {
      kind: "api-key",
      opts: {
        appleApiKey: keyPath,
        appleApiKeyId: process.env.APPLE_API_KEY_ID || DEFAULT_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER || DEFAULT_API_ISSUER,
      },
    };
  }
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  if (appleId && appleIdPassword) {
    return {
      kind: "apple-id",
      opts: {
        appleId,
        appleIdPassword,
        teamId: process.env.APPLE_TEAM_ID || DEFAULT_TEAM_ID,
      },
    };
  }
  return null;
}

/**
 * @param {import("electron-builder").AfterPackContext} context
 * @param {{ name: string, sign: string } | null} identity signing identity the
 *   afterSign pass used ("-" means ad-hoc, null means signing was skipped)
 */
async function notarizeApp(context, identity) {
  if (process.platform !== "darwin") {
    return;
  }

  const auth = resolveNotaryAuth();
  if (!auth) {
    console.log(
      "notarize: skipped — no credentials. Provide the ASC API key " +
        "(APPLE_API_KEY[_ID]/APPLE_API_ISSUER, or keep the default key at " +
        "~/.appstoreconnect/private_keys) or APPLE_ID + " +
        "APPLE_APP_SPECIFIC_PASSWORD.",
    );
    return;
  }

  if (!identity || identity.sign === "-") {
    console.warn(
      "notarize: skipped — the app is not signed with a Developer ID " +
        "identity (ad-hoc or unsigned builds cannot be notarized). " +
        "Install the 'Developer ID Application' certificate and re-run pack.",
    );
    return;
  }

  // Only a "Developer ID Application" identity can notarize. Local
  // "Apple Development" (or "Apple Distribution") signing is valid and gives a
  // stable DR for TCC, but notarytool rejects it — attempting it would fail the
  // whole pack. Skip cleanly so signed-for-local builds still complete.
  if (!/^Developer ID Application/.test(identity.name || "")) {
    console.warn(
      `notarize: skipped — signing identity "${identity.name}" is not a ` +
        "'Developer ID Application' certificate, so the app cannot be " +
        "notarized (this is expected for local Apple Development builds).",
    );
    return;
  }

  const { appOutDir, packager } = context;
  const appPath = path.join(
    appOutDir,
    `${packager.appInfo.productFilename}.app`,
  );

  console.log(
    `notarize: submitting ${appPath} to Apple notary service (${auth.kind} auth)…`,
  );
  const { notarize } = require("@electron/notarize");
  await notarize({
    tool: "notarytool",
    appPath,
    ...auth.opts,
  });

  console.log("notarize: stapling ticket…");
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  console.log("notarize: done");
}

exports.notarizeApp = notarizeApp;
