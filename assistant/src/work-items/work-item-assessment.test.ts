/**
 * Tests for the pre-run assessment: the cheap flash-tier pass that decides,
 * before a work item's execution turn, whether Cue understands the task and
 * can actually do it with the context this run will receive.
 *
 * The model is injected (an {@link AssessmentModel} stub), so every test is
 * deterministic and offline. The headline case — "a task WITH project context
 * assesses execute, the SAME task WITHOUT it assesses clarify" — uses a stub
 * that branches on the prompt it was handed, which is what proves the context
 * genuinely reaches the assessor rather than being assembled and dropped.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getConfig } from "../config/loader.js";
import { uploadAttachment } from "../memory/attachments-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { addProjectFileKnowledge } from "./project-knowledge-store.js";
import { createProject } from "./project-store.js";
import {
  type AssessmentInput,
  type AssessmentModel,
  assessWorkItem,
  buildAssessmentPrompt,
  buildCapabilitySnapshot,
  narrationForAssessment,
  parseAssessmentResponse,
  toSingleQuestion,
} from "./work-item-assessment.js";
import { listWorkItemEvents } from "./work-item-events.js";
import { buildWorkItemRunContext } from "./work-item-runner.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
} from "./work-item-store.js";

initializeDb();

let taskId = "";
beforeEach(() => {
  getDb().run("DELETE FROM work_item_events");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM project_knowledge");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM tasks");
  taskId = createTask({ title: "t", template: "do it" }).id;
});

const CAPABILITIES = {
  lines: ["search the web and read web pages"],
  connectors: ["google"],
  fingerprint: "cap-fixed",
};

function inputFor(
  itemId: string,
  overrides: Partial<AssessmentInput> = {},
): AssessmentInput {
  const item = getWorkItem(itemId)!;
  return {
    item,
    contextPreamble: "",
    capabilities: CAPABILITIES,
    ...overrides,
  };
}

/** A stub model that always replies with the given JSON. */
function replying(json: unknown): AssessmentModel {
  return async () => JSON.stringify(json);
}

const PARSE_OPTS = { notAiTaskMinConfidence: 0.7 };

// ---------------------------------------------------------------------------

describe("parseAssessmentResponse — the four verdicts", () => {
  test("execute carries the plan", () => {
    const parsed = parseAssessmentResponse(
      JSON.stringify({
        verdict: "execute",
        understanding: "Summarise the Q2 costs for the board.",
        plan: "I'll read the Q2 deck in project knowledge, pull the three cost lines, and draft the summary.",
        confidence: 0.9,
      }),
      PARSE_OPTS,
    );
    expect(parsed?.verdict).toBe("execute");
    expect(parsed?.plan).toContain("Q2 deck");
    expect(parsed?.question).toBeNull();
    expect(parsed?.confidence).toBe(0.9);
  });

  test("clarify carries exactly one question and no plan", () => {
    const parsed = parseAssessmentResponse(
      JSON.stringify({
        verdict: "clarify",
        understanding: "Send an update to the investor.",
        plan: "I'd draft something.",
        question: "Which investor should this go to?",
        confidence: 0.8,
      }),
      PARSE_OPTS,
    );
    expect(parsed?.verdict).toBe("clarify");
    expect(parsed?.question).toBe("Which investor should this go to?");
    // A parked verdict must never carry a plan — a surface would otherwise
    // show "here's what I'll do" beside "I'm not doing this".
    expect(parsed?.plan).toBeNull();
  });

  test("not_ai_task survives when the model is confident", () => {
    const parsed = parseAssessmentResponse(
      JSON.stringify({
        verdict: "not_ai_task",
        understanding: "Sign the lease in person at the office.",
        confidence: 0.95,
      }),
      PARSE_OPTS,
    );
    expect(parsed?.verdict).toBe("not_ai_task");
  });

  test("blocked names the one missing thing", () => {
    const parsed = parseAssessmentResponse(
      JSON.stringify({
        verdict: "blocked",
        understanding: "File the receipts in Xero.",
        missing: "Xero is not connected.",
        confidence: 0.85,
      }),
      PARSE_OPTS,
    );
    expect(parsed?.verdict).toBe("blocked");
    expect(parsed?.missing).toBe("Xero is not connected.");
  });

  test("garbage is unparseable — the caller then runs unassessed", () => {
    expect(
      parseAssessmentResponse("I think you should ask them.", PARSE_OPTS),
    ).toBeNull();
    expect(
      parseAssessmentResponse('{"verdict": "maybe"}', PARSE_OPTS),
    ).toBeNull();
  });
});

