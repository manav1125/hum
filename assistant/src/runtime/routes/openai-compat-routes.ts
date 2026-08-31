/**
 * An OpenAI-shaped front door, so anything that can call OpenAI can feed Cue.
 *
 * ## Why this exists
 *
 * The Halo wearable's stock companion app (Seeed's SenseCraft Voice) does not
 * talk to Cue and never will. What it does have is a "bring your own API key"
 * setting with a **base URL** — and its pipeline ends by handing the finished
 * transcript to that LLM as `input` with the summarisation template as the
 * system prompt. Point that base URL at a Cue instance and the last hop of
 * somebody else's product becomes Cue's ingest: the transcript of a real day
 * arrives here, is turned into work items by the same spine that voice notes
 * and meeting recaps already use, and the summary Cue writes goes back as the
 * completion their app is waiting to render.
 *
 * No BLE, no mobile plugin, no re-pairing the device. One route.
 *
 * ## The shape is the contract
 *
 * `POST /v1/chat/completions`, because every route here is already served
 * under `/v1/` — so a caller sets its base URL to `https://<instance>/v1`,
 * exactly as it would for `api.openai.com/v1`, and the paths line up with no
 * special-casing at either end.
 *
 * This deliberately implements the *shape* and not the semantics. `model`,
 * `temperature` and the rest are accepted and ignored: Cue chooses its own
 * model at its own call site, and a caller that thinks it is picking one is
 * not entitled to override that. What matters is that the response validates
 * as a chat completion, because their app parses it strictly.
 *
 * ## What it is not
 *
 * Not a general-purpose LLM proxy, and not a way to rent Cue's model budget.
 * The transcript becomes a thread and a set of parked work items every time —
 * that is the only behaviour. It carries the same policy as every other
 * actor-facing route, so it needs a real Cue token in the caller's API-key
 * field; there is no unauthenticated path in.
 *
 * ## The second door: `/v1/audio/transcriptions`
 *
 * The same trick one hop earlier. Their app's STT setting also takes a base
 * URL, so pointing it here makes Cue do the transcription instead of a third
 * vendor — which is where diarization, language pinning and the per-minute
 * cost of an eight-hour day actually live. It is an ordinary OpenAI Whisper
 * upload: `multipart/form-data` with a `file` part, answered with `{"text":…}`.
 *
 * ## Streaming
 *
 * Their backend streams its summaries (`/api/v1/llm/chat` is SSE), so callers
 * may set `stream: true`. Cue's work is not incremental — the extraction is a
 * single forced tool call — so streaming here replays a finished answer in the
 * chunk format rather than pretending to think out loud. The alternative,
 * refusing `stream`, would fail closed against a caller we cannot reconfigure.
 */

import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { z } from "zod";

import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  generateVoiceIntake,
  type VoiceIntakeResult,
} from "../services/voice-intake.js";
import { BadRequestError } from "./errors.js";
import { handleTranscribeFile } from "./stt-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { RouteResponse } from "./types.js";

const log = getLogger("openai-compat-routes");

/** Provenance for everything that arrives through this door. */
const HALO_SOURCE_TYPE = "halo";

/** Model name echoed back. Callers display it; nothing keys off it. */
const REPORTED_MODEL = "cue-halo";

/**
 * Below this, a "transcript" is a connection test or a stray tap, not a day.
 * Minting a thread and a work item for it would put noise in HQ, which is the
 * one thing an always-on capture path must not do.
 */
const MIN_TRANSCRIPT_CHARS = 40;

// ---------------------------------------------------------------------------
// Test-only overrides
// ---------------------------------------------------------------------------

type IntakeFn = typeof generateVoiceIntake;
type TranscribeFn = typeof handleTranscribeFile;

let intakeOverride: IntakeFn | null = null;
let transcribeOverride: TranscribeFn | null = null;

/**
 * Test-only seam for the two things this route delegates to, so the contract
 * with the caller can be exercised without a model or an ffmpeg. Deliberately
 * not `mock.module`: that mutates the process-global registry and leaks into
 * every file that runs after it — here it would replace the very module
 * `voice-intake.test.ts` exists to test. Pass `{}` to reset.
 */
