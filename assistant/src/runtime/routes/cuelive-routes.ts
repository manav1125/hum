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

import { kickScreenObservationCapture } from "../../cue-live/observation-capture.js";
import type { MissionMode } from "../../missions/mission-store.js";
import { getGlobalDial } from "../../playbooks/autonomy-cap.js";
import { getConfiguredProvider } from "../../providers/provider-send-message.js";
import type { Message } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { runBtwSidechain } from "../btw-sidechain.js";
import {
  dialAllowsCueLiveAction,
  evaluateInputRelay,
} from "./cuelive-input-policy.js";
import {
  armTakeover,
  disarmTakeover,
  dispatchRelayAction,
  getTakeoverStatus,
  isTakeoverArmed,
  type RelayAction,
} from "./cuelive-input-relay.js";
import {
  consumeRemoteStop,
  getSessionView,
  isRemotePaused,
  recordActStep,
  recordGuidance,
  recordLook,
  recordRelayAction,
  requestRemoteStop,
  setRemotePaused,
} from "./cuelive-session.js";
import {
  armStream,
  disarmStream,
  getLiveFrameGeometry,
  getStreamStatus,
  MAX_FRAME_BASE64_BYTES,
  pushFrame,
  recordMacCheckin,
  takeFrame,
} from "./cuelive-stream.js";
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

  // Feed the remote viewer (metadata only), then honor a remote pause: the
  // overlay falls back to its local AX heuristic, exactly like the no-model
  // case.
  recordGuidance({ appName, label });
  if (isRemotePaused()) return { nextMove: null };

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

  // Remote pause (from the phone viewer): answer inertly with a reason the
  // overlay can show. The screenshot is never retained either way.
  if (isRemotePaused()) {
    recordLook({ question, imageWidth, imageHeight, held: true });
    return { answer: "", points: [], error: "Paused from your phone." };
  }

  const provider = await getConfiguredProvider("mainAgent");
  if (!provider) {
    recordLook({ question, imageWidth, imageHeight });
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
    const lookResult = parsePoints(result.text);
    recordLook({
      question,
      answer: lookResult.answer,
      imageWidth,
      imageHeight,
    });
    // A look already produced a fresh description of this screen. When the
    // owner has armed observation capture, hand that description to the
    // capture pass (text tier — no second vision call, no frame retained) so
    // "Cue watches your screen and picks up the work" is true of the verb the
    // user actually uses. No-ops when capture is off or disarmed.
    kickScreenObservationCapture({
      description: lookResult.answer,
      appName: getSessionView().watching?.appName ?? undefined,
    });
    return lookResult;
  } catch (err) {
    log.warn({ err }, "Cue Live look generation failed");
    const error = describeLookFailure(err);
    recordLook({ question, error, imageWidth, imageHeight });
    return { answer: "", points: [], error };
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
  "x and y are SEPARATE top-level numbers holding the pixel center of the " +
  "target — never a coordinate array. Exactly like this:\n" +
  '{"say": "Opening Projects.", "done": false, ' +
  '"action": {"type": "click", "x": 113, "y": 216}}\n' +
  "One action per " +
  "step. After typing into a field, the next step is usually key=return when " +
  "submitting. When the goal is complete, set done=true with action=null.\n" +
  "If the goal is just a question rather than a task to perform, answer it in " +
  "'say' and set done=true with action=null — do not click or type.\n" +
  "Safety: never type passwords, card numbers, or other credentials, and never " +
  "perform irreversible deletions, sends, or purchases unless the goal " +
  "explicitly and unambiguously asks for it — in that case set done=true and " +
  "say why instead.";

/**
 * Vision models ground to a *point*, so they reach for a coordinate pair even
 * when the schema asks for two numbers: `"x": [113, 216]` with `y` absent.
 * That is the right click target expressed the model's native way, so accept it
 * rather than throw the step away — the alternative is a run that gives up on
 * step 1 and reports success. Only the unambiguous case is coerced: an `x` pair
 * with no usable `y`.
 */
function normalizeActionCoords(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const action = value as Record<string, unknown>;
  if (
    Array.isArray(action.x) &&
    action.x.length === 2 &&
    action.x.every((n) => typeof n === "number") &&
    typeof action.y !== "number"
  ) {
    return { ...action, x: action.x[0], y: action.x[1] };
  }
  return action;
}

function parseActJson(text: string): ActResultT {
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj && typeof obj === "object" && "action" in obj) {
      obj.action = normalizeActionCoords(obj.action);
    }
    const parsed = ActResult.safeParse(obj);
    if (parsed.success) return parsed.data;
    log.warn(
      { issues: parsed.error.issues, text: text.slice(0, 300) },
      "Cue Live act: model reply did not match the action schema",
    );
  } catch {
    log.warn(
      { text: text.slice(0, 300) },
      "Cue Live act: model reply was not valid JSON",
    );
  }
  // Couldn't parse a valid action — stop the run rather than flail. Logged
  // above: an unreadable reply and a completed goal both land here, and
  // silently they look identical.
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

  // Remote stop (one-shot, from the phone viewer): the act loop asks the
  // daemon for every step, so answering done genuinely ends the run.
  if (consumeRemoteStop()) {
    const say = "Stopped from your phone.";
    recordActStep({
      goal,
      step,
      say,
      done: true,
      stoppedRemotely: true,
      imageWidth,
      imageHeight,
    });
    return { say, done: true, action: null };
  }

  // The global trust dial caps Cue Live exactly as it caps every other
  // acting surface: Observe means watch-only, so the take-control loop stops
  // before it touches the mouse. Assist and Autonomous both permit attended
  // action, which is what a summoned auto-run is.
  if (!dialAllowsCueLiveAction(readTrustDial())) {
    const say =
      "Your trust dial is set to Observe, so I can look but not act.";
    recordActStep({
      goal,
      step,
      say,
      done: true,
      stoppedRemotely: true,
      imageWidth,
      imageHeight,
    });
    return { say, done: true, action: null };
  }

  // Remote pause: an auto-run can't idle mid-step, so a pause ends it too —
  // said out loud rather than silently.
  if (isRemotePaused()) {
    const say = "Paused from your phone.";
    recordActStep({
      goal,
      step,
      say,
      done: true,
      held: true,
      stoppedRemotely: true,
      imageWidth,
      imageHeight,
    });
    return { say, done: true, action: null };
  }

  const provider = await getConfiguredProvider("mainAgent");
  if (!provider) {
    recordActStep({ goal, step, done: true, imageWidth, imageHeight });
    return { say: null, done: true, action: null };
  }

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
    const actResult = parseActJson(result.text);
    recordActStep({
      goal,
      step,
      say: actResult.say,
      done: actResult.done,
      imageWidth,
      imageHeight,
    });
    return actResult;
  } catch (err) {
    log.warn({ err }, "Cue Live act generation failed");
    // `done: true` ends the run — it has to, since without vision there is no
    // next action to take. Carry the reason in `say` so the run reports why it
    // stopped instead of looking like it finished the goal.
    const say = describeLookFailure(err);
    recordActStep({ goal, step, say, done: true, imageWidth, imageHeight });
    return { say, done: true, action: null };
  }
}

