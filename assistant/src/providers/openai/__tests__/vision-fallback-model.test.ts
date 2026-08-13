/**
 * The one-shot vision fallback must retry on a model that can actually see.
 *
 * It used to retry on whatever `CUE_OPENROUTER_MODEL` named — the deploy's
 * brain. On 2026-08-13 prod ran `deepseek/deepseek-v4-pro` (text-only), so an
 * image-bearing turn was refused, "recovered" onto the model that had just
 * refused it, failed again, and then reported the FALLBACK's name as the model
 * lacking vision. Two costs: a request that could never succeed, and an error
 * pointing at a model the caller never configured.
 */
import { describe, expect, test } from "bun:test";

import OpenAI from "openai";

import {
  DEFAULT_OPENROUTER_VISION_MODEL,
  resolveVisionFallbackModel,
} from "../../model-catalog.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

const TEXT_ONLY = "deepseek/deepseek-v4-pro";

describe("resolveVisionFallbackModel", () => {
  test("skips a text-only CUE_OPENROUTER_MODEL and picks a model that can see", () => {
    // The exact prod shape that made the fallback useless.
    expect(
      resolveVisionFallbackModel(TEXT_ONLY, {
        CUE_OPENROUTER_MODEL: TEXT_ONLY,
      }),
    ).toBe(DEFAULT_OPENROUTER_VISION_MODEL);
  });

  test("skips a text-only configured model even when a different model failed", () => {
    expect(
      resolveVisionFallbackModel("some/other-model", {
        CUE_OPENROUTER_MODEL: TEXT_ONLY,
      }),
    ).toBe(DEFAULT_OPENROUTER_VISION_MODEL);
  });

  test("an explicit vision override wins", () => {
    expect(
      resolveVisionFallbackModel(TEXT_ONLY, {
        CUE_OPENROUTER_VISION_MODEL: "vendor/some-vision-model",
        CUE_OPENROUTER_MODEL: TEXT_ONLY,
      }),
    ).toBe("vendor/some-vision-model");
  });

  test("keeps using the configured model when it is not known text-only", () => {
    // Catalog-unknown must NOT be treated as text-only: the catalog does not
    // carry every OpenRouter id, and the model this deploy runs vision on is
    // itself unknown to it.
    expect(
      resolveVisionFallbackModel(TEXT_ONLY, {
        CUE_OPENROUTER_MODEL: "vendor/unlisted-model",
      }),
    ).toBe("vendor/unlisted-model");
  });

  test("never returns the model that just failed", () => {
    expect(
      resolveVisionFallbackModel(DEFAULT_OPENROUTER_VISION_MODEL, {
        CUE_OPENROUTER_MODEL: DEFAULT_OPENROUTER_VISION_MODEL,
      }),
    ).toBeUndefined();
  });

  test("falls back to the default when nothing is configured", () => {
    expect(resolveVisionFallbackModel(TEXT_ONLY, {})).toBe(
      DEFAULT_OPENROUTER_VISION_MODEL,
    );
  });
});

// ---------------------------------------------------------------------------
// End to end through the provider: does the retry actually happen, and does the
// error name the model the caller chose?
// ---------------------------------------------------------------------------

function visionRefusal(): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(
    404,
    {
      error: { message: "No endpoints found that support image input" },
    } as Record<string, unknown>,
    undefined,
    new Headers(),
  );
}

const IMAGE_MESSAGES = [
  {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "what is this" },
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/png" as const,
          data: "iVBORw0KGgo=",
        },
      },
    ],
  },
];

/** Build an OpenRouter provider whose every request refuses the image. */
function buildRefusingProvider(model: string): {
  provider: OpenAIChatCompletionsProvider;
  modelsTried: string[];
} {
  const provider = new OpenAIChatCompletionsProvider("test-key", model, {
    providerName: "openrouter",
    providerLabel: "OpenRouter",
  });
  const modelsTried: string[] = [];
  (
    provider as unknown as {
      client: { chat: { completions: { create: unknown } } };
    }
  ).client = {
    chat: {
      completions: {
        create: (params: { model: string }) => {
          modelsTried.push(params.model);
          throw visionRefusal();
        },
      },
    },
  } as never;
  return { provider, modelsTried };
}

describe("vision fallback through the provider", () => {
  const saved = {
    model: process.env.CUE_OPENROUTER_MODEL,
    vision: process.env.CUE_OPENROUTER_VISION_MODEL,
  };
  const restore = () => {
    if (saved.model === undefined) delete process.env.CUE_OPENROUTER_MODEL;
    else process.env.CUE_OPENROUTER_MODEL = saved.model;
    if (saved.vision === undefined)
      delete process.env.CUE_OPENROUTER_VISION_MODEL;
    else process.env.CUE_OPENROUTER_VISION_MODEL = saved.vision;
  };

  test("retries on a vision-capable model, not the text-only configured one", async () => {
    process.env.CUE_OPENROUTER_MODEL = TEXT_ONLY;
    delete process.env.CUE_OPENROUTER_VISION_MODEL;
    const { provider, modelsTried } = buildRefusingProvider(TEXT_ONLY);
    try {
      await expect(provider.sendMessage(IMAGE_MESSAGES)).rejects.toThrow(
        /doesn't support image input/,
      );
      // Two attempts: the original, then a model that can actually see —
      // never the text-only one a second time.
      expect(modelsTried).toEqual([TEXT_ONLY, DEFAULT_OPENROUTER_VISION_MODEL]);
    } finally {
      restore();
    }
  });

  test("names the ORIGINAL model in the error, not the fallback", async () => {
    process.env.CUE_OPENROUTER_MODEL = TEXT_ONLY;
    delete process.env.CUE_OPENROUTER_VISION_MODEL;
    const { provider } = buildRefusingProvider(TEXT_ONLY);
    try {
      await expect(provider.sendMessage(IMAGE_MESSAGES)).rejects.toThrow(
        new RegExp(`This model \\(${TEXT_ONLY.replace("/", "\\/")}\\)`),
      );
    } finally {
      restore();
    }
  });

  test("issues no retry when no vision-capable fallback can be resolved", async () => {
    // The failing model IS the only candidate, so there is nothing better to
    // try — burning a second request would just add latency to a certain
    // failure.
    process.env.CUE_OPENROUTER_MODEL = DEFAULT_OPENROUTER_VISION_MODEL;
    delete process.env.CUE_OPENROUTER_VISION_MODEL;
    const { provider, modelsTried } = buildRefusingProvider(
      DEFAULT_OPENROUTER_VISION_MODEL,
    );
    try {
      await expect(provider.sendMessage(IMAGE_MESSAGES)).rejects.toThrow(
        new RegExp(
          `This model \\(${DEFAULT_OPENROUTER_VISION_MODEL.replace("/", "\\/")}\\)`,
        ),
      );
      expect(modelsTried).toEqual([DEFAULT_OPENROUTER_VISION_MODEL]);
    } finally {
      restore();
    }
  });

  test("does not retry a text-only refusal that carries no image", async () => {
    process.env.CUE_OPENROUTER_MODEL = TEXT_ONLY;
    const { provider, modelsTried } = buildRefusingProvider(TEXT_ONLY);
    try {
      await expect(
        provider.sendMessage([
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "no image here" }],
          },
        ]),
      ).rejects.toThrow(/doesn't support image input/);
      expect(modelsTried).toEqual([TEXT_ONLY]);
    } finally {
      restore();
    }
  });
});
