/**
 * Cue Live guidance route.
 *
 * The native overlay reads the accessibility element under the user's cursor
 * and asks the assistant for one short, action-oriented "next move". This runs
 * a single ephemeral, tool-free side-chain LLM call through the active brain —
 * no conversation is created or persisted, so it returns fast and never shows
 * up in the user's history. When no model is configured (e.g. no provider key)
 * it returns `{ nextMove: null }` so the overlay falls back to its local AX
 * heuristic.
 */
import { z } from "zod";

import { getConfiguredProvider } from "../../providers/provider-send-message.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { runBtwSidechain } from "../btw-sidechain.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("cuelive");

const GuidanceBody = z.object({
  role: z
    .string()
    .describe("Accessibility role of the element under the cursor"),
  roleDescription: z
    .string()
    .optional()
    .describe("Human-readable role description (e.g. 'text field')"),
  label: z.string().optional().describe("The element's accessible label"),
  value: z
    .string()
    .optional()
    .describe("The element's value (already redacted for secure fields)"),
  appName: z.string().optional().describe("Frontmost application name"),
  actions: z
    .array(z.string())
    .optional()
    .describe("AX actions the element supports, e.g. AXPress, AXConfirm"),
});

const GUIDANCE_SYSTEM_PROMPT =
  "You are Cue, guiding the user through their Mac in real time. Given the UI " +
  "element under their cursor, reply with ONE short, imperative next-move " +
  "suggestion of at most 10 words — no preamble, no quotes, no trailing period. " +
  "If the element isn't actionable, suggest what to look at instead.";

const MAX_GUIDANCE_TOKENS = 64;
const GUIDANCE_TIMEOUT_MS = 8_000;

async function handleGuidance({
  body,
  abortSignal,
}: RouteHandlerArgs): Promise<{ nextMove: string | null }> {
  const parsed = GuidanceBody.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError("Invalid Cue Live guidance request body");
  }
  const { role, roleDescription, label, value, appName, actions } = parsed.data;

  const provider = await getConfiguredProvider("mainAgent");
  if (!provider) {
    // No usable model (e.g. no provider key configured) — the overlay falls
    // back to its local AX heuristic.
    return { nextMove: null };
  }

  const context = [
    appName ? `App: ${appName}` : null,
    `Element: ${role}${roleDescription ? ` (${roleDescription})` : ""}`,
    label ? `Label: ${label}` : null,
    value ? `Value: ${value.slice(0, 160)}` : null,
    actions && actions.length ? `Supports: ${actions.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const result = await runBtwSidechain({
      content: `The user summoned you. What's their next move here?\n${context}`,
      provider,
      systemPrompt: GUIDANCE_SYSTEM_PROMPT,
      tools: [],
      maxTokens: MAX_GUIDANCE_TOKENS,
      callSite: "mainAgent",
      timeoutMs: GUIDANCE_TIMEOUT_MS,
      signal: abortSignal,
    });
    const nextMove = result.text
      .trim()
      .replace(/^["']|["']$/g, "")
      .slice(0, 120);
    return { nextMove: nextMove || null };
  } catch (err) {
    log.warn({ err }, "Cue Live guidance generation failed");
    return { nextMove: null };
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "cuelive_guidance",
    endpoint: "cuelive/guidance",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGuidance,
    summary: "Synthesize a next-move hint for the Cue Live overlay",
    description:
      "Run one ephemeral, tool-free LLM call to suggest the user's next action " +
      "for the accessibility element under their cursor. Returns " +
      "{ nextMove: null } when no model is configured so the overlay can fall " +
      "back to its local heuristic.",
    tags: ["cuelive"],
    requestBody: GuidanceBody,
    responseBody: z.object({ nextMove: z.string().nullable() }),
  },
];