// --- Remote viewer session routes (mobile is the remote) ---------------------

const ObservationSchema = z.object({
  id: z.number(),
  kind: z.enum(["guidance", "look", "act", "input"]),
  at: z.string(),
  summary: z.string(),
  detail: z.string().optional(),
  status: z.enum(["active", "done", "held"]),
  verify: z.enum(["verified", "retrying", "stuck"]).optional(),
});

const MacPresenceSchema = z.object({
  seenAt: z.string(),
  cueLiveRunning: z.boolean(),
  screenRecordingGranted: z.boolean(),
  deviceName: z.string().nullable(),
});

const StreamStatusSchema = z.object({
  state: z.enum(["off", "starting", "live", "stalled"]),
  armed: z.boolean(),
  armedBy: z.enum(["web", "mac"]).nullable(),
  armedAt: z.string().nullable(),
  lastFrameAt: z.string().nullable(),
  seq: z.number(),
  intervalMs: z.number(),
  maxWidth: z.number(),
  viewerAttached: z.boolean(),
  lastStopReason: z.string().nullable(),
  mac: MacPresenceSchema.nullable(),
});

const TakeoverStatusSchema = z.object({
  armed: z.boolean(),
  armedAt: z.string().nullable(),
  steps: z.number(),
  maxSteps: z.number(),
});

