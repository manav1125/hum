import { describe, expect, test } from "bun:test";

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { LLMSchema } from "../config/schemas/llm.js";
import { getCatalogVisionSupport } from "../providers/model-catalog.js";
import type { ContentBlock, Message } from "../providers/types.js";
import { resolveFlashTierRouteForTurn } from "./flash-tier.js";
import {
  DEFAULT_OPENROUTER_VISION_MODEL,
  historyCarriesImageInput,
  resolveModelRouteForTurn,
  resolveVisionTierModel,
  resolveVisionTierRouteForTurn,
} from "./vision-tier.js";

function user(...content: Array<string | ContentBlock>): Message {
  return {
    role: "user",
    content: content.map((c) =>
      typeof c === "string" ? { type: "text", text: c } : c,
    ),
  };
}

function assistant(...content: Array<string | ContentBlock>): Message {
  return {
    role: "assistant",
    content: content.map((c) =>
      typeof c === "string" ? { type: "text", text: c } : c,
    ),
  };
}

const imageBlock: ContentBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "aGk=" },
};

const fileBlock: ContentBlock = {
  type: "file",
  source: {
    type: "base64",
    media_type: "application/pdf",
    data: "aGk=",
    filename: "a.pdf",
  },
};

const toolResultWithImage: ContentBlock = {
  type: "tool_result",
  tool_use_id: "tu_1",
  content: "screenshot taken",
  contentBlocks: [imageBlock],
};

// Catalog fixtures. `TEXT_ONLY_MODEL` is the actual prod brain; the suite
// asserts its catalog capability up front so a catalog change that would
// silently defuse these tests fails loudly instead.
const TEXT_ONLY_MODEL = "deepseek/deepseek-v4-pro";
const VISION_MODEL = "moonshotai/kimi-k2.6"; // catalog: openrouter, vision+tools
const UNKNOWN_MODEL = "qwen/qwen2.5-vl-72b-instruct"; // deliberately uncataloged

/** llm config whose mainAgent resolves to the text-only OpenRouter brain. */
function textOnlyLlm(overrides: Record<string, unknown> = {}) {
  return LLMSchema.parse({
    profiles: {
      textonly: { model: TEXT_ONLY_MODEL, provider: "openrouter" },
    },
    activeProfile: "textonly",
    ...overrides,
  });
}

describe("catalog fixtures", () => {
  test("hold the capabilities the suite depends on", () => {
    expect(getCatalogVisionSupport(TEXT_ONLY_MODEL)).toBe(false);
    expect(getCatalogVisionSupport(VISION_MODEL)).toBe(true);
    expect(getCatalogVisionSupport(UNKNOWN_MODEL)).toBeUndefined();
    expect(getCatalogVisionSupport(DEFAULT_OPENROUTER_VISION_MODEL)).toBe(
      undefined,
    );
  });
});

describe("historyCarriesImageInput", () => {
  test("detects an image in the trailing user message", () => {
    expect(historyCarriesImageInput([user("look", imageBlock)])).toBe(true);
  });

  test("detects an image earlier in history (payload still carries it)", () => {
    expect(
      historyCarriesImageInput([
        user("look", imageBlock),
        assistant("I see a chart"),
        user("what is the y axis?"),
      ]),
    ).toBe(true);
  });

  test("detects an image inside a tool_result's contentBlocks", () => {
    expect(
      historyCarriesImageInput([
        user("screenshot the page"),
        user(toolResultWithImage),
      ]),
    ).toBe(true);
  });

  test("ignores file blocks (serialized as text on the wire)", () => {
    expect(historyCarriesImageInput([user("read this", fileBlock)])).toBe(
      false,
    );
  });

  test("false for plain text history and empty history", () => {
    expect(historyCarriesImageInput([user("hi"), assistant("hello")])).toBe(
      false,
    );
    expect(historyCarriesImageInput([])).toBe(false);
  });
});

