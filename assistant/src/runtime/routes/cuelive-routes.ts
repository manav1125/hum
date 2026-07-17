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
import type { Message } from "../../providers/types.js";
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

// --- Vision "look" route (clicky-style: screenshot + spoken question) --------

const LookBody = z.object({
  question: z
    .string()
    .describe("The user's spoken (transcribed) question about their screen"),
  imageBase64: z.string().describe("Screenshot, base64-encoded (no data URI)"),
  mediaType: z
    .string()
    .default("image/png")
    .describe("MIME type of the screenshot"),
  imageWidth: z
    .number()
    .describe("Pixel width of the screenshot (POINT coords are in this space)"),
  imageHeight: z.number().describe("Pixel height of the screenshot"),
});

const LookPoint = z.object({
  x: z.number(),
  y: z.number(),
  label: z.string(),
});

const LookResult = z.object({
  /** Spoken answer with the [POINT] tags stripped out. */
  answer: z.string(),
  /** Where to point on screen, in screenshot-pixel coordinates. */
  points: z.array(LookPoint),
  /**
   * Why the look produced no answer, when it failed outright. An empty `answer`
   * alone is ambiguous — a dead vision model and a model with nothing to say
   * look identical, which is how a total Cue Live vision outage stayed
   * invisible. Present only on failure, so the overlay can say something true
   * instead of silently shrugging.
   */
  error: z.string().optional(),
});
type LookResultT = z.infer<typeof LookResult>;

const lookSystemPrompt = (w: number, h: number): string =>
  "You are Cue, an AI teacher who lives next to the user's cursor. You can see " +
  "their screen and you talk to them like a friendly buddy looking over their " +
  "shoulder. Answer their question about what's on screen in 1-3 short, spoken " +
  "sentences — natural and conversational, no markdown, no lists.\n\n" +
  `The screenshot is ${w}x${h} pixels, origin at the top-left. Whenever you ` +
  "refer to something the user should look at or click, emit a tag of the form " +
  "[POINT:x,y:label] inline, where x,y are pixel coordinates of the CENTER of " +
  "that element in the screenshot and label is 1-3 words. Emit one tag per " +
  "element you call out; you may use several. Keep the tags inline where you " +
  "mention the thing — they are stripped from what the user hears.";

const POINT_TAG =
  /\[POINT:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*:\s*([^\]]*?)\s*\]/g;

/** Pull [POINT:x,y:label] tags out of the model text; return cleaned text + points. */
function parsePoints(text: string): LookResultT {
  const points: LookResultT["points"] = [];
  let m: RegExpExecArray | null;
  POINT_TAG.lastIndex = 0;
  while ((m = POINT_TAG.exec(text)) !== null) {
    points.push({ x: Number(m[1]), y: Number(m[2]), label: m[3].trim() });
  }
  const answer = text
    .replace(POINT_TAG, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { answer, points };
}

const MAX_LOOK_TOKENS = 320;
const LOOK_TIMEOUT_MS = 20_000;

/**
 * Turn a look failure into one short line the overlay can show the owner.
 * The vision model is configured separately from the brain (`cueLiveVision`),
 * so its two operator-fixable failures — a model that can't take images, and
 * one no provider will serve — get named rather than buried.
 */
function describeLookFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (
    /doesn't support image input|no endpoints found that support image/i.test(
      message,
    )
  ) {
    return "The configured vision model can't read images. Set llm.callSites.cueLiveVision to a vision-capable model.";
  }
  if (/no endpoints found/i.test(message)) {
    return "No provider is serving the configured vision model right now.";
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "Looking at your screen timed out.";
  }
  return "Cue couldn't read your screen just now.";
}

async function handleLook({
  body,
  abortSignal,
}: RouteHandlerArgs): Promise<LookResultT> {
  const parsed = LookBody.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError("Invalid Cue Live look request body");
  }
  const { question, imageBase64, mediaType, imageWidth, imageHeight } =
    parsed.data;

  const provider = await getConfiguredProvider("mainAgent");
  if (!provider) {
    return { answer: "", points: [] };
  }

  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mediaType, data: imageBase64 },
        },
        {
          type: "text",
          text: question.trim() || "What's on my screen and what should I do?",
        },
      ],
    },
  ];

  try {
    const result = await runBtwSidechain({
      content: "", // unused — messages carries the image + question
      messages,
      provider,
      systemPrompt: lookSystemPrompt(imageWidth, imageHeight),
      tools: [],
      maxTokens: MAX_LOOK_TOKENS,
      callSite: "cueLiveVision",
      timeoutMs: LOOK_TIMEOUT_MS,
      signal: abortSignal,
    });
    return parsePoints(result.text);
  } catch (err) {
    log.warn({ err }, "Cue Live look generation failed");
    return { answer: "", points: [], error: describeLookFailure(err) };
  }
}

// --- Agentic "act" route (full-auto take control) ----------------------------

