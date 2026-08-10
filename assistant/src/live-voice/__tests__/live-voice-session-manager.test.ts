import { describe, expect, mock, test } from "bun:test";

import {
  LIVE_VOICE_CLIENT_INACTIVITY_MESSAGE,
  LIVE_VOICE_TAKEN_OVER_MESSAGE,
  type LiveVoiceSession,
  type LiveVoiceSessionCloseReason,
  type LiveVoiceSessionFactoryContext,
  LiveVoiceSessionManager,
  LiveVoiceSessionStartupError,
} from "../live-voice-session-manager.js";
import type {
  LiveVoiceClientFrame,
  LiveVoiceClientStartFrame,
  LiveVoiceServerFrame,
} from "../protocol.js";

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: {
    mimeType: "audio/pcm",
    sampleRate: 24_000,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

interface TestSession extends LiveVoiceSession {
  readonly clientFrames: LiveVoiceClientFrame[];
  readonly binaryChunks: Uint8Array[];
  readonly closeReasons: LiveVoiceSessionCloseReason[];
}

function createTestSession(overrides: Partial<LiveVoiceSession> = {}) {
  const session: TestSession = {
    clientFrames: [],
    binaryChunks: [],
    closeReasons: [],
    start: mock(() => {}),
    handleClientFrame: mock((frame: LiveVoiceClientFrame) => {
      session.clientFrames.push(frame);
    }),
    handleBinaryAudio: mock((chunk: Uint8Array) => {
      session.binaryChunks.push(chunk);
    }),
    close: mock((reason: LiveVoiceSessionCloseReason) => {
      session.closeReasons.push(reason);
    }),
    ...overrides,
  };
  return session;
}

function createSink() {
  const frames: LiveVoiceServerFrame[] = [];
  return {
    frames,
    sink: {
      sendFrame: mock((frame: LiveVoiceServerFrame) => {
        frames.push(frame);
      }),
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await sleep(5);
  }
}

describe("LiveVoiceSessionManager", () => {
  test("creates and starts the first accepted live voice session", async () => {
    const sessions: TestSession[] = [];
    const contexts: LiveVoiceSessionFactoryContext[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: (context) => {
        contexts.push(context);
        const session = createTestSession({
          start: mock(async () => {
            await context.sendFrame({
              type: "ready",
              sessionId: context.sessionId,
              conversationId:
                context.startFrame.conversationId ?? "conversation-new",
            });
          }),
        });
        sessions.push(session);
        return session;
      },
    });
    const { frames, sink } = createSink();

    const result = await manager.startSession(START_FRAME, sink);

    expect(result).toEqual({ status: "accepted", sessionId: "session-1" });
    expect(manager.activeSessionId).toBe("session-1");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.sessionId).toBe("session-1");
    expect(contexts[0]?.startFrame).toEqual(START_FRAME);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.start).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([
      {
        type: "ready",
        seq: 1,
        sessionId: "session-1",
        conversationId: "conversation-123",
      },
    ]);
  });

  test("newest start preempts the active session instead of sending busy", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: () => {
        const session = createTestSession();
        sessions.push(session);
        return session;
      },
    });
    const first = createSink();
    const second = createSink();

    const accepted = await manager.startSession(START_FRAME, first.sink);
    const preempting = await manager.startSession(START_FRAME, second.sink);

    expect(accepted).toEqual({ status: "accepted", sessionId: "session-1" });
    // The newer session is admitted — never a busy rejection.
    expect(preempting).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(manager.activeSessionId).toBe("session-2");
    expect(second.frames).toEqual([]);
    expect(
      [...first.frames, ...second.frames].filter((f) => f.type === "busy"),
    ).toEqual([]);

    // The old session's client got the terminal takeover error on its own
    // sequenced channel, and its normal close path (finalize) ran.
    expect(first.frames).toEqual([
      {
        type: "error",
        seq: 1,
        code: "invalid_frame",
        message: LIVE_VOICE_TAKEN_OVER_MESSAGE,
        fatal: true,
      },
    ]);
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(sessions[0]?.closeReasons).toEqual(["superseded"]);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.start).toHaveBeenCalledTimes(1);
    expect(sessions[1]?.close).not.toHaveBeenCalled();
  });

  test("preemption completes old teardown before the new session starts", async () => {
    const events: string[] = [];
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: (context) => {
        const session = createTestSession({
          start: mock(() => {
            events.push(`start:${context.sessionId}`);
          }),
          close: mock(async (reason: LiveVoiceSessionCloseReason) => {
            session.closeReasons.push(reason);
            events.push(`close:${context.sessionId}`);
            // Async but prompt teardown — well inside the bound.
            await Promise.resolve();
          }),
        });
        sessions.push(session);
        return session;
      },
    });

    await manager.startSession(START_FRAME, createSink().sink);
    await manager.startSession(START_FRAME, createSink().sink);

    expect(events).toEqual([
      "start:session-1",
      "close:session-1",
      "start:session-2",
    ]);
  });

  test("a wedged old teardown still admits the new session within the bound", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      preemptTeardownTimeoutMs: 20,
      createSession: (context) => {
        const session = createTestSession(
          context.sessionId === "session-1"
            ? {
                close: mock((reason: LiveVoiceSessionCloseReason) => {
                  sessions[0]?.closeReasons.push(reason);
                  // Never settles: a wedged session teardown.
                  return new Promise<void>(() => {});
                }),
              }
            : {},
        );
        sessions.push(session);
        return session;
      },
    });
    const first = createSink();
    const second = createSink();

    await manager.startSession(START_FRAME, first.sink);
    const preempting = await manager.startSession(START_FRAME, second.sink);

    expect(preempting).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(manager.activeSessionId).toBe("session-2");
    // The wedged close was still attempted (finalize had its chance) and the
    // old client still got the takeover frame.
    expect(sessions[0]?.closeReasons).toEqual(["superseded"]);
    expect(first.frames).toEqual([
      {
        type: "error",
        seq: 1,
        code: "invalid_frame",
        message: LIVE_VOICE_TAKEN_OVER_MESSAGE,
        fatal: true,
      },
    ]);
  });

  for (const engine of ["cascade", "gemini-live"] as const) {
    test(`reaps a frame-silent ${engine} session after the client-liveness bound`, async () => {
      const sessions: TestSession[] = [];
      const manager = new LiveVoiceSessionManager({
        createSessionId: mock(() => `session-${sessions.length + 1}`),
        clientInactivityTimeoutMs: 30,
        createSession: () => {
          const session = createTestSession();
          sessions.push(session);
          return session;
        },
      });
      const { frames, sink } = createSink();

      await manager.startSession({ ...START_FRAME, engine }, sink);
      expect(manager.activeSessionId).toBe("session-1");

      await waitFor(() => manager.activeSessionId === null, 500);

      expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
      expect(sessions[0]?.closeReasons).toEqual(["client_inactivity"]);
      expect(frames).toEqual([
        {
          type: "error",
          seq: 1,
          code: "invalid_frame",
          message: LIVE_VOICE_CLIENT_INACTIVITY_MESSAGE,
          fatal: true,
        },
      ]);
    });
  }

  test("a session actively sending frames is never reaped", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      clientInactivityTimeoutMs: 60,
      createSession: () => {
        const session = createTestSession();
        sessions.push(session);
        return session;
      },
    });

    await manager.startSession(START_FRAME, createSink().sink);

    // Keep frames flowing well past several liveness windows.
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      await manager.handleBinaryAudio("session-1", new Uint8Array([1]));
      await sleep(15);
    }

    expect(manager.activeSessionId).toBe("session-1");
    expect(sessions[0]?.close).not.toHaveBeenCalled();

    await manager.releaseSession("session-1", "manager_shutdown");
    expect(manager.activeSessionId).toBeNull();
  });

  test("releases the active session once for repeated close events", async () => {
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);
    const firstRelease = await manager.releaseSession(
      "session-1",
      "websocket_close",
    );
    const secondRelease = await manager.releaseSession(
      "session-1",
      "websocket_close",
    );

    expect(firstRelease).toEqual({
      released: true,
      sessionId: "session-1",
    });
    expect(secondRelease).toEqual({ released: false });
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(session.closeReasons).toEqual(["websocket_close"]);
    expect(manager.activeSessionId).toBeNull();
  });

  test("releases the lock on a normal end frame", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: () => {
        const session = createTestSession();
        sessions.push(session);
        return session;
      },
    });

    await manager.startSession(START_FRAME, createSink().sink);
    const result = await manager.handleClientFrame("session-1", {
      type: "end",
    });
    const next = await manager.startSession(START_FRAME, createSink().sink);

    expect(result).toEqual({ status: "handled", sessionId: "session-1" });
    expect(sessions[0]?.clientFrames).toEqual([{ type: "end" }]);
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(sessions[0]?.closeReasons).toEqual(["client_end"]);
    expect(next).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(sessions).toHaveLength(2);
  });

  test("releases the lock when session start throws", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: (context) => {
        const session = createTestSession(
          context.sessionId === "session-1"
            ? {
                start: mock(() => {
                  throw new Error("session start failed");
                }),
              }
            : {},
        );
        sessions.push(session);
        return session;
      },
    });

    await expect(
      manager.startSession(START_FRAME, createSink().sink),
    ).rejects.toThrow("session start failed");
    const retry = await manager.startSession(START_FRAME, createSink().sink);

    expect(sessions[0]?.closeReasons).toEqual(["error"]);
    expect(retry).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(manager.activeSessionId).toBe("session-2");
  });

  test("releases the lock without rethrowing terminal startup failures", async () => {
    const sessions: TestSession[] = [];
    const first = createSink();
    const second = createSink();
    const startupErrorMessage = "Live voice transcription could not be started";
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: (context) => {
        const session = createTestSession(
          context.sessionId === "session-1"
            ? {
                start: mock(async () => {
                  await context.sendFrame({
                    type: "error",
                    code: "invalid_field",
                    message: startupErrorMessage,
                  });
                  throw new LiveVoiceSessionStartupError(startupErrorMessage);
                }),
              }
            : {},
        );
        sessions.push(session);
        return session;
      },
    });

    const failed = await manager.startSession(START_FRAME, first.sink);
    const retry = await manager.startSession(START_FRAME, second.sink);

    expect(failed).toEqual({ status: "failed", sessionId: "session-1" });
    expect(first.frames).toEqual([
      {
        type: "error",
        seq: 1,
        code: "invalid_field",
        message: startupErrorMessage,
      },
    ]);
    expect(sessions[0]?.closeReasons).toEqual(["error"]);
    expect(retry).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(manager.activeSessionId).toBe("session-2");
  });

  test("releases the lock when session frame handling throws", async () => {
    const session = createTestSession({
      handleClientFrame: mock(() => {
        throw new Error("client frame failed");
      }),
    });
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);

    await expect(
      manager.handleClientFrame("session-1", { type: "interrupt" }),
    ).rejects.toThrow("client frame failed");
    expect(session.closeReasons).toEqual(["error"]);
    expect(manager.activeSessionId).toBeNull();
  });

  test("releases the lock when binary audio handling throws", async () => {
    const session = createTestSession({
      handleBinaryAudio: mock(() => {
        throw new Error("binary audio failed");
      }),
    });
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);

    await expect(
      manager.handleBinaryAudio("session-1", new Uint8Array([1, 2, 3])),
    ).rejects.toThrow("binary audio failed");
    expect(session.closeReasons).toEqual(["error"]);
    expect(manager.activeSessionId).toBeNull();
  });

  test("ignores stale session ids without releasing the active lock", async () => {
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);

    expect(
      await manager.handleClientFrame("session-stale", { type: "end" }),
    ).toEqual({ status: "not_found" });
    expect(
      await manager.handleBinaryAudio("session-stale", new Uint8Array([1])),
    ).toEqual({ status: "not_found" });
    expect(
      await manager.releaseSession("session-stale", "websocket_close"),
    ).toEqual({ released: false });
    expect(session.close).not.toHaveBeenCalled();
    expect(manager.activeSessionId).toBe("session-1");
  });

  test("admits a start racing an in-flight close without clobbering the new session", async () => {
    const sessions: TestSession[] = [];
    let resolveClose: (() => void) | undefined;
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: () => {
        const session = createTestSession(
          sessions.length === 0
            ? {
                close: mock(
                  (reason: LiveVoiceSessionCloseReason) =>
                    new Promise<void>((resolve) => {
                      sessions[0]?.closeReasons.push(reason);
                      resolveClose = resolve;
                    }),
                ),
              }
            : {},
        );
        sessions.push(session);
        return session;
      },
    });
    const first = createSink();
    const second = createSink();

    await manager.startSession(START_FRAME, first.sink);
    const releasePromise = manager.releaseSession("session-1", "client_end");
    // The closing session is unreachable for frames while it tears down.
    const concurrentDispatch = await manager.handleClientFrame("session-1", {
      type: "interrupt",
    });
    expect(concurrentDispatch).toEqual({ status: "not_found" });

    // Newest-wins: the racing start detaches the closing registration and is
    // admitted immediately — no busy, no takeover frame to a client that is
    // already ending its own session.
    const concurrent = await manager.startSession(START_FRAME, second.sink);
    expect(concurrent).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(manager.activeSessionId).toBe("session-2");
    expect(first.frames).toEqual([]);
    expect(sessions).toHaveLength(2);

    // When the old close finally completes it must not clobber the new slot.
    resolveClose?.();
    await releasePromise;
    expect(manager.activeSessionId).toBe("session-2");
    expect(sessions[0]?.closeReasons).toEqual(["client_end"]);
    expect(sessions[1]?.close).not.toHaveBeenCalled();
  });

  test("does not import runtime, gateway, provider, or conversation modules", async () => {
    const source = await Bun.file(
      new URL("../live-voice-session-manager.ts", import.meta.url),
    ).text();
    const imports = Array.from(
      source.matchAll(/from\s+["']([^"']+)["']/g),
      (match) => match[1],
    );

    expect(imports).toEqual(["node:crypto", "./protocol.js"]);
    for (const importPath of imports) {
      expect(importPath).not.toContain("runtime");
      expect(importPath).not.toContain("gateway");
      expect(importPath).not.toContain("stt");
      expect(importPath).not.toContain("tts");
      expect(importPath).not.toContain("conversation");
    }
  });
});