const SessionView = z.object({
  active: z.boolean(),
  paused: z.boolean(),
  stopPending: z.boolean(),
  lastSeenAt: z.string().nullable(),
  sessionStartedAt: z.string().nullable(),
  watching: z
    .object({
      appName: z.string().nullable(),
      screen: z.object({ width: z.number(), height: z.number() }).nullable(),
      at: z.string(),
    })
    .nullable(),
  goal: z
    .object({
      text: z.string(),
      step: z.number(),
      done: z.boolean(),
      startedAt: z.string(),
      stoppedRemotely: z.boolean().optional(),
    })
    .nullable(),
  observations: z.array(ObservationSchema),
  /** Screen-stream state. Frames are never part of this payload. */
  stream: StreamStatusSchema,
  /** Whether the owner has armed steering from the web, and the step budget. */
  takeover: TakeoverStatusSchema,
  /** Live global trust dial — the ceiling on everything Cue Live may do. */
  trustDial: z.enum(["observe", "assist", "autonomous"]),
});
type SessionViewT = z.infer<typeof SessionView>;

const PauseBody = z.object({
  paused: z.boolean().describe("Hold (true) or release (false) the session"),
});

/**
 * Read the global trust dial, failing CLOSED. The dial lives in the workspace
 * database; if that read throws (degraded daemon, migration in flight) the
 * honest answer is not "assume the owner allowed it" — it is the most
 * restrictive posture, which makes Cue Live watch-only until the dial can be
 * read again.
 */
function readTrustDial(): MissionMode {
  try {
    return getGlobalDial();
  } catch (err) {
    log.warn({ err }, "Cue Live could not read the trust dial — failing closed");
    return "observe";
  }
}

/**
 * One payload for the whole remote-control surface: what the Mac is doing,
 * whether frames are flowing, whether steering is armed, and the dial that
 * caps both. The frame bytes deliberately travel on their own endpoint so
 * this stays cheap to poll.
 */
function sessionView(): SessionViewT {
  return {
    ...getSessionView(),
    stream: getStreamStatus(),
    takeover: getTakeoverStatus(),
    trustDial: readTrustDial(),
  };
}

function handleSessionGet(): SessionViewT {
  return sessionView();
}

function handleSessionPause({ body }: RouteHandlerArgs): SessionViewT {
  const parsed = PauseBody.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError("Invalid Cue Live pause request body");
  }
  setRemotePaused(parsed.data.paused);
  return sessionView();
}

function handleSessionStop(): {
  stopped: boolean;
  note: string;
  session: SessionViewT;
} {
  const { runInFlight } = requestRemoteStop();
  // Stop ends the run at the next safe boundary AND cuts the picture: leaving
  // frames flowing after a stop would be the one thing the word cannot mean.
  disarmStream("web");
  disarmTakeover();
  return {
    stopped: runInFlight,
    note: runInFlight
      ? "Stop armed — the run ends at its next step, and the screen stream is off."
      : "No auto-run in flight. The screen stream is off; a run started in the next minute will be stopped.",
    session: sessionView(),
  };
}

// --- Screen stream (Mac → daemon → viewer; frames are never persisted) ------

const StreamBody = z.object({
  streaming: z
    .boolean()
    .describe("Arm (true) or stop (false) the screen stream"),
  origin: z
    .enum(["web", "mac"])
    .default("web")
    .describe("Which surface asked, so both can say who stopped it"),
});

function handleStreamGet(): z.infer<typeof StreamStatusSchema> {
  return getStreamStatus();
}

