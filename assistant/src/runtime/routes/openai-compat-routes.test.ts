/**
 * The OpenAI-shaped front door.
 *
 * The caller here is somebody else's product — Seeed's SenseCraft Voice app,
 * pointed at Cue by its base-URL setting — so the tests are written from its
 * side of the wire: it parses the envelope strictly, it cannot be changed to
 * accommodate us, and it must never be left hanging. What is asserted is
 * therefore the contract (envelope shape, `[DONE]`, never throwing at a
 * summariser, the temp file always cleaned up) and the one piece of judgement
 * in the route: which turns count as the transcript.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { BadRequestError } from "./errors.js";
import {
  _setHaloIngestOverridesForTests,
  composeCompletionText,
  extractTranscript,
  parseUpload,
  ROUTES,
} from "./openai-compat-routes.js";
import { RouteResponse } from "./types.js";

const route = ROUTES.find((r) => r.operationId === "openaiChatCompletions")!;

/** The envelope the caller parses. Typed so the assertions mean something. */
interface Completion {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
}

/** Long enough to clear the ingest floor. */
const REAL_TRANSCRIPT =
  "So we agreed Manav sends the pricing over to Amina tomorrow morning, " +
  "and then we book the follow-up for Thursday.";

function call(body: Record<string, unknown>) {
  return route.handler({ body } as never);
}

async function readStream(result: unknown): Promise<string> {
  expect(result).toBeInstanceOf(RouteResponse);
  const response = result as RouteResponse;
  const chunks: Uint8Array[] = [];
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(
    new Uint8Array(chunks.flatMap((c) => Array.from(c))),
  );
}

const sttRoute = ROUTES.find(
  (r) => r.operationId === "openaiAudioTranscriptions",
)!;

/** Build a real multipart body the way an OpenAI client would. */
async function multipart(
  fields: Record<string, string>,
  file?: { name: string; bytes: Uint8Array },
): Promise<{ rawBody: Uint8Array; contentType: string }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) {
    form.append(
      "file",
      new File([file.bytes as BlobPart], file.name, { type: "audio/wav" }),
    );
  }
  // `new Request(…, {body: form})` does not expose the generated
  // content-type via headers.get(); Response does, and the boundary in it has
  // to be the one that actually framed these bytes.
  const res = new Response(form);
  const contentType = res.headers.get("content-type")!;
  return { rawBody: new Uint8Array(await res.arrayBuffer()), contentType };
}

function callStt(rawBody: Uint8Array, contentType: string) {
  return sttRoute.handler({
    rawBody,
    headers: { "content-type": contentType },
  } as never);
}

// Injected through the route's own seam rather than `mock.module`, which
// would replace the module `voice-intake.test.ts` exists to exercise for
// every file that runs after this one in the same process.
let intakeCalls: Array<{ transcript: string; options: unknown }> = [];
let transcribeCalls: string[] = [];

let intakeResult: unknown = {
  conversationId: "conv-1",
  summary: "You agreed to send pricing to Amina.",
  actionItems: [
    { text: "Send pricing to Amina", owner: "Manav", done: false },
    { text: "Book the follow-up", owner: null, done: false },
    { text: "Already handled", owner: null, done: true },
  ],
  workItems: [{ id: "wi-1" }, { id: "wi-2" }],
};

let transcribeResult: unknown = {
  transcript: "So we agreed Manav sends the pricing over to Amina.",
  provider: "deepgram",
  durationSeconds: 4.2,
};

beforeEach(() => {
  intakeCalls = [];
  transcribeCalls = [];
  _setHaloIngestOverridesForTests({
    intake: (async (transcript: string, options: unknown) => {
      intakeCalls.push({ transcript, options });
      return intakeResult;
    }) as never,
    transcribe: (async ({ body }: { body: { filePath: string } }) => {
      transcribeCalls.push(body.filePath);
      if (transcribeResult instanceof Error) throw transcribeResult;
      return transcribeResult;
    }) as never,
  });
});

afterAll(() => {
  _setHaloIngestOverridesForTests({});
});

