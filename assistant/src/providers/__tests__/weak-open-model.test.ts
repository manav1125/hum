/**
 * Weak-open-model classification: the Kimi branch is scoped to the K2
 * generation, so the newly-cataloged K3 models (Fireworks
 * `accounts/fireworks/models/kimi-k3`, OpenRouter `moonshotai/kimi-k3`) must
 * NOT inherit the K2-era harness coaching.
 */

import { describe, expect, test } from "bun:test";

import { isWeakOpenModel } from "../weak-open-model.js";

describe("isWeakOpenModel", () => {
  test("matches the K2 generation across provider naming conventions", () => {
    expect(isWeakOpenModel("moonshotai/kimi-k2.6")).toBe(true);
    expect(isWeakOpenModel("accounts/fireworks/models/kimi-k2p6")).toBe(true);
    expect(isWeakOpenModel("deepseek/deepseek-chat-v3-0324")).toBe(true);
    expect(isWeakOpenModel("minimax/minimax-m3")).toBe(true);
  });

  test("does not match frontier-class Kimi K3", () => {
    expect(isWeakOpenModel("moonshotai/kimi-k3")).toBe(false);
    expect(isWeakOpenModel("accounts/fireworks/models/kimi-k3")).toBe(false);
    expect(isWeakOpenModel("kimi-latest")).toBe(false);
  });

  test("does not match capable closed models", () => {
    expect(isWeakOpenModel("claude-fable-5")).toBe(false);
    expect(isWeakOpenModel("gpt-5.6-sol")).toBe(false);
    expect(isWeakOpenModel(undefined)).toBe(false);
  });
});
