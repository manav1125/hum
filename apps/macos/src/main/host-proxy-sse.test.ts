import { afterEach, describe, expect, mock, test } from "bun:test";

// Stub device-id so we don't touch the filesystem.
const MOCK_DEVICE_ID = "test-device-00000000-0000-0000-0000-000000000000";
mock.module("./device-id", () => ({
  getDeviceId: () => MOCK_DEVICE_ID,
}));

const { HostProxySseClient } = await import("./host-proxy-sse");
type HostProxySseMessage = import("./host-proxy-sse").HostProxySseMessage;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream that pushes encoded SSE chunks then closes. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Build a ReadableStream that yields chunks on demand via a push function. */
function controllableStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (text: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    stream,
    push: (text: string) => ctrl.enqueue(encoder.encode(text)),
    close: () => ctrl.close(),
  };
}

/** Create a mock fetch that returns a streaming SSE response. */
function mockFetch(
  body: ReadableStream<Uint8Array>,
  status = 200,
): typeof globalThis.fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    })) as unknown as typeof globalThis.fetch;
}

/** Flush pending microtasks / timers so stream processing can complete. */
async function flush(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HostProxySseClient", () => {
  let client: InstanceType<typeof HostProxySseClient>;

  afterEach(() => {
    client?.disconnect();
  });

  // -- Basic SSE parsing --------------------------------------------------

  test("parses data frames and delivers messages via callback", async () => {
    const messages: HostProxySseMessage[] = [];
    const body = sseStream([
      'data: {"type":"ping"}\n\n',
      'data: {"type":"host_bash_request","conversationId":"c1"}\n\n',
    ]);

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(body),
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    await flush(50);

    expect(messages).toHaveLength(2);
    expect(messages[0]!.type).toBe("ping");
    expect(messages[1]!.type).toBe("host_bash_request");
  });

  test("ignores heartbeat comments", async () => {
    const messages: HostProxySseMessage[] = [];
    const body = sseStream([
      ": heartbeat\n",
      'data: {"type":"ping"}\n\n',
      ": another heartbeat\n",
    ]);

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(body),
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    await flush(50);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("ping");
  });

  test("skips malformed JSON data lines", async () => {
    const messages: HostProxySseMessage[] = [];
    const body = sseStream([
      "data: not json\n\n",
      'data: {"type":"ok"}\n\n',
    ]);

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(body),
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    await flush(50);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("ok");
  });

  // -- Connection state ---------------------------------------------------

  test("isConnected reflects stream state", async () => {
    const { stream, close } = controllableStream();
    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(stream),
    });

    expect(client.isConnected).toBe(false);
    client.connect();

    // Wait for the fetch response to resolve
    await flush(50);
    expect(client.isConnected).toBe(true);

    close();
    await flush(50);
    // After stream closes, connected should be false (reconnect may be scheduled
    // but the stream itself is down).
    expect(client.isConnected).toBe(false);
  });

  // -- Reconnection on error ---------------------------------------------

  test("reconnects with backoff on fetch failure", async () => {
    let fetchCount = 0;
    const messages: HostProxySseMessage[] = [];

    const fakeFetch: typeof globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount < 3) {
        throw new Error("network error");
      }
      // Third attempt succeeds
      return new Response(sseStream(['data: {"type":"recovered"}\n\n']), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: fakeFetch,
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    // Wait for reconnect attempts (1s + 2s backoff)
    await flush(4_000);

    expect(fetchCount).toBeGreaterThanOrEqual(3);
    expect(messages.some((m) => m.type === "recovered")).toBe(true);
  });

  test("reconnects on non-200 response", async () => {
    let fetchCount = 0;
    const fakeFetch: typeof globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        // A connection problem, NOT an auth rejection. 401 used to stand in
        // for "non-200" here; it now has its own policy (see the auth tests
        // below), and a fixture that conflates the two would assert the
        // opposite of what the client must do.
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response(sseStream(['data: {"type":"ok"}\n\n']), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    const messages: HostProxySseMessage[] = [];
    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: fakeFetch,
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    await flush(2_000);

    expect(fetchCount).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.type === "ok")).toBe(true);
  });

  // -- Idle watchdog ------------------------------------------------------

  test("idle watchdog triggers reconnect when no traffic arrives", async () => {
    let fetchCount = 0;
    const { stream, push } = controllableStream();

    const fakeFetch: typeof globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      // Second connect: return a fresh stream that closes immediately
      return new Response(sseStream(['data: {"type":"reconnected"}\n\n']), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    const messages: HostProxySseMessage[] = [];
    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: fakeFetch,
      idleTimeoutMs: 200,
      idleCheckIntervalMs: 100,
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    // Push initial data so stream is established
    await flush(50);
    push('data: {"type":"initial"}\n\n');
    await flush(50);

    // Wait for idle timeout (200ms) + check interval (100ms) + reconnect buffer
    await flush(1_500);

    expect(fetchCount).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.type === "reconnected")).toBe(true);
  });

  // -- Disconnect ---------------------------------------------------------

  test("disconnect cancels timers and stream", async () => {
    const { stream } = controllableStream();
    let fetchCount = 0;

    const fakeFetch: typeof globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: fakeFetch,
    });
    client.connect();
    await flush(50);
    expect(client.isConnected).toBe(true);

    client.disconnect();
    expect(client.isConnected).toBe(false);

    // Wait to confirm no reconnect happens
    await flush(3_000);
    expect(fetchCount).toBe(1);
  });

  // -- Request headers ----------------------------------------------------

  test("sends correct headers for local connection", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const fakeFetch: typeof globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(input);
      const h = init?.headers as Record<string, string> | undefined;
      if (h) capturedHeaders = { ...h };
      return new Response(sseStream([]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:8080/v1/events",
      authHeaders: () => ({ Authorization: "Bearer my-token" }),
      fetch: fakeFetch,
    });
    client.connect();
    await flush(50);

    expect(capturedUrl).toBe("http://127.0.0.1:8080/v1/events");
    expect(capturedHeaders["Authorization"]).toBe("Bearer my-token");
    expect(capturedHeaders["Accept"]).toBe(
      "text/event-stream, application/json",
    );
    expect(capturedHeaders["X-Vellum-Client-Id"]).toBe(MOCK_DEVICE_ID);
    expect(capturedHeaders["X-Vellum-Interface-Id"]).toBe("macos");
    expect(capturedHeaders["X-Vellum-Machine-Name"]).toBeTruthy();
  });

  test("MUTATION CHECK: it advertises host_observe so the daemon may ask", async () => {
    // The daemon does NOT derive `host_observe` from the interface type — a
    // Mac is not assumed to be able to observe, because every build shipped
    // before screen observation cannot. This header is the only thing that
    // turns the capability on, so dropping it silently disables watching
    // rather than breaking it visibly.
    let capturedHeaders: Record<string, string> = {};
    const fakeFetch: typeof globalThis.fetch = (async (
      _url: string,
      init?: RequestInit,
    ) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(null, { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:8080/v1/events",
      authHeaders: () => ({ Authorization: "Bearer my-token" }),
      fetch: fakeFetch,
    });
    client.connect();
    await flush(50);

    expect(capturedHeaders["X-Vellum-Host-Capabilities"]).toContain(
      "host_observe",
    );
    client.disconnect();
  });

  test("sends correct headers for cloud connection", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const fakeFetch: typeof globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(input);
      const h = init?.headers as Record<string, string> | undefined;
      if (h) capturedHeaders = { ...h };
      return new Response(sseStream([]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "https://platform.vellum.ai/v1/assistants/asst-123/events",
      authHeaders: () => ({ "X-Session-Token": "session-tok-abc" }),
      fetch: fakeFetch,
    });
    client.connect();
    await flush(50);

    expect(capturedUrl).toBe("https://platform.vellum.ai/v1/assistants/asst-123/events");
    expect(capturedHeaders["X-Session-Token"]).toBe("session-tok-abc");
    expect(capturedHeaders["Authorization"]).toBeUndefined();
    expect(capturedHeaders["X-Vellum-Client-Id"]).toBe(MOCK_DEVICE_ID);
    expect(capturedHeaders["X-Vellum-Interface-Id"]).toBe("macos");
  });

  // -- Chunked data handling ----------------------------------------------

  test("handles data split across multiple chunks", async () => {
    const messages: HostProxySseMessage[] = [];
    // JSON payload split across two chunks
    const body = sseStream([
      'data: {"type":"sp',
      'lit_msg","val":1}\n\n',
    ]);

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(body),
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    await flush(50);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("split_msg");
  });
});

