/**
 * What actually reaches Gemini in the `setup` frame's system instruction: the
 * conversation the call is bound to, and the behavioural rules that decide
 * whether a question gets answered or filed.
 *
 * ## Thread context
 *
 * A voice call started inside an existing conversation must open KNOWING that
 * conversation.
 *
 * The reported failure (owner's prod thread, 2026-08-15): he discussed a
 * pinched nerve in voice, got a real answer by switching to typed chat in the
 * same thread, then went back to voice — and voice asked "when and how did it
 * start?", with no idea it was sitting inside that exchange. Cause: the session
 * composed its system instruction from persona + `buildLiveBriefing()` only,
 * and the briefing reads PKB/missions/projects/tasks/schedules — never the
 * bound conversation's messages.
 *
 * ## Answer-vs-file routing
 *
 * The same transcript showed voice calling `add_task` on a question about
 * recovery timelines and then deflecting to "ask your physio". The prompt told
 * it to: "Substantive work (research, drafting, multi-step) → run_deep_task"
 * gives the model no way to tell a substantive QUESTION from substantive WORK,
 * and "usually one or two sentences" caps every explanation below the length a
 * real answer needs. It also said "I'm having Cue research some best
 * practices" — third person, about itself.
 *
 * The rules below are prose, so these are shape guards on the exact regressions
 * seen in prod, not a proof of model behaviour. Only a live call proves that.
 *
 * These tests drive the REAL session against the REAL message store and the
 * REAL client, and assert on the bytes of the `setup` frame that actually goes
 * upstream — not on an intermediate return value. Only two seams are replaced:
 * the API key (no credential store in tests) and the WebSocket (no network).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const loggerActual = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...loggerActual,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  addMessage,
  createConversation,
} from "../../memory/conversation-crud.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";

type GeminiLiveSocket = import("../gemini-live-client.js").GeminiLiveSocket;

/** Scripted stand-in for the upstream WebSocket (mirrors the lifecycle suite). */
class FakeSocket implements GeminiLiveSocket {
  binaryType = "";
  readyState = 0;
  readonly sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }

  completeSetup(): void {
    this.readyState = 1;
    this.onopen?.({});
    this.onmessage?.({
      data: JSON.stringify({ setupComplete: {} }),
    } as MessageEvent);
  }

  /** The `setup` payload this socket actually carried upstream. */
  setup(): Record<string, unknown> {
    for (const raw of this.sent) {
      const frame = JSON.parse(raw) as { setup?: Record<string, unknown> };
      if (frame.setup) return frame.setup;
    }
    return {};
  }

  /** The system instruction this socket actually carried upstream. */
  systemInstruction(): string {
    const instruction = this.setup().systemInstruction as
      | { parts?: Array<{ text?: string }> }
      | undefined;
    return instruction?.parts?.[0]?.text ?? "";
  }

  /** The speech config as sent, if any. */
  speechConfig(): Record<string, unknown> | undefined {
    const generationConfig = this.setup().generationConfig as
      | { speechConfig?: Record<string, unknown> }
      | undefined;
    return generationConfig?.speechConfig;
  }
}

let sockets: FakeSocket[];

const clientActual = await import("../gemini-live-client.js");

/**
 * The REAL client, with only the socket factory injected — so the setup
 * payload under test is the one the production code builds and sends.
 */
class TestClient extends clientActual.GeminiLiveClient {
  constructor(
    opts: ConstructorParameters<typeof clientActual.GeminiLiveClient>[0],
  ) {
    super({
      ...opts,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        // Handlers are assigned after `createSocket` returns; complete setup
        // once this turn of the event loop has finished wiring them.
        queueMicrotask(() => socket.completeSetup());
        return socket;
      },
    });
  }
}

mock.module("../gemini-live-client.js", () => ({
  ...clientActual,
  resolveGeminiLiveApiKey: async () => "test-key",
  GeminiLiveClient: TestClient,
}));

const { createGeminiLiveSession } = await import("../gemini-live-session.js");

initializeDb();

