import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { FakeChild } from "./test-helpers";

class FakeHelperChild extends FakeChild {
  stdin = {
    writes: [] as string[],
    ended: false,
    write: mock((data: string, callback?: (err?: Error) => void) => {
      this.stdin.writes.push(data);
      callback?.();
      return true;
    }),
    end: mock(() => {
      this.stdin.ended = true;
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
  describeNextMove,
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
});

afterEach(() => {
  __resetForTesting();
  resetHotkeyHelper();
});

describe("isCueLiveEnabled", () => {
  test("is off by default", () => {
    expect(isCueLiveEnabled()).toBe(false);
  });

  test("is on when CUE_LIVE_ENABLED is truthy", () => {
    process.env.CUE_LIVE_ENABLED = "1";
    expect(isCueLiveEnabled()).toBe(true);
    process.env.CUE_LIVE_ENABLED = "true";
    expect(isCueLiveEnabled()).toBe(true);
  });
});

describe("installCueLive", () => {
  test("does nothing when disabled", async () => {
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

describe("summon → read → show orchestration", () => {
  test("reads the element, highlights it, and shows the card", async () => {
    void start();
    await wait(0);

    // Answer cuelive.start.
    emit({ jsonrpc: "2.0", id: requestIdAt(0), result: { enabled: true } });
    await wait(0);

    const writesBeforeSummon = lastChild?.stdin.writes.length ?? 0;

    // Helper reports a summon at the cursor.
    emit({
      jsonrpc: "2.0",
      method: "cuelive.summoned",
      params: { x: 100, y: 200 },
    });
    await wait(0);

    // The service should have called readElementAtCursor.
    const readFrame = writeFor("cuelive.readElementAtCursor");
    expect(readFrame).toBeDefined();

    // Answer the read with a found element + bounds.
    emit({
      jsonrpc: "2.0",
      id: requestIdAt(writesBeforeSummon),
      result: {
        found: true,
        role: "AXButton",
        label: "Send",
        x: 10,
        y: 20,
        width: 80,
        height: 30,
      },
    });
    await wait(0);

    // Highlight with the AX role as the mono label, anchored to bounds.
    const highlight = writeFor("cuelive.highlight");
    expect(highlight).toBeDefined();
    expect(highlight?.params).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 30,
      label: "AXButton",
    });

    // Resolve the highlight call so the chained showCard call fires.
    const highlightId = (highlight as { id: number }).id;
    emit({ jsonrpc: "2.0", id: highlightId, result: {} });
    await wait(0);

    // Card titled "Cue" with an AX-derived next-move subtitle.
    const card = writeFor("cuelive.showCard");
    expect(card).toBeDefined();
    expect(card?.params).toEqual({
      title: "Cue",
      subtitle: 'Click "Send"',
      x: 10,
      y: 20,
    });
  });

  test("does nothing when no element is found", async () => {
    void start();
    await wait(0);
    emit({ jsonrpc: "2.0", id: requestIdAt(0), result: { enabled: true } });
    await wait(0);

    const writesBeforeSummon = lastChild?.stdin.writes.length ?? 0;
    emit({
      jsonrpc: "2.0",
      method: "cuelive.summoned",
      params: { x: 5, y: 5 },
    });
    await wait(0);

    emit({
      jsonrpc: "2.0",
      id: requestIdAt(writesBeforeSummon),
      result: { found: false },
    });
    await wait(0);

    expect(writeFor("cuelive.highlight")).toBeUndefined();
    expect(writeFor("cuelive.showCard")).toBeUndefined();
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
