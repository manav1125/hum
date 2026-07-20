import { describe, expect, test } from "bun:test";

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { LLMSchema } from "../config/schemas/llm.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import type { ContentBlock, Message } from "../providers/types.js";
import {
  classifyTurnForFlashTier,
  resolveFlashTierModel,
  resolveFlashTierRouteForTurn,
} from "./flash-tier.js";

const MAX_CHARS = { maxUserChars: 280 };

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

const toolUse: ContentBlock = {
  type: "tool_use",
  id: "tu_1",
  name: "web_search",
  input: {},
};

const toolResult: ContentBlock = {
  type: "tool_result",
  tool_use_id: "tu_1",
  content: "ok",
};

const imageBlock: ContentBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "aGk=" },
};

describe("classifyTurnForFlashTier", () => {
  test("routes a short plain user turn", () => {
    const decision = classifyTurnForFlashTier(
      [user("hi"), assistant("hello"), user("what is 2+2?")],
      MAX_CHARS,
    );
    expect(decision).toEqual({ route: true, reason: "trivial_structural" });
  });

  test("rejects empty history", () => {
    expect(classifyTurnForFlashTier([], MAX_CHARS).reason).toBe(
      "empty_history",
    );
  });

  test("rejects when the last message is not a user message", () => {
    const decision = classifyTurnForFlashTier(
      [user("hi"), assistant("hello")],
      MAX_CHARS,
    );
    expect(decision.reason).toBe("last_message_not_user");
  });

  test("rejects long user text", () => {
    const decision = classifyTurnForFlashTier(
      [user("x".repeat(300))],
      MAX_CHARS,
    );
    expect(decision).toEqual({ route: false, reason: "user_text_too_long" });
  });

  test("rejects attachments (image / file blocks)", () => {
    expect(
      classifyTurnForFlashTier([user("look", imageBlock)], MAX_CHARS).reason,
    ).toBe("attachments_present");
    const fileBlock: ContentBlock = {
      type: "file",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "aGk=",
        filename: "a.pdf",
      },
    };
    expect(
      classifyTurnForFlashTier([user("read", fileBlock)], MAX_CHARS).reason,
    ).toBe("attachments_present");
  });

  test("rejects recent tool activity (mid-task window)", () => {
    const decision = classifyTurnForFlashTier(
      [user("do the thing"), assistant(toolUse), user(toolResult), user("ok?")],
      MAX_CHARS,
    );
    expect(decision.reason).toBe("recent_tool_activity");
  });

  test("rejects mid-loop rounds (last user message is a tool_result)", () => {
    const decision = classifyTurnForFlashTier(
      [user("check the weather"), assistant(toolUse), user(toolResult)],
      MAX_CHARS,
    );
    expect(decision.reason).toBe("recent_tool_activity");
  });

  test("routes when tool activity is older than the window", () => {
    const history: Message[] = [
      user("do the thing"),
      assistant(toolUse),
      user(toolResult),
      assistant("done"),
      // 5 trailing messages with no tool blocks:
      user("thanks"),
      assistant("anytime"),
      user("nice"),
      assistant("yep"),
      user("what is 2+2?"),
    ];
    expect(classifyTurnForFlashTier(history, MAX_CHARS).route).toBe(true);
  });

  test("excludes runtime-injected blocks from the length check", () => {
    const injected = `<memory>\n${"m".repeat(5000)}\n</memory>`;
    const turnContext = `<turn_context>\n${"c".repeat(2000)}\n</turn_context>`;
    const decision = classifyTurnForFlashTier(
      [user(injected, turnContext, "what is 2+2?")],
      MAX_CHARS,
    );
    expect(decision).toEqual({ route: true, reason: "trivial_structural" });
  });

  test("rejects an injection-only user message (no user-authored text)", () => {
    const decision = classifyTurnForFlashTier(
      [user("<background_turn>\nwake\n</background_turn>")],
      MAX_CHARS,
    );
    expect(decision.reason).toBe("no_user_text");
  });
});

