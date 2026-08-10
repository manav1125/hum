/**
 * The deep-task escalation's return path (the former black hole): a
 * `run_deep_task` fired from a live call registers interest in the spawned
 * work item, and when the runner's `work_item_completed` broadcast lands while
 * the call is STILL OPEN, the session injects a silent context note (clipped
 * summary + announce-aloud instruction, same injection mechanism as the H-3
 * recap) that makes the model speak the outcome into the call. Failures are
 * announced honestly; a session that closed first injects nothing and leaks
 * no hub subscriber; an unrelated work item's completion is ignored.
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
/** Context notes the session injected via sendUserText, with turn trigger. */
let injectedNotes: Array<{ text: string; triggerTurn: boolean }>;
/** Function responses the session sent back to the model. */
let toolResponses: Array<{ id?: string; name: string; response: unknown }>;

class FakeGeminiLiveClient {
  constructor(options: { callbacks: typeof captured }) {
    captured = options.callbacks;
  }
  async connect(): Promise<void> {}
  sendAudio(): void {}
  sendAudioStreamEnd(): void {}
  sendToolResponse(responses: typeof toolResponses): void {
    toolResponses.push(...responses);
  }
  sendUserText(text: string, opts?: { triggerTurn?: boolean }): void {
    injectedNotes.push({ text, triggerTurn: opts?.triggerTurn === true });
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

const skillToolsActual =
  await import("../../daemon/conversation-skill-tools.js");
mock.module("../../daemon/conversation-skill-tools.js", () => ({
  ...skillToolsActual,
  projectSkillTools: () => ({
    toolDefinitions: [],
    allowedToolNames: new Set<string>(),
  }),
  resetSkillToolProjection: () => {},
}));

// The work-item fast path must not reach the real DB or the background
// runner: the seam under test is the id handed BACK to the session, not the
// store (which has its own suites).
const taskStoreActual = await import("../../tasks/task-store.js");
mock.module("../../tasks/task-store.js", () => ({
  ...taskStoreActual,
  createTask: () => ({ id: "task-1" }),
}));

const workItemStoreActual = await import("../../work-items/work-item-store.js");
mock.module("../../work-items/work-item-store.js", () => ({
  ...workItemStoreActual,
  createWorkItemWithPermissions: (opts: { title: string }) => ({
    id: "wi-1",
    title: opts.title,
    status: "queued",
  }),
}));

const triageActual = await import("../../work-items/work-item-triage.js");
mock.module("../../work-items/work-item-triage.js", () => ({
  ...triageActual,
  triageAndMaybeAutoRunWorkItem: async () => {},
}));

const { createGeminiLiveSession, DEEP_TASK_SUMMARY_CLIP_CHARS } =
  await import("../gemini-live-session.js");
const { assistantEventHub } =
  await import("../../runtime/assistant-event-hub.js");
const { buildAssistantEvent } =
  await import("../../runtime/assistant-event.js");

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

/** Drive run_deep_task and wait for the async dispatch to settle. */
async function startDeepTask(request: string): Promise<void> {
  const before = toolResponses.length;
  captured.onToolCall?.([
    { id: "call-1", name: "run_deep_task", args: { request } },
  ]);
  for (let i = 0; i < 20 && toolResponses.length === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Publish the runner's completion broadcast through the real hub. */
async function publishCompletion(opts: {
  workItemId: string;
  status: "done" | "awaiting_review" | "failed";
  summary?: string;
}): Promise<void> {
  await assistantEventHub.publish(
    buildAssistantEvent({
      type: "work_item_completed",
      workItemId: opts.workItemId,
      status: opts.status,
      result: { summary: opts.summary ?? "", highlights: [] },
      completedAt: new Date().toISOString(),
    }),
  );
}

beforeEach(() => {
  captured = undefined as unknown as typeof captured;
  injectedNotes = [];
  toolResponses = [];
});

describe("gemini-live deep-task completion announce-back", () => {
  test("completion while the call is open injects the note + announce instruction", async () => {
    const { session, frames } = await startSession();
    await startDeepTask("Research the best flights to Tokyo next week");

    await publishCompletion({
      workItemId: "wi-1",
      status: "awaiting_review",
      summary: "Found 3 direct options; the 9am Garuda flight is cheapest.",
    });

    expect(injectedNotes).toHaveLength(1);
    const note = injectedNotes[0]!;
    // The model must speak NOW — the note closes the client turn.
    expect(note.triggerTurn).toBe(true);
    expect(note.text).toContain("not spoken by the user");
    expect(note.text).toContain("just finished");
    expect(note.text).toContain("Research the best flights to Tokyo");
    expect(note.text).toContain("the 9am Garuda flight is cheapest");
    expect(note.text).toContain("one or two sentences");
    expect(note.text).toContain("Review");
    // Optional card: the model is allowed a ui_show tile for visual results.
    expect(note.text).toContain("ui_show");
    // The announcement is attributed to a real turn (thinking frame opened).
    expect(frames.some((f) => f.type === "thinking")).toBe(true);

    // The completion signal fires once per item; a duplicate is a no-op.
    await publishCompletion({
      workItemId: "wi-1",
      status: "awaiting_review",
      summary: "dup",
    });
    expect(injectedNotes).toHaveLength(1);
    session.close("client_end");
  });

  test("a failed deep task is announced honestly — problem + Review, no result", async () => {
    const { session } = await startSession();
    await startDeepTask("Draft the partnership memo");

    await publishCompletion({ workItemId: "wi-1", status: "failed" });

    expect(injectedNotes).toHaveLength(1);
    const note = injectedNotes[0]!;
    expect(note.triggerTurn).toBe(true);
    expect(note.text).toContain("hit a problem");
    expect(note.text).toContain("Review");
    expect(note.text).toContain("do not invent a result");
    session.close("client_end");
  });

  test("the injected note never exceeds the summary clip", async () => {
    const { session } = await startSession();
    await startDeepTask("Summarize the giant report");

    await publishCompletion({
      workItemId: "wi-1",
      status: "done",
      summary: "x".repeat(20_000),
    });

    expect(injectedNotes).toHaveLength(1);
    const text = injectedNotes[0]!.text;
    expect(text).toContain("… (truncated)");
    // Clipped summary + fixed note framing — nowhere near the raw 20KB.
    expect(text.length).toBeLessThan(DEEP_TASK_SUMMARY_CLIP_CHARS + 800);
    session.close("client_end");
  });

  test("an empty summary degrades to an honest it's-in-Review note", async () => {
    const { session } = await startSession();
    await startDeepTask("Do the thing");

    await publishCompletion({ workItemId: "wi-1", status: "done" });

    expect(injectedNotes).toHaveLength(1);
    expect(injectedNotes[0]!.text).toContain("no summary was captured");
    session.close("client_end");
  });

  test("an unrelated work item completing injects nothing", async () => {
    const { session } = await startSession();
    await startDeepTask("Research flights");

    await publishCompletion({
      workItemId: "someone-elses-item",
      status: "done",
      summary: "not ours",
    });

    expect(injectedNotes).toHaveLength(0);
    session.close("client_end");
  });

  test("completion after close injects nothing and leaks no subscriber", async () => {
    const baseline = assistantEventHub.subscriberCount();
    const { session, frames } = await startSession();
    await startDeepTask("Research flights");

    // The lazy subscription exists while the call is open…
    expect(assistantEventHub.subscriberCount()).toBe(baseline + 1);

    session.close("client_end");
    frames.length = 0;

    // …and is gone the moment the call ends: no leaked listener.
    expect(assistantEventHub.subscriberCount()).toBe(baseline);

    await publishCompletion({
      workItemId: "wi-1",
      status: "done",
      summary: "finished after hangup",
    });

    // Nothing announced, nothing sent: the result lands in Review as before.
    expect(injectedNotes).toHaveLength(0);
    expect(frames).toEqual([]);
  });

  test("a call that never escalates registers no hub subscriber", async () => {
    const baseline = assistantEventHub.subscriberCount();
    const { session } = await startSession();

    expect(assistantEventHub.subscriberCount()).toBe(baseline);
    session.close("client_end");
    expect(assistantEventHub.subscriberCount()).toBe(baseline);
  });
});
