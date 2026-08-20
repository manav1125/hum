/**
 * The connector management shims.
 *
 * Every operation used to route through an Electron bridge to a LOCAL
 * connector daemon. A desktop app pointed at a REMOTE instance has no such
 * bridge, so the surface reported itself unavailable and vanished: no Manage
 * button, no detail page, no way to disconnect. Disconnect was worse than
 * hidden — it returned an empty list, which is the shape of success, so the
 * control looked like it worked and did nothing at all.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

const listCalls: unknown[] = [];
const disconnectCalls: unknown[] = [];

const actualSdk = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...actualSdk,
  connectorappsGet: async (opts: unknown) => {
    listCalls.push(opts);
    return {
      data: {
        apps: [
          {
            slug: "airtable",
            name: "Airtable",
            category: "productivity",
            connected: true,
            logoUrl: "https://example.test/a.png",
          },
        ],
      },
    };
  },
  connectorappsDisconnectPost: async (opts: unknown) => {
    disconnectCalls.push(opts);
    return { data: { disconnected: true } };
  },
}));

const actualStore = await import("@/stores/resolved-assistants-store");
let selectedAssistantId: string | null = "asst-1";
mock.module("@/stores/resolved-assistants-store", () => ({
  ...actualStore,
  useResolvedAssistantsStore: {
    ...actualStore.useResolvedAssistantsStore,
    getState: () => ({ selectedAssistantId }),
  },
}));

const { connectorsAvailable, listConnectors, disconnectConnector } =
  await import("@/runtime/connectors");

afterEach(() => {
  listCalls.length = 0;
  disconnectCalls.length = 0;
  selectedAssistantId = "asst-1";
});

describe("connector shims without an Electron bridge", () => {
  test("management is available when an assistant is selected", async () => {
    expect(await connectorsAvailable()).toBe(true);
  });

  test("with no assistant there is nothing to manage", async () => {
    selectedAssistantId = null;
    expect(await connectorsAvailable()).toBe(false);
  });

  test("the connector list comes from the daemon", async () => {
    const list = await listConnectors();
    expect(list).toEqual([
      {
        slug: "airtable",
        name: "Airtable",
        category: "productivity",
        connected: true,
      },
    ]);
    expect(listCalls).toHaveLength(1);
  });

  test("disconnect actually calls the daemon rather than reporting a silent success", async () => {
    await disconnectConnector("airtable");
    expect(disconnectCalls).toHaveLength(1);
    expect(disconnectCalls[0]).toMatchObject({ body: { slug: "airtable" } });
  });

  test("disconnect with no assistant does not call the daemon", async () => {
    selectedAssistantId = null;
    await disconnectConnector("airtable");
    expect(disconnectCalls).toHaveLength(0);
  });
});
