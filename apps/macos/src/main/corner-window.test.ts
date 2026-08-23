/**
 * The corner's two load-bearing behaviours.
 *
 *  1. **It never appears unbidden.** With the flag off, the summon does
 *     nothing at all — no window, and no `⌥C` claimed system-wide. `⌥C`
 *     types `ç` in every app that has not bound it, so registering that for
 *     someone who never asked for the feature would take a character away
 *     from them.
 *  2. **The selection is read BEFORE the window is shown.** The summon fires
 *     while the owner's own app is still frontmost, and that is the only
 *     moment their selection can be read. Show first and the read races the
 *     focus change — which fails silently, and quotes the wrong thing.
 *
 * Plus the rule that is easiest to break by accident: **closing cancels
 * nothing.** `esc` reaches `hideCornerWindow`, and if that ever grew an abort
 * "to tidy up", dismissing the panel would become a way to lose work halfway.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Listener = (...args: unknown[]) => void;

interface StubWindow {
  webContents: {
    on: (event: string, listener: Listener) => unknown;
    isDestroyed: () => boolean;
    send: ReturnType<typeof mock>;
  };
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  getBounds: () => Electron.Rectangle;
  on: (event: string, listener: Listener) => StubWindow;
  close: ReturnType<typeof mock>;
  hide: ReturnType<typeof mock>;
  show: ReturnType<typeof mock>;
  focus: ReturnType<typeof mock>;
  showInactive: ReturnType<typeof mock>;
  setPosition: ReturnType<typeof mock>;
  setBounds: ReturnType<typeof mock>;
  setResizable: ReturnType<typeof mock>;
  setAlwaysOnTop: ReturnType<typeof mock>;
  setVisibleOnAllWorkspaces: ReturnType<typeof mock>;
  setIgnoreMouseEvents: ReturnType<typeof mock>;
  loadURL: ReturnType<typeof mock>;
}

const appState = { isPackaged: false, name: "Cue" };
const workArea: Electron.Rectangle = { x: 0, y: 0, width: 1600, height: 900 };

/** Every call the corner makes, in order — the "read before show" assertion. */
const calls: string[] = [];
let visible = false;
const created: StubWindow[] = [];

const makeWindow = (): StubWindow => {
  const bounds: Electron.Rectangle = { x: 0, y: 0, width: 420, height: 320 };
  const listeners = new Map<string, Listener[]>();
  let destroyed = false;
  const win: StubWindow = {
    webContents: {
      on: () => win,
      isDestroyed: () => destroyed,
      send: mock(() => undefined),
    },
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    getBounds: () => bounds,
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return win;
    },
    // Emits "closed" like the real thing, so `floating-window`'s cleanup runs
    // and the singleton is actually released between tests.
    close: mock(() => {
      destroyed = true;
      for (const listener of listeners.get("closed") ?? []) listener();
    }),
    hide: mock(() => {
      calls.push("hide");
      visible = false;
    }),
    show: mock(() => {
      calls.push("show");
      visible = true;
    }),
    focus: mock(() => undefined),
    showInactive: mock(() => undefined),
    setPosition: mock(() => undefined),
    setBounds: mock(() => undefined),
    setResizable: mock(() => undefined),
    setAlwaysOnTop: mock(() => undefined),
    setVisibleOnAllWorkspaces: mock(() => undefined),
    setIgnoreMouseEvents: mock(() => undefined),
    loadURL: mock(() => Promise.resolve()),
  };
  return win;
};

let settingsState: Record<string, unknown> = {};
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

/** What `readSelection` will return, and a record of when it was called. */
let selectionResult: unknown = null;
const readSelectionMock = mock(async () => {
  calls.push("read");
  return selectionResult;
});

mock.module("./logger", () => ({
  default: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

mock.module("electron", () => ({
  app: appState,
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }
    static getAllWindows() {
      return [];
    }
  },
  ipcMain: { handle: mock(() => undefined), on: mock(() => undefined) },
  screen: {
    getPrimaryDisplay: () => ({ workArea }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea }),
    getDisplayMatching: mock(() => ({ workArea })),
  },
}));

mock.module("./windows", () => ({
  createWindow: mock(() => {
    const win = makeWindow();
    created.push(win);
    return win;
  }),
}));

