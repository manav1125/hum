/**
 * "Connected" was never the question.
 *
 * An MCP server accepts the transport first and decides whether it likes your
 * credentials afterwards, so a server rejecting every call still connects.
 * Eight servers on one instance sat exactly there for days while every status
 * surface called them healthy. These tests pin the distinction that was
 * missing: a server is healthy when it *serves*, not when it answers the door.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { McpServerConfig } from "../../../config/schemas/mcp.js";

interface FakeBehaviour {
  connects: boolean;
  tools?: Array<{ name: string }>;
  listError?: Error;
  lastError?: Error | null;
}

let behaviour: FakeBehaviour = { connects: true, tools: [{ name: "a" }] };
let disconnected = 0;

const actualClient = await import("../../../mcp/client.js");
mock.module("../../../mcp/client.js", () => ({
  ...actualClient,
  McpClient: class {
    get isConnected() {
      return behaviour.connects;
    }
    get lastError() {
      return behaviour.lastError ?? null;
    }
    async connect() {
      if (!behaviour.connects && behaviour.lastError) return;
    }
    async listTools() {
      if (behaviour.listError) throw behaviour.listError;
      return behaviour.tools ?? [];
    }
    async disconnect() {
      disconnected += 1;
    }
  },
}));

const { checkServerHealth } = await import("../mcp-auth-routes.js");

const config = {
  transport: { type: "streamable-http", url: "https://example.invalid" },
} as unknown as McpServerConfig;

afterEach(() => {
  behaviour = { connects: true, tools: [{ name: "a" }] };
  disconnected = 0;
});

describe("MCP server health", () => {
  test("a server that serves tools reports how many", async () => {
    behaviour = { connects: true, tools: [{ name: "a" }, { name: "b" }] };

    expect(await checkServerHealth("srv", config)).toBe(
      "✓ Connected · 2 tools",
    );
  });

  test("one tool is not pluralised", async () => {
    behaviour = { connects: true, tools: [{ name: "only" }] };

    expect(await checkServerHealth("srv", config)).toBe("✓ Connected · 1 tool");
  });

  // THE regression: connected, and refusing every call. This is the state
  // that used to read "✓ Connected".
  test("a connected server that refuses to list is reported broken", async () => {
    behaviour = {
      connects: true,
      listError: new Error("HTTP 401 Unauthorized"),
    };

    const status = await checkServerHealth("srv", config);

    expect(status).toContain("✗");
    expect(status).toContain("401");
    expect(status).not.toContain("✓");
  });

  test("a connected server offering nothing is not reported as healthy", async () => {
    behaviour = { connects: true, tools: [] };

    expect(await checkServerHealth("srv", config)).toBe(
      "! Connected, but offers no tools",
    );
  });

  // The probe opens a real session; leaving it open would leak one per poll.
  test("the probe session is always closed", async () => {
    behaviour = { connects: true, listError: new Error("nope") };
    await checkServerHealth("srv", config);

    expect(disconnected).toBe(1);
  });
});