describe("resolveVisionTierModel", () => {
  const base = { mainProvider: "openrouter", mainModel: TEXT_ONLY_MODEL };

  test("explicit llm.visionTier.model wins", () => {
    const llm = textOnlyLlm({ visionTier: { model: VISION_MODEL } });
    expect(resolveVisionTierModel(llm, base)).toBe(VISION_MODEL);
  });

  test("explicit catalog-unknown model is accepted (cannot be proven wrong)", () => {
    const llm = textOnlyLlm({ visionTier: { model: "my/custom-vlm" } });
    expect(resolveVisionTierModel(llm, base)).toBe("my/custom-vlm");
  });

  test("explicit model equal to the turn's model is a respected no-op", () => {
    const llm = textOnlyLlm({ visionTier: { model: TEXT_ONLY_MODEL } });
    expect(resolveVisionTierModel(llm, base)).toBeUndefined();
  });

  test("explicit model on a foreign provider falls through to the default", () => {
    // gemini-2.5-flash is catalog-known under the gemini provider only.
    const llm = textOnlyLlm({ visionTier: { model: "gemini-2.5-flash" } });
    expect(resolveVisionTierModel(llm, base)).toBe(
      DEFAULT_OPENROUTER_VISION_MODEL,
    );
  });

  test("explicit known-text-only model falls through to the default", () => {
    const llm = textOnlyLlm({
      visionTier: { model: "deepseek/deepseek-v4-flash" },
    });
    expect(resolveVisionTierModel(llm, base)).toBe(
      DEFAULT_OPENROUTER_VISION_MODEL,
    );
  });

  test("falls back to the resolved cueLiveVision call-site model", () => {
    const llm = textOnlyLlm({
      callSites: {
        cueLiveVision: { model: UNKNOWN_MODEL, provider: "openrouter" },
      },
    });
    expect(resolveVisionTierModel(llm, base)).toBe(UNKNOWN_MODEL);
  });

  test("skips a cueLiveVision resolution that is itself known text-only", () => {
    const llm = textOnlyLlm({
      callSites: {
        cueLiveVision: {
          model: "deepseek/deepseek-v4-flash",
          provider: "openrouter",
        },
      },
    });
    expect(resolveVisionTierModel(llm, base)).toBe(
      DEFAULT_OPENROUTER_VISION_MODEL,
    );
  });

  test("skips a cueLiveVision resolution on a different provider", () => {
    const llm = textOnlyLlm({
      callSites: {
        cueLiveVision: { model: "gemini-2.5-flash", provider: "gemini" },
      },
    });
    expect(resolveVisionTierModel(llm, base)).toBe(
      DEFAULT_OPENROUTER_VISION_MODEL,
    );
  });

  test("openrouter turns get the proven default when nothing is configured", () => {
    expect(resolveVisionTierModel(textOnlyLlm(), base)).toBe(
      DEFAULT_OPENROUTER_VISION_MODEL,
    );
  });

  test("non-openrouter providers have no default (no reroute)", () => {
    const llm = LLMSchema.parse({
      profiles: {
        local: { model: "llama3.2", provider: "ollama" },
      },
      activeProfile: "local",
    });
    expect(
      resolveVisionTierModel(llm, {
        mainProvider: "ollama",
        mainModel: "llama3.2",
      }),
    ).toBeUndefined();
  });
});