/**
 * The give-up the main process never had.
 *
 * Every non-OK response was treated as a connection problem and retried
 * forever. A 401 is not one: reopening cannot mint a valid credential, and
 * each attempt records another auth failure against this IP in the gateway's
 * limiter — ten in sixty seconds blocks it, which locks the owner out of
 * their own instance. The desktop app did exactly this against a live
 * instance, every thirty seconds, with a token signed by a retired key.
 */
describe("HostProxySseClient auth rejections", () => {
  let client: InstanceType<typeof HostProxySseClient> | null = null;
  afterEach(() => {
    client?.disconnect();
    client = null;
  });

  test("REGRESSION: a rejected credential stops, it does not hammer", async () => {
    let fetchCount = 0;
    const fakeFetch = (async () => {
      fetchCount += 1;
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof globalThis.fetch;

    let rejected = 0;
    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer stale" }),
      fetch: fakeFetch,
      onRefreshToken: () => Promise.resolve("stale"),
      onAuthRejected: () => {
        rejected += 1;
      },
    });
    client.connect();
    await flush(3_000);

    // One refresh is allowed, because a new connect link can re-seed the
    // token while the app runs. The second rejection is the credential.
    expect(fetchCount).toBe(2);
    expect(rejected).toBe(1);
  });

  test("with nothing able to refresh it, the first rejection is final", async () => {
    let fetchCount = 0;
    const fakeFetch = (async () => {
      fetchCount += 1;
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer stale" }),
      fetch: fakeFetch,
    });
    client.connect();
    await flush(3_000);

    // Retrying would present the identical token, so there is nothing to
    // learn from a second attempt and a limiter strike to lose.
    expect(fetchCount).toBe(1);
  });

  test("a refresh that produces a working token recovers", async () => {
    let fetchCount = 0;
    let token = "stale";
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      fetchCount += 1;
      const auth = (init.headers as Record<string, string>).Authorization;
      if (auth !== "Bearer fresh") {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(sseStream(['data: {"type":"ok"}\n\n']), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    const messages: HostProxySseMessage[] = [];
    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: `Bearer ${token}` }),
      fetch: fakeFetch,
      onRefreshToken: () => {
        token = "fresh";
        return Promise.resolve(token);
      },
    });
    client.setMessageCallback((m: HostProxySseMessage) => messages.push(m));
    client.connect();
    await flush(3_000);

    expect(messages.some((m) => m.type === "ok")).toBe(true);
  });
});
