/**
 * Who was listening when a prompt went out.
 *
 * A prompt that never reaches a client leaves the run on "Working" with
 * nothing to click, and the two explanations — nobody was connected, versus a
 * connected client that ignored it — call for opposite fixes. Only publish
 * time can tell them apart: by the time a stall is noticed, a client has
 * usually reconnected and the audience at the moment that mattered is gone.
 */

import { describe, expect, test } from "bun:test";

import { AssistantEventHub } from "../assistant-event-hub.js";

function hub() {
  return new AssistantEventHub({ maxSubscribers: 100 });
}

function subscribeClient(
  h: AssistantEventHub,
  opts: { conversationId?: string } = {},
) {
  return h.subscribe({
    type: "client",
    clientId: `c-${Math.floor(Number.MAX_SAFE_INTEGER * 0.5)}-${opts.conversationId ?? "any"}`,
    interfaceId: "web",
    capabilities: [],
    callback: () => {},
    ...(opts.conversationId
      ? { filter: { conversationId: opts.conversationId } }
      : {}),
  });
}

describe("countClientAudience", () => {
  test("is zero when nothing is subscribed", () => {
    // The stranded-turn case: the prompt goes nowhere.
    expect(hub().countClientAudience("conv-1")).toBe(0);
  });

  test("counts a client with no conversation filter", () => {
    const h = hub();
    subscribeClient(h);
    expect(h.countClientAudience("conv-1")).toBe(1);
  });

  test("counts a client scoped to this conversation", () => {
    const h = hub();
    subscribeClient(h, { conversationId: "conv-1" });
    expect(h.countClientAudience("conv-1")).toBe(1);
  });

  test("does not count a client scoped to a different conversation", () => {
    // A subscriber watching another chat is not an audience for this prompt,
    // and counting it would report a delivery that never happened.
    const h = hub();
    subscribeClient(h, { conversationId: "conv-other" });
    expect(h.countClientAudience("conv-1")).toBe(0);
  });

  test("stops counting a client once it disconnects", () => {
    // The stranded-turn shape: the stream dropped, so the prompt that is
    // about to be published has nowhere to go.
    const h = hub();
    const sub = subscribeClient(h, { conversationId: "conv-1" });
    expect(h.countClientAudience("conv-1")).toBe(1);
    sub.dispose();
    expect(h.countClientAudience("conv-1")).toBe(0);
  });

  test("counts every listening client, not just the first", () => {
    const h = hub();
    subscribeClient(h, { conversationId: "conv-1" });
    subscribeClient(h);
    expect(h.countClientAudience("conv-1")).toBe(2);
  });

  test("an undefined conversation counts every client", () => {
    // A broadcast reaches conversation-scoped subscribers too.
    const h = hub();
    subscribeClient(h, { conversationId: "conv-1" });
    subscribeClient(h, { conversationId: "conv-2" });
    expect(h.countClientAudience(undefined)).toBe(2);
  });
});
