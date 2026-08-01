import { beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Mocks ─────────────────────────────────────────────────────────────

let greetingRefreshed = false;
let promptsRefreshed = false;
let greetingCalls = 0;
let promptsCalls = 0;
let greetingGate: Promise<void> = Promise.resolve();

mock.module("../home-greeting.js", () => ({
  refreshPersonalizedGreeting: async () => {
    greetingCalls++;
    await greetingGate;
    return greetingRefreshed;
  },
}));

mock.module("../suggested-prompts.js", () => ({
  refreshAssistantSuggestedPrompts: async () => {
    promptsCalls++;
    return promptsRefreshed;
  },
}));

// Spread the real module and override only the seam. An exhaustive factory rots
// the moment the module under test imports one more export — which is exactly
// what happened here: `broadcastMessage` was added, this mock did not have it,
// and the import threw at load so the whole file errored before a single test
// ran. A suite that never executes still reads as "one known failure".
const eventHubActual = await import("../../runtime/assistant-event-hub.js");
const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});
mock.module("../../runtime/assistant-event-hub.js", () => ({
  ...eventHubActual,
  assistantEventHub: { publish: publishSpy },
}));

mock.module("../../runtime/assistant-event.js", () => ({
  buildAssistantEvent: (e: unknown) => e,
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const { revalidateHomeContentInBackground, resetRevalidateCooldownForTests } =
  await import("../home-content-refresh.js");

// The cooldown is process-wide module state, so without this the first test to
// run consumes it and every later test silently observes zero refreshes.
beforeEach(() => {
  resetRevalidateCooldownForTests();
});

async function settle(): Promise<void> {
  // Let the fire-and-forget revalidation chain run to completion.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("revalidateHomeContentInBackground", () => {
  test("publishes home_feed_updated when content was refreshed", async () => {
    publishSpy.mockClear();
    greetingRefreshed = true;
    promptsRefreshed = false;

    revalidateHomeContentInBackground();
    await settle();

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0]?.[0]).toMatchObject({
      type: "home_feed_updated",
    });
  });

  test("does not publish when both caches were fresh", async () => {
    publishSpy.mockClear();
    greetingRefreshed = false;
    promptsRefreshed = false;

    revalidateHomeContentInBackground();
    await settle();

    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("concurrent calls share a single in-flight revalidation", async () => {
    greetingCalls = 0;
    promptsCalls = 0;
    greetingRefreshed = false;
    promptsRefreshed = false;

    let release!: () => void;
    greetingGate = new Promise((resolve) => {
      release = resolve;
    });

    revalidateHomeContentInBackground();
    revalidateHomeContentInBackground();
    revalidateHomeContentInBackground();

    release();
    greetingGate = Promise.resolve();
    await settle();

    expect(greetingCalls).toBe(1);
    expect(promptsCalls).toBe(1);
  });

  test("a completed run allows a later revalidation once the cooldown lapses", async () => {
    greetingCalls = 0;
    greetingRefreshed = false;
    promptsRefreshed = false;

    revalidateHomeContentInBackground();
    await settle();
    // What a 30-minute wait does in production.
    resetRevalidateCooldownForTests();
    revalidateHomeContentInBackground();
    await settle();

    expect(greetingCalls).toBe(2);
  });

  test("the cooldown floor blocks a second revalidation within the window", async () => {
    // The behaviour the floor exists for: a broken persistent cache always
    // reads "stale", so without this every home-feed fetch would trigger a
    // fresh LLM generation — hundreds a day instead of a handful. Nothing
    // covered it, because this file had not run since the floor landed.
    greetingCalls = 0;
    greetingRefreshed = false;
    promptsRefreshed = false;

    revalidateHomeContentInBackground();
    await settle();
    revalidateHomeContentInBackground();
    await settle();

    expect(greetingCalls).toBe(1);
  });
});
