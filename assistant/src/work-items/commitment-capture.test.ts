import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import {
  _setCommitmentCaptureOverridesForTests,
  DEFAULT_CAPTURE_CHANNELS,
  type ExtractedCommitment,
  hasCommitmentSignal,
  isCommitmentCaptureDisabled,
  maybeCaptureCommitments,
  parseCommitmentsResponse,
  resolveCaptureChannels,
} from "./commitment-capture.js";
import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
} from "./work-item-store.js";

// ---------------------------------------------------------------------------
// Pure prefilter
// ---------------------------------------------------------------------------

describe("hasCommitmentSignal (stage-1 prefilter)", () => {
  test("matches request shapes", () => {
    const positives = [
      "Can you send me the Q3 deck?",
      "could u share the figures",
      "Please review the contract",
      "I need you to book the flights",
      "Don't forget to submit the invoice",
      "don’t forget the invoice needs to go out", // curly apostrophe
      "Remember to renew the domain",
      "Make sure the deploy goes out tonight",
      "Reminder: pay the vendor",
      "Following up on the proposal",
      "Still waiting on your signature",
      "Get back to me about the venue",
      "Let me know once the report is ready",
      "Any chance you can look at this today?",
      "Send me the updated numbers",
    ];
    for (const text of positives) {
      expect(hasCommitmentSignal(text)).toBe(true);
    }
  });

  test("matches deadline shapes", () => {
    const positives = [
      "The report is expected by Friday",
      "Everything must land by tomorrow",
      "Submit it by EOD",
      "Deliver by 5pm",
      "Do this before the meeting",
      "The filing is due on Monday",
      "There's a hard deadline next week",
      "Handle this ASAP",
      "This is urgent",
      "The invoice is overdue",
    ];
    for (const text of positives) {
      expect(hasCommitmentSignal(text)).toBe(true);
    }
  });

  test("rejects plain chatter", () => {
    const negatives = [
      "lol sounds good",
      "Thanks!",
      "How was your weekend?",
      "I'm running late, be there in 10",
      "😂😂😂",
      "here's the link: https://example.com/notes",
      "Great job on the launch, congrats to everyone",
      "ok",
      "",
      "   ",
    ];
    for (const text of negatives) {
      expect(hasCommitmentSignal(text)).toBe(false);
    }
  });

  test("rejects sub-minimum-length text even with a keyword", () => {
    expect(hasCommitmentSignal("please")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Env gates
// ---------------------------------------------------------------------------

describe("env gates", () => {
  test("isCommitmentCaptureDisabled accepts 1/true only", () => {
    expect(isCommitmentCaptureDisabled("1")).toBe(true);
    expect(isCommitmentCaptureDisabled("true")).toBe(true);
    expect(isCommitmentCaptureDisabled("0")).toBe(false);
    expect(isCommitmentCaptureDisabled("")).toBe(false);
    expect(isCommitmentCaptureDisabled(undefined)).toBe(false);
  });

  test("resolveCaptureChannels defaults to external channels (no vellum)", () => {
    const channels = resolveCaptureChannels(undefined);
    expect(channels).toEqual(DEFAULT_CAPTURE_CHANNELS);
    expect(channels.has("vellum")).toBe(false);
    for (const c of ["telegram", "slack", "sms", "whatsapp", "email", "a2a"]) {
      expect(channels.has(c as never)).toBe(true);
    }
  });

  test("'all' includes vellum", () => {
    const channels = resolveCaptureChannels("all");
    expect(channels.has("vellum")).toBe(true);
    expect(channels.has("telegram")).toBe(true);
  });

  test("explicit comma list selects exactly those channels", () => {
    const channels = resolveCaptureChannels("telegram, slack");
    expect(channels).toEqual(new Set(["telegram", "slack"]));
  });

  test("garbage values fall back to the default set", () => {
    expect(resolveCaptureChannels("bogus,nope")).toEqual(
      DEFAULT_CAPTURE_CHANNELS,
    );
    expect(resolveCaptureChannels("   ")).toEqual(DEFAULT_CAPTURE_CHANNELS);
  });
});

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

describe("parseCommitmentsResponse", () => {
  test("parses a valid array and resolves dueAtIso to epoch ms", () => {
    const now = Date.parse("2026-07-02T12:00");
    const parsed = parseCommitmentsResponse(
      JSON.stringify([
        {
          title: "Send the Q3 deck to Sarah",
          executionPrompt:
            'Sarah asked via slack: "can you send me the Q3 deck by Friday?" Send it.',
          dueAtIso: "2026-07-03T17:00",
        },
      ]),
      now,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed![0].title).toBe("Send the Q3 deck to Sarah");
    expect(parsed![0].dueAt).toBe(Date.parse("2026-07-03T17:00"));
  });

  test("returns null on non-JSON and non-array responses (LLM failure)", () => {
    expect(parseCommitmentsResponse("no json here")).toBeNull();
    expect(parseCommitmentsResponse('{"title": "not an array"}')).toBeNull();
    expect(parseCommitmentsResponse("[not valid json]")).toBeNull();
  });

  test("empty array parses to an empty list (a valid 'no commitments')", () => {
    expect(parseCommitmentsResponse("[]")).toEqual([]);
  });

  test("drops entries missing title or executionPrompt", () => {
    const parsed = parseCommitmentsResponse(
      JSON.stringify([
        { title: "Only a title", dueAtIso: null },
        { executionPrompt: "Only a prompt", dueAtIso: null },
        { title: "  ", executionPrompt: "blank title", dueAtIso: null },
        { title: "Valid", executionPrompt: "Valid prompt", dueAtIso: null },
        "not an object",
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed![0].title).toBe("Valid");
  });

  test("caps at 3 commitments and truncates long titles to 80 chars", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      title: `${"x".repeat(100)}-${i}`,
      executionPrompt: `do thing ${i}`,
      dueAtIso: null,
    }));
    const parsed = parseCommitmentsResponse(JSON.stringify(entries));
    expect(parsed).toHaveLength(3);
    for (const c of parsed!) expect(c.title.length).toBe(80);
  });

  test("rejects unparseable and stale dueAtIso values", () => {
    const now = Date.parse("2026-07-02T12:00");
    const parsed = parseCommitmentsResponse(
      JSON.stringify([
        { title: "A", executionPrompt: "a", dueAtIso: "next friday-ish" },
        { title: "B", executionPrompt: "b", dueAtIso: "2026-06-20T17:00" },
      ]),
      now,
    );
    expect(parsed![0].dueAt).toBeNull();
    expect(parsed![1].dueAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end capture pipeline (DB-backed, injected extractor + triage)
// ---------------------------------------------------------------------------

describe("maybeCaptureCommitments (DB-backed)", () => {
  initializeDb();

  const savedDisable = process.env.CUE_DISABLE_COMMITMENT_CAPTURE;
  const savedChannels = process.env.CUE_COMMITMENT_CAPTURE_CHANNELS;

  let extractorCalls: Array<{ channel: string; content: string }> = [];
  let triagedIds: string[] = [];
  let extractorResult: ExtractedCommitment[] | null = [];

  function installOverrides(): void {
    _setCommitmentCaptureOverridesForTests({
      extractor: async (params) => {
        extractorCalls.push({
          channel: params.channel,
          content: params.content,
        });
        return extractorResult;
      },
      triage: async (workItemId: string) => {
        triagedIds.push(workItemId);
        return { autoRunStarted: false, reason: "skipped" as const };
      },
    });
  }

  beforeEach(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
    delete process.env.CUE_DISABLE_COMMITMENT_CAPTURE;
    delete process.env.CUE_COMMITMENT_CAPTURE_CHANNELS;
    extractorCalls = [];
    triagedIds = [];
    extractorResult = [];
    installOverrides();
  });

  afterEach(() => {
    _setCommitmentCaptureOverridesForTests({});
  });

  afterAll(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
    if (savedDisable === undefined) {
      delete process.env.CUE_DISABLE_COMMITMENT_CAPTURE;
    } else {
      process.env.CUE_DISABLE_COMMITMENT_CAPTURE = savedDisable;
    }
    if (savedChannels === undefined) {
      delete process.env.CUE_COMMITMENT_CAPTURE_CHANNELS;
    } else {
      process.env.CUE_COMMITMENT_CAPTURE_CHANNELS = savedChannels;
    }
  });

  const baseArgs = {
    sourceChannel: "telegram" as const,
    conversationId: "conv-1",
    content: "Can you send me the Q3 report by Friday?",
    senderDisplayName: "Sarah Chen",
  };

  test("captures a commitment into a work item and hands it to triage", async () => {
    extractorResult = [
      {
        title: "Send Sarah the Q3 report",
        executionPrompt:
          'Sarah Chen asked via telegram: "Can you send me the Q3 report by Friday?" Prepare and send the Q3 report.',
        dueAt: Date.now() + 3 * 24 * 3600_000,
      },
    ];

    const result = await maybeCaptureCommitments(baseArgs);

    expect(result.status).toBe("captured");
    expect(result.createdWorkItemIds).toHaveLength(1);

    const item = getWorkItem(result.createdWorkItemIds[0])!;
    expect(item.title).toBe("Send Sarah the Q3 report");
    expect(item.sourceType).toBe("telegram");
    expect(item.sourceId).toBe("conv-1");
    expect(item.status).toBe("queued");
    expect(item.notes).toContain("From: Sarah Chen via telegram");
    expect(item.dueAt).not.toBeNull();
    const sourceContext = JSON.parse(item.sourceContext!) as {
      origin: string;
      sender: string;
    };
    expect(sourceContext.origin).toBe("telegram");
    expect(sourceContext.sender).toBe("Sarah Chen");

    // The existing triage/auto-run pass received the fresh item.
    expect(triagedIds).toEqual([item.id]);
  });

  test("skips the vellum surface by default but honors CUE_COMMITMENT_CAPTURE_CHANNELS=all", async () => {
    extractorResult = [
      { title: "Do the thing", executionPrompt: "do it", dueAt: null },
    ];

    const skipped = await maybeCaptureCommitments({
      ...baseArgs,
      sourceChannel: "vellum",
    });
    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toBe("channel_not_in_scope");
    expect(extractorCalls).toHaveLength(0);

    process.env.CUE_COMMITMENT_CAPTURE_CHANNELS = "all";
    const captured = await maybeCaptureCommitments({
      ...baseArgs,
      sourceChannel: "vellum",
    });
    expect(captured.status).toBe("captured");
  });

  test("kill switch CUE_DISABLE_COMMITMENT_CAPTURE=1 stops everything", async () => {
    process.env.CUE_DISABLE_COMMITMENT_CAPTURE = "1";
    const result = await maybeCaptureCommitments(baseArgs);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("disabled");
    expect(extractorCalls).toHaveLength(0);
    expect(listWorkItems()).toHaveLength(0);
  });

  test("chatter with no prefilter signal never reaches the LLM", async () => {
    const result = await maybeCaptureCommitments({
      ...baseArgs,
      content: "haha nice one, see you at the party",
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_signal");
    expect(extractorCalls).toHaveLength(0);
  });

  test("bot messages and slash-commands are skipped", async () => {
    const bot = await maybeCaptureCommitments({ ...baseArgs, isBot: true });
    expect(bot.reason).toBe("bot_message");

    const command = await maybeCaptureCommitments({
      ...baseArgs,
      content: "/start please help",
    });
    expect(command.reason).toBe("command");
    expect(extractorCalls).toHaveLength(0);
  });

  test("LLM failure (null) means NO capture — never guess", async () => {
    extractorResult = null;
    const result = await maybeCaptureCommitments(baseArgs);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("llm_unavailable");
    expect(listWorkItems()).toHaveLength(0);
  });

  test("extractor throwing degrades to error result, never rejects", async () => {
    _setCommitmentCaptureOverridesForTests({
      extractor: async () => {
        throw new Error("provider exploded");
      },
    });
    const result = await maybeCaptureCommitments(baseArgs);
    expect(result.status).toBe("error");
    expect(listWorkItems()).toHaveLength(0);
  });

  test("empty extraction ([]) captures nothing", async () => {
    extractorResult = [];
    const result = await maybeCaptureCommitments(baseArgs);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_commitments");
  });

  test("skips creation when an active work item with the same normalized title exists", async () => {
    const task = createTask({
      title: "Send Sarah the Q3 report",
      template: "x",
    });
    createWorkItem({
      taskId: task.id,
      title: "send sarah the q3 report", // different case — normalized match
      sourceType: "slack",
    });

    extractorResult = [
      {
        title: "Send Sarah the Q3 report",
        executionPrompt: "send it",
        dueAt: null,
      },
    ];
    const result = await maybeCaptureCommitments(baseArgs);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("all_duplicates");
    expect(listWorkItems()).toHaveLength(1); // only the pre-existing item
    expect(triagedIds).toEqual([]);
  });

  test("collapses intra-message duplicate titles", async () => {
    extractorResult = [
      { title: "Book the flights", executionPrompt: "book", dueAt: null },
      { title: "book the flights", executionPrompt: "book again", dueAt: null },
      { title: "Reserve the hotel", executionPrompt: "reserve", dueAt: null },
    ];
    const result = await maybeCaptureCommitments(baseArgs);
    expect(result.status).toBe("captured");
    expect(result.createdWorkItemIds).toHaveLength(2);
    const titles = listWorkItems().map((i) => i.title.toLowerCase());
    expect(titles.sort()).toEqual(["book the flights", "reserve the hotel"]);
  });

  test("one failing commitment does not sink the others", async () => {
    extractorResult = [
      // Empty title after trim — skipped by validation guard.
      { title: "   ", executionPrompt: "broken", dueAt: null },
      { title: "Pay the vendor invoice", executionPrompt: "pay", dueAt: null },
    ];
    const result = await maybeCaptureCommitments(baseArgs);
    expect(result.status).toBe("captured");
    expect(result.createdWorkItemIds).toHaveLength(1);
    expect(getWorkItem(result.createdWorkItemIds[0])!.title).toBe(
      "Pay the vendor invoice",
    );
  });
});
