/**
 * The capture source's failure semantics.
 *
 * The driver treats `null` as "could not look" and anything else as a real
 * observation, so every way of failing has to arrive as `null`. The mutation
 * checks guard the two that would be actively harmful: asking a client that
 * cannot answer, and forwarding an empty reply as though the screen were
 * blank.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  HostObserveProxy,
  observeHostScreen,
} from "./host-observe-proxy.js";

afterEach(() => {
  HostObserveProxy.reset();
  mock.restore();
});

/** Stand the singleton up with `isAvailable`/`observe` under our control. */
function withProxy(over: {
  available: boolean;
  observe?: () => Promise<unknown>;
}): { observeCalls: () => number } {
  let calls = 0;
  const proxy = HostObserveProxy.instance;
  proxy.isAvailable = () => over.available;
  (proxy as unknown as { observe: unknown }).observe = async () => {
    calls += 1;
    if (!over.observe) return {};
    return over.observe();
  };
  return { observeCalls: () => calls };
}

describe("no client that can answer", () => {
  test("MUTATION CHECK: an unavailable host is never asked", async () => {
    // A desktop that predates this capability must not be sent a message it
    // cannot handle — there is no negotiation here, only advertisement.
    const { observeCalls } = withProxy({ available: false });
    const result = await observeHostScreen("s1", new AbortController().signal);
    expect(result).toBeNull();
    expect(observeCalls()).toBe(0);
  });
});

describe("a real look comes back whole", () => {
  test("accessibility text and the app name are carried through", async () => {
    withProxy({
      available: true,
      observe: async () => ({
        description: "Invoice 4471 — Mail",
        appName: "Mail",
      }),
    });
    const result = await observeHostScreen("s1", new AbortController().signal);
    expect(result?.description).toBe("Invoice 4471 — Mail");
    expect(result?.appName).toBe("Mail");
    // Stamped so the capture seam dedupes against the right moment.
    expect(typeof result?.at).toBe("number");
  });

  test("a frame-only reply is still a real observation", async () => {
    withProxy({
      available: true,
      observe: async () => ({ imageBase64: "aGk=", mediaType: "image/png" }),
    });
    const result = await observeHostScreen("s1", new AbortController().signal);
    expect(result?.imageBase64).toBe("aGk=");
  });
});

describe("every way of failing arrives as null", () => {
  test("MUTATION CHECK: an empty reply is not an empty screen", async () => {
    // Forwarding `{}` would spend an extraction to assert the screen held
    // nothing — a claim the host never made.
    withProxy({ available: true, observe: async () => ({}) });
    expect(
      await observeHostScreen("s1", new AbortController().signal),
    ).toBeNull();
  });

  test("a thrown request is null, not a throw", async () => {
    // The driver survives throws, but it should not have to: a failed look is
    // an ordinary outcome of asking a machine that might be asleep.
    withProxy({
      available: true,
      observe: async () => {
        throw new Error("client timed out");
      },
    });
    expect(
      await observeHostScreen("s1", new AbortController().signal),
    ).toBeNull();
  });

  test("an aborted look is null and stays quiet", async () => {
    const controller = new AbortController();
    controller.abort();
    withProxy({
      available: true,
      observe: async () => {
        throw new Error("aborted");
      },
    });
    expect(await observeHostScreen("s1", controller.signal)).toBeNull();
  });
});

describe("what the capability means", () => {
  test("it is its own channel, not the one that clicks and types", () => {
    // If this ever reads `host_cu`, watching and acting have been welded into
    // one permission and cannot be granted separately.
    const proxy = HostObserveProxy.instance;
    expect(
      (proxy as unknown as { capabilityName: string }).capabilityName,
    ).toBe("host_observe");
  });
});