export function _setHaloIngestOverridesForTests(overrides: {
  intake?: IntakeFn;
  transcribe?: TranscribeFn;
}): void {
  intakeOverride = overrides.intake ?? null;
  transcribeOverride = overrides.transcribe ?? null;
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * OpenAI message content is either a string or an array of typed parts. Both
 * are in the wild, so accept both and keep only the text.
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * The transcript is the user turns, joined.
 *
 * System turns are dropped on purpose: the caller's system prompt is its
 * summarisation template ("Meeting Summary", "Daily Conversation Summary"),
 * which describes how *their* product wanted the text shaped. Folding that
 * into the transcript would have Cue extracting action items out of someone
 * else's formatting instructions.
 */
export function extractTranscript(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return messages
    .filter(
      (m): m is { role: string; content: unknown } =>
        !!m && typeof m === "object" && "role" in m,
    )
    .filter((m) => m.role === "user")
    .map((m) => contentToText(m.content).trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Response composition
// ---------------------------------------------------------------------------

/**
 * What the caller's UI renders. The summary alone would lose the part that
 * makes this worth doing — that Cue has already turned the day into work —
 * so the action items are listed, and the fact they are waiting is stated.
 */
export function composeCompletionText(result: VoiceIntakeResult): string {
  const parts: string[] = [];
  if (result.summary.trim()) parts.push(result.summary.trim());

  const open = result.actionItems.filter((item) => !item.done);
  if (open.length > 0) {
    parts.push(
      open
        .map((item, i) => {
          const owner = item.owner ? ` — ${item.owner}` : "";
          return `${i + 1}. ${item.text}${owner}`;
        })
        .join("\n"),
    );
    const n = result.workItems.length;
    if (n > 0) {
      parts.push(
        n === 1
          ? "Cue has queued 1 of these for review."
          : `Cue has queued ${n} of these for review.`,
      );
    }
  }

  return parts.length > 0
    ? parts.join("\n\n")
    : "Cue captured this, but found nothing in it that needs doing.";
}

/**
 * Token counts are required by the schema and meaningless here — Cue's real
 * spend happens at its own call site under its own accounting, and reporting
 * a number the caller might bill against would be worse than reporting none.
 */
const ZERO_USAGE = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
} as const;

function completionEnvelope(text: string) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model: REPORTED_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: text },
        finish_reason: "stop" as const,
      },
    ],
    usage: ZERO_USAGE,
  };
}

/**
 * Replay a finished answer as `chat.completion.chunk` events. One content
 * chunk, then the stop chunk, then the `[DONE]` sentinel every OpenAI client
 * waits for — omitting it is the classic way to leave a caller hanging.
 */
