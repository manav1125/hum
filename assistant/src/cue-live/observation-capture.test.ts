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
import { getWorkItem, listWorkItems } from "../work-items/work-item-store.js";
import { maybeAutoRunWorkItem } from "../work-items/work-item-triage.js";
import {
  _resetObservationCaptureStateForTests,
  _setObservationCaptureOverridesForTests,
  detectSensitiveScreen,
  type ExtractedScreenTask,
  getObservationCaptureSessionView,
  isObservationCaptureArmed,
  normalizeTaskTitle,
  observationDigest,
  parseScreenTasksResponse,
  SCREEN_SOURCE_TYPE,
  startObservationCaptureSession,
  stopObservationCaptureSession,
  submitScreenObservation,
  wasRecentlyCaptured,
} from "./observation-capture.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseScreenTasksResponse", () => {
  test("keeps well-formed, evidenced tasks and truncates the title", () => {
    const parsed = parseScreenTasksResponse(
      JSON.stringify([
        {
          title: "x".repeat(120),
          executionPrompt: "Reply to the thread",
          evidence: "Unread from Dana: can you sign off?",
        },
      ]),
      2,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed![0].title).toHaveLength(80);
  });

  test("drops entries missing a title, instruction, or on-screen evidence", () => {
    const parsed = parseScreenTasksResponse(
      JSON.stringify([
        { title: "", executionPrompt: "a", evidence: "e" },
        { title: "A", executionPrompt: "", evidence: "e" },
        // An unevidenced task cannot be explained to the user, so it is not filed.
        { title: "B", executionPrompt: "b", evidence: "" },
        { title: "C", executionPrompt: "c", evidence: "seen it" },
      ]),
      5,
    );
    expect(parsed!.map((t) => t.title)).toEqual(["C"]);
  });

  test("honors the per-observation cap", () => {
    const parsed = parseScreenTasksResponse(
      JSON.stringify(
        [1, 2, 3, 4].map((n) => ({
          title: `T${n}`,
          executionPrompt: "p",
          evidence: "e",
        })),
      ),
      2,
    );
    expect(parsed).toHaveLength(2);
  });

  test("returns null (never a guess) when the reply carries no JSON array", () => {
    expect(
      parseScreenTasksResponse("I could not read the screen", 2),
    ).toBeNull();
    expect(parseScreenTasksResponse("[not json", 2)).toBeNull();
    expect(parseScreenTasksResponse('{"title":"A"}', 2)).toBeNull();
  });

  test("an empty array is a valid answer, distinct from a failure", () => {
    expect(parseScreenTasksResponse("[]", 2)).toEqual([]);
  });
});

describe("normalizeTaskTitle / dedupe window", () => {
  test("collapses punctuation and case but keeps distinct tasks distinct", () => {
    expect(normalizeTaskTitle("Reply to Sam's email!")).toBe(
      normalizeTaskTitle("reply to sams   email"),
    );
    expect(normalizeTaskTitle("Reply to Sam")).not.toBe(
      normalizeTaskTitle("Reply to Dana"),
    );
  });

  test("a title outside the window is capturable again", () => {
    _resetObservationCaptureStateForTests();
    // Nothing captured yet.
    expect(wasRecentlyCaptured("Send the deck", 1_000, 60_000)).toBe(false);
  });
});

describe("observationDigest", () => {
  test("identical observations share a fingerprint", () => {
    const a = observationDigest({ appName: "Figma", description: "same" });
    const b = observationDigest({ appName: "Figma", description: "same" });
    expect(a).toBe(b);
  });

  test("a changed description or app changes the fingerprint", () => {
    const base = observationDigest({ appName: "Figma", description: "same" });
    expect(
      observationDigest({ appName: "Figma", description: "other" }),
    ).not.toBe(base);
    expect(
      observationDigest({ appName: "Slack", description: "same" }),
    ).not.toBe(base);
  });

  test("byte-identical frames share a fingerprint; different bytes do not", () => {
    const frame = "A".repeat(5_000);
    expect(observationDigest({ imageBase64: frame })).toBe(
      observationDigest({ imageBase64: frame }),
    );
    expect(observationDigest({ imageBase64: frame + "B" })).not.toBe(
      observationDigest({ imageBase64: frame }),
    );
  });
});

