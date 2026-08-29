import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Listener = (...args: unknown[]) => void;

type StubWebContents = {
  on: (event: string, listener: Listener) => StubWebContents;
  isDestroyed: () => boolean;
  emit: (event: string, ...args: unknown[]) => void;
  send: ReturnType<typeof mock>;
};

type StubWindow = {
  webContents: StubWebContents;
  isDestroyed: () => boolean;
  getBounds: () => Electron.Rectangle;
  on: (event: string, listener: Listener) => StubWindow;
  emit: (event: string, ...args: unknown[]) => void;
  close: ReturnType<typeof mock>;
  setPosition: ReturnType<typeof mock>;
  setBounds: ReturnType<typeof mock>;
  setResizable: ReturnType<typeof mock>;
  setAlwaysOnTop: ReturnType<typeof mock>;
  setVisibleOnAllWorkspaces: ReturnType<typeof mock>;
  setIgnoreMouseEvents: ReturnType<typeof mock>;
  show: ReturnType<typeof mock>;
  focus: ReturnType<typeof mock>;
  blur: ReturnType<typeof mock>;
  showInactive: ReturnType<typeof mock>;
  isVisible: () => boolean;
  loadURL: ReturnType<typeof mock>;
};

type CreateWindowOptions = {
  browserWindow: Record<string, unknown>;
  navigation: unknown;
};

const appState = { isPackaged: false, name: "Cue" };
const created: Array<{ opts: CreateWindowOptions; win: StubWindow }> = [];
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

const primaryWorkArea: Electron.Rectangle = {
  x: 0,
  y: 0,
  width: 1600,
  height: 900,
};

/**
 * Where the pointer is.
 *
 * Main reads this itself while a drag is held, rather than taking the
 * renderer's word for it — see `companion-drag.ts` for why. Which means these
 * tests move the cursor, not the mouse events.
 */
let cursor = { x: 0, y: 0 };

/** Seconds since the user last touched anything — the nudge gate reads it. */
let idleSeconds = 600;

const makeWindow = (opts: CreateWindowOptions): StubWindow => {
  const windowListeners = new Map<string, Listener[]>();
  const webContentsListeners = new Map<string, Listener[]>();
  let destroyed = false;
  let visible = false;
  let webContentsDestroyed = false;
  const bounds: Electron.Rectangle = {
    x: 0,
    y: 0,
    width: (opts.browserWindow.width as number) ?? 0,
    height: (opts.browserWindow.height as number) ?? 0,
  };

  const webContents: StubWebContents = {
    on: (event, listener) => {
      const listeners = webContentsListeners.get(event) ?? [];
      listeners.push(listener);
      webContentsListeners.set(event, listeners);
      return webContents;
    },
    isDestroyed: () => webContentsDestroyed,
    emit: (event, ...args) => {
      if (event === "destroyed") webContentsDestroyed = true;
      for (const listener of webContentsListeners.get(event) ?? []) {
        listener(...args);
      }
    },
    send: mock(() => undefined),
  };

  const win: StubWindow = {
    webContents,
    isDestroyed: () => destroyed,
    getBounds: () => ({ ...bounds }),
    on: (event, listener) => {
      const listeners = windowListeners.get(event) ?? [];
      listeners.push(listener);
      windowListeners.set(event, listeners);
      return win;
    },
    emit: (event, ...args) => {
      if (event === "closed") destroyed = true;
      for (const listener of windowListeners.get(event) ?? []) {
        listener(...args);
      }
    },
    close: mock(() => {
      win.emit("closed");
    }),
    setPosition: mock((x: number, y: number) => {
      bounds.x = x;
      bounds.y = y;
    }),
    setBounds: mock((next: Partial<Electron.Rectangle>) => {
      Object.assign(bounds, next);
    }),
    setResizable: mock((_resizable: boolean) => undefined),
    setAlwaysOnTop: mock((_flag: boolean, _level: string) => undefined),
    setVisibleOnAllWorkspaces: mock(
      (_visible: boolean, _opts: Record<string, boolean>) => undefined,
    ),
    setIgnoreMouseEvents: mock((_ignore: boolean) => undefined),
    show: mock(() => undefined),
    focus: mock(() => undefined),
    blur: mock(() => undefined),
    showInactive: mock(() => {
      visible = true;
    }),
    isVisible: () => visible,
    loadURL: mock((_url: string) => Promise.resolve()),
  };
  return win;
};

const createWindowMock = mock((opts: CreateWindowOptions): StubWindow => {
  const win = makeWindow(opts);
  created.push({ opts, win });
  return win;
});

/** One-way publishes from the app — `on`, not `handle`. */
const onMock = mock(
  (
    channel: string,
    _schema: unknown,
    fn: (...args: unknown[]) => unknown,
  ) => {
    ipcHandlers.set(channel, fn);
  },
);

const handleMock = mock(
  (
    channel: string,
    _schema: unknown,
    fn: (...args: unknown[]) => unknown,
  ) => {
    ipcHandlers.set(channel, fn);
  },
);

const ensureVisibleMock = mock(async () => undefined);
const dispatchToMainMock = mock((_command: unknown) => undefined);

// Controllable ./settings stand-in. Full surface so the mock — which leaks
// into co-run test files via the global module registry — doesn't break
// sibling modules.
let settingsState: Record<string, unknown> = {};
const settingChangeListeners = new Map<string, Listener[]>();
const writeSettingMock = mock((key: string, value: unknown) => {
  settingsState[key] = value;
});
const fireSettingChange = (key: string): void => {
  for (const listener of settingChangeListeners.get(key) ?? []) {
    listener(settingsState[key], undefined);
  }
};

const restoreBoundsMock = mock(
  (_key: string, defaults: { width: number; height: number }) => ({
    ...defaults,
  }),
);
const trackMock = mock(
  (_key: string, _win: unknown, _shouldPersist?: () => boolean) => undefined,
);