function resetConversations() {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function textBlocks(text: string): string {
  return JSON.stringify([{ type: "text", text }]);
}

async function startSessionOn(conversationId: string) {
  const session = createGeminiLiveSession({
    sessionId: "s-ctx",
    startFrame: {
      type: "start",
      audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
      conversationId,
    },
    sendFrame: async (payload) => payload as never,
  });
  await session.start();
  return session;
}

/** The owner's real thread shape: voice turns and typed chat interleaved. */
async function seedPinchedNerveThread(conversationId: string) {
  createConversation({
    id: conversationId,
    conversationType: "standard",
    source: "live-voice",
    title: "Voice conversation",
  });
  await addMessage(
    conversationId,
    "user",
    textBlocks("How long does a pinched nerve take to recover?"),
    { metadata: { voiceTurn: true } },
  );
  await addMessage(
    conversationId,
    "assistant",
    textBlocks("I've noted that down. Recovery varies for everyone."),
  );
  await addMessage(
    conversationId,
    "user",
    textBlocks("analyse this and give me an answer"),
  );
  // A typed-chat assistant turn, stored with a thinking block ahead of the
  // spoken text — the machinery must not reach the spoken context.
  await addMessage(
    conversationId,
    "assistant",
    JSON.stringify([
      { type: "thinking", thinking: "The user likely has a double crush." },
      {
        type: "text",
        text: "This looks like double crush syndrome — neck compression plus tennis elbow. Expect three to six months.",
      },
    ]),
  );
  // A synthetic tool-result user row from the same agent turn.
  await addMessage(
    conversationId,
    "user",
    JSON.stringify([
      { type: "tool_result", tool_use_id: "tu_1", content: "recall hit" },
    ]),
  );
}

beforeEach(() => {
  sockets = [];
  resetConversations();
});

describe("gemini-live seeds the bound conversation into the session", () => {
  test("a call inside an existing thread carries its recent tail upstream", async () => {
    await seedPinchedNerveThread("conv-nerve");

    await startSessionOn("conv-nerve");

    expect(sockets).toHaveLength(1);
    const instruction = sockets[0]!.systemInstruction();

    // The exchange the model was previously blind to is now in the prompt.
    expect(instruction).toContain("CONVERSATION SO FAR");
    expect(instruction).toContain(
      "User: How long does a pinched nerve take to recover?",
    );
    expect(instruction).toContain("You: I've noted that down.");
    expect(instruction).toContain("User: analyse this and give me an answer");
    expect(instruction).toContain("double crush syndrome");
    expect(instruction).toContain("three to six months");
  });

  test("thinking blocks and tool-result rows never reach the spoken context", async () => {
    await seedPinchedNerveThread("conv-nerve");

    await startSessionOn("conv-nerve");
    const instruction = sockets[0]!.systemInstruction();

    expect(instruction).not.toContain("The user likely has a double crush");
    expect(instruction).not.toContain("tool_result");
    expect(instruction).not.toContain("recall hit");
    expect(instruction).not.toContain("tu_1");
  });

  test("a brand-new voice-initiated thread appends nothing", async () => {
    // No conversation row exists yet — `ensureLiveVoiceThread` creates it on
    // the first utterance, which is after start().
    await startSessionOn("conv-fresh");

    expect(sockets[0]!.systemInstruction()).not.toContain(
      "CONVERSATION SO FAR",
    );
  });

  test("an existing thread with no readable text appends nothing", async () => {
    createConversation({
      id: "conv-empty",
      conversationType: "standard",
      source: "live-voice",
      title: "Voice conversation",
    });
    await addMessage(
      "conv-empty",
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu_9", content: "x" },
      ]),
    );

    await startSessionOn("conv-empty");

    expect(sockets[0]!.systemInstruction()).not.toContain(
      "CONVERSATION SO FAR",
    );
  });

  test("a long thread is bounded — the newest exchange always survives", async () => {
    createConversation({
      id: "conv-long",
      conversationType: "standard",
      source: "live-voice",
      title: "Voice conversation",
    });
    for (let i = 0; i < 40; i++) {
      await addMessage(
        "conv-long",
        "user",
        textBlocks(`Question number ${i}.`),
      );
      await addMessage(
        "conv-long",
        "assistant",
        textBlocks(`Answer number ${i}. ${"padding ".repeat(60)}`),
      );
    }

    await startSessionOn("conv-long");
    const instruction = sockets[0]!.systemInstruction();
    const context = instruction.slice(
      instruction.indexOf("CONVERSATION SO FAR"),
    );

    // The tail is present and the oldest turns were dropped, not the newest.
    expect(context).toContain("Question number 39.");
    expect(context).not.toContain("Question number 0.");
    // Bounded well below anything that could slow session start.
    expect(context.length).toBeLessThan(2600);
  });

  test("the seeded context is replayed on an upstream reconnect", async () => {
    await seedPinchedNerveThread("conv-nerve");
    await startSessionOn("conv-nerve");

    // Drop the socket; the client reconnects and replays its setup.
    sockets[0]!.readyState = 3;
    sockets[0]!.onclose?.({ code: 1011, reason: "internal" } as CloseEvent);
    // First reconnect attempt waits the default 250ms backoff.
    await Bun.sleep(600);

    expect(sockets.length).toBeGreaterThan(1);
    // Every socket this session opened carried the thread context — this is
    // why it lives in the system instruction and not a post-connect injection.
    for (const socket of sockets) {
      expect(socket.systemInstruction()).toContain("double crush syndrome");
    }
  });
});

