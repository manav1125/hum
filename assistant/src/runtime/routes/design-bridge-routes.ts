/**
 * Design bridge — a curated, read-only allowlist of Cue tools exposed to the
 * Cue Design sidecar's headless studio agent (opencode).
 *
 * ## Why this exists
 *
 * The sidecar's design agent can build far richer output when it can gather
 * live material (research a brand, read a spec page) instead of fabricating
 * facts. Rather than give the third-party agent Cue's whole tool surface, we
 * expose exactly two read-only network tools — `web_search` and `web_fetch` —
 * reusing Cue's existing executors (same provider, same key, same SSRF guard).
 * The allowlist IS the security boundary: no memory, email, connectors,
 * filesystem, terminal, schedule, or any side-effectful tool is reachable here.
 *
 * ## Security model (fail-closed, default-off)
 *
 * - **Off by default.** When `DESIGN_BRIDGE_TOKEN` is unset the handlers throw
 *   `NotFoundError` — the bridge is inert and no behaviour changes. Enabling it
 *   is a deliberate act (a Fly secret on both apps, like `OPENROUTER_API_KEY`).
 * - **Authenticated every call.** The sidecar reaches Cue over the private Fly
 *   6PN network; the reverse hop (sidecar → Cue) is authenticated by the shared
 *   `DESIGN_BRIDGE_TOKEN`. The gateway validates a `Bearer` header at the edge
 *   (see `gateway/src/http/routes/design-tools-proxy.ts`) AND forwards it here,
 *   so the daemon handler re-checks it with a constant-time compare. The guard
 *   is uniform across both transports (HTTP + IPC) — an HTTP caller that
 *   reaches the daemon route directly still needs the token.
 * - **Read-only, no new key.** Both handlers call the existing tool executors
 *   (`webSearchTool.execute` / `executeWebFetch`), which use the configured
 *   provider and key. `web_fetch` reuses the executor's built-in URL-safety /
 *   SSRF guard verbatim (private/local targets are refused; we never pass
 *   `allow_private_network`).
 *
 * These routes live in the shared ROUTES array (served over HTTP and IPC per
 * assistant/CLAUDE.md); the gateway calls them over IPC via `ipcCallAssistant`.
 * The HTTP path is additionally locked to `local` principals — the real gate is
 * the token check below, not the transport.
 */

import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { executeWebFetch } from "../../tools/network/web-fetch.js";
import { webSearchTool } from "../../tools/network/web-search.js";
import type { ToolContext, ToolExecutionResult } from "../../tools/types.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError, UnauthorizedError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/**
 * The hard-coded, read-only allowlist. Adding a tool here is the ONLY way to
 * widen what the design agent can reach — do not make this dynamic. Anything
 * with a side effect (memory, email, connectors, filesystem, terminal,
 * schedule) must never appear.
 */
export const DESIGN_BRIDGE_ALLOWED_TOOLS = ["web_search", "web_fetch"] as const;

/** Read the shared secret. Absent ⇒ the bridge is disabled. */
function designBridgeToken(): string | undefined {
  const raw = process.env.DESIGN_BRIDGE_TOKEN?.trim();
  return raw ? raw : undefined;
}

/** Constant-time string comparison that never short-circuits on length. */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Compare against self to keep the timing profile flat, then fail.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Fail-closed gate shared by every bridge handler:
 * 1. If `DESIGN_BRIDGE_TOKEN` is unset the whole feature is off → 404 (inert).
 * 2. The caller must present `Authorization: Bearer <DESIGN_BRIDGE_TOKEN>`.
 *
 * The gateway validates the same token at the edge; this second check makes the
 * daemon route self-guarding regardless of transport.
 */
function assertBridgeAuthorized(args: RouteHandlerArgs): void {
  const token = designBridgeToken();
  if (!token) {
    // Indistinguishable from "route does not exist" — the bridge is off.
    throw new NotFoundError("Not found");
  }
  const header =
    args.headers?.authorization ?? args.headers?.Authorization ?? "";
  const prefix = "Bearer ";
  const presented = header.startsWith(prefix)
    ? header.slice(prefix.length)
    : "";
  if (!presented || !constantTimeEquals(presented, token)) {
    throw new UnauthorizedError("Invalid design bridge token");
  }
}

/**
 * Minimal synthetic tool context for an internal, non-conversation invocation.
 * `web_search` / `web_fetch` read only `signal`; the required identity fields
 * are set to inert internal values. `trustClass` is unused by these two tools.
 */
function bridgeToolContext(abortSignal?: AbortSignal): ToolContext {
  return {
    conversationId: "design-bridge",
    workingDir: process.cwd(),
    trustClass: "guardian",
    signal: abortSignal,
  };
}

function toResponse(result: ToolExecutionResult): {
  content: string;
  isError: boolean;
} {
  return { content: result.content, isError: result.isError };
}

const bridgeResultSchema = z.object({
  content: z.string(),
  isError: z.boolean(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "designBridgeWebSearch",
    endpoint: "design-bridge/web-search",
    method: "POST",
    // The HTTP surface is locked to local principals; the token check in the
    // handler is the real gate for the IPC path the gateway actually uses.
    policy: {
      requiredScopes: [],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Curated web search for the Cue Design agent",
    description:
      "Read-only web search exposed to the Cue Design sidecar agent when the design bridge is enabled (DESIGN_BRIDGE_TOKEN set). Reuses Cue's configured search provider and key. Inert (404) when the bridge is off.",
    tags: ["design-bridge"],
    requestBody: z.object({ query: z.string() }),
    responseBody: bridgeResultSchema,
    handler: async (args: RouteHandlerArgs) => {
      assertBridgeAuthorized(args);
      const query = args.body?.query;
      if (typeof query !== "string" || !query.trim()) {
        return {
          content: "Error: query is required and must be a non-empty string",
          isError: true,
        };
      }
      const result = await webSearchTool.execute(
        { query },
        bridgeToolContext(args.abortSignal),
      );
      return toResponse(result);
    },
  },
  {
    operationId: "designBridgeWebFetch",
    endpoint: "design-bridge/web-fetch",
    method: "POST",
    policy: {
      requiredScopes: [],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Curated web fetch for the Cue Design agent",
    description:
      "Read-only single-URL fetch exposed to the Cue Design sidecar agent when the design bridge is enabled (DESIGN_BRIDGE_TOKEN set). Reuses Cue's existing URL-safety / SSRF guard — private and local targets are refused. Inert (404) when the bridge is off.",
    tags: ["design-bridge"],
    requestBody: z.object({ url: z.string() }),
    responseBody: bridgeResultSchema,
    handler: async (args: RouteHandlerArgs) => {
      assertBridgeAuthorized(args);
      const url = args.body?.url;
      if (typeof url !== "string" || !url.trim()) {
        return {
          content: "Error: url is required and must be a non-empty string",
          isError: true,
        };
      }
      // Pass ONLY the url — never allow_private_network — so the executor's
      // SSRF guard stays fully active (initial host + every redirect hop).
      const result = await executeWebFetch(
        { url },
        { signal: args.abortSignal },
      );
      return toResponse(result);
    },
  },
];
