/**
 * Auth headers for Composio-hosted MCP endpoints.
 *
 * Composio's MCP endpoint answers an unauthenticated POST with 401 "API key or
 * valid JWT Bearer token is required in headers", and the auto-provisioned
 * server entries carry no headers — so every Composio MCP server on an
 * instance failed to connect while the proxy path beside it worked. The
 * user-visible shape was a connector reading "connected" in the list and
 * erroring the instant a chat touched it, and an agent whose tools answer 401
 * keeps re-deriving how it is connected: one tester burned 2.5M tokens on
 * exactly that before concluding the connector needed reconnecting. It did
 * not.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const original = process.env.VELLUM_WORKSPACE_DIR;
const dirs: string[] = [];

function workspaceWithCreds(creds: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "composio-mcp-auth-"));
  dirs.push(dir);
  writeFileSync(join(dir, "connectors.json"), JSON.stringify(creds));
  return dir;
}

afterEach(() => {
  if (original === undefined) delete process.env.VELLUM_WORKSPACE_DIR;
  else process.env.VELLUM_WORKSPACE_DIR = original;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("composioMcpAuthHeaders", () => {
  test("sends the key to a Composio MCP host", async () => {
    process.env.VELLUM_WORKSPACE_DIR = workspaceWithCreds({
      composioApiKey: "ak_live_key",
      userId: "u1",
    });
    const { composioMcpAuthHeaders } = await import("../composio-oauth.js");
    expect(
      composioMcpAuthHeaders(
        "https://backend.composio.dev/v3.1/mcp/server-1?user_id=u1",
      ),
    ).toEqual({ "x-api-key": "ak_live_key" });
  });

  test("sends nothing to any other host", async () => {
    process.env.VELLUM_WORKSPACE_DIR = workspaceWithCreds({
      composioApiKey: "ak_live_key",
      userId: "u1",
    });
    const { composioMcpAuthHeaders } = await import("../composio-oauth.js");
    // A third-party MCP server must never receive our Composio credential.
    for (const url of [
      "https://mcp.example.com/v1/mcp",
      "https://backend.composio.dev.evil.test/mcp",
      "not a url",
    ]) {
      expect(composioMcpAuthHeaders(url)).toBeUndefined();
    }
  });

  // The credentials-absent case is not exercised here on purpose: readCreds()
  // memoises for the life of the process, so asserting it would only pass as
  // the first test in the file and would silently invert if anything were
  // added above it. That memoisation is also why a rotated Composio key needs
  // a daemon restart to take effect.
});