// companion-window → ./status → ./logger → electron-log, which calls
// `app.isReady()` at import time. Stub the logger so the real electron-log
// never loads (the same stub the other main-process suites use).
mock.module("./logger", () => ({
  default: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const menuPopups: Array<Electron.MenuItemConstructorOptions[]> = [];

mock.module("electron", () => ({
  app: appState,
  powerMonitor: { getSystemIdleTime: () => idleSeconds },
  Menu: {
    buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
      menuPopups.push(template);
      return { popup: mock(() => undefined) };
    },
  },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }

    static getAllWindows() {
      return [];
    }
  },
  ipcMain: {
    handle: mock(() => undefined),
    on: mock(() => undefined),
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: primaryWorkArea }),
    getCursorScreenPoint: () => ({ ...cursor }),
    getDisplayNearestPoint: () => ({ workArea: primaryWorkArea }),
    getDisplayMatching: mock((_bounds: Electron.Rectangle) => ({
      workArea: primaryWorkArea,
    })),
    on: mock((_event: string, _listener: Listener) => undefined),
  },
}));

mock.module("./windows", () => ({
  createWindow: createWindowMock,
}));

mock.module("./ipc", () => ({
  handle: handleMock,
  handleSync: mock(() => undefined),
  on: onMock,
}));

mock.module("./main-window", () => ({
  current: () => null,
  ensureVisible: ensureVisibleMock,
  dispatchToMain: dispatchToMainMock,
}));

mock.module("./settings", () => ({
  readSetting: (key: string) => settingsState[key] ?? null,
  readHotkeyOverride: () => null,
  writeSetting: writeSettingMock,
  clearSetting: (key: string) => {
    delete settingsState[key];
  },
  onSettingChange: (key: string, listener: Listener) => {
    const listeners = settingChangeListeners.get(key) ?? [];
    listeners.push(listener);
    settingChangeListeners.set(key, listeners);
    return () => {};
  },
}));

mock.module("./window-state", () => ({
  readOnboardingActive: () => false,
  restoreBounds: restoreBoundsMock,
  track: trackMock,
}));

const {
  __resetForTesting,
  inQuietHours,
  isCompanionVisible,
  nextLocalMidnight,
  runCompanionMenuAction,
  summonCompanionCard,
  installCompanionWindow,
  isCompanionEnabled,
  syncCompanionWindow,
  toggleCompanionWindow,
} = await import("./companion-window");
const { geometryFor } = await import("./companion-geometry");
const { setStatus, __resetForTesting: resetStatus } = await import("./status");

const { setSignedIn, __resetForTesting: resetSession } = await import(
  "./session-state"
);

/**
 * The two preconditions the companion has, together.
 *
 * The session is one of them: the companion is a window onto the same SPA, so
 * opening it signed-out draws the sign-in screen inside a creature-sized
 * canvas. Almost every test here is about what the companion does once it is
 * up, so both are set together — the gate itself has its own tests, which
 * drive the session separately.
 */
const flagOn = (): void => {
  settingsState["featureFlags"] = { "desktop-companion": true };
  setSignedIn(true);
};

const companionWin = (): StubWindow | undefined => created.at(-1)?.win;

beforeEach(() => {
  for (const { win } of created) {
    if (!win.isDestroyed()) win.close();
  }
  created.length = 0;
  ipcHandlers.clear();
  settingsState = {};
  settingChangeListeners.clear();
  createWindowMock.mockClear();
  handleMock.mockClear();
  onMock.mockClear();
  ensureVisibleMock.mockClear();
  dispatchToMainMock.mockClear();
  writeSettingMock.mockClear();
  restoreBoundsMock.mockClear();
  trackMock.mockClear();
  cursor = { x: 0, y: 0 };
  idleSeconds = 600;
  menuPopups.length = 0;
  appState.isPackaged = false;
  process.env.VELLUM_DEV_URL = "http://localhost:4242/assistant/";
  delete process.env.VELLUM_FLAG_DESKTOP_COMPANION;
  __resetForTesting();
  resetStatus();
  resetSession();
});

afterEach(() => {
  for (const { win } of created) {
    if (!win.isDestroyed()) win.close();
  }
  delete process.env.VELLUM_DEV_URL;
  delete process.env.VELLUM_FLAG_DESKTOP_COMPANION;
});

describe("isCompanionEnabled", () => {
  test("defaults off, follows the renderer-published flag map, and yields to the env override in both directions", () => {
    expect(isCompanionEnabled()).toBe(false);

    flagOn();
    expect(isCompanionEnabled()).toBe(true);

    process.env.VELLUM_FLAG_DESKTOP_COMPANION = "off";
    expect(isCompanionEnabled()).toBe(false);

    settingsState["featureFlags"] = {};
    process.env.VELLUM_FLAG_DESKTOP_COMPANION = "1";
    expect(isCompanionEnabled()).toBe(true);
  });
});