describe("extractTranscript", () => {
  test("reads user turns and ignores the caller's own template", () => {
    // The system prompt is THEIR summarisation template ("Meeting Summary").
    // Folding it in would have Cue extracting action items out of somebody
    // else's formatting instructions.
    const text = extractTranscript([
      { role: "system", content: "You are a meeting summariser. Use bullets." },
      { role: "user", content: "We agreed to ship on Friday." },
      { role: "assistant", content: "Sure." },
    ]);
    expect(text).toBe("We agreed to ship on Friday.");
  });

  test("joins multiple user turns", () => {
    expect(
      extractTranscript([
        { role: "user", content: "First half." },
        { role: "user", content: "Second half." },
      ]),
    ).toBe("First half.\n\nSecond half.");
  });

  test("accepts array content parts, not just strings", () => {
    expect(
      extractTranscript([
        {
          role: "user",
          content: [
            { type: "text", text: "Part one." },
            { type: "text", text: "Part two." },
          ],
        },
      ]),
    ).toBe("Part one.\nPart two.");
  });

  test("survives junk without throwing", () => {
    expect(extractTranscript(undefined)).toBe("");
    expect(extractTranscript([null, 7, { noRole: true }])).toBe("");
    expect(extractTranscript([{ role: "user", content: null }])).toBe("");
  });
});

describe("composeCompletionText", () => {
  test("summary, open items numbered, completed ones dropped", () => {
    const text = composeCompletionText(intakeResult as never);
    expect(text).toContain("You agreed to send pricing to Amina.");
    expect(text).toContain("1. Send pricing to Amina — Manav");
    expect(text).toContain("2. Book the follow-up");
    expect(text).not.toContain("Already handled");
    expect(text).toContain("queued 2");
  });

  test("says so plainly when there was nothing to do", () => {
    const text = composeCompletionText({
      conversationId: "c",
      summary: "",
      actionItems: [],
      workItems: [],
    } as never);
    expect(text).toContain("nothing in it that needs doing");
  });
});

