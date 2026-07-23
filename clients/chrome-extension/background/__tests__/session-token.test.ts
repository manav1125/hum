/**
 * Tests for reading the signed-in Cue session token from an open instance tab.
 *
 * Covers:
 *   - pickSessionToken: prefers the first JWT-shaped value.
 *   - pickTabIdForOrigin: origin match, id/url guards, order preference.
 *   - readActorSessionToken: end-to-end selection via injected deps, including
 *     the "no matching tab" and "signed out" (no token) cases, and that only
 *     the origin-matching tab is ever read.
 */

import { describe, test, expect } from "bun:test";

import {
  pickSessionToken,
  pickTabIdForOrigin,
  readActorSessionToken,
  SESSION_TOKEN_LS_KEYS,
  type SessionTokenReaderDeps,
} from "../session-token.js";

const JWT = "aaa.bbb.ccc";

describe("pickSessionToken", () => {
  test("returns the first JWT-shaped value", () => {
    expect(pickSessionToken([null, JWT, "other.jwt.here"])).toBe(JWT);
  });

  test("skips non-JWT values", () => {
    expect(pickSessionToken(["not-a-jwt", "", null, JWT])).toBe(JWT);
  });

  test("returns null when nothing looks like a JWT", () => {
    expect(pickSessionToken([null, undefined, "x", "a.b"])).toBeNull();
  });
});

describe("pickTabIdForOrigin", () => {
  test("returns the id of the first origin-matching tab", () => {
    const tabs = [
      { id: 1, url: "https://other.example.com/x" },
      { id: 2, url: "https://manav.justcue.app/assistant/home" },
      { id: 3, url: "https://manav.justcue.app/assistant/thread/1" },
    ];
    expect(pickTabIdForOrigin(tabs, "https://manav.justcue.app")).toBe(2);
  });

  test("ignores tabs without an id or url", () => {
    const tabs = [
      { url: "https://manav.justcue.app/a" }, // no id
      { id: 5 }, // no url
      { id: 6, url: "https://manav.justcue.app/b" },
    ];
    expect(pickTabIdForOrigin(tabs, "https://manav.justcue.app")).toBe(6);
  });

  test("returns null when no tab matches the origin", () => {
    const tabs = [{ id: 1, url: "https://elsewhere.com/" }];
    expect(pickTabIdForOrigin(tabs, "https://manav.justcue.app")).toBeNull();
  });
});

/** Build injected deps around a fixed set of tabs + a per-tab storage map. */
function makeDeps(
  tabs: Array<{ id?: number; url?: string; active?: boolean }>,
  storageByTab: Record<number, Array<string | null>>,
): { deps: SessionTokenReaderDeps; readTabs: number[] } {
  const readTabs: number[] = [];
  const deps: SessionTokenReaderDeps = {
    queryTabs: async (query) => {
      if (query.active) return tabs.filter((t) => t.active) as ChromeTab[];
      return tabs as ChromeTab[];
    },
    readLocalStorageKeys: async (tabId, keys) => {
      readTabs.push(tabId);
      expect(keys).toEqual(SESSION_TOKEN_LS_KEYS);
      return storageByTab[tabId] ?? [];
    },
  };
  return { deps, readTabs };
}

describe("readActorSessionToken", () => {
  test("reads the token from the origin-matching tab", async () => {
    const { deps, readTabs } = makeDeps(
      [
        { id: 1, url: "https://other.com/" },
        { id: 2, url: "https://manav.justcue.app/assistant/home" },
      ],
      { 2: [JWT, null] },
    );
    const token = await readActorSessionToken(
      "https://manav.justcue.app",
      deps,
    );
    expect(token).toBe(JWT);
    // Only the matching tab is ever scripted into — never the unrelated one.
    expect(readTabs).toEqual([2]);
  });

  test("prefers the active/focused tab when several instance tabs are open", async () => {
    const { deps, readTabs } = makeDeps(
      [
        { id: 7, url: "https://manav.justcue.app/assistant/a", active: true },
        { id: 8, url: "https://manav.justcue.app/assistant/b" },
      ],
      { 7: [JWT, null], 8: ["different.jwt.value", null] },
    );
    const token = await readActorSessionToken(
      "https://manav.justcue.app",
      deps,
    );
    expect(token).toBe(JWT);
    expect(readTabs).toEqual([7]);
  });

  test("falls back to the gateway-token key when the durable key is empty", async () => {
    const { deps } = makeDeps(
      [{ id: 3, url: "https://manav.justcue.app/assistant" }],
      { 3: [null, JWT] }, // cue:selfHost:actorToken empty, vellum:gw:token set
    );
    expect(
      await readActorSessionToken("https://manav.justcue.app", deps),
    ).toBe(JWT);
  });

  test("returns null when no instance tab is open", async () => {
    const { deps, readTabs } = makeDeps(
      [{ id: 1, url: "https://mail.google.com/" }],
      {},
    );
    expect(
      await readActorSessionToken("https://manav.justcue.app", deps),
    ).toBeNull();
    expect(readTabs).toEqual([]); // never scripts into a non-matching tab
  });

  test("returns null when the instance tab has no usable token (signed out)", async () => {
    const { deps } = makeDeps(
      [{ id: 4, url: "https://manav.justcue.app/assistant" }],
      { 4: [null, null] },
    );
    expect(
      await readActorSessionToken("https://manav.justcue.app", deps),
    ).toBeNull();
  });

  test("never throws when the underlying APIs reject", async () => {
    const deps: SessionTokenReaderDeps = {
      queryTabs: async () => {
        throw new Error("tabs unavailable");
      },
      readLocalStorageKeys: async () => [],
    };
    expect(
      await readActorSessionToken("https://manav.justcue.app", deps),
    ).toBeNull();
  });
});
