import { spawn } from "node:child_process";
import fs from "node:fs";

import { guardianTokenPath } from "./config";
import type { CliInvocation } from "./util";

const GUARDIAN_TOKEN_REFRESH_TIMEOUT_MS = 15_000;

/**
 * The CLI's exit code for "the gateway is not answering", as distinct from
 * "the gateway refused these credentials". Defined in
 * `cli/src/commands/gateway/token.ts`, duplicated here because the two have no
 * common dependency.
 *
 * It matters which of the two a failure is. `requiresGuardianReprovision()`
 * treats 401 as terminal — only re-provisioning recovers — so reporting a
 * stopped gateway as 401 sends someone to replace credentials that are
 * perfectly good. A gateway that is merely down needs starting, not repairing.
 */
const CLI_EXIT_GATEWAY_UNAVAILABLE = 69;

interface GuardianTokenData {
  accessToken: string;
  accessTokenExpiresAt: string | number;
  refreshToken: string;
  refreshTokenExpiresAt: string | number;
}

function isAccessTokenExpired(data: GuardianTokenData): boolean {
  const expiresAt = new Date(data.accessTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  return Date.now() >= expiresAt - 60_000;
}

function isRefreshTokenExpired(data: GuardianTokenData): boolean {
  const expiresAt = new Date(data.refreshTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  return Date.now() >= expiresAt;
}

export type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; status: number; error: string };

export function getGuardianAccessToken(
  assistantId: string,
  configDir: string,
  invocation: CliInvocation,
  isLoopback: boolean,
  env?: Record<string, string>,
): Promise<TokenResult> {
  if (!isLoopback) {
    return Promise.resolve({ ok: false, status: 403, error: "Forbidden" });
  }

  const tokenPath = guardianTokenPath(configDir, assistantId);

  let raw: string;
  try {
    raw = fs.readFileSync(tokenPath, "utf-8");
  } catch {
    return Promise.resolve({
      ok: false,
      status: 404,
      error: "Guardian token not found",
    });
  }

  let data: GuardianTokenData;
  try {
    data = JSON.parse(raw) as GuardianTokenData;
  } catch {
    return Promise.resolve({
      ok: false,
      status: 500,
      error: "Malformed guardian token file",
    });
  }

  if (!isAccessTokenExpired(data)) {
    return Promise.resolve({ ok: true, accessToken: data.accessToken });
  }

  // The refresh token outlives the access token, but a gateway restart rotates
  // the signing key and invalidates both. So: try refresh while the refresh
  // token is live; on any failure (or an already-expired refresh token),
  // recover by re-leasing from scratch via the stored bootstrap secret
  // (`relink`) rather than bricking the connection until the user re-hatches.
  if (isRefreshTokenExpired(data)) {
    return runTokenSubcommand("relink", assistantId, invocation, env);
  }

  return runTokenSubcommand("refresh", assistantId, invocation, env).then(
    (refreshed) =>
      refreshed.ok
        ? refreshed
        : runTokenSubcommand("relink", assistantId, invocation, env),
  );
}

function runTokenSubcommand(
  subcommand: "refresh" | "relink",
  assistantId: string,
  invocation: CliInvocation,
  env?: Record<string, string>,
): Promise<TokenResult> {
  return new Promise((resolve) => {
    const child = spawn(
      invocation.command,
      [...invocation.baseArgs, "gateway", "token", subcommand, assistantId],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: TokenResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        status: 500,
        error: `Guardian token ${subcommand} timed out`,
      });
    }, GUARDIAN_TOKEN_REFRESH_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    // Drained, not ignored: stderr is piped, so leaving it unread lets the
    // child block once the pipe buffer fills. It also carries the only
    // description of what went wrong.
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        const accessToken = stdout.trim();
        if (accessToken) {
          finish({ ok: true, accessToken });
        } else {
          finish({ ok: false, status: 500, error: "CLI returned empty token" });
        }
      } else if (code === CLI_EXIT_GATEWAY_UNAVAILABLE) {
        // An outage, not a credential problem. 503 keeps the caller on the
        // retry path instead of the re-provision one.
        finish({
          ok: false,
          status: 503,
          error:
            stderr.trim() ||
            `Gateway unavailable while trying to ${subcommand} the guardian token`,
        });
      } else {
        finish({
          ok: false,
          status: 401,
          error: stderr.trim() || `Failed to ${subcommand} guardian token`,
        });
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        status: 500,
        error: `Failed to spawn CLI: ${err.message}`,
      });
    });
  });
}
