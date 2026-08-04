/**
 * First-class `browser_*` tools.
 *
 * The model is instructed (system prompt + reach snapshot) to drive a web
 * browser with `browser_navigate` / `browser_click` / `browser_fill` / etc.
 * Those tools historically did NOT exist — browser control was only reachable
 * by loading a skill and shelling out to the `assistant browser` CLII, which the
 * model rarely discovered. With no `browser_*` tool in its toolset, the model
 * fell back to `computer_use_*` screen-clicking (the "clicks keep hitting the
 * wrong window" failure), never actually using the connected extension.
 *
 * This module makes the promised tools real: it generates one `browser_<op>`
 * tool per {@link BROWSER_OPERATION_META} entry, each delegating to
 * {@link executeBrowserOperation} — the same single execution entrypoint the
 * CLI uses, which routes to the connected Chrome extension (or the macOS host
 * proxy / local Playwright, per backend precedence). No new browser plumbing:
 * only the tool surface that was missing.
 */

import {
  BROWSER_OPERATION_META,
  executeBrowserOperation,
} from "../../browser/operations.js";
import type { BrowserOperation } from "../../browser/types.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../types.js";

/**
 * Operations that only read or navigate are Low risk (auto-approvable);
 * operations that mutate the user's real, signed-in browser are Medium (they
 * prompt unless the user has raised their auto-approve threshold). This mirrors
 * how the rest of the tool surface treats read-vs-write.
 */
const LOW_RISK_OPERATIONS: ReadonlySet<BrowserOperation> = new Set([
  "navigate",
  "snapshot",
  "screenshot",
  "extract",
  "status",
  "wait_for",
  "attach",
  "detach",
  "close",
]);

/** Map an operation field type to its JSON-schema type. */
function fieldSchema(field: {
  type: string;
  description: string;
  enum?: readonly string[];
}): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: field.type,
    description: field.description,
  };
  if (field.enum) schema.enum = [...field.enum];
  return schema;
}

function buildBrowserTool(
  meta: (typeof BROWSER_OPERATION_META)[number],
): ToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of meta.fields) {
    properties[field.name] = fieldSchema(field);
    if (field.required) required.push(field.name);
  }
  // Shared, optional inputs every browser op accepts. `browser_mode` and
  // `session` mirror the CLI's parent options; `activity` is the
  // non-technical explanation shown in a permission prompt.
  properties.browser_mode = {
    type: "string",
    description:
      "Optional backend override (auto|extension|host|local). Defaults to auto, which prefers the connected Chrome extension.",
  };
  properties.session = {
    type: "string",
    description:
      "Optional browser session id to pin this operation to a specific tab/session.",
  };
  properties.activity = {
    type: "string",
    description:
      "Brief non-technical explanation of what this does, shown to the user in any permission prompt.",
  };
  properties.label = {
    type: "string",
    description:
      'Visible name of the control you are acting on (e.g. "Send", "Submit", "Pay"). Set this when an attempt was blocked because the target resolved to a send/submit control — it is what makes the action legible to the human-approval gate, which then asks the user to confirm.',
  };

  return {
    name: `browser_${meta.operation}`,
    description: `${meta.description} Drives the user's connected browser (Chrome extension when paired, else the macOS host proxy or local Playwright) — the correct tool for web work. Do NOT use computer_use_* to click around a browser.${meta.helpText ? `\n\n${meta.helpText}` : ""}`,
    category: "browser",
    executionTarget: "host",
    defaultRiskLevel: LOW_RISK_OPERATIONS.has(meta.operation)
      ? RiskLevel.Low
      : RiskLevel.Medium,
    input_schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    execute: (input, context) =>
      executeBrowserOperation(meta.operation, input, context),
  } satisfies ToolDefinition;
}

/** All `browser_*` tools, one per canonical browser operation. */
export const browserTools: ToolDefinition[] =
  BROWSER_OPERATION_META.map(buildBrowserTool);