function handleStreamSet({
  body,
}: RouteHandlerArgs): z.infer<typeof StreamStatusSchema> {
  const parsed = StreamBody.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError("Invalid Cue Live stream request body");
  }
  const { streaming, origin } = parsed.data;
  if (!streaming) {
    // Stopping the picture also drops steering — you may not steer blind.
    disarmTakeover();
    return disarmStream(origin);
  }
  return armStream(origin);
}

const CheckinBody = z.object({
  cueLiveRunning: z.boolean(),
  screenRecordingGranted: z.boolean(),
  deviceName: z.string().nullish(),
});

const CheckinResult = z.object({
  stream: StreamStatusSchema,
  paused: z.boolean(),
  stopPending: z.boolean(),
});

/**
 * The Mac's control channel. It reports what it can do and learns from the
 * response whether the owner armed the stream — capture never starts on the
 * Mac's own initiative.
 */
function handleCheckin({ body }: RouteHandlerArgs): z.infer<
  typeof CheckinResult
> {
  const parsed = CheckinBody.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError("Invalid Cue Live check-in body");
  }
  const stream = recordMacCheckin(parsed.data);
  const session = getSessionView();
  return { stream, paused: session.paused, stopPending: session.stopPending };
}

const FrameBody = z.object({
  dataBase64: z
    .string()
    .max(MAX_FRAME_BASE64_BYTES)
    .describe("Downscaled JPEG/WebP frame, base64, no data URI"),
  mediaType: z.string().default("image/jpeg"),
  width: z.number().describe("Frame pixel width"),
  height: z.number().describe("Frame pixel height"),
  screenWidth: z.number().describe("Screen width in points"),
  screenHeight: z.number().describe("Screen height in points"),
  appName: z.string().nullish(),
});

const FramePushResult = z.object({
  streaming: z.boolean(),
  intervalMs: z.number(),
  maxWidth: z.number(),
  rejected: z.string().optional(),
});

function handleFramePush({
  body,
}: RouteHandlerArgs): z.infer<typeof FramePushResult> {
  const parsed = FrameBody.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError("Invalid Cue Live frame body");
  }
  return pushFrame(parsed.data);
}

const FrameResult = z.object({
  stream: StreamStatusSchema,
  frame: z
    .object({
      dataBase64: z.string(),
      mediaType: z.string(),
      width: z.number(),
      height: z.number(),
      screenWidth: z.number(),
      screenHeight: z.number(),
      appName: z.string().nullable(),
      capturedAt: z.string(),
      seq: z.number(),
    })
    .nullable(),
});

function handleFrameGet(): z.infer<typeof FrameResult> {
  const { status, frame } = takeFrame();
  return { stream: status, frame };
}

// --- Take over + input relay (web → the proven host computer-use path) ------

const TakeoverBody = z.object({
  armed: z.boolean().describe("Arm (true) or release (false) web steering"),
});

const TakeoverResult = z.object({
  takeover: TakeoverStatusSchema,
  trustDial: z.enum(["observe", "assist", "autonomous"]),
  /** Present when arming was refused, e.g. the dial forbids acting. */
  refused: z.string().optional(),
});

function handleTakeoverSet({
  body,
}: RouteHandlerArgs): z.infer<typeof TakeoverResult> {
  const parsed = TakeoverBody.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError("Invalid Cue Live takeover request body");
  }
  const dial = readTrustDial();
  if (!parsed.data.armed) {
    disarmTakeover();
    return { takeover: getTakeoverStatus(), trustDial: dial };
  }
  // Refuse to arm at all under Observe, so the button never lights up a
  // capability the dial forbids.
  const decision = evaluateInputRelay({
    dial,
    takeoverArmed: true,
    liveFrame: true,
    paused: isRemotePaused(),
  });
  if (!decision.allowed) {
    return {
      takeover: getTakeoverStatus(),
      trustDial: dial,
      refused: decision.reason,
    };
  }
  armTakeover();
  return { takeover: getTakeoverStatus(), trustDial: dial };
}