describe("parseAssessmentResponse — precision guards", () => {
  test("an unsure not_ai_task softens to clarify when a question was given", () => {
    const parsed = parseAssessmentResponse(
      JSON.stringify({
        verdict: "not_ai_task",
        question: "Do you want me to call them, or will you?",
        confidence: 0.4,
      }),
      PARSE_OPTS,
    );
    // A wrong not_ai_task (Cue refusing work it could do) is the worst
    // outcome, so an unsure one never stands.
    expect(parsed?.verdict).toBe("clarify");
  });

  test("an unsure not_ai_task with no question softens to execute", () => {
    const parsed = parseAssessmentResponse(
      JSON.stringify({ verdict: "not_ai_task", confidence: 0.2 }),
      PARSE_OPTS,
    );
    expect(parsed?.verdict).toBe("execute");
  });

  test("clarify without a question degrades to execute", () => {
    const parsed = parseAssessmentResponse(
      JSON.stringify({ verdict: "clarify", confidence: 0.9 }),
      PARSE_OPTS,
    );
    expect(parsed?.verdict).toBe("execute");
  });

  test("blocked without a missing thing degrades to execute", () => {
    const parsed = parseAssessmentResponse(
      JSON.stringify({ verdict: "blocked", confidence: 0.9 }),
      PARSE_OPTS,
    );
    expect(parsed?.verdict).toBe("execute");
  });

  test("only the first question survives — never a checklist", () => {
    expect(
      toSingleQuestion("Which deck do you mean? And should I include Q1?"),
    ).toBe("Which deck do you mean?");
    expect(toSingleQuestion("Which deck do you mean?")).toBe(
      "Which deck do you mean?",
    );
  });
});

describe("buildAssessmentPrompt", () => {
  test("quotes the context the run will actually receive", () => {
    const item = createWorkItem({ taskId, title: "Draft the update" });
    const prompt = buildAssessmentPrompt(
      inputFor(item.id, {
        contextPreamble: "## Project: Q4 launch\nSHIP THE PRICING PAGE",
      }),
    );
    expect(prompt).toContain("SHIP THE PRICING PAGE");
    expect(prompt).toContain("search the web and read web pages");
    expect(prompt).toContain("LINKED ACCOUNTS: google");
  });

  test("says so, explicitly, when the run will receive no context", () => {
    const item = createWorkItem({ taskId, title: "Draft the update" });
    const prompt = buildAssessmentPrompt(inputFor(item.id));
    expect(prompt).toContain("CONTEXT THE RUN WILL RECEIVE: none");
  });

  test("names the capability set so human-only calls are judged honestly", () => {
    const item = createWorkItem({ taskId, title: "Call the vet" });
    const prompt = buildAssessmentPrompt(inputFor(item.id));
    expect(prompt).toContain("ALWAYS choose clarify");
  });
});

describe("buildCapabilitySnapshot", () => {
  test("reports live capabilities and a stable fingerprint", () => {
    const snapshot = buildCapabilitySnapshot();
    // Derived from the live tool registry, so the exact lines depend on what
    // is registered; the shape and stability are what matter here.
    expect(Array.isArray(snapshot.lines)).toBe(true);
    expect(snapshot.fingerprint).toBe(buildCapabilitySnapshot().fingerprint);
  });

  // Regression: the snapshot used to claim phone calls whenever a call tool
  // was registered, so with no Twilio account configured the assessor read
  // "Call the dentist to book a cleaning" as execute and planned to speak to
  // the receptionist. A capability the assessor states becomes a promise.
  test("does not claim phone calls when no phone account is configured", () => {
    const twilio = getConfig().twilio;
    const configured = Boolean(twilio?.accountSid && twilio?.phoneNumber);
    const claimsCalls = buildCapabilitySnapshot().lines.some((line) =>
      line.includes("phone calls"),
    );
    expect(claimsCalls).toBe(configured);
  });
});