mock.module("./ipc", () => ({
  handle: mock(
    (channel: string, _schema: unknown, fn: (...a: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  ),
  handleSync: mock(() => undefined),
  on: mock(() => undefined),
}));

mock.module("./main-window", () => ({
  current: () => null,
  ensureVisible: mock(async () => undefined),
  dispatchToMain: mock(() => undefined),
}));

mock.module("./settings", () => ({
  readSetting: (key: string) => settingsState[key] ?? null,
  readHotkeyOverride: () => null,
  writeSetting: mock(() => undefined),
  onSettingChange: () => () => {},
}));

mock.module("./window-state", () => ({
  readOnboardingActive: () => false,
  restoreBounds: mock((_key: string, defaults: unknown) => ({
    ...(defaults as object),
  })),
  track: mock(() => undefined),
}));

mock.module("./selection-read", () => ({
  readSelection: readSelectionMock,
}));

/**
 * Stub the screen read too. Without this the corner would reach for the real
 * mac-helper sidecar during a unit test — and, more to the point, the
 * consent gate is what these tests are asserting, not the helper's answer.
 */
const readFrontWindowMock = mock(async () => null);
let consentState: "granted" | "declined" | "unasked" = "unasked";
mock.module("./corner-screen-read", () => ({
  readFrontWindow: readFrontWindowMock,
  screenReadConsent: () => consentState,
  setScreenReadConsent: mock(() => undefined),
  noteSummonAndShouldOffer: mock(() => false),
}));

const {
  __resetForTesting,
  hideCornerWindow,
  installCornerWindow,
  isCornerEnabled,
  summonCorner,
} = await import("./corner-window");

const enable = () => {
  settingsState.featureFlags = { "desktop-corner": true };
};

beforeEach(() => {
  // Close any window a previous test left behind: `floating-window` holds its
  // singletons in a module-level map that `__resetForTesting` cannot reach.
  for (const win of created) win.close();
  __resetForTesting();
  settingsState = {};
  calls.length = 0;
  created.length = 0;
  visible = false;
  selectionResult = null;
  readSelectionMock.mockClear();
  delete process.env.VELLUM_FLAG_DESKTOP_CORNER;
});

afterEach(() => {
  delete process.env.VELLUM_FLAG_DESKTOP_CORNER;
});

describe("it never appears unbidden", () => {
  test("the flag is off by default", () => {
    expect(isCornerEnabled()).toBe(false);
  });

  test("summoning with the flag off does nothing at all", async () => {
    await summonCorner();

    // No window, and — crucially — no selection read either. With the flag
    // off the corner must not so much as touch the pasteboard.
    expect(created).toHaveLength(0);
    expect(readSelectionMock).not.toHaveBeenCalled();
  });

  test("the env override turns it on without a restart", () => {
    process.env.VELLUM_FLAG_DESKTOP_CORNER = "true";
    expect(isCornerEnabled()).toBe(true);
  });

  test("the env override can also force it off over a live flag", () => {
    enable();
    process.env.VELLUM_FLAG_DESKTOP_CORNER = "false";
    expect(isCornerEnabled()).toBe(false);
  });

  test("installing the IPC surface opens no window", () => {
    enable();
    installCornerWindow();
    expect(created).toHaveLength(0);
  });

  test("there is no IPC channel that can open the panel", () => {
    enable();
    installCornerWindow();
    // Rule 4 is kept by there being no other door, not by a check inside one.
    // Every channel here reads, hides, records a consent answer, or hands the
    // exchange to the app. None of them can show the window — the summon is
    // the only opener, and it is bound to the global shortcut.
    expect([...ipcHandlers.keys()].sort()).toEqual([
      "vellum:corner:getContext",
      "vellum:corner:getSelection",
      "vellum:corner:hide",
      "vellum:corner:openInCue",
      "vellum:corner:setScreenReading",
    ]);
  });
});

describe("the selection is read before the window is shown", () => {
  test("read, then show — in that order", async () => {
    enable();
    selectionResult = { text: "some words", wordCount: 2, appName: "Mail" };

    await summonCorner();

    // Showing first would race the read against the focus change, and the
    // failure is silent: the panel opens quoting the wrong thing.
    expect(calls).toEqual(["read", "show"]);
  });

  test("no selection is an ordinary summon, not a failure", async () => {
    enable();
    selectionResult = null;

    await summonCorner();

    expect(created).toHaveLength(1);
    expect(calls).toEqual(["read", "show"]);
  });

  test("the selection reaches the renderer", async () => {
    enable();
    selectionResult = { text: "some words", wordCount: 2, appName: "Mail" };

    await summonCorner();

    expect(created[0]?.webContents.send).toHaveBeenCalledWith(
      "vellum:corner:selection",
      selectionResult,
    );
  });
});

describe("screen-reading is off until asked", () => {
  test("a summon with no consent reads no window", async () => {
    enable();
    await summonCorner();

    // The corner still opens and still has the selection; it simply has no
    // window context, because nobody granted that.
    expect(created).toHaveLength(1);
    const context = (await ipcHandlers.get("vellum:corner:getContext")?.(
      [],
    )) as {
      screen: unknown;
      consent: string;
    };
    expect(context.screen).toBeNull();
    expect(context.consent).toBe("unasked");
  });
});

describe("summoning again dismisses", () => {
  test("a second summon while open closes the panel", async () => {
    enable();
    await summonCorner();
    calls.length = 0;
    readSelectionMock.mockClear();

    await summonCorner();

    // Closing, not re-reading: the same key opens and dismisses, which is
    // what makes it a glance rather than a window to manage.
    expect(calls).toEqual(["hide"]);
    expect(readSelectionMock).not.toHaveBeenCalled();
  });
});

describe("closing cancels nothing", () => {
  test("hide only hides", async () => {
    enable();
    await summonCorner();

    hideCornerWindow();

    // If this ever grows an abort "to tidy up", dismissing the panel becomes
    // a way to lose work halfway — the rule is that anything running keeps
    // running and reports in HQ.
    expect(created[0]?.hide).toHaveBeenCalled();
    expect(created[0]?.close).not.toHaveBeenCalled();
  });

  test("hiding a corner that was never summoned is harmless", () => {
    expect(() => hideCornerWindow()).not.toThrow();
  });
});