const InputBody = z.object({
  kind: z.enum(["click", "double_click", "type", "key", "scroll"]),
  x: z.number().optional().describe("Frame-pixel X (click/scroll)"),
  y: z.number().optional().describe("Frame-pixel Y (click/scroll)"),
  text: z.string().max(2_000).optional(),
  key: z.string().max(40).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.number().optional(),
});

const InputResult = z.object({
  performed: z.boolean(),
  detail: z.string(),
  /** Set when the gate refused; `performed` is false and nothing was sent. */
  refused: z.string().optional(),
  session: SessionView,
});

async function handleInput({
  body,
  abortSignal,
}: RouteHandlerArgs): Promise<z.infer<typeof InputResult>> {
  const parsed = InputBody.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError("Invalid Cue Live input request body");
  }
  const decision = evaluateInputRelay({
    dial: readTrustDial(),
    takeoverArmed: isTakeoverArmed(),
    liveFrame: getLiveFrameGeometry() !== null,
    paused: isRemotePaused(),
  });
  if (!decision.allowed) {
    log.info(
      { code: decision.code, dial: decision.dial },
      "Cue Live input relay refused",
    );
    return {
      performed: false,
      detail: decision.reason,
      refused: decision.reason,
      session: sessionView(),
    };
  }

  const action = parsed.data as RelayAction;
  const result = await dispatchRelayAction(action, { signal: abortSignal });
  recordRelayAction({
    summary: describeRelayAction(action),
    detail: result.detail,
    verify: result.performed ? "verified" : "stuck",
  });
  return { ...result, session: sessionView() };
}

