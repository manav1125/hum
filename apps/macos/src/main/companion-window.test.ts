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
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: primaryWorkArea }),
    getDisplayMatching: mock((_bounds: Electron.Rectangle) => ({
      workArea: primaryWorkArea,
    })),
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
  COMPANION_COLLAPSED_SIZE,
  COMPANION_EXPANDED_SIZE,
  installCompanionWindow,
  isCompanionEnabled,
  syncCompanionWindow,
  toggleCompanionWindow,
} = await import("./companion-window");
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
      "vellum:companion:setExpanded",
      "vellum:companion:talk",
      "vellum:companion:openCue",
      "vellum:companion:hide",
      "vellum:companion:getStatus",
    ]);
    expect(created).toHaveLength(0);
  });

  test("flag on: opens the collapsed non-activating panel at the corner default and loads the companion route", () => {
    flagOn();
    installCompanionWindow();

    expect(created).toHaveLength(1);
    const { opts, win } = created[0]!;
    expect(opts.navigation).toBe("deny-all");
    expect(opts.browserWindow).toMatchObject({
      type: "panel",
      width: COMPANION_COLLAPSED_SIZE.width,
      height: COMPANION_COLLAPSED_SIZE.height,
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
    // Non-activating: shown without focus.
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "floating");
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    // Bottom-right of the 1600×900 work area, 24px margin.
    expect(win.setPosition).toHaveBeenCalledWith(1504, 804);
    expect(win.loadURL.mock.calls[0]?.[0]).toBe(
      "http://localhost:4242/assistant/floating/companion",
    );
    // Collapsed position persists under its own window-state key.
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock.mock.calls[0]?.[0]).toBe("companion");
  });

  test("restores a previously saved position over the corner default", () => {
    flagOn();
    restoreBoundsMock.mockImplementationOnce(
      (_key: string, defaults: { width: number; height: number }) => ({
        ...defaults,
        x: 100,
        y: 120,
      }),
    );
    installCompanionWindow();

    expect(companionWin()?.setPosition).toHaveBeenCalledWith(100, 120);
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

describe("toggleCompanionWindow", () => {
  test("hides an open companion and persists the choice; toggling again re-opens", () => {
    flagOn();
    installCompanionWindow();
    const first = companionWin()!;

    toggleCompanionWindow();
    expect(writeSettingMock).toHaveBeenLastCalledWith(
      "companionVisible",
      false,
    );
    expect(first.isDestroyed()).toBe(true);

    toggleCompanionWindow();
    expect(writeSettingMock).toHaveBeenLastCalledWith("companionVisible", true);
    expect(created).toHaveLength(2);
  });
});

describe("companion IPC", () => {
  test("setExpanded grows the panel anchored to its bottom-right corner, then collapses back", () => {
    flagOn();
    installCompanionWindow();
    const win = companionWin()!;

    ipcHandlers.get("vellum:companion:setExpanded")?.([true]);

    // 1504+72−260 = 1316, 804+72−148 = 728 — bottom-right corner pinned.
    expect(win.setBounds).toHaveBeenLastCalledWith({
      x: 1316,
      y: 728,
      width: COMPANION_EXPANDED_SIZE.width,
      height: COMPANION_EXPANDED_SIZE.height,
    });
    // Programmatic resize of a fixed-size panel: unlock, resize, relock.
    expect(win.setResizable.mock.calls.map((call) => call[0])).toEqual([
      true,
      false,
    ]);

    ipcHandlers.get("vellum:companion:setExpanded")?.([false]);
    expect(win.setBounds).toHaveBeenLastCalledWith({
      x: 1504,
      y: 804,
      width: COMPANION_COLLAPSED_SIZE.width,
      height: COMPANION_COLLAPSED_SIZE.height,
    });
  });

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

    expect(writeSettingMock).toHaveBeenLastCalledWith(
      "companionVisible",
      false,
    );
    expect(win.isDestroyed()).toBe(true);
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