describe("installCompanionWindow", () => {
  test("flag off: registers IPC handlers but creates no window (zero footprint)", () => {
    installCompanionWindow();

    expect(handleMock.mock.calls.map((call) => call[0])).toEqual([
      "vellum:companion:setPointerOver",
      "vellum:companion:dragBegin",
      "vellum:companion:dragEnd",
      "vellum:companion:setSize",
      "vellum:companion:getState",
      "vellum:companion:setDrawnRect",
      "vellum:companion:ready",
      "vellum:companion:menu",
      "vellum:companion:introNext",
      "vellum:companion:introDismiss",
      "vellum:companion:nudge",
      "vellum:companion:nudgeOpen",
      "vellum:companion:dragOver",
      "vellum:companion:drop",
      "vellum:companion:dropChoose",
      "vellum:companion:dropRelease",
      "vellum:companion:ask",
      "vellum:companion:publishTurns",
      "vellum:companion:keepAsNote",
      "vellum:companion:openCard",
      "vellum:companion:listening",
      "vellum:companion:closeCard",
      "vellum:companion:nudgeDismiss",
      "vellum:companion:talk",
      "vellum:companion:openCue",
      "vellum:companion:hide",
      "vellum:companion:stop",
    ]);
    expect(created).toHaveLength(0);
  });

  test("flag on: one canvas, sized for the widest state the surface can reach", () => {
    flagOn();
    installCompanionWindow();

    const g = geometryFor("medium");
    expect(created).toHaveLength(1);
    const { opts, win } = created[0]!;
    expect(opts.navigation).toBe("deny-all");
    // Not the creature's box: the canvas has to hold the pill unfurled either
    // way and the card grown, because it must never resize to show one.
    expect(opts.browserWindow).toMatchObject({
      type: "panel",
      width: g.canvasWidth,
      height: g.canvasHeight,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      movable: true,
      hasShadow: false,
      backgroundColor: "#00000000",
    });
    // Non-activating: shown without focus, and only once the page has said it
    // is the companion. The creature must never take the user out of what
    // they are working in — and must never be a sign-in screen.
    ipcHandlers.get("vellum:companion:ready")?.([]);
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "floating");
    expect(win.loadURL.mock.calls[0]?.[0]).toBe(
      "http://localhost:4242/assistant/floating/companion",
    );
  });

  test("REGRESSION: it is transparent to clicks from its very first frame", () => {
    // A window that claims its canvas before anything has been drawn swallows
    // presses meant for whatever is behind it. `forward: true` is the whole
    // technique: moves keep arriving, presses go through.
    flagOn();
    installCompanionWindow();

    expect(companionWin()?.setIgnoreMouseEvents).toHaveBeenCalledWith(true, {
      forward: true,
    });
  });

  test("first run: the creature stands on an edge, below the middle", () => {
    flagOn();
    installCompanionWindow();

    // Right edge of a 1600×900 work area, 62% down: centre (1531, 558). With
    // no room to unfurl rightward the pill grows left, so the canvas is
    // anchored by its right edge — and the card grows up, so the canvas
    // reserves its height above.
    expect(companionWin()?.setPosition).toHaveBeenLastCalledWith(682, 195);
  });

  test("it comes back where it was left, from the centre rather than the bounds", () => {
    // The origin means different things in different corners — the canvas is
    // asymmetric and unfurls whichever way the display allows. The creature's
    // centre means the same thing everywhere.
    flagOn();
    settingsState["companionCentre"] = { x: 69, y: 300 };
    installCompanionWindow();

    expect(companionWin()?.setPosition).toHaveBeenLastCalledWith(0, -63);
  });

  test("respects the persisted hidden choice at startup", () => {
    flagOn();
    settingsState["companionVisible"] = false;
    installCompanionWindow();

    expect(created).toHaveLength(0);
  });

  test("reconciles live when the renderer publishes a flag change", () => {
    installCompanionWindow();
    expect(created).toHaveLength(0);

    flagOn();
    fireSettingChange("featureFlags");
    expect(created).toHaveLength(1);

    settingsState["featureFlags"] = { "desktop-companion": false };
    fireSettingChange("featureFlags");
    expect(companionWin()?.isDestroyed()).toBe(true);
  });
});

describe("the canvas resizes for a size step and nothing else", () => {
  test("REGRESSION: no phase, hover or status change ever resizes the window", () => {
    // The retired companion grew its window from 72×72 to 260×148 to show a
    // card. A window that resizes on every phase change resizes constantly —
    // and it is also what makes real glass impossible, since a vibrancy
    // material fills its window.
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    ipcHandlers.get("vellum:companion:setPointerOver")?.([true]);
    ipcHandlers.get("vellum:companion:setPointerOver")?.([false]);
    setStatus("thinking");
    setStatus("idle");

    expect(win.setBounds).not.toHaveBeenCalled();
  });

  test("a size step resizes once, and does not walk the creature across the desktop", () => {
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    ipcHandlers.get("vellum:companion:setSize")?.(["large"]);

    const g = geometryFor("large");
    expect(win.setBounds).toHaveBeenCalledTimes(1);
    expect(win.setBounds.mock.calls[0]?.[0]).toMatchObject({
      width: g.canvasWidth,
      height: g.canvasHeight,
    });
    // Programmatic resize of a fixed-size panel: unlock, resize, relock.
    expect(win.setResizable.mock.calls.map((call) => call[0])).toEqual([
      true,
      false,
    ]);
    // Same creature, same place — only bigger.
    expect(win.setPosition).toHaveBeenLastCalledWith(399, 74);
    expect(writeSettingMock).toHaveBeenCalledWith("companionCentre", {
      x: 1531,
      y: 558,
    });
  });
});

describe("who owns the clicks", () => {
  test("the canvas is claimed only while the pointer is over something drawn", () => {
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    ipcHandlers.get("vellum:companion:setPointerOver")?.([true]);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);

    ipcHandlers.get("vellum:companion:setPointerOver")?.([false]);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, {
      forward: true,
    });
  });

  test("REGRESSION: a hover report during a drag cannot hand the canvas back", () => {
    // The renderer's idea of where the pointer is is exactly what a drag
    // outruns. Acting on it mid-gesture would drop the window out from under
    // the hand that is holding it.
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    cursor = { x: 1531, y: 558 };
    ipcHandlers.get("vellum:companion:dragBegin")?.([]);
    win.setIgnoreMouseEvents.mockClear();
    ipcHandlers.get("vellum:companion:setPointerOver")?.([false]);

    expect(win.setIgnoreMouseEvents).not.toHaveBeenCalled();
  });
});

