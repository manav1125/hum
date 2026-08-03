import { describe, expect, test } from "bun:test";

import {
  HQ_SIGNIN_BRIDGE_FLAG,
  RENDERER_HQ_SIGNIN_URL,
  buildHqSigninBridgeSource,
  shouldBridgeHqSignin,
} from "./hq-signin-bridge";
import { HQ_SIGNIN_PATH } from "./hq-forward";

interface Call {
  input: unknown;
  init: unknown;
}

/**
 * Run the generated shim the way the renderer would, against a stub `window`,
 * and hand back a recorder of what the underlying `fetch` actually saw. The
 * source is executed rather than string-matched — a shim that reads correctly
 * but rewrites the wrong request would pass an assertion on its text.
 */
const install = (
  source: string,
  overrides: Record<string, unknown> = {},
): { window: Record<string, unknown>; calls: Call[]; result: unknown } => {
  const calls: Call[] = [];
  const window: Record<string, unknown> = {
    fetch: function (input: unknown, init: unknown) {
      calls.push({ input, init });
      return "original-response";
    },
    ...overrides,
  };
  const result = new Function("window", `return ${source}`)(window) as unknown;
  return { window, calls, result };
};

const source = (): string =>
  buildHqSigninBridgeSource(RENDERER_HQ_SIGNIN_URL, HQ_SIGNIN_PATH);

describe("shouldBridgeHqSignin", () => {
  test("bridges the bundled app:// renderer — the origin HQ cannot allow", () => {
    expect(shouldBridgeHqSignin({ protocol: "app:", host: "vellum.ai" })).toBe(
      true,
    );
  });

  test("leaves a connected instance alone — its direct call already works", () => {
    expect(
      shouldBridgeHqSignin({ protocol: "https:", host: "manav.justcue.app" }),
    ).toBe(false);
    // Dev renderer runs over http on localhost; the browser path is correct
    // there too.
    expect(
      shouldBridgeHqSignin({ protocol: "http:", host: "localhost:5173" }),
    ).toBe(false);
  });
});

describe("the injected shim", () => {
  test("rewrites the sign-on client's HQ call onto the same-origin rail", () => {
    const { window, calls, result } = install(source());
    expect(result).toBe("installed");

    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com" }),
    };
    (window.fetch as (i: unknown, x: unknown) => unknown)(
      RENDERER_HQ_SIGNIN_URL,
      init,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(HQ_SIGNIN_PATH);
    // Same-origin means no preflight; the body (and only the body) still
    // carries the email.
    expect(calls[0]?.init).toBe(init);
  });

  test("the rewritten URL is same-origin and relative — it names no host", () => {
    expect(HQ_SIGNIN_PATH.startsWith("/")).toBe(true);
    expect(HQ_SIGNIN_PATH).not.toContain("://");
  });

  test("leaves every other request byte-for-byte alone", () => {
    const { window, calls } = install(source());
    const fetch = window.fetch as (...args: unknown[]) => unknown;

    const untouched: unknown[] = [
      "/v1/assistants/self/conversations",
      "https://justcue.ai/signin?x=1",
      "https://justcue.ai/signin/",
      "https://justcue.ai/signinx",
      "xhttps://justcue.ai/signin",
      "https://evil.example.com/signin",
      new URL("https://justcue.ai/signin"),
      { url: RENDERER_HQ_SIGNIN_URL },
      undefined,
    ];
    for (const input of untouched) fetch(input, { method: "GET" });

    expect(calls).toHaveLength(untouched.length);
    for (const [i, call] of calls.entries()) {
      expect(call.input).toBe(untouched[i]);
    }
  });

  test("passes the original argument list through, not a rebuilt one", () => {
    const { window, calls } = install(source());
    const fetch = window.fetch as (...args: unknown[]) => unknown;
    const init = { method: "POST" };
    const third = { extra: true };
    fetch("/somewhere", init, third);
    expect(calls[0]?.init).toBe(init);
    expect(window.fetch).not.toBe(undefined);
  });

  test("returns whatever the real fetch returned", () => {
    const { window } = install(source());
    const fetch = window.fetch as (...args: unknown[]) => unknown;
    expect(fetch("/anything")).toBe("original-response");
    expect(fetch(RENDERER_HQ_SIGNIN_URL, {})).toBe("original-response");
  });

  test("is idempotent — a reload cannot stack two layers of patch", () => {
    const calls: Call[] = [];
    const window: Record<string, unknown> = {
      fetch: function (input: unknown, init: unknown) {
        calls.push({ input, init });
        return "original-response";
      },
    };
    const run = new Function("window", `return ${source()}`);
    expect(run(window)).toBe("installed");
    const afterFirst = window.fetch;
    expect(run(window)).toBe("already-installed");
    expect(window.fetch).toBe(afterFirst);
    expect(window[HQ_SIGNIN_BRIDGE_FLAG]).toBe(true);

    (window.fetch as (i: unknown) => unknown)(RENDERER_HQ_SIGNIN_URL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(HQ_SIGNIN_PATH);
  });

  test("degrades to a no-op rather than throwing when there is no fetch", () => {
    const window: Record<string, unknown> = { fetch: undefined };
    expect(new Function("window", `return ${source()}`)(window)).toBe(
      "no-fetch",
    );
    expect(window[HQ_SIGNIN_BRIDGE_FLAG]).toBeUndefined();
  });

  test("embeds both URLs as data, so neither can break out of the literal", () => {
    const hostile = `https://justcue.ai/signin";window.pwned=1;"`;
    const src = buildHqSigninBridgeSource(hostile, HQ_SIGNIN_PATH);
    const { window } = install(src);
    expect(window.pwned).toBeUndefined();
    // …and the hostile string is matched literally, not executed.
    const fetch = window.fetch as (...args: unknown[]) => unknown;
    fetch(hostile);
    expect(window.pwned).toBeUndefined();
  });
});