describe("gemini-live answer-vs-file routing rules", () => {
  async function instruction(): Promise<string> {
    await startSessionOn("conv-rules");
    return sockets[0]!.systemInstruction();
  }

  test("a question is to be answered in the call, not filed", async () => {
    const text = await instruction();

    expect(text).toContain("When they ASK you something, answer it");
    expect(text).toContain("A question is not a task");
    // The two tools that make an in-call answer real are named as the thing to
    // reach for FIRST, not as an afterthought.
    expect(text).toMatch(/answer it[\s\S]*recall_memory[\s\S]*web_search/);
  });

  test("run_deep_task is scoped to work asked for, never to dodge a question", async () => {
    const text = await instruction();

    // The old rule that could not distinguish a substantive QUESTION from
    // substantive WORK is gone.
    expect(text).not.toContain(
      "Substantive work (research, drafting, multi-step) → run_deep_task",
    );
    expect(text).toContain("Work they have asked you to DO");
    expect(text).toContain(
      "Never reach for run_deep_task to get out of answering a question",
    );
  });

  test("brevity is a default, not a cap on a real explanation", async () => {
    const text = await instruction();

    // The hard cap that could not carry an explanation is gone...
    expect(text).not.toContain("usually one or two sentences");
    // ...replaced by a default that explicitly yields when explaining is needed.
    expect(text).toContain("Short is the default, not a ceiling");
    expect(text).toContain("take the several sentences it needs");
  });

  test("Cue never refers to itself in the third person", async () => {
    const text = await instruction();

    expect(text).toContain("always speak about yourself in the first person");
    // Regression guard on the exact shape heard in prod ("I'm having Cue
    // research some best practices") and the delegation phrasings nearest to
    // it. Scoped per sentence, because the rule teaches by counter-example
    // ("never 'I'm having Cue look into that'") — a quoted illustration inside
    // a prohibition is the opposite of committing the mistake, so a sentence
    // carrying the shape is only a failure if it does not forbid it. Not a
    // grammar proof: a guard on the family that leaked into a live call.
    const thirdPerson =
      /(hav(e|ing) Cue\b)|(\bask(ing)? Cue\b)|(\bCue (set|will|is|does|can) )/i;
    const offenders = text
      .split(/(?<=\.)\s+/)
      .filter((sentence) => thirdPerson.test(sentence))
      .filter((sentence) => !/\bnever\b/i.test(sentence));

    expect(offenders).toEqual([]);
  });
});

/**
 * The accent/language drift. `speechConfig.languageCode` was omitted for the
 * multilingual default while the prompt promised to "switch with them without
 * missing a beat" — so NOTHING fixed the output language and the spoken voice
 * drifted locale mid-reply. On the native-audio model class Cue runs, the
 * config field is unsupported (and a rejected value 1007s the session), so the
 * system instruction is the mechanism, per Google's own guidance.
 */
describe("gemini-live spoken language", () => {
  const ENV_KEYS = [
    "CUE_GEMINI_LIVE_LANGUAGE",
    "CUE_GEMINI_LIVE_PIN_SPEECH_LANGUAGE",
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("the default call is pinned to English, emphatically", async () => {
    await startSessionOn("conv-lang");
    const text = sockets[0]!.systemInstruction();

    expect(text).toContain("YOU MUST RESPOND UNMISTAKABLY IN ENGLISH");
    expect(text).toContain("never drift into another language or accent");
    // The line that invited the drift is gone.
    expect(text).not.toContain("switch with them without missing a beat");
  });

  test("comprehension stays multilingual and switching stays possible", async () => {
    await startSessionOn("conv-lang");
    const text = sockets[0]!.systemInstruction();

    // Understanding is never narrowed — the owner mixes Hindi into English.
    expect(text).toContain("You understand every language fluently");
    expect(text).toContain("mix words or whole sentences");
    // A caller who genuinely wants another language can still get one.
    expect(text).toContain("if they ASK you to speak another language");
  });

  test("nothing is put on the wire by default — the config field is unsupported", async () => {
    await startSessionOn("conv-lang");

    // The voice IS supported and must still be sent; the language code must
    // not be, or a reject would strip the voice with it via the 1007 fallback.
    expect(sockets[0]!.speechConfig()).toHaveProperty("voiceConfig");
    expect(sockets[0]!.speechConfig()).not.toHaveProperty("languageCode");
  });

  test("CUE_GEMINI_LIVE_LANGUAGE still overrides the spoken language", async () => {
    process.env.CUE_GEMINI_LIVE_LANGUAGE = "hi";

    await startSessionOn("conv-lang");
    const text = sockets[0]!.systemInstruction();

    expect(text).toContain("YOU MUST RESPOND UNMISTAKABLY IN HINDI");
    expect(text).toContain("their chosen language for these calls");
    // Still no wire pin: the model class doesn't accept one.
    expect(sockets[0]!.speechConfig()).not.toHaveProperty("languageCode");
  });

  test("the wire pin is opt-in, for half-cascade models only", async () => {
    process.env.CUE_GEMINI_LIVE_LANGUAGE = "hi";
    process.env.CUE_GEMINI_LIVE_PIN_SPEECH_LANGUAGE = "1";

    await startSessionOn("conv-lang");

    // Mapped to the regional tag Gemini expects.
    expect(sockets[0]!.speechConfig()).toMatchObject({ languageCode: "hi-IN" });
  });

  test("the opt-in pin stays absent when no language was chosen", async () => {
    process.env.CUE_GEMINI_LIVE_PIN_SPEECH_LANGUAGE = "1";

    await startSessionOn("conv-lang");

    // Opting in must not invent a pin the user never asked for.
    expect(sockets[0]!.speechConfig()).not.toHaveProperty("languageCode");
  });
});
