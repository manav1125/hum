/**
 * The rail's auto-collapse.
 *
 * Before this, `collapsed` was a single `useState` in `chat-layout.tsx` that
 * never read the route: the rail was exactly as wide over a transcript as over
 * HQ. Design's line — *"the rail auto-collapses to a 52px icon strip the moment
 * you enter a conversation (◧ or ⌘\ pins it open) — this is what makes
 * discoverability affordable"* — is the argument for everything else in the
 * rail, so it is worth a test file of its own.
 */

import { describe, expect, test } from "bun:test";

import {
  RAIL_COLLAPSED_WIDTH,
  isConversationSurface,
  isRailCollapsed,
  toggleRail,
} from "./rail-collapse";

describe("where a conversation is", () => {
  test.each([
    "/assistant",
    "/assistant/",
    "/assistant/conversations/abc",
    "/assistant/conversations/abc/",
  ])("%s is a transcript", (pathname) => {
    expect(isConversationSurface(pathname)).toBe(true);
  });

  test.each([
    // An index is a list to scan — exactly when you want the rail.
    "/assistant/conversations",
    "/assistant/hq",
    "/assistant/projects",
    "/assistant/library",
    "/assistant/identity",
    "/assistant/settings/general",
    // The LLM-context inspector is a dense diagnostic page, not a transcript.
    "/assistant/conversations/abc/inspect",
  ])("%s is not", (pathname) => {
    expect(isConversationSurface(pathname)).toBe(false);
  });
});

describe("the rail collapses on entering a conversation", () => {
  test("open on HQ, collapsed the moment you enter a conversation", () => {
    const base = { preferenceCollapsed: false, pinnedOpen: false };
    expect(isRailCollapsed({ ...base, inConversation: false })).toBe(false);
    expect(isRailCollapsed({ ...base, inConversation: true })).toBe(true);
  });

  test("pinning holds it open in conversations", () => {
    expect(
      isRailCollapsed({
        preferenceCollapsed: false,
        inConversation: true,
        pinnedOpen: true,
      }),
    ).toBe(false);
  });

  test("outside a conversation the standing preference wins", () => {
    expect(
      isRailCollapsed({
        preferenceCollapsed: true,
        inConversation: false,
        pinnedOpen: true,
      }),
    ).toBe(true);
    expect(
      isRailCollapsed({
        preferenceCollapsed: false,
        inConversation: false,
        pinnedOpen: false,
      }),
    ).toBe(false);
  });

  test("a pin does NOT force the rail open on HQ", () => {
    // The asymmetry is intentional: on HQ the rail is not competing with
    // anything for space, so the standing preference is still the answer.
    expect(
      isRailCollapsed({
        preferenceCollapsed: true,
        inConversation: false,
        pinnedOpen: true,
      }),
    ).toBe(true);
  });
});

describe("what ◧ / ⌘\\ changes", () => {
  test("inside a conversation it pins, and leaves the standing choice alone", () => {
    const next = toggleRail({
      preferenceCollapsed: false,
      inConversation: true,
      pinnedOpen: false,
    });
    expect(next).toEqual({ preferenceCollapsed: false, pinnedOpen: true });
  });

  test("pressing it again un-pins", () => {
    const next = toggleRail({
      preferenceCollapsed: false,
      inConversation: true,
      pinnedOpen: true,
    });
    expect(next.pinnedOpen).toBe(false);
  });

  test("outside a conversation it collapses, and leaves the pin alone", () => {
    const next = toggleRail({
      preferenceCollapsed: false,
      inConversation: false,
      pinnedOpen: true,
    });
    expect(next).toEqual({ preferenceCollapsed: true, pinnedOpen: true });
  });

  test("the two flags never bleed into each other", () => {
    // One boolean would make pinning the rail open inside a transcript
    // silently change what HQ looks like when you navigate back.
    const inChat = toggleRail({
      preferenceCollapsed: true,
      inConversation: true,
      pinnedOpen: false,
    });
    expect(inChat.preferenceCollapsed).toBe(true);

    const onHq = toggleRail({
      preferenceCollapsed: true,
      inConversation: false,
      pinnedOpen: false,
    });
    expect(onHq.pinnedOpen).toBe(false);
  });

  test("toggling twice returns to where you started, on both surfaces", () => {
    for (const inConversation of [true, false]) {
      const start = {
        preferenceCollapsed: false,
        inConversation,
        pinnedOpen: false,
      };
      const once = toggleRail(start);
      const twice = toggleRail({ ...once, inConversation });
      expect(twice).toEqual({
        preferenceCollapsed: start.preferenceCollapsed,
        pinnedOpen: start.pinnedOpen,
      });
    }
  });
});

test("the strip is 52px", () => {
  expect(RAIL_COLLAPSED_WIDTH).toBe(52);
});
