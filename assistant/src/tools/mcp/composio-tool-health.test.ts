/**
 * Passive health signals from real MCP tool executions — the fix for the
 * false-positive "working ✓ just now": a REAL calendar call failing with an
 * expired OAuth connection must downgrade a stored probe "ok" immediately,
 * not wait for the next probe sweep to notice.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import {
  getConnectorHealthState,
  recordConnectorProbe,
  resetConnectorHealthStoreForTest,
} from "../../oauth/connector-health-store.js";
import { connectorHealthFor } from "../../runtime/routes/connector-health.js";
import {
  composioToolkitsForCall,
  findAuthShapedError,
  recordComposioToolOutcome,
} from "./composio-tool-health.js";

afterEach(() => {
  resetConnectorHealthStoreForTest();
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  if (ws && existsSync(join(ws, "connector-health.json"))) {
    rmSync(join(ws, "connector-health.json"));
  }
});

describe("composioToolkitsForCall", () => {
  it("maps a per-toolkit Composio server id to its toolkit", () => {
    expect(composioToolkitsForCall("composio_googlecalendar", {})).toEqual([
      "googlecalendar",
    ]);
  });

  it("extracts toolkits from the bare workbench's embedded action slugs", () => {
    expect(
      composioToolkitsForCall("composio", {
        tool_slug: "GOOGLECALENDAR_FIND_EVENT",
      }),
    ).toEqual(["googlecalendar"]);
    expect(
      composioToolkitsForCall("composio", {
        tools: [
          { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} },
          { tool_slug: "SLACK_SEND_MESSAGE", arguments: {} },
        ],
      }).sort(),
    ).toEqual(["gmail", "slack"]);
  });

  it("returns nothing for meta calls and non-Composio servers", () => {
    // A COMPOSIO_SEARCH_TOOLS call has no embedded action slug — searching
    // the catalog says nothing about any provider connection.
    expect(composioToolkitsForCall("composio", { queries: ["email"] })).toEqual(
      [],
    );
    expect(
      composioToolkitsForCall("filesystem", { tool_slug: "GMAIL_X" }),
    ).toEqual([]);
    // Schema fetches identify actions via `tool_schemas` keys, but fetching a
    // schema never touches provider auth — not evidence.
    expect(
      composioToolkitsForCall("composio", {
        tool_schemas: { GMAIL_SEND_EMAIL: {} },
      }),
    ).toEqual([]);
  });
});

describe("findAuthShapedError", () => {
  it("matches the connector auth-error idioms", () => {
    for (const text of [
      "Connection expired. Please reauthenticate to continue.",
      "No active connection found for toolkit(s) 'googledrive' in this session",
      '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
      "Request had invalid authentication credentials. Expected OAuth 2 access token",
      '{"ok":false,"error":"token_revoked"}',
    ]) {
      expect(findAuthShapedError(text)).not.toBeNull();
    }
  });

  it("ignores non-auth failures and ordinary provider data", () => {
    for (const text of [
      "Invalid arguments: start_time must be an ISO date",
      "Rate limit exceeded, retry after 30s",
      "Subject: Your gym membership is about to end — renew today!",
      "Found 3 events for tomorrow",
    ]) {
      expect(findAuthShapedError(text)).toBeNull();
    }
  });
});

describe("recordComposioToolOutcome", () => {
  it("a real auth-expired tool failure downgrades a stored probe 'ok' immediately", () => {
    // THE PROD BUG: the Connectors page said "Google Calendar · working ✓
    // just now" (a ≤10-min-old probe result) at the same moment a real
    // calendar tool call failed with an expired OAuth connection.
    const probedAt = Date.now() - 60_000;
    recordConnectorProbe("googlecalendar", {
      checkedAt: probedAt,
      status: "ok",
    });
    const account = { id: "ca_1", isDisabled: false };
    expect(connectorHealthFor("googlecalendar", account).status).toBe("ok");

    recordComposioToolOutcome({
      serverId: "composio",
      input: { tool_slug: "GOOGLECALENDAR_FIND_EVENT" },
      content:
        "Error executing tool: connection is expired, please reauthenticate googlecalendar",
      isError: true,
    });

    const health = connectorHealthFor("googlecalendar", account);
    expect(health.status).toBe("attention");
    expect(health.lastError).toContain("reconnect to fix");
  });

  it("records the failure for per-toolkit Composio servers too", () => {
    recordComposioToolOutcome({
      serverId: "composio_gmail",
      input: {},
      content: "Request had invalid authentication credentials.",
      isError: true,
    });
    const { signals } = getConnectorHealthState();
    expect(signals.gmail?.lastErrorAt).toBeDefined();
  });

  it("catches an auth failure embedded in a non-error multi-execute envelope", () => {
    recordComposioToolOutcome({
      serverId: "composio",
      input: {
        tools: [{ tool_slug: "GOOGLEDRIVE_LIST_FILES", arguments: {} }],
      },
      content:
        '{"results":[{"successful":false,"error":"No active connection found for toolkit(s) \'googledrive\' in this session"}]}',
      isError: false,
    });
    const { signals } = getConnectorHealthState();
    expect(signals.googledrive?.lastErrorAt).toBeDefined();
    // A batch with an embedded failure must never refresh lastSuccessAt.
    expect(signals.googledrive?.lastSuccessAt).toBeUndefined();
  });

  it("a non-auth failure records no signal (only auth evidence may downgrade)", () => {
    recordComposioToolOutcome({
      serverId: "composio_gmail",
      input: {},
      content: "Invalid arguments: max_results must be a number",
      isError: true,
    });
    expect(getConnectorHealthState().signals.gmail).toBeUndefined();
  });

  it("a successful execution records passive success for the exercised toolkit", () => {
    // This is what keeps unprobed toolkits (googlesheets et al.) honestly
    // green from real usage instead of sitting evidence-less forever.
    recordComposioToolOutcome({
      serverId: "composio",
      input: { tool_slug: "GOOGLESHEETS_BATCH_GET" },
      content: '{"values":[["a","b"]]}',
      isError: false,
    });
    const { signals } = getConnectorHealthState();
    expect(signals.googlesheets?.lastSuccessAt).toBeDefined();
    expect(signals.googlesheets?.lastErrorAt).toBeUndefined();
  });
});