describe("the drag", () => {
  test("the creature follows the cursor, which main reads itself", async () => {
    // Not the renderer's coordinates: a fast drag outruns a window moved one
    // IPC message at a time, so by the time a renderer event arrives it
    // describes where the pointer used to be.
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    cursor = { x: 1531, y: 558 };
    ipcHandlers.get("vellum:companion:dragBegin")?.([]);
    cursor = { x: 400, y: 300 };
    await Bun.sleep(60);

    expect(win.setPosition).toHaveBeenLastCalledWith(331, -63);
  });

  test("it settles on the nearest edge, and that is what persists", async () => {
    // `C8`: a creature mid-desktop is furniture; on an edge it is a companion.
    flagOn();
    installCompanionWindow();

    cursor = { x: 1531, y: 558 };
    ipcHandlers.get("vellum:companion:dragBegin")?.([]);
    cursor = { x: 400, y: 300 };
    await Bun.sleep(60);
    ipcHandlers.get("vellum:companion:dragEnd")?.([]);

    expect(writeSettingMock).toHaveBeenLastCalledWith("companionCentre", {
      x: 69,
      y: 300,
    });
  });

  test("REGRESSION: a drag that ends over another application still ends", async () => {
    // The button comes up somewhere the page is not — routinely, because the
    // window cannot keep up with the hand. A press that never ends leaves the
    // window claiming a canvas many times the size of the creature, swallowing
    // clicks meant for other applications (upstream `56405459`).
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    cursor = { x: 1531, y: 558 };
    ipcHandlers.get("vellum:companion:dragBegin")?.([]);
    cursor = { x: 1800, y: 20 };
    await Bun.sleep(60);
    ipcHandlers.get("vellum:companion:dragEnd")?.([]);

    expect(writeSettingMock).toHaveBeenLastCalledWith("companionCentre", {
      x: 1531,
      y: 69,
    });
    // The gesture is over — the press is not outstanding any more. The canvas
    // stays claimed only because the pointer is still on the creature it just
    // dropped; handing it back there would make the creature unclickable the
    // instant you let go. Move away and it goes back.
    cursor = { x: 200, y: 800 };
    await Bun.sleep(160);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, {
      forward: true,
    });
  });

  test("REGRESSION: losing the window mid-gesture ends the press", async () => {
    // Blur and teardown are not mouse-ups, but they end the gesture all the
    // same — otherwise the cursor poll outlives the window it was moving.
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    cursor = { x: 1531, y: 558 };
    ipcHandlers.get("vellum:companion:dragBegin")?.([]);
    win.emit("blur");
    win.setPosition.mockClear();
    cursor = { x: 200, y: 200 };
    await Bun.sleep(60);

    expect(win.setPosition).not.toHaveBeenCalled();
  });
});

describe("companion IPC", () => {
  test("talk surfaces the main window then dispatches openVoice", async () => {
    flagOn();
    installCompanionWindow();

    await ipcHandlers.get("vellum:companion:talk")?.([]);

    expect(ensureVisibleMock).toHaveBeenCalledTimes(1);
    expect(dispatchToMainMock).toHaveBeenCalledWith({ kind: "openVoice" });
  });

  test("openCue surfaces the main window without dispatching a command", async () => {
    flagOn();
    installCompanionWindow();

    await ipcHandlers.get("vellum:companion:openCue")?.([]);

    expect(ensureVisibleMock).toHaveBeenCalledTimes(1);
    expect(dispatchToMainMock).not.toHaveBeenCalled();
  });

  test("hide persists companionVisible=false and closes the window", () => {
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    ipcHandlers.get("vellum:companion:hide")?.([]);

    expect(writeSettingMock).toHaveBeenCalledWith("companionVisible", false);
    expect(win.isDestroyed()).toBe(true);
  });

  test("getState answers with the geometry main owns", () => {
    flagOn();
    // Seen already, so the introduction is not part of what is being asserted
    // here — it has its own tests.
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();

    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toEqual({
      phase: "resting",
      avatarBox: 66,
      growth: "left",
      cardGrowth: "up",
      // Character travels with the geometry: they change for the same reasons,
      // and a renderer holding half an update draws a creature main does not
      // believe in.
      blink: "calm",
      weight: "regular",
      quiet: false,
    });
  });

  test("a run in progress reaches the creature as a phase, not a status", () => {
    // There is no companion status channel any more: main resolves whose turn
    // it is against everything else it knows and publishes one phase.
    flagOn();
    installCompanionWindow();

    setStatus("thinking");
    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "working",
    });

    setStatus("idle");
    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "resting",
    });
  });
});

describe("an approval raises the app, and the creature only badges (C6, C9)", () => {
  const signal = async (patch: Record<string, unknown>): Promise<void> => {
    await ipcHandlers.get("vellum:companion:signals")?.([patch]);
  };

  test("the first raise opens the app and names the protocol, once", async () => {
    flagOn();
    installCompanionWindow();

    await signal({ awaitingApproval: true });

    // Upstream's rule, adopted: an approval nobody can reach is the failure,
    // and a window in front of you is the bluntest possible fix.
    expect(ensureVisibleMock).toHaveBeenCalledTimes(1);
    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "waiting",
      line: "That needs your okay, so I've opened the app — I'll always bring you there for anything that acts.",
      detail: "I never approve things from here.",
    });
    expect(writeSettingMock).toHaveBeenCalledWith(
      "companionApprovalExplained",
      true,
    );
  });

  test("REGRESSION: the long line is not swapped out from under the reader", async () => {
    // The flag is persisted the moment the app is raised, but feeding it back
    // into the store there would shorten the sentence while it is on screen.
    flagOn();
    installCompanionWindow();

    await signal({ awaitingApproval: true });
    await signal({ hover: true });

    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      line: "That needs your okay, so I've opened the app — I'll always bring you there for anything that acts.",
    });
  });

  test("every raise after it is the short line", async () => {
    flagOn();
    installCompanionWindow();

    await signal({ awaitingApproval: true });
    await signal({ awaitingApproval: false });
    await signal({ awaitingApproval: true });

    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      line: "That one needs your okay — I've raised the window.",
    });
  });

  test("an approval that stays open does not re-raise the app on every signal", async () => {
    flagOn();
    installCompanionWindow();

    await signal({ awaitingApproval: true });
    await signal({ awaitingApproval: true });
    await signal({ online: true });

    expect(ensureVisibleMock).toHaveBeenCalledTimes(1);
  });
});

