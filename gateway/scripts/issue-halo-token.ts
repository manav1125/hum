#!/usr/bin/env bun
/**
 * Mint the long-lived Halo bridge token.
 *
 * Run this **on the machine that holds the signing key** — the key lives in
 * the gateway's security directory and never leaves it, so there is no way to
 * do this from a laptop and no endpoint that would do it over HTTP. That is
 * deliberate: an HTTP route that mints a year-long credential is a route
 * worth attacking, and this operation needs a shell on the box instead.
 *
 *   flyctl ssh console -a <app> -C "bun /app/gateway/scripts/issue-halo-token.ts"
 *
 * Prints the token once. It is not stored anywhere in readable form — only
 * its hash is recorded — so if it is lost, issue a new one, which revokes
 * the old one in the same step.
 *
 * To revoke without issuing a replacement:
 *
 *   flyctl ssh console -a <app> -C "bun /app/gateway/scripts/issue-halo-token.ts --revoke"
 */

import {
  ensureVellumGuardianBinding,
  HALO_BRIDGE_TTL_SECONDS,
  issueHaloBridgeToken,
  revokeHaloBridgeTokens,
} from "../src/auth/guardian-bootstrap.js";
import { initGatewayDb } from "../src/db/connection.js";
import {
  initSigningKey,
  loadOrCreateSigningKey,
} from "../src/auth/token-service.js";

async function main(): Promise<number> {
  const revokeOnly = process.argv.includes("--revoke");
  const days = Number(
    process.argv
      .find((a) => a.startsWith("--days="))
      ?.slice("--days=".length) ?? "",
  );

  // Same two steps the gateway takes at startup, in the same order: the key
  // before anything that signs, the database before anything that records.
  initSigningKey(loadOrCreateSigningKey());
  await initGatewayDb();

  const guardianPrincipalId = await ensureVellumGuardianBinding();

  if (revokeOnly) {
    revokeHaloBridgeTokens(guardianPrincipalId);
    console.log("Halo bridge token revoked. The app will stop syncing.");
    return 0;
  }

  const ttlSeconds =
    Number.isFinite(days) && days > 0
      ? Math.round(days * 24 * 60 * 60)
      : HALO_BRIDGE_TTL_SECONDS;

  const { token, expiresAt } = issueHaloBridgeToken({
    guardianPrincipalId,
    ttlSeconds,
  });

  console.log("");
  console.log("Halo bridge token — paste into the app's API key field.");
  console.log(`Expires ${new Date(expiresAt).toISOString().slice(0, 10)}.`);
  console.log("Shown once; issuing again revokes this one.");
  console.log("");
  console.log(token);
  console.log("");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("Failed to issue the Halo bridge token:", err);
    process.exit(1);
  },
);
