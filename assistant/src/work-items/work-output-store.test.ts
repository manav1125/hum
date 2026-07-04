/**
 * Tests for the work-output store ("Sprint outputs"): the migration, kind
 * derivation, capture from a completed run's conversation attachments
 * (including mission denormalization and exact-once idempotency), the
 * mission/work-item/recent listings, and the review-state flip.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { attachInlineAttachmentToMessage } from "../memory/attachments-store.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createMission } from "../missions/mission-store.js";
import { createTask } from "../tasks/task-store.js";
import { createProject } from "./project-store.js";
import { createWorkItem } from "./work-item-store.js";
import {
  createWorkOutput,
  deriveOutputKind,
  enrichOutputsWithAttachments,
  getWorkOutput,
  listMissionOutputs,
  listRecentOutputs,
  listWorkItemOutputs,
  registerOutputsForCompletedRun,
  setWorkOutputReviewState,
} from "./work-output-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM work_outputs");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM missions");
});

// A 1x1 transparent PNG — a real payload so the attachment write path works.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Persist a run conversation with one assistant message; returns both ids. */
async function seedRunConversation(): Promise<{
  conversationId: string;
  assistantMessageId: string;
}> {
  const conversation = createConversation("run conversation");
  const inserted = await addMessage(
    conversation.id,
    "assistant",
    "Done — deliverables attached.",
    { skipIndexing: true },
  );
  return { conversationId: conversation.id, assistantMessageId: inserted.id };
}