describe("the introduction, and the canvas it has to hand back (C4)", () => {
  test("it is offered to somebody who has not seen it", () => {
    flagOn();
    installCompanionWindow();

    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      intro: { beat: 0, title: "I'm Cue." },
    });
  });

  test("it is never offered again once it has been seen", () => {
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();

    expect(
      (ipcHandlers.get("vellum:companion:getState")?.([]) as Record<
        string,
        unknown
      >).intro,
    ).toBeUndefined();
  });

  test("REGRESSION: it never covers something that is happening", async () => {
    // The one card Cue shows without being asked, so it yields to whatever
    // the user is actually in the middle of.
    flagOn();
    installCompanionWindow();
    await ipcHandlers.get("vellum:companion:signals")?.([
      { recording: { label: "Standup", elapsed: "00:12" } },
    ]);

    expect(
      (ipcHandlers.get("vellum:companion:getState")?.([]) as Record<
        string,
        unknown
      >).intro,
    ).toBeUndefined();
  });

  test("REGRESSION: dismissing hands the canvas back", () => {
    // Removing a card from under a stationary pointer is followed by no
    // mouse-move, so nothing recomputes the hit-test on its own and the
    // window keeps claiming a canvas many times the size of the creature.
    // Upstream shipped this leak in exactly this card (`64e3eead`).
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    ipcHandlers.get("vellum:companion:setPointerOver")?.([true]);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);

    ipcHandlers.get("vellum:companion:introDismiss")?.([]);

    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, {
      forward: true,
    });
    expect(writeSettingMock).toHaveBeenCalledWith("companionIntroSeen", true);
  });

  test("advancing hands it back too — the card shrinks under the pointer", () => {
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    ipcHandlers.get("vellum:companion:setPointerOver")?.([true]);
    ipcHandlers.get("vellum:companion:introNext")?.([0]);

    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, {
      forward: true,
    });
  });

  test("a stale press changes nothing, and republishes nothing", () => {
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    ipcHandlers.get("vellum:companion:introNext")?.([0]);
    win.webContents.send.mockClear();
    ipcHandlers.get("vellum:companion:introNext")?.([0]);

    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});

describe("the nudge answers whether it took the interruption (C7)", () => {
  const offer = (patch: Record<string, unknown> = {}) =>
    ipcHandlers.get("vellum:companion:nudge")?.([
      {
        itemId: "i1",
        line: "Dana replied on pricing",
        source: "needs-you",
        ...patch,
      },
    ]);

  test("a taken nudge says so, so the caller does not also push", () => {
    // The budget is shared: a nudge replaces the notification rather than
    // doubling it, which only works if one side decides.
    flagOn();
    installCompanionWindow();

    expect(offer()).toEqual({ allowed: true });
    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "nudge",
      line: "Dana replied on pricing",
    });
  });

  test("a refusal names its reason, so the caller can push instead", () => {
    flagOn();
    installCompanionWindow();

    expect(offer({ source: "run-finished" })).toEqual({
      allowed: false,
      reason: "source",
    });
  });

  test("REGRESSION: it does not interrupt somebody who is mid-something", () => {
    flagOn();
    installCompanionWindow();
    idleSeconds = 0;

    expect(offer()).toEqual({ allowed: false, reason: "typing" });
  });

  test("never during quiet hours", () => {
    flagOn();
    settingsState["companionQuietHours"] = { start: "00:00", end: "23:59" };
    installCompanionWindow();

    expect(offer()).toEqual({ allowed: false, reason: "quiet" });
  });

  test("with no creature on screen there is nothing to nudge from", () => {
    installCompanionWindow();
    expect(offer()).toEqual({ allowed: false, reason: "hidden" });
  });

  test("✕ teaches the valve and hands the canvas back", () => {
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;
    offer();

    ipcHandlers.get("vellum:companion:setPointerOver")?.([true]);
    ipcHandlers.get("vellum:companion:nudgeDismiss")?.([]);

    expect(dispatchToMainMock).toHaveBeenCalledWith({
      kind: "nudgeDismissed",
      itemId: "i1",
    });
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, {
      forward: true,
    });
  });

  test("Open hands the item to the app, and acts on nothing itself", async () => {
    flagOn();
    installCompanionWindow();
    offer();

    await ipcHandlers.get("vellum:companion:nudgeOpen")?.([]);

    expect(ensureVisibleMock).toHaveBeenCalledTimes(1);
    expect(dispatchToMainMock).toHaveBeenLastCalledWith({
      kind: "openNeedsYouItem",
      itemId: "i1",
    });
  });
});

describe("main hit-tests the cursor against what was actually drawn", () => {
  const rect = (r: Record<string, number>) =>
    ipcHandlers.get("vellum:companion:setDrawnRect")?.([r]);

  test("REGRESSION: the pill becomes clickable, not just the creature's box", async () => {
    // The renderer used to answer this from its own `mousemove`, which a
    // click-through non-activating panel may never receive — leaving the
    // introduction drawn, visible, and dead to every click. Main can always
    // read the cursor, so main does the test.
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();
    const win = companionWin()!;
    ipcHandlers.get("vellum:companion:ready")?.([]);
    win.setIgnoreMouseEvents.mockClear();

    // The window sits at (682, 195); a card drawn across its left half.
    rect({ x: 10, y: 10, width: 300, height: 120 });
    cursor = { x: 682 + 150, y: 195 + 60 };
    await Bun.sleep(160);

    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });

  test("and hands the canvas back outside it", async () => {
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();
    const win = companionWin()!;
    ipcHandlers.get("vellum:companion:ready")?.([]);

    rect({ x: 10, y: 10, width: 300, height: 120 });
    cursor = { x: 682 + 150, y: 195 + 60 };
    await Bun.sleep(160);
    cursor = { x: 682 + 500, y: 195 + 400 };
    await Bun.sleep(160);

    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, {
      forward: true,
    });
  });

  test("hover is published from the same test, so the surface can react", async () => {
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();
    ipcHandlers.get("vellum:companion:ready")?.([]);

    rect({ x: 10, y: 10, width: 300, height: 120 });
    cursor = { x: 682 + 150, y: 195 + 60 };
    await Bun.sleep(160);

    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "hover",
    });
  });

  test("before any rectangle is reported, the creature's own box still works", async () => {
    // Otherwise a window that is click-through everywhere cannot even be
    // picked up and moved.
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();
    const win = companionWin()!;
    ipcHandlers.get("vellum:companion:ready")?.([]);
    win.setIgnoreMouseEvents.mockClear();

    cursor = { x: 1531, y: 558 };
    await Bun.sleep(160);

    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });
});

