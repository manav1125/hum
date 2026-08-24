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
import { gatewayReachable } from "../../lib/http-client.js";

/**
 * Exit code meaning "the gateway is not answering", as distinct from "the
 * gateway refused these credentials".
 *
 * 69 is `EX_UNAVAILABLE` from sysexits(3). The counterpart lives in
 * `packages/local-mode/src/guardian-token.ts`, which maps it to HTTP 503; the
 * two are duplicated rather than shared because the CLI and that package have
 * no common dependency, and the constant is part of this command's contract.
 * An older CLI that never emits it degrades to the previous behaviour rather
 * than to a wrong answer.
 */
const EXIT_GATEWAY_UNAVAILABLE = 69;

/**
 * Fail the command, separating an outage from a rejected credential.
 *
 * Every failure here used to exit 1, which the callers read as "these
 * credentials are gone" and answered with a re-provision — for an assistant
 * whose credentials were fine and whose gateway was merely stopped. Asking
 * whether the gateway is answering is the cheapest way to tell the two apart,
 * and it asks the real question instead of inferring one from an exit code
 * that never carried it.
 */
async function failClassified(
  gatewayUrl: string,
  refusedMessage: string,
): Promise<never> {
  if (!(await gatewayReachable(gatewayUrl))) {
    console.error(
      `Gateway not reachable at ${gatewayUrl}. It is probably not running.`,
    );
    process.exit(EXIT_GATEWAY_UNAVAILABLE);
  }
  console.error(refusedMessage);
  process.exit(1);
}

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
      return failClassified(gatewayUrl, "Failed to refresh guardian token.");
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
  let leased;
  try {
    leased = await leaseGuardianToken(
      gatewayUrl,
      entry.assistantId,
      entry.guardianBootstrapSecret,
    );
  } catch (err) {
    return failClassified(
      gatewayUrl,
      `Failed to re-lease guardian token: ${(err as Error).message}`,
    );
  }
  console.log(leased.accessToken);
}
