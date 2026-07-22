/**
 * `spawned-work` injector — the turn-context half of the fix.
 *
 * The block itself is covered in `work-items/spawned-work-context.test.ts`;
 * this file covers the wiring the agent actually depends on: that the block
 * reaches the turn at all, ahead of the user's text, only on the main reply,
 * and that it stays out of the way when there is nothing to say.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let buildBlockMock = mock((..._args: unknown[]) => null as string | null);

mock.module("../work-items/spawned-work-context.js", () => ({
  buildSpawnedWorkBlock: (...args: unknown[]) => buildBlockMock(...args),
}));

const { DEFAULT_INJECTOR_ORDER, defaultInjectors, SPAWNED_WORK_BLOCK_ID } =
  await import("../plugins/defaults/memory-retrieval/injectors.js");
import type { Injector, TurnContext } from "../plugins/types.js";

function findInjector(name: string): Injector {
  const injector = defaultInjectors.find((c) => c.name === name);
  if (!injector) throw new Error(`injector '${name}' not registered`);
  return injector;
}

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-voice-1",
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
    mode: "full",
    ...overrides,
  };
}

const injector = findInjector("spawned-work");
const BLOCK = "<spawned_work>\n- \"Find cafes\" — running now\n</spawned_work>";

describe("spawned-work injector", () => {
  beforeEach(() => {
    buildBlockMock = mock(() => null as string | null);
  });

  test("injects the block ahead of the user's text when the thread spawned work", async () => {
    buildBlockMock = mock(() => BLOCK);

    const block = await injector.produce(makeContext());

    expect(block).not.toBeNull();
    expect(block!.id).toBe(SPAWNED_WORK_BLOCK_ID);
    expect(block!.text).toBe(BLOCK);
    // Standing context for the whole turn, not a trailing note.
    expect(block!.placement).toBe("prepend-user-tail");
    expect(buildBlockMock).toHaveBeenCalledWith("conv-voice-1");
  });

  test("quiet when the conversation spawned nothing", async () => {
    buildBlockMock = mock(() => null as string | null);
    expect(await injector.produce(makeContext())).toBeNull();
  });

  test("skipped in minimal mode", async () => {
    buildBlockMock = mock(() => BLOCK);
    expect(await injector.produce(makeContext({ mode: "minimal" }))).toBeNull();
    expect(buildBlockMock).not.toHaveBeenCalled();
  });

  test("skipped on background/utility call sites that share the conversation", async () => {
    buildBlockMock = mock(() => BLOCK);
    expect(
      await injector.produce(makeContext({ callSite: "conversationTitle" })),
    ).toBeNull();
    expect(
      await injector.produce(makeContext({ callSite: "compactionAgent" })),
    ).toBeNull();
    expect(buildBlockMock).not.toHaveBeenCalled();

    // …but the main reply still gets it.
    expect(
      await injector.produce(makeContext({ callSite: "mainAgent" })),
    ).not.toBeNull();
  });

  test("a read failure costs the turn nothing", async () => {
    buildBlockMock = mock(() => {
      throw new Error("db is unhappy");
    });
    expect(await injector.produce(makeContext())).toBeNull();
  });

  test("ordered between document-comments and subagent-status", () => {
    expect(injector.order).toBe(DEFAULT_INJECTOR_ORDER.spawnedWork);
    expect(DEFAULT_INJECTOR_ORDER.spawnedWork).toBeGreaterThan(
      DEFAULT_INJECTOR_ORDER.documentComments,
    );
    expect(DEFAULT_INJECTOR_ORDER.spawnedWork).toBeLessThan(
      DEFAULT_INJECTOR_ORDER.subagentStatus,
    );
  });
});