describe("drops, and the click-through window that has to receive them (C10)", () => {
  test("REGRESSION: main claims the canvas for the creature's own box", async () => {
    // The renderer learns where the pointer is from forwarded mouse-move, and
    // a NATIVE drag does not forward one — the window is click-through, so the
    // OS never offers it the drag and it can never become a drop target. Main
    // can answer for the creature's box without any of that, because it knows
    // the box and the cursor in the same coordinates.
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();
    const win = companionWin()!;
    win.setIgnoreMouseEvents.mockClear();

    // The creature's first-run home, with no renderer report at all.
    cursor = { x: 1531, y: 558 };
    await Bun.sleep(200);

    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });

  test("and hands it back when the cursor leaves", async () => {
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();
    const win = companionWin()!;

    cursor = { x: 1531, y: 558 };
    await Bun.sleep(200);
    cursor = { x: 200, y: 200 };
    await Bun.sleep(200);

    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, {
      forward: true,
    });
  });

  test("REGRESSION: the renderer saying no does not override main saying yes", async () => {
    // Two authorities that could contradict each other would flap. They are
    // OR-ed: either side saying the pointer is on something claims the canvas.
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();
    const win = companionWin()!;

    cursor = { x: 1531, y: 558 };
    await Bun.sleep(200);
    ipcHandlers.get("vellum:companion:setPointerOver")?.([false]);

    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });

  test("a drag opens the arc without becoming a phase", () => {
    // The arc opening is a thing the creature does, so it works in the middle
    // of whatever else is true — including a recording, whose evidence
    // nothing may cover.
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();

    ipcHandlers.get("vellum:companion:dragOver")?.([true]);
    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      opening: true,
      phase: "resting",
    });
  });

  test("a drop is held and named, and nothing is dispatched yet", () => {
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();

    ipcHandlers.get("vellum:companion:drop")?.([
      { kind: "file", value: "/Users/x/acme-msa-v4.pdf" },
    ]);

    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "caught",
      caught: { kind: "file", label: "acme-msa-v4.pdf" },
    });
    // Nothing is stored until a choice is made.
    expect(dispatchToMainMock).not.toHaveBeenCalled();
  });

  test("a choice hands it to the app, untouched", async () => {
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();

    ipcHandlers.get("vellum:companion:drop")?.([
      { kind: "file", value: "/Users/x/acme-msa-v4.pdf" },
    ]);
    ipcHandlers.get("vellum:companion:dropChoose")?.(["file"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatchToMainMock).toHaveBeenLastCalledWith({
      kind: "handleDrop",
      choice: "file",
      dropKind: "file",
      label: "acme-msa-v4.pdf",
      payload: "/Users/x/acme-msa-v4.pdf",
    });
  });

  test("letting go stores nothing and leaves no phase behind", () => {
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();

    ipcHandlers.get("vellum:companion:drop")?.([
      { kind: "url", value: "https://example.com/x" },
    ]);
    ipcHandlers.get("vellum:companion:dropRelease")?.([]);

    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "resting",
    });
    expect(dispatchToMainMock).not.toHaveBeenCalled();
  });
});