describe("assessWorkItem — persistence, caching, fail-open", () => {
  test("persists the verdict, writes an assessed trail row, and narrates", async () => {
    const item = createWorkItem({ taskId, title: "Summarise Q2 costs" });
    const result = await assessWorkItem(
      inputFor(item.id),
      replying({
        verdict: "execute",
        understanding: "Summarise the Q2 costs.",
        plan: "I'll read the Q2 deck and pull the cost lines.",
        confidence: 0.9,
      }),
    );

    expect(result.assessment?.verdict).toBe("execute");
    const stored = getWorkItem(item.id)!;
    expect(stored.assessmentVerdict).toBe("execute");
    expect(stored.assessmentPlan).toContain("Q2 deck");
    expect(stored.assessmentInputHash).toBeTruthy();
    expect(stored.assessmentAt).toBeGreaterThan(0);

    const assessed = listWorkItemEvents(item.id).filter(
      (e) => e.kind === "assessed",
    );
    expect(assessed).toHaveLength(1);
    expect(assessed[0].actor).toBe("assessor");
    expect(assessed[0].detail).toContain("Q2 deck");
  });

  test("a clarify verdict stores the question and no plan", async () => {
    const item = createWorkItem({ taskId, title: "Send the update" });
    await assessWorkItem(
      inputFor(item.id),
      replying({
        verdict: "clarify",
        understanding: "Send an update.",
        question: "Which investor should this go to?",
        confidence: 0.8,
      }),
    );
    const stored = getWorkItem(item.id)!;
    expect(stored.assessmentVerdict).toBe("clarify");
    expect(stored.assessmentQuestion).toBe("Which investor should this go to?");
    expect(stored.assessmentPlan).toBeNull();
  });

  test("a blocked verdict stores exactly what is missing", async () => {
    const item = createWorkItem({ taskId, title: "File the receipts in Xero" });
    await assessWorkItem(
      inputFor(item.id),
      replying({
        verdict: "blocked",
        missing: "Xero is not connected.",
        confidence: 0.9,
      }),
    );
    expect(getWorkItem(item.id)!.assessmentMissing).toBe(
      "Xero is not connected.",
    );
  });

  test("does not fire again while nothing that matters has changed", async () => {
    const item = createWorkItem({ taskId, title: "Summarise Q2 costs" });
    let calls = 0;
    const model: AssessmentModel = async () => {
      calls += 1;
      return JSON.stringify({
        verdict: "execute",
        plan: "I'll read the deck.",
        confidence: 0.9,
      });
    };

    await assessWorkItem(inputFor(item.id), model);
    const second = await assessWorkItem(inputFor(item.id), model);
    const third = await assessWorkItem(inputFor(item.id), model);

    expect(calls).toBe(1);
    expect(second.cached).toBe(true);
    expect(third.assessment?.verdict).toBe("execute");
  });

  test("re-assesses once the task changes — the answer could change too", async () => {
    const item = createWorkItem({ taskId, title: "Send the update" });
    let calls = 0;
    const model: AssessmentModel = async () => {
      calls += 1;
      return JSON.stringify({
        verdict: "clarify",
        question: "To whom?",
        confidence: 0.9,
      });
    };

    await assessWorkItem(inputFor(item.id), model);
    // The user answers by adding task context, which the run preamble carries.
    const second = await assessWorkItem(
      inputFor(item.id, {
        contextPreamble: "## Task context\nSend it to Aileen.",
      }),
      model,
    );
    expect(calls).toBe(2);
    expect(second.cached).toBe(false);
  });

  test("fails open when the model errors — nothing is stored, nothing blocks", async () => {
    const item = createWorkItem({ taskId, title: "Summarise Q2 costs" });
    const result = await assessWorkItem(inputFor(item.id), async () => {
      throw new Error("provider exploded");
    });
    expect(result.assessment).toBeNull();
    expect(getWorkItem(item.id)!.assessmentVerdict).toBeNull();
  });

  test("fails open when no assessment can be made at all", async () => {
    const item = createWorkItem({ taskId, title: "Summarise Q2 costs" });
    const result = await assessWorkItem(inputFor(item.id), async () => null);
    expect(result.assessment).toBeNull();
    expect(getWorkItem(item.id)!.assessmentVerdict).toBeNull();
  });

  // Regression: a live burst of 14 dispatches left 9 of them silently
  // unassessed, because one slow provider reply was the end of it. Under
  // load, the slow half of a batch is exactly the half that must recover.
  test("retries once when the first attempt comes back empty", async () => {
    const item = createWorkItem({ taskId, title: "Summarise Q2 costs" });
    let calls = 0;
    const result = await assessWorkItem(inputFor(item.id), async () => {
      calls += 1;
      if (calls === 1) return null;
      return JSON.stringify({
        verdict: "execute",
        understanding: "Summarise the Q2 costs.",
        plan: "Read the deck and pull the cost lines.",
        confidence: 0.9,
      });
    });
    expect(calls).toBe(2);
    expect(result.assessment?.verdict).toBe("execute");
    expect(getWorkItem(item.id)!.assessmentVerdict).toBe("execute");
  });

  test("gives up after the second attempt rather than retrying forever", async () => {
    const item = createWorkItem({ taskId, title: "Summarise Q2 costs" });
    let calls = 0;
    const result = await assessWorkItem(inputFor(item.id), async () => {
      calls += 1;
      return null;
    });
    expect(calls).toBe(2);
    expect(result.assessment).toBeNull();
  });
});

