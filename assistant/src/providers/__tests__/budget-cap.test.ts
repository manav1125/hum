import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

// ─── Mutable mock state ────────────────────────────────────────────────

interface MockBudgetConfig {
  dailyCapUsd: number | null;
  monthlyCapUsd: number | null;
  killSwitch: boolean;
  alertThresholdPct: number;
}

let mockConfig: MockBudgetConfig = {
  dailyCapUsd: null,
  monthlyCapUsd: null,
  killSwitch: false,
  alertThresholdPct: 80,
};
let configShouldThrow = false;

let mockSpend = 0;
let spendShouldThrow = false;

let emittedAlerts: Array<Record<string, unknown>> = [];

mock.module("../budget-config-reader.js", () => ({
  getBudgetConfig: async () => {
    if (configShouldThrow) throw new Error("synthetic config read failure");
    return mockConfig;
  },
}));

mock.module("../../memory/llm-usage-store.js", () => ({
  getTotalUsageCostInWindow: (_from: number, _to: number) => {
    if (spendShouldThrow) throw new Error("synthetic spend query failure");
    return mockSpend;
  },
}));

mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emittedAlerts.push(params);
    return { signalId: "x", deduplicated: false, dispatched: true };
  },
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

const { BudgetCapProvider, BudgetCapError } = await import("../budget-cap.js");

// ─── Inner provider stub ───────────────────────────────────────────────

let innerCalls = 0;
function makeInner(): Provider {
  return {
    name: "stub",
    async sendMessage(
      _messages: Message[],
      _options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      innerCalls += 1;
      return {
        content: "ok",
        model: "stub-model",
        usage: { inputTokens: 1, outputTokens: 1 },
      } as unknown as ProviderResponse;
    },
  };
}

const MSG: Message[] = [{ role: "user", content: "hi" } as unknown as Message];

beforeEach(() => {
  mockConfig = {
    dailyCapUsd: null,
    monthlyCapUsd: null,
    killSwitch: false,
    alertThresholdPct: 80,
  };
  configShouldThrow = false;
  mockSpend = 0;
  spendShouldThrow = false;
  emittedAlerts = [];
  innerCalls = 0;
});

describe("BudgetCapProvider", () => {
  test("allows when no caps configured (default OFF)", async () => {
    const provider = new BudgetCapProvider(makeInner());
    await provider.sendMessage(MSG);
    expect(innerCalls).toBe(1);
  });

  test("blocks when daily spend >= daily cap", async () => {
    mockConfig.dailyCapUsd = 10;
    mockSpend = 12; // over daily cap
    const provider = new BudgetCapProvider(makeInner());
    await expect(provider.sendMessage(MSG)).rejects.toBeInstanceOf(
      BudgetCapError,
    );
    expect(innerCalls).toBe(0);
  });

  test("blocks when monthly spend >= monthly cap", async () => {
    mockConfig.monthlyCapUsd = 100;
    mockSpend = 100; // exactly at cap → blocked (>=)
    const provider = new BudgetCapProvider(makeInner());
    await expect(provider.sendMessage(MSG)).rejects.toBeInstanceOf(
      BudgetCapError,
    );
    expect(innerCalls).toBe(0);
  });

  test("blocks when kill switch is on, without querying spend", async () => {
    mockConfig.killSwitch = true;
    spendShouldThrow = true; // would throw if queried — proves kill switch short-circuits
    const provider = new BudgetCapProvider(makeInner());
    let caught: unknown;
    try {
      await provider.sendMessage(MSG);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetCapError);
    expect((caught as InstanceType<typeof BudgetCapError>).kind).toBe(
      "killSwitch",
    );
    expect(innerCalls).toBe(0);
  });

  test("allows (fail OPEN) when config read throws", async () => {
    configShouldThrow = true;
    const provider = new BudgetCapProvider(makeInner());
    await provider.sendMessage(MSG);
    expect(innerCalls).toBe(1);
  });

  test("allows (fail OPEN) when spend query throws even with a cap set", async () => {
    mockConfig.dailyCapUsd = 5;
    spendShouldThrow = true;
    const provider = new BudgetCapProvider(makeInner());
    await provider.sendMessage(MSG);
    expect(innerCalls).toBe(1);
  });

  test("allows when spend is below cap", async () => {
    mockConfig.dailyCapUsd = 10;
    mockSpend = 3;
    const provider = new BudgetCapProvider(makeInner());
    await provider.sendMessage(MSG);
    expect(innerCalls).toBe(1);
  });

  test("emits exactly one alert when crossing the threshold across calls", async () => {
    mockConfig.dailyCapUsd = 10;
    mockConfig.alertThresholdPct = 80;
    mockSpend = 9; // 90% — over the 80% threshold, under the cap
    const provider = new BudgetCapProvider(makeInner());
    await provider.sendMessage(MSG);
    await provider.sendMessage(MSG);
    await provider.sendMessage(MSG);
    expect(innerCalls).toBe(3);
    // Dedup: one alert for the day window despite three calls.
    const dailyAlerts = emittedAlerts.filter(
      (a) => a.sourceEventName === "budget.alert",
    );
    expect(dailyAlerts.length).toBe(1);
  });

  test("does not alert below the threshold", async () => {
    mockConfig.dailyCapUsd = 10;
    mockConfig.alertThresholdPct = 80;
    mockSpend = 5; // 50% — under threshold
    const provider = new BudgetCapProvider(makeInner());
    await provider.sendMessage(MSG);
    expect(emittedAlerts.length).toBe(0);
  });
});
