import { beforeEach, describe, expect, mock, test } from "bun:test";

// The logger pulls in electron-log/main → electron; stub it before importing
// the executors (they import `../logger`).
mock.module("../logger", () => ({ default: { info() {}, warn() {}, error() {} } }));

import { createHostCuExecutor, CU_HELPER_METHOD } from "./host-cu-executor";
import {
  createHostAppControlExecutor,
  APP_CONTROL_HELPER_METHOD,
} from "./host-app-control-executor";
import type { CuHelperClient } from "./host-helper-proxy-executor";
import type { HostProxyPoster } from "../host-proxy-poster";
import type { HostProxySseMessage } from "../host-proxy-sse";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedCall {
  method: string;
  params: Record<string, unknown>;
}

function makeHelper(
  result: unknown | (() => Promise<unknown>),
): { helper: CuHelperClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const helper: CuHelperClient = {
    call: (method: string, params?: unknown) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      return typeof result === "function"
        ? (result as () => Promise<unknown>)()
        : Promise.resolve(result);
    },
  };
  return { helper, calls };
}

function makePoster(): {
  poster: HostProxyPoster;
  cu: Array<Record<string, unknown>>;
  app: Array<Record<string, unknown>>;
} {
  const cu: Array<Record<string, unknown>> = [];
  const app: Array<Record<string, unknown>> = [];
  const poster = {
    postCuResult: async (r: Record<string, unknown>) => {
      cu.push(r);
      return true;
    },
    postAppControlResult: async (r: Record<string, unknown>) => {
      app.push(r);
      return true;
    },
  } as unknown as HostProxyPoster;
  return { poster, cu, app };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Computer-use executor
// ---------------------------------------------------------------------------

describe("host-cu-executor", () => {
  test("translates a CU request into a computeruse.perform call and posts the observation", async () => {
    const { helper, calls } = makeHelper({
      axTree: "[1] AXButton 'Save'",
      screenshot: "aGVsbG8=",
      screenshotWidthPx: 1280,
      screenshotHeightPx: 720,
      executionResult: "clicked",
    });
    const { poster, cu } = makePoster();
    const executor = createHostCuExecutor({ helper });

    executor.handleRequest(
      {
        type: "host_cu_request",
        requestId: "req-1",
        conversationId: "conv-1",
        toolName: "computer_use_click",
        input: { element_id: 1, reasoning: "click save" },
        stepNumber: 3,
        reasoning: "click save",
      } as unknown as HostProxySseMessage,
      poster,
    );

    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe(CU_HELPER_METHOD);
    expect(calls[0].params).toMatchObject({
      requestId: "req-1",
      conversationId: "conv-1",
      toolName: "computer_use_click",
      stepNumber: 3,
      input: { element_id: 1, reasoning: "click save" },
    });
    expect(cu).toHaveLength(1);
    expect(cu[0]).toMatchObject({
      requestId: "req-1",
      axTree: "[1] AXButton 'Save'",
      screenshotWidthPx: 1280,
      executionResult: "clicked",
    });
  });

  test("missing toolName posts an executionError without calling the helper", async () => {
    const { helper, calls } = makeHelper({});
    const { poster, cu } = makePoster();
    const executor = createHostCuExecutor({ helper });

    executor.handleRequest(
      { type: "host_cu_request", requestId: "req-2" } as HostProxySseMessage,
      poster,
    );
    await tick();

    expect(calls).toHaveLength(0);
    expect(cu[0]).toMatchObject({ requestId: "req-2", executionError: "Missing toolName" });
  });

  test("a helper failure posts an executionError", async () => {
    const { helper } = makeHelper(() => Promise.reject(new Error("helper down")));
    const { poster, cu } = makePoster();
    const executor = createHostCuExecutor({ helper });

    executor.handleRequest(
      {
        type: "host_cu_request",
        requestId: "req-3",
        toolName: "computer_use_observe",
        input: {},
      } as unknown as HostProxySseMessage,
      poster,
    );
    await tick();

    expect(cu[0]).toMatchObject({ requestId: "req-3", executionError: "helper down" });
  });

  test("a result arriving after cancel is dropped, not posted", async () => {
    let resolveCall: (v: unknown) => void = () => {};
    const helper: CuHelperClient = {
      call: () => new Promise((res) => (resolveCall = res)),
    };
    const { poster, cu } = makePoster();
    const executor = createHostCuExecutor({ helper });

    const msg = {
      type: "host_cu_request",
      requestId: "req-4",
      toolName: "computer_use_observe",
      input: {},
    } as unknown as HostProxySseMessage;
    executor.handleRequest(msg, poster);
    executor.handleCancel(msg, poster);
    resolveCall({ axTree: "late" });
    await tick();

    expect(cu).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// App-control executor
// ---------------------------------------------------------------------------

describe("host-app-control-executor", () => {
  test("forwards the discriminated input and posts window state", async () => {
    const { helper, calls } = makeHelper({
      state: "running",
      pngBase64: "iVBOR",
      windowBounds: { x: 0, y: 0, width: 800, height: 600 },
      executionResult: "ok",
    });
    const { poster, app } = makePoster();
    const executor = createHostAppControlExecutor({ helper });

    executor.handleRequest(
      {
        type: "host_app_control_request",
        requestId: "ac-1",
        conversationId: "conv-9",
        toolName: "app_control_observe",
        input: { tool: "observe", app: "com.apple.Safari" },
      } as unknown as HostProxySseMessage,
      poster,
    );
    await tick();

    expect(calls[0].method).toBe(APP_CONTROL_HELPER_METHOD);
    expect(calls[0].params).toMatchObject({
      requestId: "ac-1",
      input: { tool: "observe", app: "com.apple.Safari" },
    });
    expect(app[0]).toMatchObject({
      requestId: "ac-1",
      state: "running",
      windowBounds: { width: 800 },
    });
  });

  test("missing input posts a missing-state executionError", async () => {
    const { helper, calls } = makeHelper({});
    const { poster, app } = makePoster();
    const executor = createHostAppControlExecutor({ helper });

    executor.handleRequest(
      { type: "host_app_control_request", requestId: "ac-2" } as HostProxySseMessage,
      poster,
    );
    await tick();

    expect(calls).toHaveLength(0);
    expect(app[0]).toMatchObject({
      requestId: "ac-2",
      state: "missing",
      executionError: "Missing input",
    });
  });

  test("an invalid helper result (bad state) posts a structured error", async () => {
    const { helper } = makeHelper({ state: "exploded" });
    const { poster, app } = makePoster();
    const executor = createHostAppControlExecutor({ helper });

    executor.handleRequest(
      {
        type: "host_app_control_request",
        requestId: "ac-3",
        input: { tool: "observe", app: "x" },
      } as unknown as HostProxySseMessage,
      poster,
    );
    await tick();

    expect(app[0]).toMatchObject({ requestId: "ac-3", state: "missing" });
    expect(app[0].executionError).toContain("invalid");
  });
});