function streamCompletion(text: string): RouteResponse {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    encoder.encode(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: REPORTED_MODEL,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk({ role: "assistant", content: text }, null));
      controller.enqueue(chunk({}, "stop"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  // The content type has to come from the handler, not the route: whether
  // this request streams is in the request BODY, and `responseHeaders` is
  // only handed path/query/headers.
  return new RouteResponse(stream, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleChatCompletions({ body }: RouteHandlerArgs) {
  const transcript = extractTranscript(body?.messages);

  if (!transcript) {
    throw new BadRequestError(
      "messages must contain at least one user message with text content",
    );
  }
  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    // Not an error — a connection test deserves a valid completion, not a 400
    // that reads as "your key is wrong". It simply does not become work.
    log.info(
      { chars: transcript.length },
      "Transcript below ingest floor; answering without filing",
    );
    const text = "Cue is connected. That was too short to file as work.";
    return body?.stream === true
      ? streamCompletion(text)
      : completionEnvelope(text);
  }

  const result = await (intakeOverride ?? generateVoiceIntake)(transcript, {
    sourceType: HALO_SOURCE_TYPE,
    fallbackTitle: "Halo capture",
  });

  if ("error" in result) {
    // The caller is a summariser that cannot act on our error taxonomy, and
    // failing its request would lose the transcript entirely. Answer with
    // what happened and let the audio stay recoverable on their side.
    log.warn({ err: result.error }, "Halo intake failed");
    const text = `Cue received this but could not process it: ${result.error.message}`;
    return body?.stream === true
      ? streamCompletion(text)
      : completionEnvelope(text);
  }

  log.info(
    {
      conversationId: result.conversationId,
      actionItems: result.actionItems.length,
      workItems: result.workItems.length,
      chars: transcript.length,
    },
    "Halo capture ingested",
  );

  const text = composeCompletionText(result);
  return body?.stream === true
    ? streamCompletion(text)
    : completionEnvelope(text);
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const MessageSchema = z.object({
  role: z.string().describe("OpenAI role — only `user` turns are read"),
  content: z.unknown().describe("String, or an array of typed content parts"),
});

// ---------------------------------------------------------------------------
// Audio transcriptions
// ---------------------------------------------------------------------------

/** Extension used when the uploaded part carries no usable filename. */
const FALLBACK_AUDIO_EXT = ".wav";

/**
 * Multipart arrives as `rawBody` — the adapter only parses JSON — so rebuild a
 * Response around the original bytes and let the platform's own parser do the
 * boundary work. A hand-rolled multipart parser is a well-known source of
 * silent truncation, and there is no reason to own one here.
 */
export async function parseUpload(
  rawBody: Uint8Array | undefined,
  contentType: string | undefined,
): Promise<FormData> {
  if (!rawBody || rawBody.byteLength === 0) {
    throw new BadRequestError("a multipart/form-data body is required");
  }
  if (!contentType?.includes("multipart/form-data")) {
    throw new BadRequestError(
      "Content-Type must be multipart/form-data with a `file` part",
    );
  }
  try {
    return await new Response(rawBody as BodyInit, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new BadRequestError("could not parse the multipart body");
  }
}

/**
 * The transcriber reads from disk (it shells out to ffmpeg), so the part has
 * to be spooled. The extension is carried across because the file type is how
 * `handleTranscribeFile` decides whether it will touch the file at all.
 */
async function spoolToDisk(file: File): Promise<string> {
  const ext = extname(file.name || "").toLowerCase() || FALLBACK_AUDIO_EXT;
  const path = join(tmpdir(), `cue-stt-${randomUUID()}${ext}`);
  await writeFile(path, new Uint8Array(await file.arrayBuffer()));
  return path;
}

async function handleAudioTranscriptions({
  rawBody,
  headers,
}: RouteHandlerArgs) {
  const form = await parseUpload(rawBody, headers?.["content-type"]);

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new BadRequestError("a `file` part is required");
  }

  const responseFormat = String(form.get("response_format") ?? "json");
  const path = await spoolToDisk(file);

  try {
    const result = (await (transcribeOverride ?? handleTranscribeFile)({
      body: { filePath: path },
    } as RouteHandlerArgs)) as { transcript: string; durationSeconds: number };

    log.info(
      {
        bytes: file.size,
        filename: file.name,
        responseFormat,
        seconds: result.durationSeconds,
      },
      "Transcribed an OpenAI-compatible upload",
    );

    // `text` is a bare body, not JSON — clients that ask for it will choke on
    // a quoted string, so it is returned as one.
    if (responseFormat === "text") return result.transcript;

    if (responseFormat === "verbose_json") {
      return {
        task: "transcribe",
        language: String(form.get("language") ?? "unknown"),
        duration: result.durationSeconds,
        text: result.transcript,
        segments: [],
      };
    }

    return { text: result.transcript };
  } finally {
    await unlink(path).catch(() => {});
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "openaiChatCompletions",
    endpoint: "chat/completions",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "OpenAI-compatible chat completions (Halo ingest)",
    description:
      "Accepts an OpenAI chat-completions request and ingests the user turns as a Halo capture: a thread is created, action items are extracted, and work items are queued for review. Returns the summary as a chat completion so OpenAI-shaped clients render it unchanged. Set a client's base URL to `<instance>/v1` to point it here.",
    tags: ["halo"],
    requestBody: z.object({
      messages: z
        .array(MessageSchema)
        .describe("Conversation turns; user turns are the transcript"),
      model: z
        .string()
        .optional()
        .describe("Accepted and ignored — Cue picks its own model"),
      stream: z
        .boolean()
        .optional()
        .describe("When true, replay the answer as SSE chunks"),
      temperature: z.number().optional().describe("Accepted and ignored"),
      max_tokens: z.number().optional().describe("Accepted and ignored"),
    }),
    handler: handleChatCompletions,
  },
  {
    operationId: "openaiAudioTranscriptions",
    endpoint: "audio/transcriptions",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "OpenAI-compatible audio transcription",
    description:
      "Transcribe an uploaded audio file with Cue's configured STT provider, answering in OpenAI's Whisper shape. Send multipart/form-data with a `file` part; `response_format` accepts json (default), text, or verbose_json. Set a client's STT base URL to the instance root so it resolves /v1/audio/transcriptions.",
    tags: ["halo"],
    requestBody: z
      .object({
        file: z.unknown().describe("The audio file part (multipart)"),
        model: z
          .string()
          .optional()
          .describe("Accepted and ignored — Cue uses its configured provider"),
        language: z
          .string()
          .optional()
          .describe("Echoed in verbose_json; the provider is not re-pinned"),
        response_format: z
          .string()
          .optional()
          .describe("json (default) | text | verbose_json"),
      })
      .describe("multipart/form-data"),
    handler: handleAudioTranscriptions,
  },
];