describe("POST /v1/chat/completions", () => {
  test("ingests as a halo capture and returns a valid completion", async () => {
    const result = (await call({
      model: "gpt-4o",
      messages: [{ role: "user", content: REAL_TRANSCRIPT }],
    })) as Completion;

    expect(intakeCalls).toHaveLength(1);
    expect(intakeCalls[0].transcript).toBe(REAL_TRANSCRIPT);
    // Provenance is the whole reason voice-intake grew an options arg —
    // a day off the wearable must be separable from a dictated note.
    expect(intakeCalls[0].options).toMatchObject({ sourceType: "halo" });

    expect(result.object).toBe("chat.completion");
    expect(result.id).toStartWith("chatcmpl-");
    expect(result.choices[0].message.role).toBe("assistant");
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.choices[0].message.content).toContain(
      "Send pricing to Amina",
    );
  });

  test("the caller's model choice is accepted and ignored", async () => {
    const result = (await call({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: REAL_TRANSCRIPT }],
    })) as Completion;
    expect(result.model).toBe("cue-halo");
  });

  test("stream:true replays the answer as chunks and terminates", async () => {
    const body = await readStream(
      await call({
        stream: true,
        messages: [{ role: "user", content: REAL_TRANSCRIPT }],
      }),
    );

    // Omitting [DONE] is the classic way to hang an OpenAI client.
    expect(body).toEndWith("data: [DONE]\n\n");

    const events = body
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice("data: ".length)));
    expect(events[0].object).toBe("chat.completion.chunk");
    expect(events[0].choices[0].delta.content).toContain(
      "Send pricing to Amina",
    );
    expect(events.at(-1).choices[0].finish_reason).toBe("stop");
  });

  test("streaming sets the SSE content type from the handler", async () => {
    const result = (await call({
      stream: true,
      messages: [{ role: "user", content: REAL_TRANSCRIPT }],
    })) as RouteResponse;
    // It cannot come from `responseHeaders`, which never sees the body.
    expect(result.headers["Content-Type"]).toBe("text/event-stream");
  });

  test("a connection test answers cleanly and files nothing", async () => {
    const result = (await call({
      messages: [{ role: "user", content: "hello" }],
    })) as Completion;

    expect(intakeCalls).toHaveLength(0);
    expect(result.object).toBe("chat.completion");
    expect(result.choices[0].message.content).toContain("connected");
  });

  test("an intake failure still answers — a summariser cannot act on our errors", async () => {
    const previous = intakeResult;
    intakeResult = {
      error: { kind: "PROVIDER", status: 503, message: "no model configured" },
    };
    try {
      const result = (await call({
        messages: [{ role: "user", content: REAL_TRANSCRIPT }],
      })) as Completion;
      expect(result.object).toBe("chat.completion");
      expect(result.choices[0].message.content).toContain(
        "no model configured",
      );
    } finally {
      intakeResult = previous;
    }
  });

  test("no user turn is a request error, not a silent empty capture", async () => {
    await expect(
      call({ messages: [{ role: "system", content: "summarise this" }] }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("served at /v1/chat/completions, behind the normal actor policy", () => {
    // Base URL `<instance>/v1` + `/chat/completions` is what every
    // OpenAI-shaped client builds, and every route here is already under /v1.
    expect(route.endpoint).toBe("chat/completions");
    expect(route.method).toBe("POST");
    expect(route.policy?.requiredScopes).toContain("chat.write");
    expect(route.isPublic).toBeUndefined();
  });
});

describe("POST /v1/audio/transcriptions", () => {
  const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02]);

  test("spools the upload and answers in Whisper's json shape", async () => {
    const { rawBody, contentType } = await multipart(
      { model: "whisper-1" },
      { name: "session.wav", bytes: AUDIO },
    );
    const result = (await callStt(rawBody, contentType)) as { text: string };

    expect(transcribeCalls).toHaveLength(1);
    // The extension has to survive — it is how the transcriber decides
    // whether it will touch the file at all.
    expect(transcribeCalls[0]).toEndWith(".wav");
    expect(result.text).toContain("Amina");
  });

  test("an .ogg upload keeps its extension", async () => {
    const { rawBody, contentType } = await multipart(
      {},
      { name: "day.ogg", bytes: AUDIO },
    );
    await callStt(rawBody, contentType);
    expect(transcribeCalls[0]).toEndWith(".ogg");
  });

  test("a nameless part still gets a usable extension", async () => {
    const { rawBody, contentType } = await multipart(
      {},
      { name: "", bytes: AUDIO },
    );
    await callStt(rawBody, contentType);
    expect(transcribeCalls[0]).toEndWith(".wav");
  });

  test("response_format=text returns a bare body, not a quoted string", async () => {
    const { rawBody, contentType } = await multipart(
      { response_format: "text" },
      { name: "a.wav", bytes: AUDIO },
    );
    const result = await callStt(rawBody, contentType);
    expect(typeof result).toBe("string");
    expect(result).toContain("Amina");
  });

  test("response_format=verbose_json carries duration and language", async () => {
    const { rawBody, contentType } = await multipart(
      { response_format: "verbose_json", language: "en" },
      { name: "a.wav", bytes: AUDIO },
    );
    const result = (await callStt(rawBody, contentType)) as Record<
      string,
      unknown
    >;
    expect(result.task).toBe("transcribe");
    expect(result.language).toBe("en");
    expect(result.duration).toBe(4.2);
  });

  test("the temp file is removed even when transcription fails", async () => {
    const previous = transcribeResult;
    transcribeResult = new Error("provider down");
    try {
      const { rawBody, contentType } = await multipart(
        {},
        { name: "a.wav", bytes: AUDIO },
      );
      await expect(callStt(rawBody, contentType)).rejects.toThrow(
        "provider down",
      );
      expect(await Bun.file(transcribeCalls[0]).exists()).toBe(false);
    } finally {
      transcribeResult = previous;
    }
  });

  test("a missing file part is a request error", async () => {
    const { rawBody, contentType } = await multipart({ model: "whisper-1" });
    await expect(callStt(rawBody, contentType)).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  test("parseUpload rejects a body that is not multipart", async () => {
    await expect(
      parseUpload(new TextEncoder().encode("{}"), "application/json"),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      parseUpload(undefined, "multipart/form-data; boundary=x"),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("POST does not collide with the public GET /v1/audio/:id route", () => {
    // http-server matches ^/v1/audio/([^/]+)$ before auth, but only for GET.
    expect(sttRoute.endpoint).toBe("audio/transcriptions");
    expect(sttRoute.method).toBe("POST");
    expect(sttRoute.isPublic).toBeUndefined();
  });
});