describe("narrationForAssessment", () => {
  test("says what Cue understood and what it will do", () => {
    expect(
      narrationForAssessment({
        verdict: "execute",
        understanding: "Summarise Q2 costs.",
        plan: "I'll read the deck.",
        question: null,
        missing: null,
      }),
    ).toBe("Understood: Summarise Q2 costs. Plan: I'll read the deck.");
  });

  test("never invents what the assessor did not say", () => {
    expect(
      narrationForAssessment({
        verdict: "execute",
        understanding: null,
        plan: null,
        question: null,
        missing: null,
      }),
    ).toBe("Understood the task; starting.");
  });

  test("surfaces the question and the missing thing verbatim", () => {
    expect(
      narrationForAssessment({
        verdict: "clarify",
        understanding: null,
        plan: null,
        question: "Which investor?",
        missing: null,
      }),
    ).toBe("Cue needs you: Which investor?");
    expect(
      narrationForAssessment({
        verdict: "blocked",
        understanding: null,
        plan: null,
        question: null,
        missing: "Xero is not connected.",
      }),
    ).toBe("Blocked — Xero is not connected.");
  });
});

// ---------------------------------------------------------------------------
// The proof that context matters
// ---------------------------------------------------------------------------

describe("the same task assesses differently with and without context", () => {
  /**
   * A stub that behaves the way a real assessor should: it can only say
   * "execute" when the prompt actually shows it the material the task refers
   * to. If the context assembled by the runner never reached the assessor,
   * both cases would come back `clarify` and this test fails — which is the
   * point.
   */
  const contextSensitiveModel: AssessmentModel = async (prompt) =>
    prompt.includes("pricing.md") && prompt.includes("PRICING BRIEF")
      ? JSON.stringify({
          verdict: "execute",
          understanding: "Summarise the pricing tiers for the board.",
          plan: "I'll read pricing.md from project knowledge and summarise the tiers.",
          confidence: 0.9,
        })
      : JSON.stringify({
          verdict: "clarify",
          understanding: "Summarise the pricing tiers.",
          question: "Which pricing document should I summarise?",
          confidence: 0.8,
        });

  test("with a briefed project + attached file → execute; bare → clarify", async () => {
    const project = createProject({
      title: "Launch",
      context: "PRICING BRIEF: three tiers, confident tone.",
    });
    const attachment = uploadAttachment(
      "pricing.md",
      "text/markdown",
      Buffer.from("starter, pro, scale\n").toString("base64"),
    );
    addProjectFileKnowledge({
      projectId: project.id,
      attachmentId: attachment.id,
    });

    const withContext = createWorkItem({
      taskId,
      title: "Summarise the pricing tiers",
      projectId: project.id,
    });
    const bare = createWorkItem({
      taskId,
      title: "Summarise the pricing tiers",
    });

    // Both go through the SAME assembly the runner uses for a real run.
    const richPreamble = buildWorkItemRunContext(
      getWorkItem(withContext.id)!,
    ).preamble;
    const barePreamble = buildWorkItemRunContext(
      getWorkItem(bare.id)!,
    ).preamble;
    expect(richPreamble).not.toBe("");
    expect(barePreamble).toBe("");

    const rich = await assessWorkItem(
      inputFor(withContext.id, { contextPreamble: richPreamble }),
      contextSensitiveModel,
    );
    const thin = await assessWorkItem(
      inputFor(bare.id, { contextPreamble: barePreamble }),
      contextSensitiveModel,
    );

    expect(rich.assessment?.verdict).toBe("execute");
    expect(rich.assessment?.plan).toContain("pricing.md");
    expect(thin.assessment?.verdict).toBe("clarify");
    expect(thin.assessment?.question).toBe(
      "Which pricing document should I summarise?",
    );
  });

  test("answering the question in task context flips the verdict", async () => {
    const item = createWorkItem({
      taskId,
      title: "Summarise the pricing tiers",
    });
    const first = await assessWorkItem(
      inputFor(item.id),
      contextSensitiveModel,
    );
    expect(first.assessment?.verdict).toBe("clarify");

    // The user answers; the runner's preamble now carries it.
    updateWorkItem(item.id, {
      context: "PRICING BRIEF: use pricing.md, the three tiers.",
    });
    const second = await assessWorkItem(
      inputFor(item.id, {
        contextPreamble: buildWorkItemRunContext(getWorkItem(item.id)!)
          .preamble,
      }),
      contextSensitiveModel,
    );
    expect(second.assessment?.verdict).toBe("execute");
  });
});
