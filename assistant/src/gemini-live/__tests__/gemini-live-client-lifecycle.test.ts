/**
 * Session-lifecycle hardening for the raw Gemini Live client (H-3).
 *
 * The engine used to treat every upstream event as terminal: any socket close
 * surfaced as a fatal error and the call died (the ~20s drops). These tests
 * drive the client with a scripted fake socket and pin the recovery behavior:
 * reconnect-with-resume on unexpected close, proactive migration on `goAway`,
 * setup-reject (1007) retry without optional fields, tool responses queued
 * across a drop, silence keepalive during idle, and an honest terminal close
 * only when bounded retries are exhausted.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const loggerActual = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...loggerActual,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const { GeminiLiveClient }: typeof import("../gemini-live-client.js") =
  await import("../gemini-live-client.js");
type GeminiLiveSocket = import("../gemini-live-client.js").GeminiLiveSocket;
type GeminiLiveClientCallbacks =
  import("../gemini-live-client.js").GeminiLiveClientCallbacks;

/** Scripted stand-in for the upstream WebSocket. */
class FakeSocket implements GeminiLiveSocket {
  binaryType = "";
  readyState = 0;
  readonly sent: string[] = [];
  closedByClient = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }

  // ── test drivers ──
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  /** Server-side close (code from the wire). */
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  completeSetup(): void {
    this.open();
    this.message({ setupComplete: {} });
  }

  /** Parsed frames this socket was asked to send. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  setup(): Record<string, unknown> {
    const frame = this.frames().find((f) => "setup" in f);
    return (frame?.setup ?? {}) as Record<string, unknown>;
  }
}

let sockets: FakeSocket[];
let events: string[];

function makeCallbacks(
  overrides: Partial<GeminiLiveClientCallbacks> = {},
): GeminiLiveClientCallbacks {
  return {
    onReconnecting: (info) => events.push(`reconnecting:${info.reason}`),
    onReconnected: (info) => events.push(`reconnected:${String(info.resumed)}`),
    onClose: (code) => events.push(`close:${code}`),
    onGoAway: (ms) => events.push(`goAway:${String(ms)}`),
    ...overrides,
  };
}

function makeClient(opts?: {
  callbacks?: GeminiLiveClientCallbacks;
  keepaliveIntervalMs?: number;
  maxAttempts?: number;
  setupTimeoutMs?: number;
}) {
  return new GeminiLiveClient({
    apiKey: "test-key",
    model: "models/test-live",
    systemInstruction: "Be Cue.",
    tools: [{ name: "add_task", description: "add a task" }],
    inputSampleRate: 16000,
    language: "en-US",
    voice: "Aoede",
    callbacks: opts?.callbacks ?? makeCallbacks(),
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    reconnect: { maxAttempts: opts?.maxAttempts ?? 3, backoffMs: () => 0 },
    keepaliveIntervalMs: opts?.keepaliveIntervalMs ?? 0,
    setupTimeoutMs: opts?.setupTimeoutMs ?? 1000,
  });
}

/** Let the reconnect loop's zero-backoff awaits run. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function connect(
  client: import("../gemini-live-client.js").GeminiLiveClient,
): Promise<void> {
  const pending = client.connect();
  sockets[0]!.completeSetup();
  await pending;
}

beforeEach(() => {
  sockets = [];
  events = [];
});

describe("setup payload", () => {
  test("requests session resumption, sliding-window compression, voice + transcription", async () => {
    const client = makeClient();
    await connect(client);

    const setup = sockets[0]!.setup();
    expect(setup.sessionResumption).toEqual({});
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    const generation = setup.generationConfig as Record<string, unknown>;
    expect(generation.speechConfig).toMatchObject({ languageCode: "en-US" });
    client.close();
  });
});

describe("unexpected close → reconnect", () => {
  test("resumes the same session with the granted handle", async () => {
    const client = makeClient();
    await connect(client);
    sockets[0]!.message({
      sessionResumptionUpdate: { newHandle: "h1", resumable: true },
    });

    sockets[0]!.serverClose(1011, "internal error");
    await flush();

    expect(sockets).toHaveLength(2);
    sockets[1]!.completeSetup();
    await flush();
    expect(sockets[1]!.setup().sessionResumption).toEqual({ handle: "h1" });

    expect(events).toEqual([
      "reconnecting:close_1011:internal error",
      "reconnected:true",
    ]);
    client.close();
  });

  test("model output keeps reaching callbacks after the reconnect", async () => {
    const heard: string[] = [];
    const client = makeClient({
      callbacks: makeCallbacks({
        onOutputText: (text) => heard.push(text),
      }),
    });
    await connect(client);
    sockets[0]!.message({
      sessionResumptionUpdate: { newHandle: "h1", resumable: true },
    });
    sockets[0]!.serverClose(1006);
    await flush();
    sockets[1]!.completeSetup();
    await flush();

    sockets[1]!.message({
      serverContent: { outputTranscription: { text: "still here" } },
    });
    expect(heard).toEqual(["still here"]);
    client.close();
  });

  test("without a resumption handle it reconnects fresh and says so", async () => {
    const client = makeClient();
    await connect(client);

    sockets[0]!.serverClose(1006);
    await flush();
    sockets[1]!.completeSetup();
    await flush();

    expect(sockets[1]!.setup().sessionResumption).toEqual({});
    expect(events).toEqual(["reconnecting:close_1006", "reconnected:false"]);
    client.close();
  });

  test("a stale handle falls back to a fresh session on the next attempt", async () => {
    const client = makeClient();
    await connect(client);
    sockets[0]!.message({
      sessionResumptionUpdate: { newHandle: "expired", resumable: true },
    });
    sockets[0]!.serverClose(1011);
    await flush();

    // The resume attempt is rejected at setup — the handle is spent.
    sockets[1]!.open();
    expect(sockets[1]!.setup().sessionResumption).toEqual({
      handle: "expired",
    });
    sockets[1]!.serverClose(1008, "handle expired");
    await flush();

    sockets[2]!.completeSetup();
    await flush();
    expect(sockets[2]!.setup().sessionResumption).toEqual({});
    expect(events).toEqual(["reconnecting:close_1011", "reconnected:false"]);
    client.close();
  });

  test("exhausted retries end the session with a single terminal close", async () => {
    const client = makeClient({ maxAttempts: 2 });
    await connect(client);

    sockets[0]!.serverClose(1011);
    await flush();
    sockets[1]!.open();
    sockets[1]!.serverClose(1011);
    await flush();
    sockets[2]!.open();
    sockets[2]!.serverClose(1011);
    await flush(8);

    expect(sockets).toHaveLength(3);
    expect(events).toEqual(["reconnecting:close_1011", "close:1011"]);

    // Terminal means terminal: nothing else reopens.
    client.sendAudio(new Uint8Array(4));
    await flush();
    expect(sockets).toHaveLength(3);
  });

  test("a wedged reconnect attempt times out instead of hanging forever", async () => {
    const client = makeClient({ maxAttempts: 1, setupTimeoutMs: 5 });
    await connect(client);

    sockets[0]!.serverClose(1006);
    await flush();
    // The attempt socket opens but never completes setup and never closes —
    // without a timeout the reconnect loop would wait on it forever (a
    // silent freeze; the user hears nothing and no terminal frame ever comes).
    sockets[1]!.open();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flush();

    expect(events).toEqual(["reconnecting:close_1006", "close:1006"]);
    expect(sockets[1]!.closedByClient).toBe(true);
  });

  test("a locally requested close() never reconnects", async () => {
    const client = makeClient();
    await connect(client);

    client.close();
    await flush();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closedByClient).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("goAway → proactive migration", () => {
  test("migrates onto a new socket with the resumption handle", async () => {
    const client = makeClient();
    await connect(client);
    sockets[0]!.message({
      sessionResumptionUpdate: { newHandle: "h2", resumable: true },
    });

    sockets[0]!.message({ goAway: { timeLeft: "5s" } });
    await flush();

    expect(sockets[0]!.closedByClient).toBe(true);
    expect(sockets).toHaveLength(2);
    sockets[1]!.completeSetup();
    await flush();
    expect(sockets[1]!.setup().sessionResumption).toEqual({ handle: "h2" });

    expect(events).toEqual([
      "goAway:5000",
      "reconnecting:goAway",
      "reconnected:true",
    ]);
    client.close();
  });

  test("the retired socket's own close event cannot double-reconnect", async () => {
    const client = makeClient();
    await connect(client);
    sockets[0]!.message({ goAway: { timeLeft: "1s" } });
    await flush();
    // The server also delivers the close it warned about.
    sockets[0]!.serverClose(1000, "goodbye");
    await flush();

    expect(sockets).toHaveLength(2);
    expect(events.filter((e) => e.startsWith("reconnecting"))).toHaveLength(1);
    client.close();
  });
});

describe("setup reject (1007) hardening", () => {
  test("retries once without optional fields, then succeeds", async () => {
    const client = makeClient();
    const pending = client.connect();
    sockets[0]!.open();
    sockets[0]!.serverClose(1007, "invalid setup");
    await flush();

    expect(sockets).toHaveLength(2);
    sockets[1]!.completeSetup();
    await pending; // resolves — the retry carried the connect
    const minimal = sockets[1]!.setup();
    // Required fields survive…
    expect(minimal.model).toBe("models/test-live");
    expect(minimal.tools).toBeDefined();
    expect(minimal.systemInstruction).toBeDefined();
    expect(minimal.sessionResumption).toEqual({});
    // …the optional (historically 1007-triggering) fields are stripped.
    expect(minimal.contextWindowCompression).toBeUndefined();
    expect(minimal.inputAudioTranscription).toBeUndefined();
    expect(minimal.outputAudioTranscription).toBeUndefined();
    const generation = minimal.generationConfig as Record<string, unknown>;
    expect(generation.speechConfig).toBeUndefined();
    client.close();
  });

  test("a second rejection surfaces honestly", async () => {
    const client = makeClient();
    const pending = client.connect();
    sockets[0]!.open();
    sockets[0]!.serverClose(1007, "invalid setup");
    await flush();
    sockets[1]!.open();
    sockets[1]!.serverClose(1007, "still invalid");

    await expect(pending).rejects.toThrow(/code=1007/);
    expect(sockets).toHaveLength(2);
  });

  test("once minimal, reconnect replays stay minimal too", async () => {
    const client = makeClient();
    const pending = client.connect();
    sockets[0]!.open();
    sockets[0]!.serverClose(1007);
    await flush();
    sockets[1]!.completeSetup();
    await pending;

    sockets[1]!.serverClose(1006);
    await flush();
    sockets[2]!.completeSetup();
    await flush();
    const replay = sockets[2]!.setup();
    expect(replay.contextWindowCompression).toBeUndefined();
    expect(
      (replay.generationConfig as Record<string, unknown>).speechConfig,
    ).toBeUndefined();
    client.close();
  });
});

describe("mid-tool-call disconnect", () => {
  test("tool responses queued while down are delivered after a resumed reconnect", async () => {
    const client = makeClient();
    await connect(client);
    sockets[0]!.message({
      sessionResumptionUpdate: { newHandle: "h3", resumable: true },
    });

    // The model called a tool, then the socket dropped before the result
    // could be returned.
    sockets[0]!.serverClose(1006);
    client.sendToolResponse([
      { id: "call-1", name: "add_task", response: { ok: true } },
    ]);
    await flush();
    sockets[1]!.completeSetup();
    await flush();

    const toolFrames = sockets[1]!
      .frames()
      .filter((f) => "toolResponse" in f) as Array<{
      toolResponse: { functionResponses: Array<{ id?: string }> };
    }>;
    expect(toolFrames).toHaveLength(1);
    expect(toolFrames[0]!.toolResponse.functionResponses[0]!.id).toBe("call-1");
    client.close();
  });

  test("a fresh session never receives responses to calls it did not make", async () => {
    const client = makeClient();
    await connect(client);

    sockets[0]!.serverClose(1006);
    client.sendToolResponse([
      { id: "call-1", name: "add_task", response: { ok: true } },
    ]);
    await flush();
    sockets[1]!.completeSetup();
    await flush();

    expect(sockets[1]!.frames().filter((f) => "toolResponse" in f)).toEqual([]);
    client.close();
  });
});

describe("idle keepalive", () => {
  test("sends silence upstream when the send path goes quiet", async () => {
    const client = makeClient({ keepaliveIntervalMs: 5 });
    await connect(client);

    // Simulated long user silence with nothing forwarded (the push-to-talk
    // posture — hands-free clients stream silence frames themselves).
    await new Promise((resolve) => setTimeout(resolve, 40));

    const audioFrames = sockets[0]!
      .frames()
      .filter((f) => "realtimeInput" in f) as Array<{
      realtimeInput: { audio?: { data: string; mimeType: string } };
    }>;
    expect(audioFrames.length).toBeGreaterThanOrEqual(1);
    const pcm = Buffer.from(
      audioFrames[0]!.realtimeInput.audio!.data,
      "base64",
    );
    // 20ms of 16-bit mono at 16kHz, and pure silence — inert to server VAD.
    expect(pcm.length).toBe(640);
    expect(pcm.every((b) => b === 0)).toBe(true);
    expect(audioFrames[0]!.realtimeInput.audio!.mimeType).toBe(
      "audio/pcm;rate=16000",
    );
    // The socket survived the idle window.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(1);
    client.close();
  });

  test("stops after close (no timer keeps the process or socket busy)", async () => {
    const client = makeClient({ keepaliveIntervalMs: 5 });
    await connect(client);
    client.close();
    const sentBefore = sockets[0]!.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets[0]!.sent.length).toBe(sentBefore);
  });
});

describe("context note injection", () => {
  test("sendUserText carries a silent text turn (no turn trigger)", async () => {
    const client = makeClient();
    await connect(client);
    client.sendUserText("[Context note: reconnected.]");
    const frame = sockets[0]!.frames().find((f) => "clientContent" in f) as {
      clientContent: {
        turns: Array<{ role: string; parts: Array<{ text: string }> }>;
        turnComplete: boolean;
      };
    };
    expect(frame.clientContent.turnComplete).toBe(false);
    expect(frame.clientContent.turns[0]!.parts[0]!.text).toContain(
      "Context note",
    );
    client.close();
  });
});
