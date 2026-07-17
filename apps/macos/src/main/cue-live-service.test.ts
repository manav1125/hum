import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { FakeChild } from "./test-helpers";

class FakeHelperChild extends FakeChild {
  stdin = {
    writes: [] as string[],
    ended: false,
    // The real stdin is a Writable stream. mac-helper's attachChild subscribes
    // to its "error" event, and writeFrame reads these state flags before
    // writing — the fake must expose them or attachChild throws (which would
    // tear down startup and drop the first write).
    destroyed: false,
    writableEnded: false,
    on: mock(() => undefined),
    write: mock((data: string, callback?: (err?: Error) => void) => {
      this.stdin.writes.push(data);
      callback?.();
      return true;
    }),
    end: mock(() => {
      this.stdin.ended = true;
      this.stdin.writableEnded = true;
    }),
  };
  kill = mock(() => true);
}

const appState = { isPackaged: false, appPath: "/repo/apps/macos" };
const appListeners = new Map<string, () => void>();

mock.module("electron", () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged;
    },
    getAppPath: () => appState.appPath,
    on: (event: string, listener: () => void) => {
      appListeners.set(event, listener);
    },
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: mock(() => undefined),
    on: mock(() => undefined),
    removeAllListeners: mock(() => undefined),
  },
}));

let exists = true;
mock.module("node:fs", () => ({ existsSync: () => exists }));

let lastChild: FakeHelperChild | null = null;
const spawnCalls: Array<[string, string[], object]> = [];
mock.module("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: object) => {
    spawnCalls.push([cmd, args, opts]);
    lastChild = new FakeHelperChild();
    return lastChild;
  },
}));

