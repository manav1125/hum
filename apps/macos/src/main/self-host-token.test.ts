import { afterEach, describe, expect, test } from "bun:test";

import {
  __resetSelfHostActorTokenForTesting,
  getCachedSelfHostActorToken,
  refreshSelfHostActorToken,
  setSelfHostActorTokenReader,
} from "./self-host-token";

describe("self-host-token", () => {
  afterEach(() => {
    __resetSelfHostActorTokenForTesting();
  });

  test("returns null until a reader is wired", async () => {
    expect(getCachedSelfHostActorToken()).toBeNull();
    expect(await refreshSelfHostActorToken()).toBeNull();
  });

  test("caches the token so sync header builders can read it", async () => {
    setSelfHostActorTokenReader(async () => "jwt-1");

    expect(getCachedSelfHostActorToken()).toBeNull();
    expect(await refreshSelfHostActorToken()).toBe("jwt-1");
    expect(getCachedSelfHostActorToken()).toBe("jwt-1");
  });

  test("a refresh picks up a re-seeded session", async () => {
    let current = "jwt-1";
    setSelfHostActorTokenReader(async () => current);
    await refreshSelfHostActorToken();

    current = "jwt-2";
    expect(await refreshSelfHostActorToken()).toBe("jwt-2");
    expect(getCachedSelfHostActorToken()).toBe("jwt-2");
  });

  test("clears the cache when the session no longer has a token", async () => {
    let current: string | null = "jwt-1";
    setSelfHostActorTokenReader(async () => current);
    await refreshSelfHostActorToken();

    // Signed out / revoked: keeping the old token would leave the app
    // presenting a credential the session has abandoned.
    current = null;
    expect(await refreshSelfHostActorToken()).toBeNull();
    expect(getCachedSelfHostActorToken()).toBeNull();
  });

  test("treats an empty token as no token", async () => {
    setSelfHostActorTokenReader(async () => "");
    expect(await refreshSelfHostActorToken()).toBeNull();
  });

  test("a throwing reader clears rather than crashes", async () => {
    setSelfHostActorTokenReader(async () => "jwt-1");
    await refreshSelfHostActorToken();

    setSelfHostActorTokenReader(async () => {
      throw new Error("window gone");
    });
    expect(await refreshSelfHostActorToken()).toBeNull();
    expect(getCachedSelfHostActorToken()).toBeNull();
  });

  test("unwiring the reader drops the cached token", async () => {
    setSelfHostActorTokenReader(async () => "jwt-1");
    await refreshSelfHostActorToken();

    setSelfHostActorTokenReader(null);
    expect(getCachedSelfHostActorToken()).toBeNull();
  });
});
