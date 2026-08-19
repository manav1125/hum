import { afterEach, describe, expect, mock, test } from "bun:test";

// --- Mocks (installed before the `await import` of the module under test) ---

// Capture IPC registrations so tests can invoke the handlers directly.
const ipcHandlers: Record<string, (args: unknown[]) => unknown> = {};
const ipcSyncHandlers: Record<string, () => unknown> = {};

mock.module("./ipc", () => ({
  handle: (
    channel: string,
    _schema: unknown,
    fn: (args: unknown[]) => unknown,
  ) => {
    ipcHandlers[channel] = fn;
  },
  handleSync: (channel: string, fn: () => unknown) => {
    ipcSyncHandlers[channel] = fn;
  },
}));

// Any outbound reach at all is the bug. `net.fetch` and `shell.openExternal`
// both record instead of doing, so a test can assert nothing left the process.
const fetchedUrls: string[] = [];
const openedUrls: string[] = [];

// Capture legacy-cookie eviction calls.
const cookieRemoveCalls: Array<{ url: string; name: string }> = [];

mock.module("electron", () => ({
  app: { getVersion: () => "9.9.9", getPath: () => "/tmp" },
  net: {
    fetch: (url: string) => {
      fetchedUrls.push(url);
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  },
  session: {
    defaultSession: {
      cookies: {
        remove: (url: string, name: string) => {
          cookieRemoveCalls.push({ url, name });
          return Promise.resolve();
        },
      },
    },
  },
  shell: {
    openExternal: (url: string) => {
      openedUrls.push(url);
      return Promise.resolve();
    },
  },
}));

mock.module("@vellumai/local-mode", () => ({
  resolveLocalConfigFromEnv: () => ({
    webUrl: "https://web.example",
    platformUrl: "https://platform.example",
  }),
}));

// Capture session-token-store interactions.
const store = {
  saved: [] as string[],
  clearCalls: 0,
};

mock.module("./session-token-store", () => ({
  clearSessionToken: () => {
    store.clearCalls += 1;
  },
  getSessionToken: () => store.saved.at(-1) ?? null,
}));

const { generateState, installNativeAuth, __resetForTesting } = await import(
  "./native-auth"
);

afterEach(() => {
  __resetForTesting();
  store.saved.length = 0;
  store.clearCalls = 0;
  fetchedUrls.length = 0;
  openedUrls.length = 0;
  cookieRemoveCalls.length = 0;
  for (const key of Object.keys(ipcHandlers)) delete ipcHandlers[key];
  for (const key of Object.keys(ipcSyncHandlers)) delete ipcSyncHandlers[key];
});

describe("generateState", () => {
  test("returns a base64url-encoded string of sufficient length", () => {
    const state = generateState();
    expect(state.length).toBeGreaterThanOrEqual(16);
    expect(/^[A-Za-z0-9_-]+$/.test(state)).toBe(true);
  });

  test("generates unique values", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});

describe("installNativeAuth — platform OAuth is gone", () => {
  test("startOAuth rejects and reaches nothing", async () => {
    installNativeAuth();

    const startOAuth = ipcHandlers["vellum:auth:startOAuth"];
    // Registered, not absent: the renderer treats an ABSENT bridge method as
    // "older preload" and falls back to a same-origin form POST that redirects
    // to the very authorize URL this removal exists to prevent.
    expect(startOAuth).toBeDefined();

    await expect(
      Promise.resolve().then(() => startOAuth([{}])),
    ).rejects.toThrow(/magic link/i);

    // Give any stray async leg a tick to show itself.
    await Bun.sleep(5);
    expect(openedUrls).toEqual([]);
    expect(fetchedUrls).toEqual([]);
  });

  test("no handler can produce a workos.com URL", async () => {
    installNativeAuth();

    for (const [channel, fn] of Object.entries(ipcHandlers)) {
      try {
        await fn(channel === "vellum:auth:startOAuth" ? [{}] : []);
      } catch {
        // A refusal is a pass.
      }
    }
    await Bun.sleep(5);

    const reached = [...openedUrls, ...fetchedUrls];
    expect(reached.some((u) => u.includes("workos.com"))).toBe(false);
  });

  test("cancelOAuth is a no-op rather than an unregistered channel", async () => {
    installNativeAuth();

    const cancel = ipcHandlers["vellum:auth:cancelOAuth"];
    expect(cancel).toBeDefined();
    await cancel([]);
  });
});

describe("installNativeAuth — session-token wiring", () => {
  test("evicts both legacy session cookies on install", () => {
    installNativeAuth();
    // Eviction fires synchronously (Promise.all over the cookie names).
    const names = cookieRemoveCalls.map((c) => c.name);
    expect(names).toContain("sessionid");
    expect(names).toContain("__Secure-sessionid");
    expect(
      cookieRemoveCalls.every((c) => c.url === "https://platform.example"),
    ).toBe(true);
  });

  test("signOut clears the persisted token", async () => {
    installNativeAuth();

    const signOut = ipcHandlers["vellum:auth:signOut"];
    expect(signOut).toBeDefined();

    await signOut([]);
    expect(store.clearCalls).toBe(1);
  });

  test("exposes the cached token over sync IPC", () => {
    installNativeAuth();
    store.saved.push("cached-tok");

    const getToken = ipcSyncHandlers["vellum:auth:getSessionToken"];
    expect(getToken).toBeDefined();
    expect(getToken()).toBe("cached-tok");
  });
});
