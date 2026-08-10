import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { LiveVoiceConfigSchema } from "../../config/schemas/live-voice.js";
import { initializeDb } from "../../memory/db-init.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";

// The shell drives a real `LiveVoiceSession`, which ensures a `conversations`
// row on start and reads one again during end-of-session synthesis. Both need
// a schema.
initializeDb();

const loggerActual = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...loggerActual,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// The config the shell sees.
//
// `liveVoice` is parsed from its own schema rather than hand-written. The
// hand-written version omitted it entirely, so `getConfig().liveVoice` was
// undefined and `resolveLiveVoiceSettings` threw on `config.frontModel` — the
// session never sent `ready`, the socket died at 1006, and four assertions
// reported a live-voice bug that only existed in this fixture. Production is
// unaffected: `LiveVoiceConfigSchema` defaults `frontModel`, so a config file
// with no `liveVoice` key still resolves one.
//
// Parsing the real schema means a new required field cannot silently reappear
// as `undefined` here.
const liveVoice = LiveVoiceConfigSchema.parse({});

mock.module("../../config/loader.js", () => {
  const config = {
    liveVoice,
    model: "test",
    provider: "test",
    platform: { baseUrl: "https://example.com" },
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200_000 },
    services: {
      stt: { provider: "deepgram" },
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": {
        mode: "your-own",
        provider: "inference-provider-native",
      },
    },
  };
  return {
    loadConfig: () => config,
    getConfig: () => config,
    invalidateConfigCache: () => {},
  };
});

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  readonly audioChunks: number[][] = [];
  readonly mimeTypes: string[] = [];
  started = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.started = true;
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer, mimeType: string): void {
    this.audioChunks.push([...audio]);
    this.mimeTypes.push(mimeType);
    this.onEvent?.({
      type: "partial",
      text: `partial-${this.audioChunks.length}`,
    });
  }

  stop(): void {
    this.onEvent?.({ type: "closed" });
  }
}

const resolvedTranscribers: MockStreamingTranscriber[] = [];
function createResolvedTranscriber(): MockStreamingTranscriber {
  const transcriber = new MockStreamingTranscriber();
  resolvedTranscribers.push(transcriber);
  return transcriber;
}

let resolveStreamingTranscriberImpl = async () => createResolvedTranscriber();
const resolveStreamingTranscriberMock = mock(() =>
  resolveStreamingTranscriberImpl(),
);

mock.module("../../providers/speech-to-text/resolve.js", () => ({
  resolveStreamingTranscriber: resolveStreamingTranscriberMock,
}));

import { CURRENT_POLICY_EPOCH } from "../../runtime/auth/policy.js";
import { mintToken } from "../../runtime/auth/token-service.js";
import { RuntimeHttpServer } from "../../runtime/http-server.js";
import { LIVE_VOICE_TAKEN_OVER_MESSAGE } from "../live-voice-session-manager.js";

type JsonFrame = Record<string, unknown>;

const savedAuthEnv = {
  DISABLE_HTTP_AUTH: process.env.DISABLE_HTTP_AUTH,
};

function mintGatewayToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_ingress_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}

function mintActorToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "actor:self:user-123",
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}

function startFrame(conversationId = "conversation-123"): string {
  return JSON.stringify({
    type: "start",
    conversationId,
    audio: {
      mimeType: "audio/pcm",
      sampleRate: 24_000,
      channels: 1,
    },
  });
}

async function waitForOpen(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket open"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket failed to open"));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

async function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket close"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket close failed"));
    };
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });
}

/**
 * Wait for the NEXT frame of a given type, skipping any that arrive ahead of
 * it.
 *
 * The plain "take whatever arrives first" version broke when the session
 * started emitting a `metrics` frame before `ready`. That is not a protocol
 * violation: the real client (`live-voice-client.ts`) dispatches on
 * `frame.type` in a switch and gates `ready` on `state === "connecting"`, so
 * it is order-independent by construction and a `metrics` frame arriving
 * first costs it nothing.
 *
 * So the ordering assumption lived only in this helper. A test that is
 * stricter than the client it stands for reports a product bug that isn't
 * one — which is what four red assertions here were doing.
 */
