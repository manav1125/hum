import {
  lookupAssistantByIdentifier,
  formatAssistantLookupError,
} from "../../lib/assistant-config.js";
import {
  loadGuardianToken,
  refreshGuardianToken,
  leaseGuardianToken,
  resetGuardianBootstrap,
} from "../../lib/guardian-token.js";

function printUsage(): void {
  console.log("Usage: vellum gateway token <subcommand> <assistantId>");
  console.log("");
  console.log("Manage gateway authentication tokens.");
  console.log("");
  console.log("Subcommands:");
  console.log("  get       Print the current guardian access token");
  console.log("  refresh   Refresh an expired access token and print it");
  console.log(
    "  relink    Re-lease the guardian token from scratch and print it",
  );
}

export async function gatewayToken(): Promise<void> {
  const args = process.argv.slice(4);
  const subcommand = args[0];

  if (subcommand === "--help" || subcommand === "-h" || !subcommand) {
    printUsage();
    process.exit(0);
  }

  if (
    subcommand !== "get" &&
    subcommand !== "refresh" &&
    subcommand !== "relink"
  ) {
    console.error(`Unknown subcommand: ${subcommand}`);
    printUsage();
    process.exit(1);
  }

  const assistantId = args[1];
  if (!assistantId) {
    console.error("Missing required argument: <assistantId>");
    printUsage();
    process.exit(1);
  }

  const result = lookupAssistantByIdentifier(assistantId);
  if (result.status !== "found") {
    console.error(formatAssistantLookupError(assistantId, result));
    process.exit(1);
  }
  const entry = result.entry;

  if (subcommand === "get") {
    const tokenData = loadGuardianToken(entry.assistantId);
    if (!tokenData) {
      console.error("No guardian token found for this assistant.");
      process.exit(1);
    }
    console.log(tokenData.accessToken);
    return;
  }

  const gatewayUrl = entry.localUrl || entry.runtimeUrl;
  if (!gatewayUrl) {
    console.error("No gateway URL found for this assistant.");
    process.exit(1);
  }

  if (subcommand === "refresh") {
    const refreshed = await refreshGuardianToken(gatewayUrl, entry.assistantId);
    if (!refreshed) {
      console.error("Failed to refresh guardian token.");
      process.exit(1);
    }
    console.log(refreshed.accessToken);
    return;
  }

  // relink: re-lease the guardian token from scratch using the stored bootstrap
  // secret. Recovers after a gateway restart invalidates the stored token (the
  // refresh path then fails). The reset clears any consumed-secret lock so the
  // single-use secret can claim guardianship again.
  try {
    await resetGuardianBootstrap(gatewayUrl, entry.guardianBootstrapSecret);
  } catch {
    // Lock may already be clear; the lease below is the real check.
  }
  const leased = await leaseGuardianToken(
    gatewayUrl,
    entry.assistantId,
    entry.guardianBootstrapSecret,
  );
  console.log(leased.accessToken);
}