describe("detectSensitiveScreen", () => {
  test("matches the deny list against the app name and the text", () => {
    expect(
      detectSensitiveScreen({ appName: "1Password", denyList: ["1password"] }),
    ).toBe("1password");
    // Browser tab titles are the real-world case: the app is Safari.
    expect(
      detectSensitiveScreen({
        appName: "Safari",
        text: "Chase — Online Banking",
        denyList: ["online banking"],
      }),
    ).toBe("online banking");
  });

  test("matches credential/payment text markers regardless of app", () => {
    expect(
      detectSensitiveScreen({
        appName: "Notes",
        text: "Seed phrase: ...",
        denyList: [],
      }),
    ).toBe("seed phrase");
    expect(
      detectSensitiveScreen({
        appName: "Chrome",
        text: "Card number",
        denyList: [],
      }),
    ).toBe("card number");
  });

  test("ordinary work screens pass", () => {
    expect(
      detectSensitiveScreen({
        appName: "Figma",
        text: "Comment from Dana: the hero needs a new headline",
        denyList: ["1password"],
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pipeline (DB-backed, injected extractor + triage + settings)
// ---------------------------------------------------------------------------

describe("submitScreenObservation", () => {
  initializeDb();

  let extractorCalls = 0;
  let triagedIds: string[] = [];
  let extractorResult: ExtractedScreenTask[] | null = [];

  const T0 = Date.parse("2026-07-21T14:22:00");

  const BASE_SETTINGS = {
    enabled: true,
    intervalSeconds: 90,
    sessionMaxMinutes: 30,
    maxExtractionsPerSession: 20,
    maxItemsPerSession: 10,
    maxItemsPerObservation: 2,
    dedupeWindowMinutes: 360,
    sensitiveAppDenyList: ["1password"],
  };

  function install(settings: Partial<typeof BASE_SETTINGS> = {}): void {
    _setObservationCaptureOverridesForTests({
      extractor: async () => {
        extractorCalls += 1;
        return extractorResult;
      },
      triage: async (workItemId: string) => {
        triagedIds.push(workItemId);
        return { autoRunStarted: false, reason: "user_parked" as const };
      },
      settings: { ...BASE_SETTINGS, ...settings },
    });
  }

  function oneTask(
    title = "Reply to Dana's review comment",
  ): ExtractedScreenTask[] {
    return [
      {
        title,
        executionPrompt: `Reply to Dana about the hero headline. Done = a reply is posted.`,
        evidence: "Dana: the hero needs a new headline",
      },
    ];
  }

  beforeEach(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
    _resetObservationCaptureStateForTests();
    extractorCalls = 0;
    triagedIds = [];
    extractorResult = [];
    install();
  });

  afterEach(() => {
    _setObservationCaptureOverridesForTests({});
    _resetObservationCaptureStateForTests();
  });

  afterAll(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
  });

  // --- Opt-in ------------------------------------------------------------

  test("captures nothing while the config switch is off, even if asked to start", () => {
    install({ enabled: false });
    const view = startObservationCaptureSession({ now: T0 });
    expect(view.enabled).toBe(false);
    expect(view.armed).toBe(false);
    expect(isObservationCaptureArmed(T0)).toBe(false);
  });

  test("the config switch alone does not capture — a session must be armed", async () => {
    extractorResult = oneTask();
    const result = await submitScreenObservation({
      description: "Dana left a review comment on the hero section of the deck",
      at: T0,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not_armed");
    expect(extractorCalls).toBe(0);
    expect(listWorkItems()).toHaveLength(0);
  });

  test("stopping a session disarms it immediately", async () => {
    startObservationCaptureSession({ now: T0 });
    stopObservationCaptureSession(T0);
    extractorResult = oneTask();
    const result = await submitScreenObservation({
      description: "Dana left a review comment on the hero section of the deck",
      at: T0,
    });
    expect(result.reason).toBe("not_armed");
    expect(extractorCalls).toBe(0);
  });

  // --- Time bound --------------------------------------------------------

  test("a session is always time-bounded and clamped to the configured max", () => {
    install({ sessionMaxMinutes: 15 });
    const unbounded = startObservationCaptureSession({ now: T0 });
    expect(unbounded.expiresAt).toBe(new Date(T0 + 15 * 60_000).toISOString());

    const overlong = startObservationCaptureSession({
      durationMinutes: 600,
      now: T0,
    });
    expect(overlong.expiresAt).toBe(new Date(T0 + 15 * 60_000).toISOString());

    const shorter = startObservationCaptureSession({
      durationMinutes: 5,
      now: T0,
    });
    expect(shorter.expiresAt).toBe(new Date(T0 + 5 * 60_000).toISOString());
  });

  test("an expired session captures nothing and reports itself disarmed", async () => {
    install({ sessionMaxMinutes: 10 });
    startObservationCaptureSession({ now: T0 });
    const after = T0 + 11 * 60_000;

    expect(isObservationCaptureArmed(after)).toBe(false);
    extractorResult = oneTask();
    const result = await submitScreenObservation({
      description: "Dana left a review comment on the hero section of the deck",
      at: after,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not_armed");
    expect(extractorCalls).toBe(0);
    expect(getObservationCaptureSessionView(after).armed).toBe(false);
  });

  // --- Filing + the parked invariant -------------------------------------

  test("files a captured task PARKED in the queue, attributed to the screen", async () => {
    startObservationCaptureSession({ now: T0 });
    extractorResult = oneTask();

    const result = await submitScreenObservation({
      description: "Dana left a review comment on the hero section of the deck",
      appName: "Figma",
      at: T0,
    });

    expect(result.status).toBe("captured");
    expect(result.createdWorkItemIds).toHaveLength(1);

    const item = getWorkItem(result.createdWorkItemIds[0])!;
    // THE invariant: captured-from-pixels work never auto-runs.
    expect(item.autoRunEligibility).toBe("parked");
    expect(item.status).toBe("queued");
    expect(item.sourceType).toBe(SCREEN_SOURCE_TYPE);
    expect(item.sourceId).toBe(getObservationCaptureSessionView(T0).sessionId);
    // Attribution the user can read: when, where, and what Cue saw.
    expect(item.notes).toContain("Seen on your screen at 14:22");
    expect(item.notes).toContain("Figma");
    expect(item.notes).toContain("Dana: the hero needs a new headline");
    const sourceContext = JSON.parse(item.sourceContext!) as {
      origin: string;
      evidence: string;
      app: string | null;
    };
    expect(sourceContext.origin).toBe("screen-observation");
    expect(sourceContext.app).toBe("Figma");
    expect(sourceContext.evidence).toContain("hero needs a new headline");

    // Handed to the existing triage pass, which cannot start a parked item.
    expect(triagedIds).toEqual([item.id]);

    // Inspectable: the session says what it took.
    const view = getObservationCaptureSessionView(T0);
    expect(view.captures).toHaveLength(1);
    expect(view.captures[0].workItemId).toBe(item.id);
    expect(view.captures[0].evidence).toContain("hero needs a new headline");
  });

  // --- Extraction gating -------------------------------------------------

  test("a too-thin observation with no frame never reaches the model", async () => {
    startObservationCaptureSession({ now: T0 });
    const result = await submitScreenObservation({
      description: "Figma",
      at: T0,
    });
    expect(result.reason).toBe("nothing_to_read");
    expect(extractorCalls).toBe(0);
  });

  test("an unchanged screen is not re-read", async () => {
    startObservationCaptureSession({ now: T0 });
    extractorResult = [];
    const description =
      "A quiet document with nothing outstanding on it at all";

    await submitScreenObservation({ description, at: T0 });
    expect(extractorCalls).toBe(1);

    // Same screen, well past the interval floor — still no second model call.
    const later = T0 + 10 * 60_000;
    const result = await submitScreenObservation({ description, at: later });
    expect(result.reason).toBe("no_change");
    expect(extractorCalls).toBe(1);
  });

  test("a sensitive screen is skipped without an extraction", async () => {
    startObservationCaptureSession({ now: T0 });
    extractorResult = oneTask();
    const result = await submitScreenObservation({
      appName: "1Password",
      description: "A vault list with several saved logins in it right now",
      at: T0,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("sensitive_screen");
    expect(extractorCalls).toBe(0);
    expect(listWorkItems()).toHaveLength(0);
  });

  test("an LLM failure captures nothing rather than guessing", async () => {
    startObservationCaptureSession({ now: T0 });
    extractorResult = null;
    const result = await submitScreenObservation({
      description: "Dana left a review comment on the hero section of the deck",
      at: T0,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("llm_unavailable");
    expect(listWorkItems()).toHaveLength(0);
  });

  // --- Cost discipline ---------------------------------------------------

  test("the interval floor drops observations that arrive too soon", async () => {
    install({ intervalSeconds: 120 });
    startObservationCaptureSession({ now: T0 });
    extractorResult = [];

    await submitScreenObservation({
      description: "screen one, nothing to do here",
      at: T0,
    });
    expect(extractorCalls).toBe(1);

    const tooSoon = await submitScreenObservation({
      description: "screen two, a different view of the same app entirely",
      at: T0 + 60_000,
    });
    expect(tooSoon.reason).toBe("interval_floor");
    expect(extractorCalls).toBe(1);

    await submitScreenObservation({
      description: "screen three, later on and different again for sure",
      at: T0 + 121_000,
    });
    expect(extractorCalls).toBe(2);
  });

  test("the per-session extraction cap is a hard spend ceiling", async () => {
    install({ maxExtractionsPerSession: 2, intervalSeconds: 15 });
    startObservationCaptureSession({ now: T0 });
    extractorResult = [];

    for (let i = 0; i < 5; i++) {
      await submitScreenObservation({
        description: `a distinct screen number ${i} with nothing actionable`,
        at: T0 + i * 60_000,
      });
    }
    expect(extractorCalls).toBe(2);

    const view = getObservationCaptureSessionView(T0);
    expect(view.extractionsUsed).toBe(2);
    expect(view.extractionsRemaining).toBe(0);

    const blocked = await submitScreenObservation({
      description: "yet another distinct screen well after the cap was hit",
      at: T0 + 10 * 60_000,
    });
    expect(blocked.reason).toBe("extraction_cap_reached");
  });

  test("the per-session item cap keeps a long watch from flooding the lane", async () => {
    install({ maxItemsPerSession: 1, intervalSeconds: 15 });
    startObservationCaptureSession({ now: T0 });

    extractorResult = oneTask("Reply to Dana's review comment");
    const first = await submitScreenObservation({
      description: "Dana left a review comment on the hero section of the deck",
      at: T0,
    });
    expect(first.status).toBe("captured");

    extractorResult = oneTask("Send the updated deck to Priya");
    const second = await submitScreenObservation({
      description: "Priya asked in Slack for the updated deck by tomorrow noon",
      at: T0 + 60_000,
    });
    expect(second.reason).toBe("item_cap_reached");
    expect(listWorkItems()).toHaveLength(1);
  });

  // --- Dedupe ------------------------------------------------------------

  test("the same task on consecutive frames is filed once", async () => {
    install({ intervalSeconds: 15 });
    startObservationCaptureSession({ now: T0 });

    extractorResult = oneTask("Reply to Dana's review comment");
    const first = await submitScreenObservation({
      description: "Dana left a review comment on the hero section of the deck",
      at: T0,
    });
    expect(first.createdWorkItemIds).toHaveLength(1);

    // A later frame of the same screen, worded differently, same to-do.
    extractorResult = [
      {
        title: "reply to danas review comment!",
        executionPrompt: "Reply to Dana about the hero headline.",
        evidence: "Dana: the hero needs a new headline",
      },
    ];
    const second = await submitScreenObservation({
      description:
        "The deck is still open and Dana's comment is still unanswered",
      at: T0 + 60_000,
    });
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("all_duplicates");
    expect(listWorkItems()).toHaveLength(1);
  });

  test("duplicates inside one observation collapse to a single item", async () => {
    startObservationCaptureSession({ now: T0 });
    extractorResult = [
      {
        title: "Send the deck",
        executionPrompt: "Send the deck to Priya.",
        evidence: "Priya: can you send the deck?",
      },
      {
        title: "send the deck.",
        executionPrompt: "Send the deck to Priya.",
        evidence: "Priya: can you send the deck?",
      },
    ];
    const result = await submitScreenObservation({
      description:
        "Priya asked in Slack whether the deck can be sent over today",
      at: T0,
    });
    expect(result.createdWorkItemIds).toHaveLength(1);
    expect(listWorkItems()).toHaveLength(1);
  });

  test("a task captured in an earlier session is not re-captured in a new one", async () => {
    install({ intervalSeconds: 15 });
    startObservationCaptureSession({ now: T0 });
    extractorResult = oneTask("Reply to Dana's review comment");
    await submitScreenObservation({
      description: "Dana left a review comment on the hero section of the deck",
      at: T0,
    });
    expect(listWorkItems()).toHaveLength(1);

    // Re-arm (a fresh session id) and see the same to-do still on screen.
    startObservationCaptureSession({ now: T0 + 60_000 });
    const again = await submitScreenObservation({
      description:
        "The deck is still open and Dana's comment is still unanswered",
      at: T0 + 61_000,
    });
    expect(again.reason).toBe("all_duplicates");
    expect(listWorkItems()).toHaveLength(1);
  });

  test("the store's active-item check catches a repeat after a daemon restart", async () => {
    install({ intervalSeconds: 15 });
    startObservationCaptureSession({ now: T0 });
    extractorResult = oneTask("Reply to Dana's review comment");
    await submitScreenObservation({
      description: "Dana left a review comment on the hero section of the deck",
      at: T0,
    });
    expect(listWorkItems()).toHaveLength(1);

    // A restart forgets the in-memory dedupe window (and the session), but the
    // already-queued item is still in the store — the belt behind the window.
    _resetObservationCaptureStateForTests();
    startObservationCaptureSession({ now: T0 + 60_000 });
    const again = await submitScreenObservation({
      description:
        "The deck is still open and Dana's comment is still unanswered",
      at: T0 + 61_000,
    });
    expect(again.reason).toBe("all_duplicates");
    expect(listWorkItems()).toHaveLength(1);
  });

  // --- The parked invariant, through the real auto-run gate ---------------

  test("the real auto-run gate refuses a screen-captured item", async () => {
    const saved = process.env.CUE_DISABLE_WORKITEM_AUTORUN;
    delete process.env.CUE_DISABLE_WORKITEM_AUTORUN;
    try {
      startObservationCaptureSession({ now: T0 });
      extractorResult = oneTask();
      const result = await submitScreenObservation({
        description:
          "Dana left a review comment on the hero section of the deck",
        at: T0,
      });
      expect(result.createdWorkItemIds).toHaveLength(1);

      // Not the injected triage stub — the production gate, which evaluates
      // `autoRunEligibility === "parked"` before every other check.
      const decision = await maybeAutoRunWorkItem(result.createdWorkItemIds[0]);
      expect(decision.started).toBe(false);
      expect(decision.reason).toBe("user_parked");
    } finally {
      if (saved === undefined) delete process.env.CUE_DISABLE_WORKITEM_AUTORUN;
      else process.env.CUE_DISABLE_WORKITEM_AUTORUN = saved;
    }
  });
});
