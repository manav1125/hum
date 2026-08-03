/**
 * "How Cue thinks" — which inference options onboarding may offer.
 *
 * Both BYO rows exist only to name a vendor: you cannot ask for "your
 * OpenRouter key" without saying OpenRouter, and "Use your Claude
 * subscription" invites the reader to conclude Cue *is* Claude. Neither is
 * true of what a managed customer is buying, so neither may appear there.
 */

import { describe, expect, test } from "bun:test";

import { thinkOptions } from "@/pages/hq-onboarding/think-step";

describe("thinkOptions", () => {
  test("a managed instance is offered only the managed plan", () => {
    const options = thinkOptions(true);
    expect(options.map((o) => o.key)).toEqual(["credits"]);
  });

  test("no option shown on managed names a vendor", () => {
    for (const option of thinkOptions(true)) {
      const text = `${option.title} ${option.sub}`.toLowerCase();
      for (const vendor of [
        "openrouter",
        "claude",
        "anthropic",
        "openai",
        "deepseek",
        "gemini",
      ]) {
        expect(text).not.toContain(vendor);
      }
    }
  });

  test("self-host keeps the bring-your-own-key options", () => {
    const keys = thinkOptions(false).map((o) => o.key);
    expect(keys).toContain("credits");
    expect(keys).toContain("byo");
  });

  test("the recommended default survives the filter", () => {
    // If the filter ever dropped `credits`, onboarding would present an empty
    // chooser and the step would be unfinishable.
    expect(thinkOptions(true)[0].badge).toBe("RECOMMENDED");
  });
});
