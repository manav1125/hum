/**
 * `startAuthFlow` is the single door every platform-login entry point in the
 * app goes through: the login page, the signup page's effect, the account
 * page, and `useOnboardingLogin` (welcome / hosting / select-assistant).
 *
 * On a Cue self-hosted install every branch behind that door ends at
 * `api.workos.com` — via the Electron bridge, the iOS `ASWebAuthenticationSession`,
 * the loopback redirect, or the same-origin form POST that 302s there. There
 * is no Vellum Platform account behind a Cue install, so none of them can
 * succeed; they can only take the owner to a third party's login page first.
 *
 * These tests assert the refusal, and — more importantly — that NONE of the
 * four egress routes is invoked. A gate that returns early but still fires one
 * of them would pass a naive "did it throw?" test.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const calls = {
  providerRedirect: 0,
  loopback: 0,
  electronStartOAuth: 0,
};

mock.module("@/domains/account/social-auth", () => ({
  startProviderRedirect: async () => {
    calls.providerRedirect += 1;
  },
}));

mock.module("@/lib/auth/loopback-auth", () => ({
  isPlatformLocal: () => false,
  startLoopbackAuth: async () => {
    calls.loopback += 1;
  },
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => true,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => true,
}));

const { startAuthFlow } = await import("@/runtime/native-auth");

const LS_SELF_HOST_FLAG = "cue:selfHost";

beforeEach(() => {
  calls.providerRedirect = 0;
  calls.loopback = 0;
  calls.electronStartOAuth = 0;
  // A desktop bridge that would happily run the flow if it were asked.
  (globalThis.window as { vellum?: unknown }).vellum = {
    selfHost: { connected: async () => null },
    auth: {
      startOAuth: async () => {
        calls.electronStartOAuth += 1;
        return { sessionToken: "should-never-happen" };
      },
    },
  };
});

afterEach(() => {
  localStorage.removeItem(LS_SELF_HOST_FLAG);
  (globalThis.window as { vellum?: unknown }).vellum = undefined;
});

describe("startAuthFlow on a Cue self-hosted install", () => {
  test("refuses, and reaches none of the four egress routes", async () => {
    localStorage.setItem(LS_SELF_HOST_FLAG, "1");

    await expect(
      startAuthFlow("workos", "/account/provider/callback"),
    ).rejects.toThrow(/magic link/i);

    expect(calls.electronStartOAuth).toBe(0);
    expect(calls.providerRedirect).toBe(0);
    expect(calls.loopback).toBe(0);
  });

  test("refuses on the packaged desktop app with no stored session at all", async () => {
    // No self-host flag and no token — the incident's state. The desktop
    // preload's bridge is the only remaining signal, and it must be enough.
    await expect(
      startAuthFlow("workos", "/account/provider/callback", {
        providerHint: "GoogleOAuth",
      }),
    ).rejects.toThrow(/magic link/i);

    expect(calls.electronStartOAuth).toBe(0);
    expect(calls.providerRedirect).toBe(0);
    expect(calls.loopback).toBe(0);
  });

  test("a signup intent is refused too — that path fires from an effect", async () => {
    localStorage.setItem(LS_SELF_HOST_FLAG, "1");

    await expect(
      startAuthFlow("workos", "/account/provider/callback", {
        intent: "signup",
      }),
    ).rejects.toThrow(/magic link/i);

    expect(calls.electronStartOAuth).toBe(0);
  });

  test("a non-Cue build is unaffected and still runs the Electron flow", async () => {
    // Narrowness check: the gate must not remove sign-in from the upstream
    // web/desktop build, only from installs that have no account to sign in to.
    (globalThis.window as { vellum?: unknown }).vellum = {
      auth: {
        startOAuth: async () => {
          calls.electronStartOAuth += 1;
          return { sessionToken: "" };
        },
      },
    };

    await startAuthFlow("workos", "/account/provider/callback");

    expect(calls.electronStartOAuth).toBe(1);
  });
});