async function waitForFrameOfType(
  ws: WebSocket,
  type: string,
  timeoutMs = 2000,
): Promise<JsonFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for a ${type} frame`);
    }
    const frame = await waitForJsonFrame(ws, remaining);
    if ((frame as { type?: string }).type === type) return frame;
  }
}

async function waitForJsonFrame(
  ws: WebSocket,
  timeoutMs = 2000,
): Promise<JsonFrame> {
  await waitForOpen(ws, timeoutMs);
  return await new Promise<JsonFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent) => {
      cleanup();
      const data = event.data;
      if (typeof data !== "string") {
        reject(new Error("Expected text WebSocket message"));
        return;
      }
      resolve(JSON.parse(data) as JsonFrame);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before message"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket errored before message"));
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });
}

function closeClient(ws: WebSocket): void {
  if (
    ws.readyState === WebSocket.CONNECTING ||
    ws.readyState === WebSocket.OPEN
  ) {
    ws.close(1000, "test shutdown");
  }
}

describe("RuntimeHttpServer live voice WebSocket shell", () => {
  let server: RuntimeHttpServer;
  let baseUrl: string;
  let wsBaseUrl: string;
  let clients: WebSocket[];

  beforeEach(async () => {
    delete process.env.DISABLE_HTTP_AUTH;
    resolveStreamingTranscriberImpl = async () => createResolvedTranscriber();
    resolveStreamingTranscriberMock.mockClear();
    resolvedTranscribers.length = 0;
    clients = [];
    const port = 21100 + Math.floor(Math.random() * 300);
    server = new RuntimeHttpServer({ port, hostname: "127.0.0.1" });
    await server.start();
    baseUrl = `http://127.0.0.1:${server.actualPort}`;
    wsBaseUrl = `ws://127.0.0.1:${server.actualPort}`;
  });

  afterEach(async () => {
    for (const client of clients) {
      closeClient(client);
    }
    await server.stop();
    if (savedAuthEnv.DISABLE_HTTP_AUTH === undefined) {
      delete process.env.DISABLE_HTTP_AUTH;
    } else {
      process.env.DISABLE_HTTP_AUTH = savedAuthEnv.DISABLE_HTTP_AUTH;
    }
  });

  function openLiveVoiceClient(token = mintGatewayToken()): WebSocket {
    const ws = new WebSocket(
      `${wsBaseUrl}/v1/live-voice?token=${encodeURIComponent(token)}`,
    );
    clients.push(ws);
    return ws;
  }

  test("rejects unauthorized upgrades before creating a WebSocket", async () => {
    const baseHeaders = {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
    };

    const missingToken = await fetch(`${baseUrl}/v1/live-voice`, {
      headers: baseHeaders,
    });
    expect(missingToken.status).toBe(401);

    const actorToken = await fetch(
      `${baseUrl}/v1/live-voice?token=${mintActorToken()}`,
      { headers: baseHeaders },
    );
    expect(actorToken.status).toBe(401);

    const externalOrigin = await fetch(
      `${baseUrl}/v1/live-voice?token=${mintGatewayToken()}`,
      {
        headers: {
          ...baseHeaders,
          Origin: "https://external.example.com",
        },
      },
    );
    expect(externalOrigin.status).toBe(403);
  });

  test("routes start and audio frames through the real live voice session", async () => {
    const ws = openLiveVoiceClient();
    await waitForOpen(ws);

    ws.send(startFrame("conversation-ready"));
    const ready = await waitForFrameOfType(ws, "ready");

    expect(ready).toMatchObject({
      type: "ready",
      seq: 1,
      conversationId: "conversation-ready",
    });
    expect(typeof ready.sessionId).toBe("string");
    expect(resolveStreamingTranscriberMock).toHaveBeenCalledWith({
      sampleRate: 24_000,
    });
    expect(resolvedTranscribers).toHaveLength(1);
    expect(resolvedTranscribers[0]?.started).toBe(true);

    ws.send(new Uint8Array([1, 2, 3]));
    const partial = await waitForJsonFrame(ws);
    expect(partial).toMatchObject({
      type: "stt_partial",
      seq: 2,
      text: "partial-1",
    });
    expect(resolvedTranscribers[0]?.audioChunks).toEqual([[1, 2, 3]]);
    expect(resolvedTranscribers[0]?.mimeTypes).toEqual(["audio/pcm"]);
  });

  test("sends an error for malformed frames and can still start", async () => {
    const ws = openLiveVoiceClient();
    await waitForOpen(ws);

    ws.send("{");
    const error = await waitForJsonFrame(ws);
    expect(error).toMatchObject({
      type: "error",
      seq: 1,
      code: "invalid_json",
    });

    ws.send(startFrame("conversation-after-error"));
    const ready = await waitForFrameOfType(ws, "ready");
    expect(ready).toMatchObject({
      type: "ready",
      conversationId: "conversation-after-error",
    });
    expect(typeof ready.sessionId).toBe("string");
    expect(ready.seq as number).toBeGreaterThan(error.seq as number);
  });

  test("a newer start takes over the active session instead of busy", async () => {
    const first = openLiveVoiceClient();
    const second = openLiveVoiceClient();
    await Promise.all([waitForOpen(first), waitForOpen(second)]);

    first.send(startFrame("conversation-first"));
    const firstReady = await waitForFrameOfType(first, "ready");

    // Register the old-socket listener BEFORE the takeover happens — the
    // terminal error frame goes out during the new start's admission.
    const takeoverPromise = waitForFrameOfType(first, "error");
    second.send(startFrame("conversation-second"));
    const secondReady = await waitForFrameOfType(second, "ready");
    expect(secondReady).toMatchObject({
      type: "ready",
      conversationId: "conversation-second",
    });
    expect(secondReady.sessionId).not.toBe(firstReady.sessionId);

    const takeover = await takeoverPromise;
    expect(takeover).toMatchObject({
      type: "error",
      code: "invalid_frame",
      message: LIVE_VOICE_TAKEN_OVER_MESSAGE,
      fatal: true,
    });

    // The preempted socket closing afterwards must not disturb the new
    // session: its audio still flows.
    first.close(1000, "client finished");
    await waitForClose(first);

    second.send(new Uint8Array([1, 2, 3]));
    const partial = await waitForFrameOfType(second, "stt_partial");
    expect(partial).toMatchObject({ type: "stt_partial" });
  });

  test("releases the session lock when the WebSocket closes", async () => {
    const first = openLiveVoiceClient();
    await waitForOpen(first);

    first.send(startFrame("conversation-first"));
    const firstReady = await waitForFrameOfType(first, "ready");

    first.close(1000, "client finished");
    await waitForClose(first);

    const second = openLiveVoiceClient();
    await waitForOpen(second);
    second.send(startFrame("conversation-second"));
    const secondReady = await waitForFrameOfType(second, "ready");
    expect(secondReady).toMatchObject({
      type: "ready",
      conversationId: "conversation-second",
    });
    expect(secondReady.sessionId).not.toBe(firstReady.sessionId);
  });

  test("releases the session lock after startup STT failure without WebSocket close", async () => {
    let attempts = 0;
    resolveStreamingTranscriberImpl = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Deepgram credentials missing");
      }
      return createResolvedTranscriber();
    };
    const ws = openLiveVoiceClient();
    await waitForOpen(ws);

    ws.send(startFrame("conversation-failed"));
    const error = await waitForJsonFrame(ws);
    expect(error).toMatchObject({
      type: "error",
      code: "invalid_field",
      message: expect.stringContaining("Deepgram credentials missing"),
    });

    ws.send(startFrame("conversation-retry"));
    const ready = await waitForFrameOfType(ws, "ready");

    expect(ready).toMatchObject({
      type: "ready",
      conversationId: "conversation-retry",
    });
    expect(typeof ready.sessionId).toBe("string");
    expect(resolveStreamingTranscriberMock).toHaveBeenCalledTimes(2);
    expect(resolvedTranscribers).toHaveLength(1);
    expect(resolvedTranscribers[0]?.started).toBe(true);
  });
});