describe("the summon, and the card's two verbs (C12, C2)", () => {
  test("REGRESSION: pressing it twice closes what it opened", async () => {
    // A summon that only opens is a summon you have to reach for the mouse to
    // undo, which is the opposite of a pointer-free path.
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();

    summonCompanionCard();
    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "typing",
    });

    summonCompanionCard();
    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "resting",
    });
  });

  test("REGRESSION: the card took the keyboard, and gave it back", async () => {
    // A window shown with `showInactive()` is never key, and a window that is
    // never key receives no keystroke. So the summon opened a card with an
    // autofocused text field that could not be typed into — the field had
    // focus inside a window that had none.
    //
    // `type: "panel"` is what makes taking them safe: measured on Electron 42,
    // a panel's `focus()` takes key status while the frontmost application is
    // unchanged. Giving them back matters just as much — a resting creature
    // holding the keyboard would swallow every shortcut of whatever is
    // underneath it.
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();
    const win = created.at(-1)!.win;
    ipcHandlers.get("vellum:companion:ready")?.([]);
    expect(win.focus).not.toHaveBeenCalled();

    summonCompanionCard();
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.blur).not.toHaveBeenCalled();

    summonCompanionCard();
    expect(win.blur).toHaveBeenCalledTimes(1);
    // And not once more per republish: the transitions are applied on the
    // change, not on every push.
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  test("REGRESSION: it brings a hidden companion back", async () => {
    // The guard used to refuse when hidden, directly under a comment claiming
    // it did the opposite — so hiding the creature made the one key that
    // brings it back do nothing, and the menu bar became the only way in.
    // That is the corner a keyboard path exists to avoid.
    flagOn();
    settingsState["companionIntroSeen"] = true;
    settingsState["companionVisible"] = false;
    installCompanionWindow();
    expect(created).toHaveLength(0);

    summonCompanionCard();

    expect(writeSettingMock).toHaveBeenCalledWith("companionVisible", true);
    expect(created).toHaveLength(1);
  });

  test("and clears a hide-until-tomorrow while it is at it", () => {
    flagOn();
    settingsState["companionIntroSeen"] = true;
    settingsState["companionHiddenUntil"] = new Date(
      Date.now() + 60_000,
    ).toISOString();
    installCompanionWindow();
    expect(created).toHaveLength(0);

    summonCompanionCard();
    expect(created).toHaveLength(1);
  });

  test("it does nothing at all when the companion is off", () => {
    installCompanionWindow();
    expect(() => summonCompanionCard()).not.toThrow();
    expect(created).toHaveLength(0);
  });

  test("↵ asks into the conversation, and the card stays open", async () => {
    // It used to close the card and raise the app on a NEW draft conversation
    // for every message, which is what made a second exchange impossible: the
    // answer landed in a window you had just been thrown into, and the card
    // that asked was gone.
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();
    summonCompanionCard();

    await ipcHandlers.get("vellum:companion:ask")?.(["when does Acme renew?"]);

    expect(dispatchToMainMock).toHaveBeenLastCalledWith({
      kind: "companionAsk",
      message: "when does Acme renew?",
    });
    // Still the card, and now visibly waiting for the reply.
    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "typing",
      thinking: true,
    });
  });

  test("the app's window publishes the conversation tail through main", async () => {
    // Only that window owns a conversation and only main may publish to the
    // companion, so this relay is the seam between them.
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();
    summonCompanionCard();

    await ipcHandlers.get("vellum:companion:publishTurns")?.([
      [
        { role: "user", text: "what did I miss" },
        { role: "assistant", text: "two things from Priya" },
      ],
      false,
    ]);

    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      turns: [
        { role: "user", text: "what did I miss" },
        { role: "assistant", text: "two things from Priya" },
      ],
    });
  });

  test("⌘↵ sends what was typed to Notes, with the text", async () => {
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();

    await ipcHandlers.get("vellum:companion:keepAsNote")?.([
      "  Dana is out Thursday  ",
    ]);

    // Trimmed here so the app never has to wonder whether whitespace was
    // meant.
    expect(dispatchToMainMock).toHaveBeenLastCalledWith({
      kind: "newNote",
      text: "Dana is out Thursday",
    });
  });

  test("REGRESSION: an empty ask opens nothing", async () => {
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();

    await ipcHandlers.get("vellum:companion:ask")?.(["   "]);

    expect(ensureVisibleMock).not.toHaveBeenCalled();
    expect(dispatchToMainMock).not.toHaveBeenCalled();
  });

  test("esc closes the card and cancels nothing", () => {
    flagOn();
    settingsState["companionIntroSeen"] = true;
    installCompanionWindow();
    summonCompanionCard();

    ipcHandlers.get("vellum:companion:closeCard")?.([]);

    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "resting",
    });
    expect(dispatchToMainMock).not.toHaveBeenCalled();
  });
});

describe("the right-click menu is native, and main's (C5)", () => {
  test("popping it builds the template from what is actually persisted", () => {
    flagOn();
    settingsState["companionSize"] = "large";
    installCompanionWindow();

    ipcHandlers.get("vellum:companion:menu")?.([]);

    const template = menuPopups.at(-1)!;
    const labels = template.map((i) => i.label).filter(Boolean);
    // Native rather than drawn: the menu is routinely taller than the
    // creature, and a drawn one would have to grow the canvas to hold it.
    expect(labels).toContain("Hide Cue");
    expect(template.find((i) => i.label === "Size")?.sublabel).toBe("large");
  });
});

describe("a live capture cannot be hidden, and Stop stops the real one (C11)", () => {
  const record = async (): Promise<void> => {
    await ipcHandlers.get("vellum:companion:signals")?.([
      { recording: { label: "Board prep", elapsed: "12:41" } },
    ]);
  };

  test("REGRESSION: hiding is refused while audio is being kept", async () => {
    // The creature is the only always-visible evidence that a recording is
    // running. Hiding it would leave the capture live with nothing on screen
    // to admit it.
    flagOn();
    installCompanionWindow();
    await record();

    await runCompanionMenuAction({ kind: "hide" });
    ipcHandlers.get("vellum:companion:hide")?.([]);

    expect(companionWin()?.isDestroyed()).toBe(false);
    expect(writeSettingMock).not.toHaveBeenCalledWith(
      "companionVisible",
      false,
    );
  });

  test("nor tucked away until tomorrow", async () => {
    flagOn();
    installCompanionWindow();
    await record();

    await runCompanionMenuAction({ kind: "hideUntilTomorrow" });

    expect(settingsState["companionHiddenUntil"]).toBeUndefined();
    expect(companionWin()?.isDestroyed()).toBe(false);
  });

  test("the same rule holds while a window is being read", async () => {
    flagOn();
    installCompanionWindow();
    await ipcHandlers.get("vellum:companion:signals")?.([{ watching: true }]);

    await runCompanionMenuAction({ kind: "hide" });
    expect(companionWin()?.isDestroyed()).toBe(false);
  });

  test("stopped, it can be hidden again", async () => {
    flagOn();
    installCompanionWindow();
    await record();
    await ipcHandlers.get("vellum:companion:signals")?.([{ recording: null }]);

    await runCompanionMenuAction({ kind: "hide" });
    expect(companionWin()?.isDestroyed()).toBe(true);
  });

  test("REGRESSION: Stop stops the session, not the picture of it", async () => {
    // A Stop that only cleared the mirror would be the worst button in the
    // product: it looks like it worked, and the microphone is still on. So it
    // asks the app, and the creature keeps saying "recording" until the app
    // says otherwise.
    flagOn();
    installCompanionWindow();
    await record();

    await ipcHandlers.get("vellum:companion:stop")?.([]);

    expect(dispatchToMainMock).toHaveBeenLastCalledWith({
      kind: "stopCapture",
      capture: "recording",
    });
    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toMatchObject({
      phase: "recording",
    });
  });

  test("REGRESSION: Stop with no capture cancels the run, and never opens voice", async () => {
    // It used to be wired to "talk to Cue", so Stop on a recording opened the
    // voice surface and left the microphone running.
    flagOn();
    installCompanionWindow();

    await ipcHandlers.get("vellum:companion:stop")?.([]);

    expect(dispatchToMainMock).toHaveBeenLastCalledWith({
      kind: "cancelActiveAction",
    });
    expect(dispatchToMainMock).not.toHaveBeenCalledWith({ kind: "openVoice" });
  });
});