describe("resolveVisionTierRouteForTurn", () => {
  const imageHistory = [user("what is in this image?", imageBlock)];

  test("routes an image round on a known text-only model to the vision model", () => {
    const route = resolveVisionTierRouteForTurn({
      llm: textOnlyLlm(),
      history: imageHistory,
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toEqual({
      model: DEFAULT_OPENROUTER_VISION_MODEL,
      reason: "image_with_text_only_model",
    });
  });

  test("enabled by default", () => {
    expect(LLMSchema.parse({}).visionTier.enabled).toBe(true);
  });

  test("no image → untouched", () => {
    const route = resolveVisionTierRouteForTurn({
      llm: textOnlyLlm(),
      history: [user("hello there")],
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toBeNull();
  });

  test("disabled via config → untouched", () => {
    const route = resolveVisionTierRouteForTurn({
      llm: textOnlyLlm({ visionTier: { enabled: false } }),
      history: imageHistory,
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toBeNull();
  });

  test("vision-capable resolved model → untouched", () => {
    // Default config resolves to a Claude model, which supports vision.
    const llm = LLMSchema.parse({});
    expect(
      getCatalogVisionSupport(resolveCallSiteConfig("mainAgent", llm).model),
    ).toBe(true);
    const route = resolveVisionTierRouteForTurn({
      llm,
      history: imageHistory,
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toBeNull();
  });

  test("catalog-unknown resolved model → untouched (not provably text-only)", () => {
    const llm = LLMSchema.parse({
      profiles: {
        custom: { model: "my/unknown-model", provider: "openrouter" },
      },
      activeProfile: "custom",
    });
    const route = resolveVisionTierRouteForTurn({
      llm,
      history: imageHistory,
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toBeNull();
  });

  test("routes THROUGH a pinned override profile (text-only pin + image → vision)", () => {
    const llm = textOnlyLlm({
      profiles: {
        textonly: { model: TEXT_ONLY_MODEL, provider: "openrouter" },
        pinned: { model: "deepseek/deepseek-v4-flash", provider: "openrouter" },
      },
    });
    const route = resolveVisionTierRouteForTurn({
      llm,
      history: imageHistory,
      callSite: "mainAgent",
      overrideProfile: "pinned",
    });
    expect(route?.model).toBe(DEFAULT_OPENROUTER_VISION_MODEL);
  });

  test("a pinned vision-capable profile is left alone", () => {
    const llm = textOnlyLlm({
      profiles: {
        textonly: { model: TEXT_ONLY_MODEL, provider: "openrouter" },
        pinned: { model: VISION_MODEL, provider: "openrouter" },
      },
    });
    const route = resolveVisionTierRouteForTurn({
      llm,
      history: imageHistory,
      callSite: "mainAgent",
      overrideProfile: "pinned",
    });
    expect(route).toBeNull();
  });

  test("explicit per-conversation model override is still vision-checked", () => {
    const route = resolveVisionTierRouteForTurn({
      llm: textOnlyLlm(),
      history: imageHistory,
      callSite: "mainAgent",
      overrideProfile: undefined,
      explicitModel: TEXT_ONLY_MODEL,
    });
    expect(route?.model).toBe(DEFAULT_OPENROUTER_VISION_MODEL);
  });

  test("non-mainAgent call sites route too", () => {
    const route = resolveVisionTierRouteForTurn({
      llm: textOnlyLlm(),
      history: [user("bg task"), user(toolResultWithImage)],
      callSite: "subagentSpawn",
      overrideProfile: undefined,
    });
    expect(route?.model).toBe(DEFAULT_OPENROUTER_VISION_MODEL);
  });

  test("text-only rounds after an image round re-evaluate per round (no image → no route)", () => {
    // Same conversation, but the image-bearing messages were compacted away:
    // the round is judged purely on the history it will actually send.
    const route = resolveVisionTierRouteForTurn({
      llm: textOnlyLlm(),
      history: [
        assistant("summary of earlier image discussion"),
        user("thanks"),
      ],
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toBeNull();
  });
});

describe("resolveModelRouteForTurn (vision beats flash)", () => {
  // History crafted so BOTH tiers want to route: a trivial trailing user
  // message (flash-eligible — flash only inspects the trailing message and
  // the tool-activity window) with an image two turns earlier that the
  // request payload still carries.
  const bothEligible: Message[] = [
    user("look at this", imageBlock),
    assistant("nice chart"),
    user("thanks!"),
  ];

  function bothTiersLlm() {
    return textOnlyLlm({
      flashTier: { enabled: true, model: "deepseek/deepseek-v4-flash" },
    });
  }

  test("sanity: flash-tier alone WOULD route this image-bearing history", () => {
    const flash = resolveFlashTierRouteForTurn({
      llm: bothTiersLlm(),
      history: bothEligible,
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(flash?.model).toBe("deepseek/deepseek-v4-flash");
  });

  test("vision wins over flash for image-bearing rounds", () => {
    const route = resolveModelRouteForTurn({
      llm: bothTiersLlm(),
      history: bothEligible,
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toEqual({
      tier: "vision",
      model: DEFAULT_OPENROUTER_VISION_MODEL,
      reason: "image_with_text_only_model",
    });
  });

  test("flash still routes text-only trivial rounds", () => {
    const route = resolveModelRouteForTurn({
      llm: bothTiersLlm(),
      history: [user("what is 2+2?")],
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toEqual({
      tier: "flash",
      model: "deepseek/deepseek-v4-flash",
      reason: "trivial_structural",
    });
  });

  test("an explicit model override disables flash but not vision", () => {
    // Text-only explicit model + no image → no route at all (explicit wins).
    expect(
      resolveModelRouteForTurn({
        llm: bothTiersLlm(),
        history: [user("what is 2+2?")],
        callSite: "mainAgent",
        overrideProfile: undefined,
        explicitModel: TEXT_ONLY_MODEL,
      }),
    ).toBeNull();
    // Text-only explicit model + image → vision reroute.
    expect(
      resolveModelRouteForTurn({
        llm: bothTiersLlm(),
        history: bothEligible,
        callSite: "mainAgent",
        overrideProfile: undefined,
        explicitModel: TEXT_ONLY_MODEL,
      })?.tier,
    ).toBe("vision");
  });

  test("no route when neither tier applies", () => {
    const route = resolveModelRouteForTurn({
      llm: LLMSchema.parse({}),
      history: [user("hello")],
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toBeNull();
  });
});
