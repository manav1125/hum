// Notarization step for the Cue macOS app (chained from afterSign.js).
//
// Runs AFTER the afterSign re-signing pass so the notarized seal covers the
// final nested signatures. Uses Apple's notarytool via @electron/notarize,
// then staples the ticket so the app passes Gatekeeper offline.
//
// Credentials come from the environment:
//   APPLE_ID                     Apple ID email used for notarization
//   APPLE_APP_SPECIFIC_PASSWORD  app-specific password for that Apple ID
//   APPLE_TEAM_ID                team id (defaults to XU8BLQACGU, the Cue team)
//
// When credentials are absent (local unsigned/dev builds) this is a clear,
// logged no-op — packing keeps working exactly as before.

const { execFileSync } = require("child_process");
const path = require("path");

const DEFAULT_TEAM_ID = "XU8BLQACGU";

/**
 * @param {import("electron-builder").AfterPackContext} context
 * @param {{ name: string, sign: string } | null} identity signing identity the
 *   afterSign pass used ("-" means ad-hoc, null means signing was skipped)
 */
async function notarizeApp(context, identity) {
  if (process.platform !== "darwin") {
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID || DEFAULT_TEAM_ID;

  if (!appleId || !appleIdPassword) {
    console.log(
      "notarize: skipped — set APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD " +
        "(and optionally APPLE_TEAM_ID) to notarize distribution builds",
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

  const { appOutDir, packager } = context;
  const appPath = path.join(
    appOutDir,
    `${packager.appInfo.productFilename}.app`,
  );

  if (!process.env.APPLE_TEAM_ID) {
    console.log(`notarize: APPLE_TEAM_ID not set, using ${DEFAULT_TEAM_ID}`);
  }

  console.log(`notarize: submitting ${appPath} to Apple notary service…`);
  const { notarize } = require("@electron/notarize");
  await notarize({
    tool: "notarytool",
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log("notarize: stapling ticket…");
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  console.log("notarize: done");
}

exports.notarizeApp = notarizeApp;
