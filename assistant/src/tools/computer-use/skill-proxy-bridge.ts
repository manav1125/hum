/**
 * Shared helper for computer-use skill wrapper scripts.
 *
 * Each wrapper calls forwardComputerUseProxyTool() to delegate execution to
 * the proxy resolver, which forwards the call to the connected macOS client.
 */

import type { ToolContext, ToolExecutionResult } from "../types.js";
import { runGuardedComputerUseTool } from "./ax-send-guard.js";

/**
 * Forward a computer-use proxy tool call through the context's proxyToolResolver.
 *
 * Returns a clear error result if the resolver is missing (e.g. when the tool
 * is invoked outside a session with a connected client).
 *
 * The dispatch is wrapped by the send-control checkpoint: a click or ⌘/Ctrl+Enter
 * that the cached accessibility snapshot resolves to a Send/Submit/Pay control
 * is parked (unattended) or routed back through the approval gate (attended)
 * instead of being forwarded to the client. See `ax-send-guard.ts`.
 */
export function forwardComputerUseProxyTool(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!context.proxyToolResolver) {
    return Promise.resolve({
      content: `Cannot execute ${toolName}: no proxy resolver available. This tool requires a connected macOS client.`,
      isError: true,
    });
  }
  const resolver = context.proxyToolResolver;
  return runGuardedComputerUseTool(toolName, input, context, () =>
    resolver(toolName, input),
  );
}
