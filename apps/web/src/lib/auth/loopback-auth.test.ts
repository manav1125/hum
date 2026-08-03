/**
 * Sign-in must never leave this origin unless the host explicitly said to.
 *
 * Found by tapping "Log In" on a fresh install on a phone. It opened
 * `https://www.vellum.ai/account/login` — the upstream fork's sign-in page —
 * and asked for credentials there. Not a dead link: a live, plausible login
 * form on a domain the reader has no relationship with, reached from the first
 * button on the first screen.
 *
 * The chain was one hardcoded constant. `getLocalConfig()` fell back to the
 * fork's domain, `isPlatformLocal()` compared that to this origin and got
 * false, and `startAuthFlow` read the mismatch as "standalone local mode" and
 * redirected off-origin. Every deployment that does not inject
 * `__VELLUM_CONFIG__` — every self-hosted one — took that path.
 *
 * These tests pin the boundary rather than the string, so the guard survives
 * a rename: what matters is that an uninjected host authenticates against
 * itself, and that a host which named a destination still gets it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isPlatformLocal, startLoopbackAuth } from "./loopback-auth";

const ORIGIN = "https://cue-manav-prod.fly.dev";

type ConfigWindow = typeof globalThis & {
  __VELLUM_CONFIG__?: { webUrl?: string };
};

function setInjectedConfig(webUrl: string | undefined): void {
  const w = globalThis as ConfigWindow;
  if (webUrl === undefined) {
    delete w.__VELLUM_CONFIG__;
    return;
  }
  w.__VELLUM_CONFIG__ = { webUrl };
}

/** Capture `window.location.href` writes without navigating the test runner. */
let assignedHref: string | null = null;

beforeEach(() => {
  assignedHref = null;
  setInjectedConfig(undefined);
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      origin: ORIGIN,
      port: "",
      get href() {
        return assignedHref ?? ORIGIN;
      },
      set href(next: string) {
        assignedHref = next;
      },
    },
  });
});

afterEach(() => {
  setInjectedConfig(undefined);
});

describe("isPlatformLocal", () => {
  test("an uninjected host is its own platform", () => {
    // This is the whole fix. False here is what routed sign-in off-origin.
    expect(isPlatformLocal()).toBe(true);
  });

  test("a host that names itself is still local", () => {
    setInjectedConfig(ORIGIN);
    expect(isPlatformLocal()).toBe(true);
  });

  test("a host that names somewhere else is not local", () => {
    // The real platform deployment must keep working: when a deployment
    // genuinely authenticates elsewhere, it says so, and that still wins.
    setInjectedConfig("https://platform.example.com");
    expect(isPlatformLocal()).toBe(false);
  });
});

describe("startLoopbackAuth", () => {
  test("an uninjected host sends the reader to its own login page", async () => {
    await startLoopbackAuth("/assistant/hq");
    expect(assignedHref).not.toBeNull();
    expect(new URL(assignedHref!).origin).toBe(ORIGIN);
  });

  test("sign-in never lands on a domain the host did not name", async () => {
    // Asserted as a property, not as "not vellum.ai" — a future constant with
    // a different foreign domain is the same defect and must fail here too.
    await startLoopbackAuth();
    expect(new URL(assignedHref!).origin).toBe(ORIGIN);
  });

  test("an injected host is still honoured", async () => {
    setInjectedConfig("https://platform.example.com");
    await startLoopbackAuth("/assistant/hq");
    expect(new URL(assignedHref!).origin).toBe("https://platform.example.com");
  });

  test("the return path survives the redirect", async () => {
    setInjectedConfig("https://platform.example.com");
    await startLoopbackAuth("/assistant/hq");
    const returnTo = new URL(assignedHref!).searchParams.get("returnTo");
    expect(returnTo).toContain("/accounts/cli/callback");
  });
});
