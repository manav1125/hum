/**
 * The proxy-execute capability probe.
 *
 * Composio mints project keys without proxy-execute and says nothing about
 * it, so the only way to know is to ask the proxy. These pin the two answers
 * apart: getting them backwards either cries wolf on every provision (and
 * trains the operator to ignore the warning) or stays silent on the one
 * customer whose connectors are about to fail.
 */

import { describe, expect, test } from "bun:test";

import { keyCanProxyExecute } from "../composio-projects.js";

function respond(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("keyCanProxyExecute", () => {
  test("a 403 naming the capability means the key cannot proxy", async () => {
    const fetchImpl = respond(403, {
      error: {
        message:
          "Proxy execute is not enabled for this API key. Create a new scoped API key with proxy execute functionality",
        code: 403,
      },
    });
    expect(await keyCanProxyExecute("ak_test", { fetchImpl })).toBe(false);
  });

  test("a 404 for the probe account means the key CAN proxy", async () => {
    // The capability is checked before the account is resolved, so reaching
    // the account lookup at all is the proof.
    const fetchImpl = respond(404, {
      error: {
        message: 'Connected account "ca_hq_capability_probe" not found',
        slug: "ConnectedAccount_ResourceNotFound",
      },
    });
    expect(await keyCanProxyExecute("ak_test", { fetchImpl })).toBe(true);
  });

  test("an unrelated 403 does not read as a missing capability", async () => {
    const fetchImpl = respond(403, {
      error: { message: "Forbidden: this project is suspended" },
    });
    expect(await keyCanProxyExecute("ak_test", { fetchImpl })).toBe(true);
  });

  test("a network failure answers 'capable' rather than crying wolf", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await keyCanProxyExecute("ak_test", { fetchImpl })).toBe(true);
  });
});