describe("migration", () => {
  test("creates the work_outputs table with its indexes", () => {
    const raw = getSqliteFrom(getDb());
    const table = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='work_outputs'`,
      )
      .all() as Array<{ name: string }>;
    expect(table.map((r) => r.name)).toEqual(["work_outputs"]);

    const indexes = (
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='work_outputs'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain("work_outputs_mission_created_idx");
    expect(indexes).toContain("work_outputs_work_item_idx");
    expect(indexes).toContain("work_outputs_created_idx");
    expect(indexes).toContain("work_outputs_item_attachment_uniq");
  });
});

describe("deriveOutputKind", () => {
  test("maps mimes and extension fallbacks onto the card taxonomy", () => {
    expect(deriveOutputKind("application/pdf", "pitch.pdf")).toBe("pdf");
    expect(
      deriveOutputKind(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "deck.pptx",
      ),
    ).toBe("deck");
    expect(
      deriveOutputKind(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "crm.xlsx",
      ),
    ).toBe("spreadsheet");
    expect(deriveOutputKind("text/csv", "funds.csv")).toBe("spreadsheet");
    expect(deriveOutputKind("image/png", "hero.png")).toBe("image");
    expect(deriveOutputKind("video/mp4", "demo.mp4")).toBe("video");
    expect(deriveOutputKind("text/markdown", "notes.md")).toBe("document");
    expect(
      deriveOutputKind(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "memo.docx",
      ),
    ).toBe("document");
    // Generic mime falls back to the extension…
    expect(deriveOutputKind("application/octet-stream", "deck.key")).toBe(
      "deck",
    );
    expect(deriveOutputKind("application/octet-stream", "report.pdf")).toBe(
      "pdf",
    );
    // …and to "other" when neither side matches.
    expect(deriveOutputKind("application/octet-stream", "blob.bin")).toBe(
      "other",
    );
  });
});

describe("registerOutputsForCompletedRun", () => {
  test("registers the run's assistant-message attachments with mission denormalized", async () => {
    const mission = createMission({
      title: "First 20 customers",
      outcome: "20 paying customers",
    });
    const project = createProject({ title: "Fundraise" });
    getDb().run(
      `UPDATE projects SET mission_id = '${mission.id}' WHERE id = '${project.id}'`,
    );
    const task = createTask({ title: "Build deck", template: "Do it" });
    const workItem = createWorkItem({
      taskId: task.id,
      title: "Build the pitch deck",
      projectId: project.id,
      assignee: "builder",
    });

    const { conversationId, assistantMessageId } = await seedRunConversation();
    const stored = attachInlineAttachmentToMessage(
      assistantMessageId,
      0,
      "Pitch deck v3.pdf",
      "application/pdf",
      TINY_PNG_B64,
    );

    const registered = registerOutputsForCompletedRun(workItem, conversationId);
    expect(registered).toHaveLength(1);
    const output = registered[0];
    expect(output.workItemId).toBe(workItem.id);
    expect(output.projectId).toBe(project.id);
    expect(output.missionId).toBe(mission.id);
    expect(output.attachmentId).toBe(stored.id);
    expect(output.kind).toBe("pdf");
    expect(output.title).toBe("Pitch deck v3.pdf");
    expect(output.why).toContain("Build the pitch deck");
    expect(output.agent).toBe("builder");
    expect(output.reviewState).toBe("pending");

    // The row is persisted, not just returned.
    expect(getWorkOutput(output.id)?.attachmentId).toBe(stored.id);
  });

  test("is idempotent per (work item, attachment) — re-registration is a no-op", async () => {
    const task = createTask({ title: "T", template: "Do it" });
    const workItem = createWorkItem({ taskId: task.id, title: "Make sheet" });
    const { conversationId, assistantMessageId } = await seedRunConversation();
    attachInlineAttachmentToMessage(
      assistantMessageId,
      0,
      "crm.csv",
      "text/csv",
      TINY_PNG_B64,
    );

    const first = registerOutputsForCompletedRun(workItem, conversationId);
    expect(first).toHaveLength(1);
    const second = registerOutputsForCompletedRun(workItem, conversationId);
    expect(second).toHaveLength(0);
    expect(listWorkItemOutputs(workItem.id)).toHaveLength(1);
  });

  test("ignores user-message attachments (inputs are not deliverables)", async () => {
    const task = createTask({ title: "T", template: "Do it" });
    const workItem = createWorkItem({ taskId: task.id, title: "Review file" });
    const conversation = createConversation("run conversation");
    const userMsg = await addMessage(conversation.id, "user", "here's input", {
      skipIndexing: true,
    });
    attachInlineAttachmentToMessage(
      userMsg.id,
      0,
      "input.pdf",
      "application/pdf",
      TINY_PNG_B64,
    );

    expect(registerOutputsForCompletedRun(workItem, conversation.id)).toEqual(
      [],
    );
  });

  test("unlinked work item (no project) registers with null mission", async () => {
    const task = createTask({ title: "T", template: "Do it" });
    const workItem = createWorkItem({ taskId: task.id, title: "Loose task" });
    const { conversationId, assistantMessageId } = await seedRunConversation();
    attachInlineAttachmentToMessage(
      assistantMessageId,
      0,
      "hero.png",
      "image/png",
      TINY_PNG_B64,
    );

    const [output] = registerOutputsForCompletedRun(workItem, conversationId);
    expect(output.missionId).toBeNull();
    expect(output.projectId).toBeNull();
    expect(output.kind).toBe("image");
    // Assignee defaults to "cue" at creation, and capture carries it through.
    expect(output.agent).toBe("cue");
  });
});

describe("listings and review state", () => {
  test("mission rollup aggregates outputs across the mission's work items", () => {
    const mission = createMission({ title: "M", outcome: "O" });
    const task = createTask({ title: "T", template: "Do it" });
    const wi1 = createWorkItem({ taskId: task.id, title: "A" });
    const wi2 = createWorkItem({ taskId: task.id, title: "B" });

    createWorkOutput({
      workItemId: wi1.id,
      missionId: mission.id,
      kind: "deck",
      title: "Pitch deck v3",
    });
    createWorkOutput({
      workItemId: wi2.id,
      missionId: mission.id,
      kind: "spreadsheet",
      title: "Investor CRM",
    });
    createWorkOutput({
      workItemId: wi2.id,
      kind: "other",
      title: "Unrelated (no mission)",
    });

    const missionOutputs = listMissionOutputs(mission.id);
    expect(missionOutputs).toHaveLength(2);
    // Newest first.
    expect(missionOutputs[0].title).toBe("Investor CRM");
    expect(missionOutputs[1].title).toBe("Pitch deck v3");

    expect(listWorkItemOutputs(wi2.id)).toHaveLength(2);
    expect(listRecentOutputs()).toHaveLength(3);
    expect(listRecentOutputs({ limit: 1 })).toHaveLength(1);
  });

  test("setWorkOutputReviewState flips pending → approved", () => {
    const task = createTask({ title: "T", template: "Do it" });
    const wi = createWorkItem({ taskId: task.id, title: "A" });
    const output = createWorkOutput({
      workItemId: wi.id,
      kind: "document",
      title: "a16z reply — draft",
      externalUrl: "https://docs.example.com/draft",
    });
    expect(output.reviewState).toBe("pending");

    const approved = setWorkOutputReviewState(output.id, "approved");
    expect(approved?.reviewState).toBe("approved");
    expect(getWorkOutput(output.id)?.reviewState).toBe("approved");
  });

  test("enrichOutputsWithAttachments carries attachment render metadata", async () => {
    const task = createTask({ title: "T", template: "Do it" });
    const workItem = createWorkItem({ taskId: task.id, title: "Make image" });
    const { conversationId, assistantMessageId } = await seedRunConversation();
    const stored = attachInlineAttachmentToMessage(
      assistantMessageId,
      0,
      "hero.png",
      "image/png",
      TINY_PNG_B64,
    );
    registerOutputsForCompletedRun(workItem, conversationId);

    const [enriched] = enrichOutputsWithAttachments(
      listWorkItemOutputs(workItem.id),
    );
    expect(enriched.attachment).not.toBeNull();
    expect(enriched.attachment!.id).toBe(stored.id);
    expect(enriched.attachment!.mimeType).toBe("image/png");
    expect(enriched.attachment!.filename).toBe("hero.png");
    expect(enriched.attachment!.sizeBytes).toBeGreaterThan(0);
    expect(enriched.attachment!.hasThumbnail).toBe(false);

    // Link-backed outputs enrich to a null attachment.
    const linkOutput = createWorkOutput({
      workItemId: workItem.id,
      kind: "other",
      title: "Deployed site",
      externalUrl: "https://example.com",
    });
    const [enrichedLink] = enrichOutputsWithAttachments([linkOutput]);
    expect(enrichedLink.attachment).toBeNull();
  });
});
