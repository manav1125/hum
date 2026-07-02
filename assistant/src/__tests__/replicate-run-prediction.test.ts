import { afterEach, describe, expect, test } from "bun:test";

import { executeReplicatePrediction } from "../config/bundled-skills/replicate/tools/replicate-run.js";

// ---------------------------------------------------------------------------
// Hermetic fetch stubbing — no real Replicate calls.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
    handler(String(input), init)) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("executeReplicatePrediction", () => {
  test("owner/name model creates via the models endpoint and returns urls on sync success", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch(async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          id: "pred-1",
          status: "succeeded",
          output: ["https://replicate.delivery/out.png"],
        }),
        { status: 200 },
      );
    });

    const result = await executeReplicatePrediction({
      model: "black-forest-labs/flux-schnell",
      input: { prompt: "a fox" },
      token: "r8_tok",
    });

    expect(result).toEqual({
      ok: true,
      urls: ["https://replicate.delivery/out.png"],
      output: ["https://replicate.delivery/out.png"],
    });
    expect(requests).toHaveLength(1);
    const create = requests[0]!;
    expect(create.url).toBe(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
    );
    const headers = create.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer r8_tok");
    // Sync-hold header caps at 60s regardless of waitSeconds default (120s).
    expect(headers.Prefer).toBe("wait=60");
    expect(JSON.parse(String(create.init?.body))).toEqual({
      input: { prompt: "a fox" },
    });
  });

  test("owner/name:version pins the version via the /predictions endpoint", async () => {
    let createUrl = "";
    let createBody: Record<string, unknown> = {};
    stubFetch(async (url, init) => {
      createUrl = url;
      createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "p",
          status: "succeeded",
          output: "https://x/y.png",
        }),
        { status: 200 },
      );
    });

    const version = "a".repeat(64);
    const result = await executeReplicatePrediction({
      model: `stability-ai/sdxl:${version}`,
      input: { prompt: "hi" },
      token: "r8_tok",
    });

    expect(result.ok).toBe(true);
    expect(createUrl).toBe("https://api.replicate.com/v1/predictions");
    expect(createBody).toEqual({ version, input: { prompt: "hi" } });
  });

  test("invalid model shape fails without any network call", async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    const result = await executeReplicatePrediction({
      model: "not-a-model",
      input: {},
      token: "r8_tok",
    });

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toContain('Invalid model "not-a-model"');
    expect(called).toBe(false);
  });

  test("HTTP error on create surfaces status and body", async () => {
    stubFetch(async () => new Response("payment required", { status: 402 }));

    const result = await executeReplicatePrediction({
      model: "black-forest-labs/flux-schnell",
      input: { prompt: "a fox" },
      token: "r8_tok",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("HTTP 402");
      expect(result.error).toContain("payment required");
    }
  });

  test("failed prediction status surfaces the model error detail", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({ id: "p", status: "failed", error: "NSFW content" }),
          { status: 200 },
        ),
    );

    const result = await executeReplicatePrediction({
      model: "black-forest-labs/flux-schnell",
      input: { prompt: "a fox" },
      token: "r8_tok",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Replicate prediction failed");
      expect(result.error).toContain("NSFW content");
    }
  });

  test("string output is flattened to a single url", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            id: "p",
            status: "succeeded",
            output: "https://replicate.delivery/single.png",
          }),
          { status: 200 },
        ),
    );

    const result = await executeReplicatePrediction({
      model: "black-forest-labs/flux-schnell",
      input: { prompt: "a fox" },
      token: "r8_tok",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.urls).toEqual(["https://replicate.delivery/single.png"]);
    }
  });
});
