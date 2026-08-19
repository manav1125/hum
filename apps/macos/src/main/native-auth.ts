import { session } from "electron";
import crypto from "node:crypto";
import { z } from "zod";

import { resolveLocalConfigFromEnv } from "@vellumai/local-mode";

import { handle, handleSync } from "./ipc";
import { clearSessionToken, getSessionToken } from "./session-token-store";

export function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// Evict the session cookies installed by prior builds, so that
// header auth takes precedence.
async function clearLegacySessionCookies(): Promise<void> {
  const url = resolveProxyPlatformUrl();
  await Promise.all(
    ["sessionid", "__Secure-sessionid"].map((name) =>
      // Best-effort — a missing cookie is the common case.
      session.defaultSession.cookies.remove(url, name).catch(() => undefined),
    ),
  );
}

// The platform URL the renderer's proxy talks to.
function resolveProxyPlatformUrl(): string {
  return resolveLocalConfigFromEnv(process.env).platformUrl;
}

/**
 * Why this file no longer starts an OAuth flow.
 *
 * We forked upstream at the commit that added app-held WorkOS PKCE login for
 * native macOS, and inherited it wholesale. Cue is single-tenant and
 * self-hosted: every owner runs their own gateway and signs in by magic link
 * to it. There is no Vellum Platform account behind a Cue install and no
 * WorkOS org that would recognise one — the client_id the flow fetched was
 * upstream's.
 *
 * So the flow could never have completed. What it could do, and did, was open
 * the system browser at `api.workos.com/user_management/authorize` under
 * another company's branding, on behalf of an account that does not exist.
 * The whole PKCE implementation (`workos-pkce.ts`) is therefore deleted rather
 * than disabled: a self-hosted install must have no code path that can reach
 * a third-party identity provider at all.
 *
 * The channel itself stays registered and rejects. Removing it would make
 * `window.vellum.auth.startOAuth` absent in the preload's shape, and the
 * renderer's `startAuthFlow` treats absence as "older preload" and falls
 * through to the same-origin form POST — which 302s to the same WorkOS
 * authorize URL. Present-and-refusing is the safe shape; absent is not.
 *
 * `signOut` / `getSessionToken` stay: `host-proxy-router` reads the session
 * token store, and the renderer clears it on logout. Neither reaches the
 * network.
 */
const PLATFORM_AUTH_REMOVED =
  "Cue signs in with a magic link to your own instance. This build has no platform sign-in.";

const startOAuthSchema = z.tuple([
  z.object({
    providerHint: z.string().optional(),
    loginHint: z.string().optional(),
    intent: z.string().optional(),
  }),
]);

let installed = false;

export const installNativeAuth = (): void => {
  if (installed) return;
  installed = true;

  void clearLegacySessionCookies();

  handle(
    "vellum:auth:startOAuth",
    startOAuthSchema,
    (): Promise<{ sessionToken: string }> => {
      throw new Error(PLATFORM_AUTH_REMOVED);
    },
  );

  // Nothing to cancel, but the renderer calls this from its login-cancel path
  // and an unregistered channel would reject into a floating promise.
  handle("vellum:auth:cancelOAuth", z.tuple([]), () => {});

  handle("vellum:auth:signOut", z.tuple([]), () => {
    clearSessionToken();
  });

  handleSync("vellum:auth:getSessionToken", () => getSessionToken());
};

export const __resetForTesting = (): void => {
  installed = false;
};
