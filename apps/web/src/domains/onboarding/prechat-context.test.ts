import { describe, expect, test } from "bun:test";

import { DEFAULT_PRECHAT_INITIAL_MESSAGE } from "@/domains/onboarding/prechat";
import {
  ACTIVATION_FLOW_COHORT,
  ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE,
  buildPreChatContext,
  PARED_DOWN_GOOGLE_TOOL_IDS,
  type BuildPreChatContextInput,
} from "@/domains/onboarding/prechat-context";

function baseInput(
  overrides: Partial<BuildPreChatContextInput> = {},
): BuildPreChatContextInput {
  return {
    mode: "paredDown",
    recipe: null,
    tone: "balanced",
    userName: "Alice",
    assistantName: "Vela",
    selfIntroGreetingEnabled: false,
    ...overrides,
  };
}

describe("buildPreChatContext — activation rail", () => {
  test("selects the activation bootstrap template when the experiment flag is on", () => {
    const context = buildPreChatContext(
      baseInput({ activationFlowEnabled: true }),
    );

    expect(context.cohort).toBe(ACTIVATION_FLOW_COHORT);
    expect(context.bootstrapTemplate).toBe(ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE);
  });

  test("activation template wins over a marketing recipe template", () => {
    const context = buildPreChatContext(
      baseInput({
        activationFlowEnabled: true,
        recipe: {
          cohort: "content-automation",
          bootstrapTemplate: "BOOTSTRAP-CONTENT-AUTOMATION.md",
          initialMessage: "Campaign hello",
          skills: ["geo-writing"],
        } as BuildPreChatContextInput["recipe"],
      }),
    );

    expect(context.cohort).toBe(ACTIVATION_FLOW_COHORT);
    expect(context.bootstrapTemplate).toBe(ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE);
    expect(context.skills).toEqual(["geo-writing"]);
    expect(context.initialMessage).toBe(DEFAULT_PRECHAT_INITIAL_MESSAGE);
  });
});

describe("buildPreChatContext — the web funnel", () => {
  test("carries names and tone", () => {
    const context = buildPreChatContext(baseInput());
    expect(context.tone).toBe("balanced");
    expect(context.userName).toBe("Alice");
    expect(context.assistantName).toBe("Vela");
    expect(context.googleConnected).toBe(false);
  });

  test("tasks come from the marketing recipe, not a picker screen", () => {
    const context = buildPreChatContext(
      baseInput({
        recipe: {
          tasks: ["inbox", "calendar"],
        } as BuildPreChatContextInput["recipe"],
      }),
    );
    expect(context.tasks).toEqual(["inbox", "calendar"]);
  });

  test("implies the Google tool bundle only when connected this action", () => {
    const connected = buildPreChatContext(
      baseInput({ connectedScopes: ["gmail.readonly"] }),
    );
    expect(connected.tools).toEqual([...PARED_DOWN_GOOGLE_TOOL_IDS]);
    expect(connected.googleConnected).toBe(true);
    expect(connected.googleScopes).toEqual(["gmail.readonly"]);

    const skipped = buildPreChatContext(baseInput());
    expect(skipped.tools).toEqual([]);
    expect(skipped.googleConnected).toBe(false);
    expect(skipped.googleScopes).toBeUndefined();
  });
});

describe("buildPreChatContext — native", () => {
  test("collects only name, tone, and a self-intro message", () => {
    const context = buildPreChatContext(
      baseInput({
        mode: "native",
        selfIntroGreetingEnabled: true,
        // A Google connect can't happen on the native path; nothing from the
        // web funnel may leak into the native payload.
        connectedScopes: ["gmail.readonly"],
      }),
    );
    expect(context.tools).toEqual([]);
    expect(context.tasks).toEqual([]);
    expect(context.googleConnected).toBe(false);
    expect(context.googleScopes).toBeUndefined();
    expect(context.priorAssistants).toBeUndefined();
    expect(context.userName).toBe("Alice");
    expect(context.initialMessage).toBe(
      "Hi Vela, I'm Alice. Nice to meet you.",
    );
  });
});

describe("buildPreChatContext — initial message", () => {
  test("a recipe message wins over the generated greeting", () => {
    const context = buildPreChatContext(
      baseInput({
        selfIntroGreetingEnabled: true,
        recipe: {
          initialMessage: "Campaign hello",
        } as BuildPreChatContextInput["recipe"],
      }),
    );
    expect(context.initialMessage).toBe("Campaign hello");
  });

  test("default message when the self-intro greeting is off", () => {
    const context = buildPreChatContext(
      baseInput({ selfIntroGreetingEnabled: false }),
    );
    expect(context.initialMessage).not.toBe(
      "Hi Vela, I'm Alice. Nice to meet you.",
    );
  });
});