describe("resolveFlashTierModel", () => {
  test("returns undefined when disabled (the default)", () => {
    const llm = LLMSchema.parse({});
    expect(llm.flashTier.enabled).toBe(false);
    expect(llm.flashTier.maxUserChars).toBe(280);
    expect(resolveFlashTierModel(llm)).toBeUndefined();
  });

  test("explicit llm.flashTier.model wins when distinct from the main model", () => {
    const llm = LLMSchema.parse({
      flashTier: { enabled: true, model: "flash-test-model-x" },
    });
    expect(resolveFlashTierModel(llm)).toBe("flash-test-model-x");
  });

  test("explicit model equal to the mainAgent model is a no-op", () => {
    const base = LLMSchema.parse({ flashTier: { enabled: true } });
    const mainModel = resolveCallSiteConfig("mainAgent", base).model;
    const llm = LLMSchema.parse({
      flashTier: { enabled: true, model: mainModel },
    });
    expect(resolveFlashTierModel(llm)).toBeUndefined();
  });

  test("rejects a catalog-known model on a different provider", () => {
    const base = LLMSchema.parse({ flashTier: { enabled: true } });
    const mainProvider = resolveCallSiteConfig("mainAgent", base).provider;
    // Find a model the catalog attributes uniquely to some OTHER provider.
    const foreign = PROVIDER_CATALOG.filter(
      (p) => p.id !== mainProvider,
    ).flatMap((p) =>
      p.models.filter(
        (m) =>
          PROVIDER_CATALOG.filter((q) => q.models.some((qm) => qm.id === m.id))
            .length === 1,
      ),
    )[0];
    if (foreign == null) return; // catalog shape makes the case unreachable
    const llm = LLMSchema.parse({
      flashTier: { enabled: true, model: foreign.id },
    });
    expect(resolveFlashTierModel(llm)).toBeUndefined();
  });

  test("falls back to the resolved conversationTitle (flash) model", () => {
    const llm = LLMSchema.parse({
      flashTier: { enabled: true },
      profiles: {
        balanced: { model: "main-model-a", provider: "anthropic" },
        "cost-optimized": { model: "flash-model-b", provider: "anthropic" },
      },
      activeProfile: "balanced",
    });
    const main = resolveCallSiteConfig("mainAgent", llm);
    const flash = resolveCallSiteConfig("conversationTitle", llm);
    const expected =
      flash.provider === main.provider && flash.model !== main.model
        ? flash.model
        : undefined;
    expect(resolveFlashTierModel(llm)).toBe(expected as string);
  });
});

describe("resolveFlashTierRouteForTurn", () => {
  const enabledLlm = LLMSchema.parse({
    flashTier: { enabled: true, model: "flash-test-model-x" },
  });
  const trivialHistory = [user("what is 2+2?")];

  test("routes a trivial mainAgent turn when enabled", () => {
    const route = resolveFlashTierRouteForTurn({
      llm: enabledLlm,
      history: trivialHistory,
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toEqual({
      model: "flash-test-model-x",
      reason: "trivial_structural",
    });
  });

  test("stays on the main path when the flag is off", () => {
    const route = resolveFlashTierRouteForTurn({
      llm: LLMSchema.parse({}),
      history: trivialHistory,
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toBeNull();
  });

  test("never routes non-mainAgent call sites", () => {
    const route = resolveFlashTierRouteForTurn({
      llm: enabledLlm,
      history: trivialHistory,
      callSite: "heartbeatAgent",
      overrideProfile: undefined,
    });
    expect(route).toBeNull();
  });

  test("never routes when an inference profile is pinned", () => {
    const route = resolveFlashTierRouteForTurn({
      llm: enabledLlm,
      history: trivialHistory,
      callSite: "mainAgent",
      overrideProfile: "some-pinned-profile",
    });
    expect(route).toBeNull();
  });

  test("never routes a non-trivial turn", () => {
    const route = resolveFlashTierRouteForTurn({
      llm: enabledLlm,
      history: [user("x".repeat(2000))],
      callSite: "mainAgent",
      overrideProfile: undefined,
    });
    expect(route).toBeNull();
  });
});
