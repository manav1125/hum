/**
 * The magic link, end to end — the one path that must never regress.
 *
 * A beautiful sign-on screen that cannot sign anyone in is worse than a plain
 * one that can, so this file walks the real boot: a `?cueToken=` URL arrives,
 * `bootstrapCueSelfHost()` consumes it, the boot gate declines to show the
 * sign-on screens, the credential is gone from the address bar, and the
 * connecting overlay (screen C) plays over the app instead of in front of it.
 *
 * Kept in the sign-on folder rather than appended to `cue-self-host.test.ts`
 * because what is under test here is the SEAM between the token bootstrap and
 * the new screens — the place a change to either side would break the other.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import {
  bootstrapCueSelfHost,
  clearSelfHostMode,
  didSeedFromMagicLink,
  isSelfHostMode,
  shouldShowCueConnect,
  shouldShowCueConnectAsync,
} from "@/lib/self-hosted/cue-self-host";

import { ConnectingOverlay } from "./connecting-overlay";

const LS_TOKEN_KEY = "vellum:gw:token";
const LS_ACTOR_TOKEN_KEY = "cue:selfHost:actorToken";

function makeToken(expSec: number): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ exp: expSec, sub: "actor" }));
  return `${header}.${payload}.sig`;
}

const liveToken = () => makeToken(Math.floor(Date.now() / 1000) + 30 * 86_400);

beforeEach(() => {
  clearSelfHostMode();
  localStorage.removeItem(LS_ACTOR_TOKEN_KEY);
  window.location.href = "https://cue-ada.justcue.app/assistant/";
});

afterEach(cleanup);

describe("a magic link still signs you in", () => {
  test("`?cueToken=` seeds the session, and the sign-on screens stand aside", async () => {
    const token = liveToken();
    window.location.href = `https://cue-ada.justcue.app/assistant/?cueToken=${token}`;

    // Before: a fresh instance browser would be shown the sign-on arc.
    expect(shouldShowCueConnect()).toBe(true);

    bootstrapCueSelfHost();

    // After: a real session exists, so the boot gate hands control to the
    // router instead of rendering SignonFlow.
    expect(localStorage.getItem(LS_TOKEN_KEY)).toBe(token);
    expect(isSelfHostMode()).toBe(true);
    expect(shouldShowCueConnect()).toBe(false);
    expect(await shouldShowCueConnectAsync()).toBe(false);
  });

  test("the credential is stripped from the URL it arrived on", () => {
    const token = liveToken();
    window.location.href = `https://cue-ada.justcue.app/assistant/?cueToken=${token}&cueExp=${Date.now() + 1000}`;
    bootstrapCueSelfHost();

    expect(window.location.search).not.toContain("cueToken");
    expect(window.location.search).not.toContain("cueExp");
    expect(window.location.href).not.toContain(token);
  });

  test("an expired link does not fake a session — the arc is shown again", async () => {
    const stale = makeToken(Math.floor(Date.now() / 1000) - 60);
    window.location.href = `https://cue-ada.justcue.app/assistant/?cueToken=${stale}`;
    bootstrapCueSelfHost();

    expect(shouldShowCueConnect()).toBe(true);
    expect(await shouldShowCueConnectAsync()).toBe(true);
  });

  test("a page load with no link seeds nothing", () => {
    bootstrapCueSelfHost();
    expect(localStorage.getItem(LS_TOKEN_KEY)).toBeNull();
    expect(shouldShowCueConnect()).toBe(true);
  });
});

describe("screen C sits ON TOP of the boot, never in front of it", () => {
  test("it renders only on the load that redeemed a link", () => {
    // `didSeedFromMagicLink()` is module state set by the bootstrap above; by
    // this point in the file a link HAS been redeemed, so the overlay arms.
    expect(didSeedFromMagicLink()).toBe(true);
    render(<ConnectingOverlay />);
    expect(screen.getByText("Opening your Cue…")).toBeTruthy();
    // Its provisioning lines are text, not motion — all three are legible in
    // the very first frame.
    expect(screen.getByText("Verifying your link")).toBeTruthy();
    expect(screen.getByText("Waking your agents")).toBeTruthy();
    expect(screen.getByText("Picking up where you left off")).toBeTruthy();
  });

  test("a click dismisses it, so it can never trap anyone", () => {
    render(<ConnectingOverlay />);
    fireEvent.click(screen.getByText("Opening your Cue…"));
    expect(screen.queryByText("Opening your Cue…")).toBeNull();
  });

  test("Escape dismisses it too", () => {
    render(<ConnectingOverlay />);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByText("Opening your Cue…")).toBeNull();
  });

  test("it removes itself on its own after the animation", async () => {
    render(<ConnectingOverlay />);
    expect(screen.getByText("Opening your Cue…")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2600));
    });
    expect(screen.queryByText("Opening your Cue…")).toBeNull();
  });
});
