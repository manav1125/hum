/**
 * `getAssistant()` resolution order, for self-hosted installs.
 *
 * Regression (found by driving the real signed-in desktop app): with no id, the
 * function asked the PLATFORM for the assistant list first and returned that
 * result's error verbatim when it was not ok. A self-hosted install has no
 * platform account — the request is not rewritten to the owner's gateway, so it
 * goes out unauthenticated and comes back 401 on every load, and the local
 * lookup underneath was never reached.
 *
 * Two properties are pinned: self-host never calls the platform at all, and a
 * failed platform call is not fatal for anyone else either.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

let ingressUrl: string | null = null;
// Spread the real module: other importers rely on its remaining exports, and
// replacing it wholesale breaks them at import time.
const connectionActual = await import("@/lib/self-hosted/connection");
mock.module("@/lib/self-hosted/connection", () => ({
  ...connectionActual,
  getSelfHostedIngressUrl: () => ingressUrl,
}));

// getAssistant() short-circuits to the lockfile in gateway-auth mode; keep that
// path off so the platform-vs-local ordering is what the test exercises.
mock.module("@/assistant/gateway-auth", () => ({
  isGatewayAuthMode: () => false,
}));
mock.module("@/assistant/selection", () => ({
  getSelectedAssistant: () => null,
  setSelectedAssistant: () => {},
}));

const listCalls: string[] = [];
const LOCAL_ASSISTANT = {
  id: "local-1",
  name: "Cue",
  status: "active",
  is_local: true,
  created: "",
};

const sdkActual = await import("@/generated/api/sdk.gen");
mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkActual,
  assistantsList: mock(async ({ query }: { query: { hosting: string } }) => {
    listCalls.push(query.hosting);
    if (query.hosting === "platform") {
      // What a self-hosted install actually gets back.
      return {
        data: undefined,
        error: { detail: "Unauthorized" },
        response: new Response(null, { status: 401 }),
      };
    }
    return {
      data: { results: [LOCAL_ASSISTANT] },
      error: undefined,
      response: new Response(null, { status: 200 }),
    };
  }),
  assistantsRetrieve: mock(async () => ({
    data: LOCAL_ASSISTANT,
    error: undefined,
    response: new Response(null, { status: 200 }),
  })),
}));

const { getAssistant } = await import("./api");

afterEach(() => {
  listCalls.length = 0;
  ingressUrl = null;
});

describe("getAssistant() with no id", () => {
  test("a self-hosted install never asks the platform", async () => {
    ingressUrl = "https://manav.justcue.app";
    const result = await getAssistant();
    expect(listCalls).not.toContain("platform");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.id).toBe("local-1");
  });

  test("a failed platform lookup falls through to local instead of erroring", async () => {
    ingressUrl = null; // not self-hosted — platform IS asked, and fails
    const result = await getAssistant();
    expect(listCalls).toEqual(["platform", "local"]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.id).toBe("local-1");
  });
});
