/**
 * Passive connector-health signals from REAL MCP tool executions.
 *
 * The health store's passive layer was only fed by the OAuth request proxy
 * (`oauth/composio-oauth.ts`) — the path connector *skills* ride. But the
 * agent's day-to-day connector calls go through the Composio MCP servers
 * (`composio_<toolkit>` per-toolkit servers, plus the bare `composio`
 * workbench whose `COMPOSIO_EXECUTE_TOOL` / `COMPOSIO_MULTI_EXECUTE_TOOL`
 * carry the real action in their input). Those calls returned their
 * auth-expired errors straight to the model and recorded NOTHING — so the
 * Connectors page kept showing "working ✓ just now" from a ≤10-minute-old
 * probe at the very moment a real calendar call was failing with an expired
 * OAuth connection. A stored "ok" must be downgraded by the first real
 * auth-shaped failure, not by the next probe sweep.
 *
 * This module classifies MCP tool outcomes and feeds the same store the
 * proxy path uses:
 *  · an auth-shaped failure → `recordConnectorFailure` (a fresh error beats
 *    an older success in `computeConnectorHealth`, so the verdict flips to
 *    "attention" immediately);
 *  · a successful execution → `recordConnectorSuccess` (real usage keeps
 *    unprobed toolkits like googlesheets honestly green);
 *  · anything else (validation errors, transport failures) → no signal —
 *    only auth-shaped evidence may claim the connection itself is broken.
 *
 * Everything here is best-effort and never throws: health is an observation
 * layer and must not break tool execution.
 */

import { mcpServerKeyToComposioToolkit } from "../../capabilities/mcp-connectors.js";
import {
  recordConnectorFailure,
  recordConnectorSuccess,
} from "../../oauth/connector-health-store.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("composio-tool-health");

/**
 * Auth-shaped failure patterns, matched against tool-result text. Kept TIGHT
 * on purpose: these strings also scan nominally-successful results (Composio's
 * multi-execute returns per-action failures inside a non-error envelope), so a
 * loose pattern could flip a healthy connector to "attention" off provider
 * DATA (an email body, a Slack message). Every pattern is a connector-error
 * idiom, not prose.
 */
const AUTH_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /no active connection/i,
  /re-?authenticat/i,
  /invalid[_\s]grant/i,
  /token[_\s](?:has\s+been\s+)?(?:expired|revoked)/i,
  /(?:expired|revoked)[_\s](?:access[_\s])?token/i,
  /invalid authentication credentials/i,
  /\bunauthenticated\b/i,
  /\binvalid_auth\b/i,
  /authentication (?:failed|expired|required)/i,
  /connection (?:is )?(?:expired|revoked|inactive|not active|disabled)/i,
];

/**
 * Input keys that carry an embedded connector action slug on the bare
 * `composio` workbench's meta tools (`COMPOSIO_EXECUTE_TOOL({ tool_slug:
 * "GMAIL_SEND_EMAIL", … })` and the multi-execute batch forms). Mirrors the
 * key list `tools/outbound-send.ts` uses to classify proxied sends —
 * deliberately NOT including `tool_schemas`, whose keys identify schema
 * FETCHES: fetching a schema never touches provider auth, so it is not
 * evidence of connector life.
 */
const ACTION_SLUG_KEYS = [
  "tool_slug",
  "tool_name",
  "action",
  "action_name",
  "slug",
  "app_action",
] as const;

const BATCH_ARRAY_KEYS = [
  "arguments",
  "tools",
  "actions",
  "executions",
  "calls",
] as const;

/** `GOOGLECALENDAR_FIND_EVENT` → `googlecalendar`; garbage → null. */
function toolkitFromActionSlug(actionSlug: string): string | null {
  const head = actionSlug.trim().split("_")[0]?.toLowerCase() ?? "";
  // Composio toolkit slugs are single alnum tokens; the workbench's own meta
  // tools (`COMPOSIO_*`) must never read as a "composio" toolkit.
  if (!/^[a-z0-9]+$/.test(head) || head === "composio") return null;
  return head;
}

/**
 * The Composio toolkit slugs a tool call actually exercised, or [] when the
 * call touched no provider connection (a non-Composio server, or a workbench
 * meta call with no embedded action).
 */
export function composioToolkitsForCall(
  serverId: string,
  input: Record<string, unknown>,
): string[] {
  const perToolkit = mcpServerKeyToComposioToolkit(serverId);
  if (perToolkit) return [perToolkit];
  if (serverId.trim().toLowerCase() !== "composio") return [];

  const toolkits = new Set<string>();
  const pushFrom = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    const rec = obj as Record<string, unknown>;
    for (const key of ACTION_SLUG_KEYS) {
      const v = rec[key];
      if (typeof v !== "string") continue;
      const toolkit = toolkitFromActionSlug(v);
      if (toolkit) toolkits.add(toolkit);
    }
  };
  pushFrom(input);
  for (const key of BATCH_ARRAY_KEYS) {
    const arr = input[key];
    if (Array.isArray(arr)) for (const el of arr) pushFrom(el);
  }
  return [...toolkits];
}

/** The auth-shaped fragment of a tool result, or null when none matches. */
export function findAuthShapedError(text: string): string | null {
  for (const pattern of AUTH_ERROR_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      // A short window around the match keeps the recorded error legible
      // without persisting a whole tool payload.
      const start = Math.max(0, match.index - 40);
      return text.slice(start, match.index + match[0].length + 80).trim();
    }
  }
  return null;
}

/**
 * Feed one real MCP tool outcome into the connector health store.
 *
 * Auth-shaped errors are looked for regardless of `isError` — Composio's
 * multi-execute reports per-action failures inside a non-error envelope, and
 * an embedded "please reauthenticate" is exactly the evidence a stored "ok"
 * must yield to. Success is only recorded when the result is a non-error AND
 * nothing auth-shaped is present, so a partially-failed batch can never
 * refresh `lastSuccessAt` past its own failure.
 */
export function recordComposioToolOutcome(args: {
  serverId: string;
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
}): void {
  try {
    const toolkits = composioToolkitsForCall(args.serverId, args.input);
    if (toolkits.length === 0) return;

    const authError = findAuthShapedError(args.content);
    if (authError) {
      for (const toolkit of toolkits) {
        recordConnectorFailure(
          toolkit,
          `A real call hit an auth error — reconnect to fix: ${authError}`,
        );
      }
      log.info(
        { serverId: args.serverId, toolkits, authError },
        "real tool call reported a connector auth failure",
      );
      return;
    }
    if (!args.isError) {
      for (const toolkit of toolkits) recordConnectorSuccess(toolkit);
    }
  } catch (err) {
    log.warn(
      { err, serverId: args.serverId },
      "recordComposioToolOutcome failed",
    );
  }
}