describe("quiet hours, and the window that crosses midnight (C5)", () => {
  const hours = { start: "22:00", end: "07:30" };

  test("inside the evening half", () => {
    expect(inQuietHours(hours, new Date(2026, 7, 25, 23, 15))).toBe(true);
  });

  test("REGRESSION: inside the morning half, on the other side of midnight", () => {
    // The default range wraps, and the naive `start <= now && now < end`
    // comparison is false for every single minute of it.
    expect(inQuietHours(hours, new Date(2026, 7, 25, 6, 0))).toBe(true);
  });

  test("outside it, in the middle of the working day", () => {
    expect(inQuietHours(hours, new Date(2026, 7, 25, 14, 0))).toBe(false);
  });

  test("a range that does not wrap still behaves", () => {
    const lunch = { start: "12:00", end: "13:00" };
    expect(inQuietHours(lunch, new Date(2026, 7, 25, 12, 30))).toBe(true);
    expect(inQuietHours(lunch, new Date(2026, 7, 25, 13, 30))).toBe(false);
  });

  test("off is off — never a guessed range", () => {
    expect(inQuietHours(null, new Date(2026, 7, 25, 23, 59))).toBe(false);
  });
});

describe("asking an uninvited guest to leave (C5)", () => {
  test("hide until tomorrow is stored as when it comes back, not as a flag", async () => {
    // A flag needs something to clear it, and that something is exactly what
    // does not run when the app was closed all evening.
    flagOn();
    installCompanionWindow();

    await runCompanionMenuAction({ kind: "hideUntilTomorrow" });

    const stored = settingsState["companionHiddenUntil"] as string;
    expect(Date.parse(stored)).toBe(nextLocalMidnight().getTime());
    expect(companionWin()?.isDestroyed()).toBe(true);
  });

  test("it comes back on its own once the moment has passed", () => {
    settingsState["companionHiddenUntil"] = new Date(
      Date.now() - 1000,
    ).toISOString();
    expect(isCompanionVisible()).toBe(true);
  });

  test("an explicit hide outlives tomorrow", () => {
    settingsState["companionVisible"] = false;
    settingsState["companionHiddenUntil"] = new Date(
      Date.now() - 1000,
    ).toISOString();
    expect(isCompanionVisible()).toBe(false);
  });

  test("hiding needs no confirmation and closes at once", async () => {
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    await runCompanionMenuAction({ kind: "hide" });

    expect(writeSettingMock).toHaveBeenCalledWith("companionVisible", false);
    expect(win.isDestroyed()).toBe(true);
  });
});

describe("nothing is shown until the page says it is the companion", () => {
  test("REGRESSION: the window is created hidden", () => {
    // Main cannot tell what the SPA will render for a route. While the app is
    // not connected every route becomes a sign-in screen — and 1.3.0 and
    // 1.3.1 both put that screen on screen in a canvas shaped for a creature.
    flagOn();
    installCompanionWindow();

    expect(companionWin()?.showInactive).not.toHaveBeenCalled();
    expect(companionWin()?.isVisible()).toBe(false);
  });

  test("the page saying so is what shows it", () => {
    flagOn();
    installCompanionWindow();

    ipcHandlers.get("vellum:companion:ready")?.([]);

    expect(companionWin()?.showInactive).toHaveBeenCalledTimes(1);
    expect(companionWin()?.isVisible()).toBe(true);
  });

  test("REGRESSION: a route that rendered something else is closed unseen", async () => {
    // No ready signal ever arrives, because `CompanionPage` never mounted.
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    await Bun.sleep(30);
    expect(win.isDestroyed()).toBe(false); // still within the grace period

    // The real timeout is 12s; assert the mechanism rather than the wait.
    expect(win.showInactive).not.toHaveBeenCalled();
  });

  test("signing in again does not double-show an already visible creature", () => {
    flagOn();
    installCompanionWindow();
    ipcHandlers.get("vellum:companion:ready")?.([]);
    ipcHandlers.get("vellum:companion:ready")?.([]);

    expect(companionWin()?.showInactive).toHaveBeenCalledTimes(1);
  });
});

describe("it does not appear before there is a session", () => {
  test("REGRESSION: signed out, the flag alone opens nothing", () => {
    // Shipped in 1.3.0: the companion is a window onto the same SPA, so
    // opening it signed-out rendered the WELCOME screen inside a canvas sized
    // for a creature — a second sign-in window beside the real one. And
    // because it loaded signed-out it stayed that way; nothing reloaded it
    // when the session arrived.
    settingsState["featureFlags"] = { "desktop-companion": true };
    installCompanionWindow();

    expect(created).toHaveLength(0);
  });

  test("signing in is what brings the creature out", () => {
    settingsState["featureFlags"] = { "desktop-companion": true };
    installCompanionWindow();
    expect(created).toHaveLength(0);

    setSignedIn(true);
    expect(created).toHaveLength(1);
  });

  test("signing out takes it away rather than leaving it floating", () => {
    flagOn();
    installCompanionWindow();
    expect(created).toHaveLength(1);

    setSignedIn(false);
    expect(companionWin()?.isDestroyed()).toBe(true);
  });

  test("REGRESSION: republishing the same session does not reopen it", () => {
    // The renderer publishes on every mount. A surface that reopened on each
    // of those would flicker.
    flagOn();
    installCompanionWindow();
    setSignedIn(true);
    setSignedIn(true);

    expect(created).toHaveLength(1);
  });
});

describe("syncCompanionWindow", () => {
  test("is idempotent while the window is open", () => {
    flagOn();
    installCompanionWindow();
    syncCompanionWindow();
    syncCompanionWindow();

    expect(created).toHaveLength(1);
  });
});
