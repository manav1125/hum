import { describe, expect, test } from "bun:test";

import {
  backendDisclosureLines,
  isUserOwnedBrowser,
  withBackendDisclosure,
} from "../backend-disclosure.js";

describe("backendDisclosureLines", () => {
  test("every backend discloses which browser it drove", () => {
    for (const kind of [
      "extension",
      "host-bridge",
      "cdp-inspect",
      "local",
    ] as const) {
      const text = backendDisclosureLines(kind).join("\n");
      expect(text).toContain("Browser used:");
    }
  });

  test("the user's own browser is named as theirs", () => {
    for (const kind of ["extension", "host-bridge"] as const) {
      const text = backendDisclosureLines(kind).join("\n");
      expect(text).toContain("the user's own Chrome");
      expect(text).toContain("logged-in sessions");
      // No stop-and-tell-them warning: this backend really is their browser.
      expect(text).not.toContain("stop here");
    }
  });

  // The failure this exists to prevent: the factory silently fell through to
  // the in-container Playwright browser, Cue read a logged-out Netlify page,
  // and reported "not logged in" as if it had looked at the user's account.
  test("the in-container fall-through says it is NOT the user's browser and to stop", () => {
    const text = backendDisclosureLines("local").join("\n");
    expect(text).toContain("INSIDE Cue's own container");
    expect(text).toContain("NOT the user's browser");
    expect(text).toContain("no cookies");
    expect(text).toContain("not evidence about the user's account");
    expect(text).toContain("stop here");
    // And it must not resolve the dead end by asking for a secret.
    expect(text).toContain("never ask them for a password or token");
  });

  test("isUserOwnedBrowser is true only for routes to the user's Chrome", () => {
    expect(isUserOwnedBrowser("extension")).toBe(true);
    expect(isUserOwnedBrowser("host-bridge")).toBe(true);
    expect(isUserOwnedBrowser("local")).toBe(false);
    // cdp-inspect dials the DAEMON's localhost. On a cloud daemon that is not
    // the user's machine, so it is not treated as their browser.
    expect(isUserOwnedBrowser("cdp-inspect")).toBe(false);
  });

  test("withBackendDisclosure appends to existing result lines", () => {
    const lines = ["Requested URL: https://app.netlify.com/"];
    const returned = withBackendDisclosure(lines, "local");
    expect(returned).toBe(lines);
    expect(lines[0]).toBe("Requested URL: https://app.netlify.com/");
    expect(lines.join("\n")).toContain("Browser used:");
  });
});

// The login-wall guidance lives in browser-execution.ts because it needs the
// live backend kind. Imported here so the "never solicit a secret" rule is
// pinned next to the disclosure it depends on.
const { loginGuidanceLines } = await import("../browser-execution.js");

describe("loginGuidanceLines", () => {
  test("in the user's own browser: work the form, never ask for a secret", () => {
    for (const kind of ["extension", "host-bridge"] as const) {
      const text = loginGuidanceLines(kind).join("\n");
      expect(text).toContain("Take a snapshot");
      expect(text).toContain("credential_store");
      expect(text).toContain("never a value the user typed into chat");
      expect(text).toContain("Never ask the user for a password or token");
    }
  });

  // Replaces the old fixed instruction "Do NOT give up or suggest manual
  // sign-in - handle the login flow yourself", whose only implementation in
  // the container browser was to ask the user for their password.
  test("in the container browser: stop, and do not offer to sign in for them", () => {
    const text = loginGuidanceLines("local").join("\n");
    expect(text).toContain("a browser the user has never signed into");
    expect(text).toContain("Stop and tell them");
    expect(text).toContain("credential_store");
    expect(text).toContain("Do NOT ask them for a password");
    expect(text).toContain("do NOT offer to sign in on their behalf");
    expect(text).not.toContain("handle the login flow yourself");
  });
});

// The first-run Chromium download is reported once, on the call that paid for
// it, and never again — otherwise every later navigate would keep blaming a
// download that already finished.
const { takePendingColdStartNotice, _setPendingColdStartNotice } = await import(
  "../browser-manager.js"
);

describe("cold-start notice", () => {
  test("is empty when the browser was already installed", () => {
    _setPendingColdStartNotice(null);
    expect(takePendingColdStartNotice()).toBeNull();
  });

  test("is delivered exactly once", () => {
    _setPendingColdStartNotice("Note: one-time 114s browser download.");
    expect(takePendingColdStartNotice()).toContain("one-time");
    expect(takePendingColdStartNotice()).toBeNull();
  });
});
