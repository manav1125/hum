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
  showInactive: ReturnType<typeof mock>;
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

const makeWindow = (opts: CreateWindowOptions): StubWindow => {
  const windowListeners = new Map<string, Listener[]>();
  const webContentsListeners = new Map<string, Listener[]>();
  let destroyed = false;
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
    showInactive: mock(() => undefined),
    loadURL: mock((_url: string) => Promise.resolve()),
  };
  return win;
};

const createWindowMock = mock((opts: CreateWindowOptions): StubWindow => {
  const win = makeWindow(opts);
  created.push({ opts, win });
  return win;
});

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
  on: mock(() => undefined),
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
  installCompanionWindow,
  isCompanionEnabled,
  syncCompanionWindow,
  toggleCompanionWindow,
} = await import("./companion-window");
const { geometryFor } = await import("./companion-geometry");
const { setStatus, __resetForTesting: resetStatus } = await import("./status");

const flagOn = (): void => {
  settingsState["featureFlags"] = { "desktop-companion": true };
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
  ensureVisibleMock.mockClear();
  dispatchToMainMock.mockClear();
  writeSettingMock.mockClear();
  restoreBoundsMock.mockClear();
  trackMock.mockClear();
  cursor = { x: 0, y: 0 };
  appState.isPackaged = false;
  process.env.VELLUM_DEV_URL = "http://localhost:4242/assistant/";
  delete process.env.VELLUM_FLAG_DESKTOP_COMPANION;
  __resetForTesting();
  resetStatus();
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
      "vellum:companion:talk",
      "vellum:companion:openCue",
      "vellum:companion:hide",
      "vellum:companion:getStatus",
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
    // Non-activating: shown without focus. The creature must never take the
    // user out of what they are working in.
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
    expect(companionWin()?.setPosition).toHaveBeenLastCalledWith(988, 195);
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
    expect(win.setPosition).toHaveBeenLastCalledWith(807, 74);
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
    // And the canvas goes back the moment the gesture does.
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
    installCompanionWindow();

    expect(ipcHandlers.get("vellum:companion:getState")?.([])).toEqual({
      avatarBox: 66,
      growth: "left",
      cardGrowth: "up",
      hover: false,
    });
  });

  test("getStatus returns the tray's current assistant status", () => {
    flagOn();
    installCompanionWindow();

    expect(ipcHandlers.get("vellum:companion:getStatus")?.([])).toBe("idle");
    setStatus("thinking");
    expect(ipcHandlers.get("vellum:companion:getStatus")?.([])).toBe(
      "thinking",
    );
  });
});

describe("companion status pushes", () => {
  test("pushes the current status once the renderer loads, and on every transition", () => {
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    setStatus("thinking");
    win.webContents.emit("did-finish-load");

    expect(win.webContents.send).toHaveBeenCalledWith(
      "vellum:companion:status",
      "thinking",
    );

    setStatus("idle");
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      "vellum:companion:status",
      "idle",
    );
  });

  test("status transitions with no window are a no-op", () => {
    installCompanionWindow();
    expect(() => setStatus("thinking")).not.toThrow();
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