const ActBody = z.object({
  goal: z.string().describe("What the user asked Cue to accomplish"),
  imageBase64: z.string().describe("Current screenshot, base64 (no data URI)"),
  mediaType: z.string().default("image/png"),
  imageWidth: z.number(),
  imageHeight: z.number(),
  step: z.number().describe("1-based step number in this run"),
  history: z
    .string()
    .optional()
    .describe("Short log of actions already taken this run"),
});

const ActionSchema = z.object({
  type: z.enum([
    "click",
    "doubleclick",
    "type",
    "key",
    "scroll",
    "move",
    "none",
  ]),
  x: z.number().nullish(),
  y: z.number().nullish(),
  text: z.string().nullish(),
  key: z.string().nullish(),
  dx: z.number().nullish(),
  dy: z.number().nullish(),
});

const ActResult = z.object({
  say: z.string().nullable(),
  done: z.boolean(),
  action: ActionSchema.nullable(),
});
type ActResultT = z.infer<typeof ActResult>;

const actSystemPrompt = (w: number, h: number): string =>
  "You are Cue, operating the user's Mac to accomplish their goal by " +
  "controlling the mouse and keyboard. You are shown a screenshot " +
  `(${w}x${h} pixels, origin top-left). Decide the SINGLE next action and ` +
  "output ONLY a JSON object, no prose, no code fences:\n" +
  '{"say": <a short spoken update, <=10 words, or null>, ' +
  '"done": <true when the goal is achieved OR you cannot safely proceed>, ' +
  '"action": {"type": "click"|"doubleclick"|"type"|"key"|"scroll"|"move"|"none", ' +
  '"x": <pixel>, "y": <pixel>, "text": <for type>, "key": <return|tab|escape|up|down|left|right|delete|space>, ' +
  '"dx": <for scroll>, "dy": <for scroll>}}\n' +
  "x,y are the pixel center of the target in the screenshot. One action per " +
  "step. After typing into a field, the next step is usually key=return when " +
  "submitting. When the goal is complete, set done=true with action=null.\n" +
  "If the goal is just a question rather than a task to perform, answer it in " +
  "'say' and set done=true with action=null — do not click or type.\n" +
  "Safety: never type passwords, card numbers, or other credentials, and never " +
  "perform irreversible deletions, sends, or purchases unless the goal " +
  "explicitly and unambiguously asks for it — in that case set done=true and " +
  "say why instead.";

function parseActJson(text: string): ActResultT {
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  try {
    const parsed = ActResult.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  // Couldn't parse a valid action — stop the run rather than flail.
  return { say: null, done: true, action: null };
}

const MAX_ACT_TOKENS = 300;
const ACT_TIMEOUT_MS = 20_000;

async function handleAct({
  body,
  abortSignal,
}: RouteHandlerArgs): Promise<ActResultT> {
  const parsed = ActBody.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError("Invalid Cue Live act request body");
  }
  const {
    goal,
    imageBase64,
    mediaType,
    imageWidth,
    imageHeight,
    step,
    history,
  } = parsed.data;

  const provider = await getConfiguredProvider("mainAgent");
  if (!provider) return { say: null, done: true, action: null };

  const userText =
    `Goal: ${goal}\nStep: ${step}` +
    (history ? `\nSo far:\n${history}` : "") +
    "\nWhat is the single next action? Respond with the JSON object only.";

  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mediaType, data: imageBase64 },
        },
        { type: "text", text: userText },
      ],
    },
  ];

  try {
    const result = await runBtwSidechain({
      content: "",
      messages,
      provider,
      systemPrompt: actSystemPrompt(imageWidth, imageHeight),
      tools: [],
      maxTokens: MAX_ACT_TOKENS,
      callSite: "cueLiveVision",
      timeoutMs: ACT_TIMEOUT_MS,
      signal: abortSignal,
    });
    return parseActJson(result.text);
  } catch (err) {
    log.warn({ err }, "Cue Live act generation failed");
    // `done: true` ends the run — it has to, since without vision there is no
    // next action to take. Carry the reason in `say` so the run reports why it
    // stopped instead of looking like it finished the goal.
    return { say: describeLookFailure(err), done: true, action: null };
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "cuelive_act",
    endpoint: "cuelive/act",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleAct,
    summary: "Decide the next UI action to accomplish the user's goal",
    description:
      "Full-auto take-control step: given a screenshot + goal, return the " +
      "single next mouse/keyboard action (or done). Returns done when no model " +
      "is configured.",
    tags: ["cuelive"],
    requestBody: ActBody,
    responseBody: ActResult,
  },
  {
    operationId: "cuelive_look",
    endpoint: "cuelive/look",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleLook,
    summary: "Answer a spoken question about the user's screen and point at it",
    description:
      "Send a screenshot + the user's transcribed question to the configured " +
      "model. Returns a short spoken answer plus on-screen points (in " +
      "screenshot-pixel coordinates) to fly the cursor to. Returns empty when " +
      "no model is configured.",
    tags: ["cuelive"],
    requestBody: LookBody,
    responseBody: LookResult,
  },
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