mock.module("./logger", () => ({
  default: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

// The guidance fetcher is dependency-injected (no host-proxy import), so tests
// drive Stage 3 guidance by setting this fake via setGuidanceFetcher.
const requestLocalDaemonMock = mock(async (): Promise<unknown> => null);

Object.defineProperty(process, "resourcesPath", {
  value: "/mock/resources",
  writable: true,
});

const { __setPlatformForTesting, __resetForTesting: resetHotkeyHelper } =
  await import("./hotkey-helper");

const {
  start,
  stop,
  installCueLive,
  isCueLiveEnabled,
  setCueLiveEnabledGetter,
  describeNextMove,
  setGuidanceFetcher,
  setStartVoiceDispatcher,
  setTtsFetcher,
  __resetForTesting,
} = await import("./cue-live-service");

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Emit a JSON-RPC frame from the helper to the main-process client. */
const emit = (frame: unknown) => {
  lastChild?.stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
};

/** The id the client assigned to the Nth request it wrote (1-based). */
const requestIdAt = (index: number): number => {
  const write = lastChild?.stdin.writes[index];
  return write ? (JSON.parse(write) as { id: number }).id : -1;
};

/** Find the first written frame whose method matches. */
const writeFor = (method: string): Record<string, unknown> | undefined => {
  for (const raw of lastChild?.stdin.writes ?? []) {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (frame.method === method) return frame;
  }
  return undefined;
};

beforeEach(() => {
  resetHotkeyHelper();
  __resetForTesting();
  __setPlatformForTesting("darwin");
  appListeners.clear();
  spawnCalls.length = 0;
  lastChild = null;
  exists = true;
  delete process.env.CUE_LIVE_ENABLED;
  delete process.env.CUE_LIVE_POINT_DWELL_MS;
  requestLocalDaemonMock.mockClear();
  requestLocalDaemonMock.mockImplementation(async () => null);
  setGuidanceFetcher(requestLocalDaemonMock);
});

afterEach(() => {
  setGuidanceFetcher(null);
});

afterEach(() => {
  __resetForTesting();
  resetHotkeyHelper();
});

describe("isCueLiveEnabled", () => {
  test("is on by default", () => {
    expect(isCueLiveEnabled()).toBe(true);
  });

  test("env CUE_LIVE_ENABLED can force it off", () => {
    process.env.CUE_LIVE_ENABLED = "0";
    expect(isCueLiveEnabled()).toBe(false);
    process.env.CUE_LIVE_ENABLED = "false";
    expect(isCueLiveEnabled()).toBe(false);
  });

  test("is on when CUE_LIVE_ENABLED is truthy", () => {
    process.env.CUE_LIVE_ENABLED = "1";
    expect(isCueLiveEnabled()).toBe(true);
    process.env.CUE_LIVE_ENABLED = "true";
    expect(isCueLiveEnabled()).toBe(true);
  });

  test("falls back to the injected persisted getter when env is unset", () => {
    setCueLiveEnabledGetter(() => false);
    expect(isCueLiveEnabled()).toBe(false);
    setCueLiveEnabledGetter(() => true);
    expect(isCueLiveEnabled()).toBe(true);
  });
});

describe("installCueLive", () => {
  test("does nothing when disabled", async () => {
    process.env.CUE_LIVE_ENABLED = "0";
    installCueLive();
    await wait(0);
    expect(spawnCalls).toHaveLength(0);
  });

  test("starts the overlay when enabled", async () => {
    process.env.CUE_LIVE_ENABLED = "1";
    installCueLive();
    await wait(0);
    expect(writeFor("cuelive.start")).toBeDefined();
  });
});

describe("start", () => {
  test("sends cuelive.start to the helper", async () => {
    void start();
    await wait(0);
    const frame = writeFor("cuelive.start");
    expect(frame).toBeDefined();
    expect(frame?.jsonrpc).toBe("2.0");
  });
});

describe("summon → capture → look → point orchestration", () => {
  // Answer cuelive.start, emit a summon, and answer cuelive.captureScreen with
  // the given result. Returns once the screenshot is in hand.
  async function summonAndCapture(capture: Record<string, unknown>) {
    void start();
    await wait(0);
    emit({ jsonrpc: "2.0", id: requestIdAt(0), result: { enabled: true } });
    await wait(0);

    emit({
      jsonrpc: "2.0",
      method: "cuelive.summoned",
      params: { x: 100, y: 200 },
    });
    await wait(0);

    const cap = writeFor("cuelive.captureScreen");
    expect(cap).toBeDefined();
    emit({ jsonrpc: "2.0", id: (cap as { id: number }).id, result: capture });
    await wait(0);
  }

  test("captures the screen, asks the model, and flies to the points", async () => {
    process.env.CUE_LIVE_POINT_DWELL_MS = "0";
    requestLocalDaemonMock.mockImplementation(async () => ({
      answer: "Click Send to send your message.",
      points: [{ x: 640, y: 400, label: "Send" }],
    }));

    await summonAndCapture({
      ok: true,
      data: "QkFTRTY0", // "BASE64"
      mediaType: "image/png",
      width: 1280,
      height: 800,
      screenWidth: 2560, // 2x scale vs the image
      screenHeight: 1600,
    });

    // A "thinking" card shows immediately; answer it so the flow proceeds.
    const thinking = writeFor("cuelive.showCard");
    expect(thinking?.params).toMatchObject({
      subtitle: "Looking at your screen…",
    });
    emit({ jsonrpc: "2.0", id: (thinking as { id: number }).id, result: {} });
    await wait(0);
    await wait(0);

    // The model was asked via the vision route, with the screenshot.
    expect(requestLocalDaemonMock).toHaveBeenCalledWith(
      "/cuelive/look",
      expect.objectContaining({
        imageBase64: "QkFTRTY0",
        imageWidth: 1280,
        imageHeight: 800,
      }),
    );

    // The cursor flies to the point, scaled from image px (640,400) to screen
    // points (×2 → 1280,800).
    const point = writeFor("cuelive.pointAt");
    expect(point?.params).toEqual({ x: 1280, y: 800, label: "Send" });

    // Drain the rest of the flow (pointAt ack → final answer card) so the
    // summon completes cleanly and doesn't leak into the next test.
    emit({ jsonrpc: "2.0", id: (point as { id: number }).id, result: {} });
    await wait(0);
    const answer = lastChild?.stdin.writes
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .reverse()
      .find((f) => f.method === "cuelive.showCard");
    if (answer) emit({ jsonrpc: "2.0", id: answer.id as number, result: {} });
    await wait(0);
  });

  test("speaks the answer in the voice configured under Voice, not a second local key", async () => {
    process.env.CUE_LIVE_POINT_DWELL_MS = "0";
    requestLocalDaemonMock.mockImplementation(async () => ({
      answer: "Click Send to send your message.",
      points: [],
    }));
    const ttsMock = mock(async () => "QVVESU8=" /* "AUDIO" */);
    setTtsFetcher(ttsMock);

    await summonAndCapture({
      ok: true,
      data: "QkFTRTY0",
      mediaType: "image/jpeg",
      width: 1280,
      height: 800,
    });
    const thinking = writeFor("cuelive.showCard");
    emit({ jsonrpc: "2.0", id: (thinking as { id: number }).id, result: {} });
    await wait(0);
    await wait(0);

    expect(ttsMock).toHaveBeenCalledWith("Click Send to send your message.");
    // Finished audio crosses to the helper — no `text`, so the helper never
    // needs an ElevenLabs key of its own.
    expect(writeFor("cuelive.speak")?.params).toEqual({
      audioBase64: "QVVESU8=",
    });
    setTtsFetcher(null);
  });

  test("falls back to the helper's own voice when the assistant can't synthesize", async () => {
    process.env.CUE_LIVE_POINT_DWELL_MS = "0";
    requestLocalDaemonMock.mockImplementation(async () => ({
      answer: "Click Send.",
      points: [],
    }));
    setTtsFetcher(async () => null);

    await summonAndCapture({
      ok: true,
      data: "QkFTRTY0",
      mediaType: "image/jpeg",
      width: 1280,
      height: 800,
    });
    const thinking = writeFor("cuelive.showCard");
    emit({ jsonrpc: "2.0", id: (thinking as { id: number }).id, result: {} });
    await wait(0);
    await wait(0);

    expect(writeFor("cuelive.speak")?.params).toEqual({ text: "Click Send." });
    setTtsFetcher(null);
  });

  test("shows a permission card and skips the model when capture is denied", async () => {
    await summonAndCapture({
      ok: false,
      reason: "screen-recording-permission",
    });

    const card = writeFor("cuelive.showCard");
    expect(card?.params).toMatchObject({
      title: "Cue Live needs Screen Recording",
    });
    expect(requestLocalDaemonMock).not.toHaveBeenCalled();
    expect(writeFor("cuelive.pointAt")).toBeUndefined();
  });
});

describe("⌥P point-at-element → capture → look → point (no take-control)", () => {
  test("a ⌥P event runs the pointing look flow and flies to the point", async () => {
    process.env.CUE_LIVE_POINT_DWELL_MS = "0";
    requestLocalDaemonMock.mockImplementation(async () => ({
      answer: "The Send button.",
      points: [{ x: 320, y: 200, label: "Send" }],
    }));

    void start();
    await wait(0);
    emit({ jsonrpc: "2.0", id: requestIdAt(0), result: { enabled: true } });
    await wait(0);

    // The helper emits cuelive.point (⌥P) with just the cursor — no question.
    emit({ jsonrpc: "2.0", method: "cuelive.point", params: { x: 10, y: 20 } });
    await wait(0);

    const cap = writeFor("cuelive.captureScreen");
    expect(cap).toBeDefined();
    emit({
      jsonrpc: "2.0",
      id: (cap as { id: number }).id,
      result: {
        ok: true,
        data: "QkFTRTY0",
        mediaType: "image/png",
        width: 640,
        height: 400,
        screenWidth: 640,
        screenHeight: 400,
      },
    });
    await wait(0);

    // Answer the immediate "thinking" card so the flow proceeds.
    const thinking = writeFor("cuelive.showCard");
    if (thinking) {
      emit({ jsonrpc: "2.0", id: (thinking as { id: number }).id, result: {} });
    }
    await wait(0);
    await wait(0);

    // The vision route was asked with the pointing-focused question.
    expect(requestLocalDaemonMock).toHaveBeenCalledWith(
      "/cuelive/look",
      expect.objectContaining({
        imageBase64: "QkFTRTY0",
        question: expect.stringContaining("Point at"),
      }),
    );

    // The cursor flies to the element; ⌥P never takes control.
    const point = writeFor("cuelive.pointAt");
    expect(point?.params).toMatchObject({ label: "Send" });
    expect(writeFor("cuelive.performAction")).toBeUndefined();

    // Drain the pointAt ack so the flow completes cleanly.
    if (point) {
      emit({ jsonrpc: "2.0", id: (point as { id: number }).id, result: {} });
    }
    await wait(0);
  });
});

describe("stop", () => {
  test("sends cuelive.stop and drops the summon subscription", async () => {
    void start();
    await wait(0);
    emit({ jsonrpc: "2.0", id: requestIdAt(0), result: { enabled: true } });
    await wait(0);

    void stop();
    await wait(0);
    expect(writeFor("cuelive.stop")).toBeDefined();

    // A summon after stop must not trigger a read.
    const writesAfterStop = lastChild?.stdin.writes.length ?? 0;
    emit({
      jsonrpc: "2.0",
      method: "cuelive.summoned",
      params: { x: 1, y: 1 },
    });
    await wait(0);
    expect(lastChild?.stdin.writes.length).toBe(writesAfterStop);
  });
});

describe("⌥R run hotkey → start Cue Live voice (backlog #29)", () => {
  // Start Cue Live and answer cuelive.start with the given trust state so the
  // helper subscription is live and lastKnownTrusted is set as requested.
  async function startTrusted(accessibilityTrusted: boolean) {
    void start();
    await wait(0);
    emit({
      jsonrpc: "2.0",
      id: requestIdAt(0),
      result: { enabled: true, accessibilityTrusted },
    });
    await wait(0);
  }

  /** Emit the helper's ⌥R run notification. */
  const emitRun = () =>
    emit({
      jsonrpc: "2.0",
      method: "cuelive.run",
      params: { x: 100, y: 200, captureMode: "screen" },
    });

  test("a ⌥R event dispatches exactly one start-voice", async () => {
    const startVoice = mock(() => undefined);
    setStartVoiceDispatcher(startVoice);
    await startTrusted(true);

    emitRun();
    await wait(0);

    expect(startVoice).toHaveBeenCalledTimes(1);
  });

  test("two ⌥R presses dispatch two starts (idempotency is the renderer's job)", async () => {
    const startVoice = mock(() => undefined);
    setStartVoiceDispatcher(startVoice);
    await startTrusted(true);

    emitRun();
    await wait(0);
    emitRun();
    await wait(0);

    expect(startVoice).toHaveBeenCalledTimes(2);
  });

  test("no-ops when the helper is not trusted for Accessibility", async () => {
    const startVoice = mock(() => undefined);
    setStartVoiceDispatcher(startVoice);
    await startTrusted(false);

    emitRun();
    await wait(0);

    expect(startVoice).not.toHaveBeenCalled();
  });

  test("no-ops after stop (Cue Live not running)", async () => {
    const startVoice = mock(() => undefined);
    setStartVoiceDispatcher(startVoice);
    await startTrusted(true);

    void stop();
    await wait(0);

    emitRun();
    await wait(0);

    expect(startVoice).not.toHaveBeenCalled();
  });

  test("no-ops when no dispatcher is wired (older wiring)", async () => {
    setStartVoiceDispatcher(null);
    await startTrusted(true);

    // No dispatcher: the only assertion is that this doesn't throw.
    emitRun();
    await wait(0);
  });
});

describe("describeNextMove (Stage 2b action hints)", () => {
  test("maps interactive roles to an action verb + label", () => {
    expect(
      describeNextMove({ found: true, role: "AXButton", label: "Save" }),
    ).toBe('Click "Save"');
    expect(
      describeNextMove({ found: true, role: "AXLink", label: "Docs" }),
    ).toBe('Open "Docs"');
    expect(
      describeNextMove({ found: true, role: "AXTextField", label: "Email" }),
    ).toBe('Type into "Email"');
    expect(
      describeNextMove({
        found: true,
        role: "AXCheckBox",
        label: "Remember me",
      }),
    ).toBe('Toggle "Remember me"');
  });

  test("uses the action alone when an interactive element has no label", () => {
    expect(describeNextMove({ found: true, role: "AXButton" })).toBe("Click");
  });

  test("surfaces static text content", () => {
    expect(
      describeNextMove({
        found: true,
        role: "AXStaticText",
        value: "Welcome back",
      }),
    ).toBe('Text: "Welcome back"');
  });

  test("falls back to the label, then a neutral prompt, for unknown roles", () => {
    expect(
      describeNextMove({ found: true, role: "AXGroup", label: "Sidebar" }),
    ).toBe("Sidebar");
    expect(describeNextMove({ found: true, role: "AXUnknown" })).toBe(
      "Hover an element to inspect it",
    );
  });
});
