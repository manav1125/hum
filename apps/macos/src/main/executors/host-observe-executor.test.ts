/**
 * The observe executor's contract with the daemon.
 *
 * Two properties carry all the risk, and both are about NOT saying something.
 * The executor must never post an observation it did not make — an empty
 * description is a claim that the screen was blank, and the capture seam
 * downstream is entitled to act on it. And it must never reach the helper
 * method that clicks and types.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      initialize: noop,
      transports: {
        file: {
          maxSize: 0,
          fileName: "",
          format: "",
          getFile: () => ({ path: "" }),
        },
      },
    },
  };
});

const { createHostObserveExecutor, OBSERVE_HELPER_METHOD } =
  await import("./host-observe-executor");

type Posted = Record<string, unknown>;

/** A poster that records only what the executor actually sent. */
function makePoster() {
  const observe: Posted[] = [];
  const cu: Posted[] = [];
  return {
    posted: observe,
    cuPosted: cu,
    poster: {
      postObserveResult: async (r: Posted) => {
        observe.push(r);
        return true;
      },
      postCuResult: async (r: Posted) => {
        cu.push(r);
        return true;
      },
    } as never,
  };
}

/** A helper that records the method it was asked for. */
function makeHelper(reply: unknown) {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    helper: {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  mock.restore();
});

describe("it reads through the read-only helper method", () => {
  test("MUTATION CHECK: it never calls the method that acts", async () => {
    // `computeruse.perform` runs verify → execute → settle. If observation
    // ever routes through it, watching and acting stop being separable and a
    // capture tick gains the ability to emit events on the guardian's machine.
    const { helper, calls } = makeHelper({ ok: true, description: "x" });
    const { poster } = makePoster();
    createHostObserveExecutor({ helper }).handleRequest(
      { requestId: "r1" } as never,
      poster,
    );
    await settle();
    expect(calls[0]?.method).toBe("observe.screen");
    expect(OBSERVE_HELPER_METHOD).not.toBe("computeruse.perform");
  });

  test("a successful read is posted with its app name", async () => {
    const { helper } = makeHelper({
      ok: true,
      description: 'Window: "Invoice 4471" (Mail)',
      appName: "Mail",
    });
    const { poster, posted } = makePoster();
    createHostObserveExecutor({ helper }).handleRequest(
      { requestId: "r1" } as never,
      poster,
    );
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.description).toContain("Invoice 4471");
    expect(posted[0]?.appName).toBe("Mail");
    expect(posted[0]?.requestId).toBe("r1");
  });

  test("an observation carries no input — there is nothing to target", async () => {
    const { helper, calls } = makeHelper({ ok: true, description: "x" });
    const { poster } = makePoster();
    createHostObserveExecutor({ helper }).handleRequest(
      { requestId: "r1", input: { selector: "#secret" } } as never,
      poster,
    );
    await settle();
    expect(calls[0]?.params).toEqual({ requestId: "r1" });
  });
});

describe("a look that failed is never posted as a look that succeeded", () => {
  test("MUTATION CHECK: ok:false posts nothing at all", async () => {
    // Posting `{description: undefined}` here would resolve the daemon's
    // request with an observation asserting the screen held nothing.
    const { helper } = makeHelper({
      ok: false,
      reason: "accessibility-permission",
    });
    const { poster, posted } = makePoster();
    createHostObserveExecutor({ helper }).handleRequest(
      { requestId: "r1" } as never,
      poster,
    );
    await settle();
    expect(posted).toHaveLength(0);
  });

  test("MUTATION CHECK: an ok reply with no description posts nothing", async () => {
    const { helper } = makeHelper({ ok: true });
    const { poster, posted } = makePoster();
    createHostObserveExecutor({ helper }).handleRequest(
      { requestId: "r1" } as never,
      poster,
    );
    await settle();
    expect(posted).toHaveLength(0);
  });

  test("a helper that throws posts nothing", async () => {
    const { helper } = makeHelper(new Error("helper is down"));
    const { poster, posted } = makePoster();
    createHostObserveExecutor({ helper }).handleRequest(
      { requestId: "r1" } as never,
      poster,
    );
    await settle();
    expect(posted).toHaveLength(0);
  });

  test("it never posts down the CU result channel", async () => {
    const { helper } = makeHelper({ ok: true, description: "x" });
    const { poster, cuPosted } = makePoster();
    createHostObserveExecutor({ helper }).handleRequest(
      { requestId: "r1" } as never,
      poster,
    );
    await settle();
    expect(cuPosted).toHaveLength(0);
  });
});

describe("a cancelled look stays quiet", () => {
  test("a result arriving after cancel is dropped", async () => {
    const { helper } = makeHelper({ ok: true, description: "x" });
    const { poster, posted } = makePoster();
    const ex = createHostObserveExecutor({ helper });
    ex.handleCancel({ requestId: "r1" } as never, poster);
    ex.handleRequest({ requestId: "r1" } as never, poster);
    await settle();
    expect(posted).toHaveLength(0);
  });
});
