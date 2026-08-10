/**
 * Session-level wiring for the H-1 voice toolset: the curated declarations
 * ride the Live session config, the session registers/releases the voice
 * skill tools, a `ui_show` function call comes out on the wire as the same
 * `card` frame the cascade emits (rendered by the same client store), and an
 * unknown function degrades to a spoken-safe error response — never a throw,
 * never a fake card.
 *
 * Every module mocked below is spread from the real one; only the seam being
 * driven is replaced.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const loggerActual = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...loggerActual,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// The session must not reach the network, the workspace, or the thread store.
const clientActual = await import("../gemini-live-client.js");

/** Callbacks the session handed to the client — the test's drive handles. */
let captured: import("../gemini-live-client.js").GeminiLiveClientCallbacks;
/** Tools the session put in the Live session config. */
let configuredTools:
  | import("../gemini-live-client.js").GeminiFunctionDeclaration[]
  | undefined;
/** Function responses the session sent back to the model. */
let toolResponses: Array<{ id?: string; name: string; response: unknown }>;

class FakeGeminiLiveClient {
  constructor(options: {
    callbacks: typeof captured;
    tools?: typeof configuredTools;
  }) {
    captured = options.callbacks;
    configuredTools = options.tools;
  }
  async connect(): Promise<void> {}
  sendAudio(): void {}
  sendAudioStreamEnd(): void {}
  sendToolResponse(responses: typeof toolResponses): void {
    toolResponses.push(...responses);
  }
  close(): void {}
}

mock.module("../gemini-live-client.js", () => ({
  ...clientActual,
  resolveGeminiLiveApiKey: async () => "test-key",
  GeminiLiveClient: FakeGeminiLiveClient,
}));

const briefingActual = await import("../../live-voice/build-live-briefing.js");
mock.module("../../live-voice/build-live-briefing.js", () => ({
  ...briefingActual,
  buildLiveBriefing: () => "",
}));

const threadActual = await import("../../live-voice/live-voice-thread.js");
mock.module("../../live-voice/live-voice-thread.js", () => ({
  ...threadActual,
  ensureLiveVoiceThread: () => {},
  persistLiveVoiceTurn: async () => {},
  finalizeLiveVoiceThread: async () => {},
}));

const synthActual =
  await import("../../live-voice/synthesize-live-voice-session.js");
mock.module("../../live-voice/synthesize-live-voice-session.js", () => ({
  ...synthActual,
  synthesizeLiveVoiceSession: async () => ({ newTaskTitles: [] }),
}));

// Skill-tool projection: recorded, not exercised — the projection machinery
// has its own suite; here we assert the session drives it with the voice
// skill set and releases it on close.
const skillToolsActual =
  await import("../../daemon/conversation-skill-tools.js");
let projectedSkillIds: string[][];
let resetCalls: number;
mock.module("../../daemon/conversation-skill-tools.js", () => ({
  ...skillToolsActual,
  projectSkillTools: (
    _history: unknown[],
    options?: { preactivatedSkillIds?: string[] },
  ) => {
    projectedSkillIds.push(options?.preactivatedSkillIds ?? []);
    return { toolDefinitions: [], allowedToolNames: new Set<string>() };
  },
  resetSkillToolProjection: () => {
    resetCalls += 1;
  },
}));

const { createGeminiLiveSession } = await import("../gemini-live-session.js");
const { GEMINI_LIVE_FUNCTION_DECLARATIONS, GEMINI_LIVE_VOICE_SKILLS } =
  await import("../gemini-live-tools.js");

type Frame = { type: string; [key: string]: unknown };

async function startSession() {
  const frames: Frame[] = [];
  const session = createGeminiLiveSession({
    sessionId: "s1",
    startFrame: {
      type: "start",
      audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
      conversationId: "conv-1",
    },
    sendFrame: async (payload) => {
      frames.push(payload as Frame);
      return { ...(payload as Frame), seq: frames.length } as never;
    },
  });
  await session.start();
  frames.length = 0; // drop the `ready` frame
  return { session, frames };
}

/** Drive a tool call and wait for the async dispatch to settle. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  captured.onToolCall?.([{ id: "call-1", name, args }]);
  // onToolCall is fire-and-forget inside the session; give it a beat.
  for (let i = 0; i < 20 && toolResponses.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  captured = undefined as unknown as typeof captured;
  configuredTools = undefined;
  toolResponses = [];
  projectedSkillIds = [];
  resetCalls = 0;
});

describe("gemini-live session toolset wiring", () => {
  test("the curated declarations ride the Live session config", async () => {
    await startSession();
    expect(configuredTools).toBe(GEMINI_LIVE_FUNCTION_DECLARATIONS);
  });

  test("start registers the voice skills; close releases them", async () => {
    const { session } = await startSession();
    expect(projectedSkillIds).toEqual([[...GEMINI_LIVE_VOICE_SKILLS]]);
    session.close("client_end");
    expect(resetCalls).toBe(1);
  });

  test("ui_show emits the cascade's `card` frame, attributed to the turn", async () => {
    const { frames } = await startSession();

    await callTool("ui_show", {
      surface_type: "list",
      title: "Options",
      data: { items: [{ title: "A" }, { title: "B" }] },
    });

    const cards = frames.filter((f) => f.type === "card");
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.op).toBe("show");
    expect(card.surfaceType).toBe("list");
    expect(card.title).toBe("Options");
    expect(typeof card.surfaceId).toBe("string");

    // The card belongs to a turn the client can key on: the session opened
    // one (thinking frame) and stamped the same id on the card.
    const thinking = frames.find((f) => f.type === "thinking");
    expect(card.turnId).toBe(thinking?.turnId);

    // And the model was told it succeeded, with the summarize-aloud nudge.
    expect(toolResponses).toHaveLength(1);
    const response = toolResponses[0]!.response as { ok: boolean };
    expect(toolResponses[0]!.name).toBe("ui_show");
    expect(response.ok).toBe(true);
  });

  test("an unknown function returns a spoken-safe error and shows nothing", async () => {
    const { frames } = await startSession();

    await callTool("transfer_funds", { amount: 1_000_000 });

    expect(frames.filter((f) => f.type === "card")).toHaveLength(0);
    expect(toolResponses).toHaveLength(1);
    const response = toolResponses[0]!.response as {
      ok: boolean;
      error: string;
    };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("isn't available in this call");
  });

  test("after close, a late ui_show never emits a card frame", async () => {
    const { session, frames } = await startSession();
    session.close("client_end");
    frames.length = 0;

    await callTool("ui_show", {
      surface_type: "card",
      data: { title: "T", body: "late" },
    });

    expect(frames.filter((f) => f.type === "card")).toHaveLength(0);
  });
});
