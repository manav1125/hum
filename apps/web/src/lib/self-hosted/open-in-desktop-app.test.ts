/**
 * B7: the "Continue in the Cue app?" banner fired on iOS and mobile web.
 *
 * `shouldOfferDesktopHandoff()` excluded only Electron. But the iOS app loads
 * `<instance>/assistant/?cueToken=…` inside its WebView
 * (apps/ios/App/App/CueNativePlugin.swift), which sets `seededFromMagicLink` —
 * so the NATIVE app offered to open the Cue app, positioned under the Dynamic
 * Island, and fired a `vellum://` no-op. Mobile web had the same banner with no
 * desktop app to hand off to.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let mockIsElectron = false;
let mockIsNative = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => mockIsElectron,
}));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => mockIsNative,
}));

let mockSeeded = true;
let mockToken: string | null = "actor-token";
mock.module("@/lib/self-hosted/cue-self-host", () => ({
  didSeedFromMagicLink: () => mockSeeded,
  getStoredActorToken: () => mockToken,
}));

const { shouldOfferDesktopHandoff, openInDesktopApp } =
  await import("@/lib/self-hosted/open-in-desktop-app");

const originalMatchMedia = window.matchMedia;
/** Pointer coarseness is how mobile is detected — not the user agent. */
function setCoarsePointer(coarse: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("pointer: coarse") ? coarse : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  mockIsElectron = false;
  mockIsNative = false;
  mockSeeded = true;
  mockToken = "actor-token";
  setCoarsePointer(false);
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("shouldOfferDesktopHandoff (B7)", () => {
  test("offers the handoff in a desktop browser after a magic link", () => {
    expect(shouldOfferDesktopHandoff()).toBe(true);
  });

  test("never offers inside the iOS/Capacitor shell", () => {
    // The native app sets seededFromMagicLink by loading ?cueToken= in its own
    // WebView, which is exactly why the Electron-only check missed it.
    mockIsNative = true;
    expect(shouldOfferDesktopHandoff()).toBe(false);
  });

  test("never offers on mobile web (no desktop app to reach)", () => {
    setCoarsePointer(true);
    expect(shouldOfferDesktopHandoff()).toBe(false);
  });

  test("never offers inside the desktop app itself", () => {
    mockIsElectron = true;
    expect(shouldOfferDesktopHandoff()).toBe(false);
  });

  test("does not offer on an ordinary page load or without a token", () => {
    mockSeeded = false;
    expect(shouldOfferDesktopHandoff()).toBe(false);
    mockSeeded = true;
    mockToken = null;
    expect(shouldOfferDesktopHandoff()).toBe(false);
  });
});

describe("the fallback scheme only fires when the first jump went nowhere", () => {
  const originalAssign = window.location.assign;
  const originalHasFocus = document.hasFocus;
  let assigned: string[];

  beforeEach(() => {
    assigned = [];
    mockSeeded = true;
    mockToken = "actor-token";
    setCoarsePointer(false);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, origin: "https://x.example", assign: (u: string) => assigned.push(u) },
    });
  });

  afterEach(() => {
    document.hasFocus = originalHasFocus;
    window.location.assign = originalAssign;
  });

  test("REGRESSION: a successful hand-off does not then prompt for the local scheme", async () => {
    // The first jump opens Cue and takes focus. The delayed fallback used to
    // fire regardless — and on any machine that has ever run a locally-built
    // app, `vellum-assistant-local:` still resolves to a stray Electron.app in
    // node_modules. The owner got "Open Electron?" on every single sign-in,
    // AFTER Cue had already opened correctly.
    document.hasFocus = () => false;
    openInDesktopApp();
    await new Promise((r) => setTimeout(r, 1400));

    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toContain("vellum://connect");
  });

  test("a hand-off that went nowhere still gets its second chance", async () => {
    // Which is the whole reason the fallback exists: a locally-built app
    // registers only its env-suffixed scheme.
    document.hasFocus = () => true;
    openInDesktopApp();
    await new Promise((r) => setTimeout(r, 1400));

    expect(assigned).toHaveLength(2);
    expect(assigned[1]).toContain("vellum-assistant-local://connect");
  });
});
