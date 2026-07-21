import { describe, expect, test } from "bun:test";

import { LLMSchema } from "../config/schemas/llm.js";
import { RiskLevel } from "../permissions/types.js";
import type {
  ContentBlock,
  Message,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import {
  type AdvisorRoute,
  classifyRoundForAdvisor,
  consultAdvisor,
  DEFAULT_ADVISOR_FALLBACK_MODEL,
  DEFAULT_ADVISOR_MODEL,
  resolveAdvisorModel,
  resolveAdvisorRouteForRound,
  textCarriesUncertainty,
} from "./advisor.js";

const ADVISOR = LLMSchema.parse({}).advisor;

/** A tool name predicate: only "delete_everything" is high-stakes. */
const isHighStakesTool = (name: string) => name === "delete_everything";

function assistant(...content: Array<string | ContentBlock>): ContentBlock[] {
  return content.map((c) =>
    typeof c === "string" ? { type: "text", text: c } : c,
  );
}

const destructiveToolUse: ContentBlock = {
  type: "tool_use",
  id: "tu_1",
  name: "delete_everything",
  input: { path: "/" },
};

const safeToolUse: ContentBlock = {
  type: "tool_use",
  id: "tu_2",
  name: "web_search",
  input: { q: "cats" },
};

describe("classifyRoundForAdvisor", () => {
  test("fires on a high-stakes tool", () => {
    const decision = classifyRoundForAdvisor({
      advisor: ADVISOR,
      proposedToolUses: [{ name: "delete_everything" }],
      assistantText: "Deleting now.",
      isHighStakesTool,
      alreadyConsulted: false,
    });
    expect(decision).toEqual({ consult: true, reason: "destructive_tool" });
  });

  test("fires on explicit uncertainty in a tool-bearing round", () => {
    const decision = classifyRoundForAdvisor({
      advisor: ADVISOR,
      proposedToolUses: [{ name: "web_search" }],
      assistantText: "I'm not sure this is the right file, but let me try.",
      isHighStakesTool,
      alreadyConsulted: false,
    });
    expect(decision).toEqual({ consult: true, reason: "explicit_uncertainty" });
  });

  test("destructive tool outranks uncertainty", () => {
    const decision = classifyRoundForAdvisor({
      advisor: ADVISOR,
      proposedToolUses: [{ name: "web_search" }, { name: "delete_everything" }],
      assistantText: "I'm not sure but deleting.",
      isHighStakesTool,
      alreadyConsulted: false,
    });
    expect(decision.reason).toBe("destructive_tool");
  });

  test("skips a trivial confident tool round (no signal)", () => {
    const decision = classifyRoundForAdvisor({
      advisor: ADVISOR,
      proposedToolUses: [{ name: "web_search" }],
      assistantText: "Searching the web for cats.",
      isHighStakesTool,
      alreadyConsulted: false,
    });
    expect(decision).toEqual({ consult: false, reason: "no_signal" });
  });

  test("skips a no-tool round", () => {
    const decision = classifyRoundForAdvisor({
      advisor: ADVISOR,
      proposedToolUses: [],
      assistantText: "I'm not sure, but here's my best answer.",
      isHighStakesTool,
      alreadyConsulted: false,
    });
    expect(decision).toEqual({ consult: false, reason: "no_tool_use" });
  });

  test("skips when disabled", () => {
    const disabled = LLMSchema.parse({ advisor: { enabled: false } }).advisor;
    const decision = classifyRoundForAdvisor({
      advisor: disabled,
      proposedToolUses: [{ name: "delete_everything" }],
      assistantText: "deleting",
      isHighStakesTool,
      alreadyConsulted: false,
    });
    expect(decision).toEqual({ consult: false, reason: "disabled" });
  });

  // Cost bound: "never fires twice per round" — once the per-turn budget is
  // spent, the gate short-circuits even on a high-stakes round.
  test("skips when the consult budget is exhausted", () => {
    const decision = classifyRoundForAdvisor({
      advisor: ADVISOR,
      proposedToolUses: [{ name: "delete_everything" }],
      assistantText: "deleting",
      isHighStakesTool,
      alreadyConsulted: true,
    });
    expect(decision).toEqual({ consult: false, reason: "budget_exhausted" });
  });

  // ── Per-command risk (bash/shell): the diagnosed bug ──────────────────────
  // bash's static defaultRiskLevel is Medium, so isHighStakesTool("bash") is
  // false. The gate must ALSO fire when the PROPOSED command's per-command
  // classified risk is High — otherwise `rm -rf …` (the most common way to do
  // destructive things) never trips the advisor.
  const bashIsNotStaticallyHigh = (name: string) => name === "delete_everything";

  test("fires on a bash command classified HIGH per-command (rm -rf class)", () => {
    const decision = classifyRoundForAdvisor({
      advisor: ADVISOR,
      proposedToolUses: [{ name: "bash", classifiedRisk: RiskLevel.High }],
      assistantText: "Cleaning up the scratch directory.",
      isHighStakesTool: bashIsNotStaticallyHigh,
      alreadyConsulted: false,
    });
    expect(decision).toEqual({ consult: true, reason: "destructive_tool" });
  });

  test("does NOT fire on a benign bash command classified LOW (ls)", () => {
    const decision = classifyRoundForAdvisor({
      advisor: ADVISOR,
      proposedToolUses: [{ name: "bash", classifiedRisk: RiskLevel.Low }],
      assistantText: "Listing the directory.",
      isHighStakesTool: bashIsNotStaticallyHigh,
      alreadyConsulted: false,
    });
    expect(decision).toEqual({ consult: false, reason: "no_signal" });
  });

  test("a HIGH-classified bash call routes to the advisor model", () => {
    const route = resolveAdvisorRouteForRound({
      llm: LLMSchema.parse({}),
      proposedToolUses: [{ name: "bash", classifiedRisk: RiskLevel.High }],
      assistantText: "removing the temp files",
      isHighStakesTool: bashIsNotStaticallyHigh,
      alreadyConsulted: false,
      env: {},
    });
    expect(route).toEqual({
      model: DEFAULT_ADVISOR_MODEL,
      fallbackModel: DEFAULT_ADVISOR_FALLBACK_MODEL,
      reason: "destructive_tool",
    });
  });

  test("a Medium-classified bash call does not fire (only HIGH is high-stakes)", () => {
    const decision = classifyRoundForAdvisor({
      advisor: ADVISOR,
      proposedToolUses: [{ name: "bash", classifiedRisk: RiskLevel.Medium }],
      assistantText: "running the build",
      isHighStakesTool: bashIsNotStaticallyHigh,
      alreadyConsulted: false,
    });
    expect(decision).toEqual({ consult: false, reason: "no_signal" });
  });

  test("respects consultOnDestructiveTools=false", () => {
    const cfg = LLMSchema.parse({
      advisor: { consultOnDestructiveTools: false },
    }).advisor;
    const decision = classifyRoundForAdvisor({
      advisor: cfg,
      proposedToolUses: [{ name: "delete_everything" }],
      assistantText: "deleting confidently",
      isHighStakesTool,
      alreadyConsulted: false,
    });
    expect(decision.consult).toBe(false);
  });
});

describe("textCarriesUncertainty", () => {
  test("matches a configured marker, case-insensitive", () => {
    expect(textCarriesUncertainty("I'M NOT SURE about this", ADVISOR)).toBe(
      true,
    );
    expect(textCarriesUncertainty("please double-check my math", ADVISOR)).toBe(
      true,
    );
  });

  test("no match on confident text", () => {
    expect(textCarriesUncertainty("Done. The file is updated.", ADVISOR)).toBe(
      false,
    );
  });

  test("empty text is never uncertain", () => {
    expect(textCarriesUncertainty("", ADVISOR)).toBe(false);
  });
});

describe("resolveAdvisorModel", () => {
  test("undefined when disabled", () => {
    const llm = LLMSchema.parse({ advisor: { enabled: false } });
    expect(resolveAdvisorModel(llm, {})).toBeUndefined();
  });

  test("defaults to kimi-k3 with glm-5.2 fallback", () => {
    const llm = LLMSchema.parse({});
    expect(resolveAdvisorModel(llm, {})).toEqual({
      model: DEFAULT_ADVISOR_MODEL,
      fallbackModel: DEFAULT_ADVISOR_FALLBACK_MODEL,
    });
  });

  test("config model and fallback win over defaults", () => {
    const llm = LLMSchema.parse({
      advisor: { model: "cfg-model", fallbackModel: "cfg-fallback" },
    });
    expect(resolveAdvisorModel(llm, {})).toEqual({
      model: "cfg-model",
      fallbackModel: "cfg-fallback",
    });
  });

  test("CUE_ADVISOR_MODEL env overrides config", () => {
    const llm = LLMSchema.parse({ advisor: { model: "cfg-model" } });
    expect(
      resolveAdvisorModel(llm, { CUE_ADVISOR_MODEL: "env-model" })?.model,
    ).toBe("env-model");
  });

  test("fallback equal to the primary is dropped", () => {
    const llm = LLMSchema.parse({
      advisor: { model: "same", fallbackModel: "same" },
    });
    expect(resolveAdvisorModel(llm, {})).toEqual({ model: "same" });
  });
});

describe("resolveAdvisorRouteForRound", () => {
  test("routes a destructive-tool round with model + fallback + reason", () => {
    const route = resolveAdvisorRouteForRound({
      llm: LLMSchema.parse({}),
      proposedToolUses: [{ name: "delete_everything" }],
      assistantText: "deleting",
      isHighStakesTool,
      alreadyConsulted: false,
      env: {},
    });
    expect(route).toEqual({
      model: DEFAULT_ADVISOR_MODEL,
      fallbackModel: DEFAULT_ADVISOR_FALLBACK_MODEL,
      reason: "destructive_tool",
    });
  });

  test("null when disabled", () => {
    const route = resolveAdvisorRouteForRound({
      llm: LLMSchema.parse({ advisor: { enabled: false } }),
      proposedToolUses: [{ name: "delete_everything" }],
      assistantText: "deleting",
      isHighStakesTool,
      alreadyConsulted: false,
      env: {},
    });
    expect(route).toBeNull();
  });

  test("null on a no-signal round", () => {
    const route = resolveAdvisorRouteForRound({
      llm: LLMSchema.parse({}),
      proposedToolUses: [{ name: "web_search" }],
      assistantText: "searching",
      isHighStakesTool,
      alreadyConsulted: false,
      env: {},
    });
    expect(route).toBeNull();
  });

  test("null when budget exhausted (never twice per round)", () => {
    const route = resolveAdvisorRouteForRound({
      llm: LLMSchema.parse({}),
      proposedToolUses: [{ name: "delete_everything" }],
      assistantText: "deleting",
      isHighStakesTool,
      alreadyConsulted: true,
      env: {},
    });
    expect(route).toBeNull();
  });
});

// ── consultAdvisor (impure; mock provider) ──────────────────────────────────

function response(text: string): ProviderResponse {
  return {
    content: assistant(text),
    model: "advisor-model",
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    stopReason: "end_turn",
  };
}

const priorHistory: Message[] = [
  { role: "user", content: [{ type: "text", text: "delete my repo" }] },
];

const route: AdvisorRoute = {
  model: "primary-advisor",
  fallbackModel: "fallback-advisor",
  reason: "destructive_tool",
};

describe("consultAdvisor", () => {
  test("returns advice from the primary model", async () => {
    const calls: Array<{ history: Message[]; options: SendMessageOptions }> =
      [];
    const advice = await consultAdvisor({
      send: async (history, options) => {
        calls.push({ history, options });
        return response("DO NOT PROCEED — wrong target.");
      },
      priorHistory,
      proposedContent: [destructiveToolUse],
      route,
      advisor: ADVISOR,
    });
    expect(advice).toEqual({
      critique: "DO NOT PROCEED — wrong target.",
      model: "primary-advisor",
    });
    expect(calls).toHaveLength(1);
    // Pins the advisor model + call site, carries NO tools.
    expect(calls[0].options.config?.model).toBe("primary-advisor");
    expect(calls[0].options.config?.callSite).toBe("advisor");
    expect(calls[0].options.tools).toBeUndefined();
    // The dangling tool_use assistant message is not included; the consult adds
    // exactly one user message onto the prior history.
    expect(calls[0].history).toHaveLength(priorHistory.length + 1);
    expect(calls[0].history.at(-1)?.role).toBe("user");
  });

  test("falls back to the fallback model when the primary errors", async () => {
    const modelsSeen: string[] = [];
    const advice = await consultAdvisor({
      send: async (_history, options) => {
        const model = options.config?.model as string;
        modelsSeen.push(model);
        if (model === "primary-advisor") throw new Error("primary 500");
        return response("PROCEED WITH CHANGES.");
      },
      priorHistory,
      proposedContent: [destructiveToolUse],
      route,
      advisor: ADVISOR,
    });
    expect(modelsSeen).toEqual(["primary-advisor", "fallback-advisor"]);
    expect(advice).toEqual({
      critique: "PROCEED WITH CHANGES.",
      model: "fallback-advisor",
    });
  });

  test("returns null (fail-open) when both models error", async () => {
    const advice = await consultAdvisor({
      send: async () => {
        throw new Error("provider down");
      },
      priorHistory,
      proposedContent: [safeToolUse],
      route,
      advisor: ADVISOR,
    });
    expect(advice).toBeNull();
  });

  test("returns null on empty critique", async () => {
    const advice = await consultAdvisor({
      send: async () => response("   "),
      priorHistory,
      proposedContent: [safeToolUse],
      route: { model: "only-model", reason: "destructive_tool" },
      advisor: ADVISOR,
    });
    expect(advice).toBeNull();
  });
});