/** One human line per relayed gesture for the observation stream. */
function describeRelayAction(action: RelayAction): string {
  switch (action.kind) {
    case "click":
      return "You clicked from the web viewer";
    case "double_click":
      return "You double-clicked from the web viewer";
    case "type":
      return `You typed "${(action.text ?? "").slice(0, 40)}" from the web viewer`;
    case "key":
      return `You pressed ${action.key} from the web viewer`;
    case "scroll":
      return `You scrolled ${action.direction ?? "down"} from the web viewer`;
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
  {
    operationId: "cuelive_session",
    endpoint: "cuelive/session",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleSessionGet,
    summary: "Remote view of the Cue Live session running on the Mac",
    description:
      "What the daemon genuinely knows about the active Cue Live session: " +
      "live/idle, pause state, the auto-run goal in flight, the recent " +
      "guidance/look/act observation stream, the screen-stream and take-over " +
      "state, and the trust dial that caps both. Metadata only: screen frames " +
      "never appear in this payload — they travel on cuelive/session/frame, " +
      "one at a time, in memory, and are never persisted. Capture itself runs " +
      "on the Mac.",
    tags: ["cuelive"],
    responseBody: SessionView,
    logging: { silenceSuccessAfter: 5 },
  },
  {
    operationId: "cuelive_session_pause",
    endpoint: "cuelive/session/pause",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleSessionPause,
    summary: "Hold or release the daemon's Cue Live answers",
    description:
      "While paused the daemon answers the Mac's guidance/look/act calls " +
      "inertly — the overlay falls back to local hints and any auto-run in " +
      "flight ends. Does not switch off capture on the Mac.",
    tags: ["cuelive"],
    requestBody: PauseBody,
    responseBody: SessionView,
  },
  {
    operationId: "cuelive_session_stop",
    endpoint: "cuelive/session/stop",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleSessionStop,
    summary: "Stop the Cue Live auto-run in flight (one-shot)",
    description:
      "Arms a one-shot stop: the act loop asks the daemon for every next " +
      "step, so the next step is answered `done` and the run ends. Expires " +
      "unconsumed after a minute.",
    tags: ["cuelive"],
    responseBody: z.object({
      stopped: z.boolean(),
      note: z.string(),
      session: SessionView,
    }),
  },
  {
    operationId: "cuelive_session_stream",
    endpoint: "cuelive/session/stream",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleStreamGet,
    summary: "Whether the Mac is streaming its screen, and at what cadence",
    description:
      "State of the opt-in screen stream (off / starting / live / stalled) " +
      "plus the negotiated push interval and downscale width. The Mac polls " +
      "this to learn when to start and stop capturing.",
    tags: ["cuelive"],
    responseBody: StreamStatusSchema,
    logging: { silenceSuccessAfter: 5 },
  },
  {
    operationId: "cuelive_session_stream_set",
    endpoint: "cuelive/session/stream",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleStreamSet,
    summary: "Start or stop the Cue Live screen stream",
    description:
      "Arms or disarms screen streaming. Streaming is never implicit: opening " +
      "the viewer does not start it. Either surface may stop it, stopping " +
      "drops the held frame and disarms take over, and an armed stream that " +
      "nobody reads from stops itself.",
    tags: ["cuelive"],
    requestBody: StreamBody,
    responseBody: StreamStatusSchema,
  },
  {
    operationId: "cuelive_session_checkin",
    endpoint: "cuelive/session/checkin",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleCheckin,
    summary: "Mac check-in: report capability, learn whether to stream",
    description:
      "The Mac's control channel. It reports whether Cue Live is running and " +
      "whether Screen Recording is granted, and learns from the response " +
      "whether the owner armed the screen stream. Capture never starts on the " +
      "Mac's own initiative, and a Mac that loses the grant disarms the " +
      "stream rather than leaving the viewer waiting.",
    tags: ["cuelive"],
    requestBody: CheckinBody,
    responseBody: CheckinResult,
    logging: { silenceSuccessAfter: 3 },
  },
  {
    operationId: "cuelive_session_frame_push",
    endpoint: "cuelive/session/frame",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleFramePush,
    summary: "Push one screen frame from the Mac (ephemeral)",
    description:
      "Replaces the single in-memory frame the daemon holds. Frames are never " +
      "written to the database, to disk, or to an event stream, and a push " +
      "while the stream is disarmed is dropped. The response carries the next " +
      "push interval and downscale width so bandwidth is negotiated, not fixed.",
    tags: ["cuelive"],
    requestBody: FrameBody,
    responseBody: FramePushResult,
    logging: { silenceSuccessAfter: 2 },
  },
  {
    operationId: "cuelive_session_frame",
    endpoint: "cuelive/session/frame",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleFrameGet,
    summary: "Read the latest Cue Live screen frame",
    description:
      "Returns the single held frame, or null when the stream is off, still " +
      "starting, stalled, or the frame has aged out — a frozen picture is " +
      "never served as if it were live. Reading also marks the viewer as " +
      "attached; a stream nobody reads stops on its own.",
    tags: ["cuelive"],
    responseBody: FrameResult,
    logging: { silenceSuccessAfter: 2 },
  },
  {
    operationId: "cuelive_session_takeover",
    endpoint: "cuelive/session/takeover",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleTakeoverSet,
    summary: "Arm or release steering the Mac from the web",
    description:
      "Take over is explicit and expiring — it never turns on because the " +
      "viewer is open. Arming is refused outright when the global trust dial " +
      "is Observe, so the button cannot light up a capability the dial forbids.",
    tags: ["cuelive"],
    requestBody: TakeoverBody,
    responseBody: TakeoverResult,
  },
  {
    operationId: "cuelive_session_input",
    endpoint: "cuelive/session/input",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleInput,
    summary: "Relay one click / keystroke from the web viewer to the Mac",
    description:
      "Translates a viewer gesture into the same computer_use_* request the " +
      "agent uses and sends it through the host computer-use proxy, so it " +
      "inherits that path's ActionVerifier, step cap and same-actor checks. " +
      "Refused when the trust dial is Observe, when take over is not armed, " +
      "when the session is paused, or when there is no live frame to steer " +
      "against.",
    tags: ["cuelive"],
    requestBody: InputBody,
    responseBody: InputResult,
  },
];

export const __testing = { parseActJson, parsePoints, describeLookFailure };
