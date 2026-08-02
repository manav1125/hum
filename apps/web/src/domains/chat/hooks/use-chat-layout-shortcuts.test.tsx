/**
 * The palette's openers, and the one key that is never ours.
 *
 * Design's rule (v8 W1) is two sentences and this suite is both of them:
 * **"`/` or ⌘K; ⌘F is never intercepted. Find-in-page is a reflex older than
 * the app."**
 *
 * The bug these tests pin was not "⌘K is unwired" — it was wired. It was
 * suppressed whenever an input had focus, and chat auto-focuses the composer,
 * so the one shortcut the UI advertises did nothing on the surface that
 * advertises it most. `/` was never wired at all.
 *
 * Two mutations this is calibrated against:
 *
 *  1. **Put ⌘K back behind the is-typing guard.** The composer-focused test
 *     fails — the exact shape of the original defect.
 *  2. **Drop the is-typing guard from `/`.** The typing test fails. `/` is a
 *     bare printable character; firing it mid-word is the same class of bug as
 *     a single-key verb completing a task while someone writes "Wednesday".
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";

mock.module("@/runtime/command-palette-window", () => ({
  // No Electron host in a browser test: the wrapper reports "not handled" and
  // the caller falls back to the in-page palette. That fallback IS the web
  // path, so this mock is the web host, not a stub of it.
  openCommandPaletteWindow: async () => false,
}));

const { useChatLayoutShortcuts, isPaletteOpener } =
  await import("./use-chat-layout-shortcuts");
const { useCommandPaletteStore } =
  await import("@/stores/command-palette-store");

function Harness() {
  useChatLayoutShortcuts({
    toggleSidebar: () => {},
    onGoBack: () => {},
    onGoForward: () => {},
  });
  return createElement(
    "div",
    null,
    createElement("textarea", { "data-testid": "composer" }),
    createElement("div", { contentEditable: true, "data-testid": "rich" }),
  );
}

/** Dispatch a real keydown at the window, as the browser would. */
function press(
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

/** The store toggle runs behind a promise, so let the microtask queue drain. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const isOpen = () => useCommandPaletteStore.getState().isOpen;

beforeEach(() => {
  useCommandPaletteStore.setState({ isOpen: false });
});

afterEach(() => {
  cleanup();
  useCommandPaletteStore.setState({ isOpen: false });
});

describe("⌘K opens the palette", () => {
  test("from the page", async () => {
    render(createElement(Harness));
    press("k", { meta: true });
    await settle();
    expect(isOpen()).toBe(true);
  });

  test("from the composer — the case that was actually broken", async () => {
    // Mutation check. Chat focuses the composer on mount, so an opener that
    // stands down for inputs is an opener that does nothing in chat.
    const { getByTestId } = render(createElement(Harness));
    (getByTestId("composer") as HTMLTextAreaElement).focus();
    press("k", { meta: true });
    await settle();
    expect(isOpen()).toBe(true);
  });

  test("from a rich-text surface too", async () => {
    const { getByTestId } = render(createElement(Harness));
    (getByTestId("rich") as HTMLElement).focus();
    press("k", { meta: true });
    await settle();
    expect(isOpen()).toBe(true);
  });

  test("Ctrl+K as well, for the non-Mac hosts", async () => {
    render(createElement(Harness));
    press("k", { ctrl: true });
    await settle();
    expect(isOpen()).toBe(true);
  });
});

describe("`/` opens the palette", () => {
  test("when nothing is being typed into", async () => {
    render(createElement(Harness));
    press("/");
    await settle();
    expect(isOpen()).toBe(true);
  });

  test("but never while typing — it is a printable character", async () => {
    // Mutation check. Without the guard, every "and/or" opens a palette.
    const { getByTestId } = render(createElement(Harness));
    (getByTestId("composer") as HTMLTextAreaElement).focus();
    press("/");
    await settle();
    expect(isOpen()).toBe(false);
  });

  test("and never while typing into a rich-text surface", async () => {
    const { getByTestId } = render(createElement(Harness));
    (getByTestId("rich") as HTMLElement).focus();
    press("/");
    await settle();
    expect(isOpen()).toBe(false);
  });
});

describe("⌘F is never intercepted", () => {
  test("it does not open the palette", async () => {
    render(createElement(Harness));
    press("f", { meta: true });
    await settle();
    expect(isOpen()).toBe(false);
  });

  test("and its default is not prevented — the reflex survives", async () => {
    render(createElement(Harness));
    const event = press("f", { meta: true });
    await settle();
    expect(event.defaultPrevented).toBe(false);
  });

  test("nor from the composer", async () => {
    const { getByTestId } = render(createElement(Harness));
    (getByTestId("composer") as HTMLTextAreaElement).focus();
    const event = press("f", { meta: true });
    await settle();
    expect(isOpen()).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("isPaletteOpener", () => {
  test("recognises the two openers and refuses ⌘F", () => {
    expect(isPaletteOpener({ key: "k", metaKey: true }, null)).toBe(true);
    expect(isPaletteOpener({ key: "k", ctrlKey: true }, null)).toBe(true);
    expect(isPaletteOpener({ key: "/" }, null)).toBe(true);
    expect(isPaletteOpener({ key: "f", metaKey: true }, null)).toBe(false);
    expect(isPaletteOpener({ key: "f", ctrlKey: true }, null)).toBe(false);
  });

  test("a modified `/` is somebody else's shortcut", () => {
    expect(isPaletteOpener({ key: "/", metaKey: true }, null)).toBe(false);
    expect(
      isPaletteOpener({ key: "k", altKey: true, metaKey: true }, null),
    ).toBe(false);
  });
});
