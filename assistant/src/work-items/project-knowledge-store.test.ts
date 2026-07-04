/**
 * Tests for the project-knowledge store: link-table CRUD plus the run-time
 * materialization contract — files attached to a project must end up on disk
 * INSIDE the agent's sandbox boundary (the workspace dir) so the agent's
 * file tools can genuinely read them during a work-item run.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  getAttachmentById,
  uploadAttachment,
} from "../memory/attachments-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { getWorkspaceDir } from "../util/platform.js";
import {
  addProjectFileKnowledge,
  addProjectLinkKnowledge,
  ensureProjectKnowledgeFiles,
  listProjectKnowledge,
  removeProjectKnowledge,
} from "./project-knowledge-store.js";
import { createProject, deleteProject } from "./project-store.js";

initializeDb();

const FILE_CONTENT = "brand voice: confident, playful\n";

function uploadTestFile(filename = "brand-guide.md"): string {
  return uploadAttachment(
    filename,
    "text/markdown",
    Buffer.from(FILE_CONTENT).toString("base64"),
  ).id;
}

let projectId = "";
beforeEach(() => {
  getDb().run("DELETE FROM project_knowledge");
  getDb().run("DELETE FROM message_attachments");
  getDb().run("DELETE FROM attachments");
  getDb().run("DELETE FROM projects");
  projectId = createProject({ title: "Q4 launch" }).id;
});

describe("project knowledge CRUD", () => {
  test("attaches a file and lists it with attachment metadata", () => {
    const attachmentId = uploadTestFile();
    const item = addProjectFileKnowledge({ projectId, attachmentId });

    expect(item.kind).toBe("file");
    expect(item.label).toBe("brand-guide.md");

    const listed = listProjectKnowledge(projectId);
    expect(listed).toHaveLength(1);
    expect(listed[0].attachmentId).toBe(attachmentId);
    expect(listed[0].filename).toBe("brand-guide.md");
    expect(listed[0].mimeType).toBe("text/markdown");
    expect(listed[0].sizeBytes).toBe(FILE_CONTENT.length);
  });

  test("attaching a missing attachment throws", () => {
    expect(() =>
      addProjectFileKnowledge({ projectId, attachmentId: "nope" }),
    ).toThrow("Attachment not found");
  });

  test("attaches a link with a default label of the URL", () => {
    const item = addProjectLinkKnowledge({
      projectId,
      url: "https://example.com/roadmap",
    });
    expect(item.kind).toBe("link");
    expect(item.label).toBe("https://example.com/roadmap");
    expect(listProjectKnowledge(projectId)).toHaveLength(1);
  });

  test("custom labels win over defaults", () => {
    const item = addProjectLinkKnowledge({
      projectId,
      url: "https://example.com",
      label: "Roadmap",
    });
    expect(item.label).toBe("Roadmap");
  });

  test("remove deletes the row, the materialized file, and the attachment", () => {
    const attachmentId = uploadTestFile();
    const item = addProjectFileKnowledge({ projectId, attachmentId });
    const [entry] = ensureProjectKnowledgeFiles(projectId);
    expect(entry.absPath).toBeTruthy();
    expect(existsSync(entry.absPath!)).toBe(true);

    expect(removeProjectKnowledge(projectId, item.id)).toBe("deleted");
    expect(listProjectKnowledge(projectId)).toHaveLength(0);
    expect(existsSync(entry.absPath!)).toBe(false);
    expect(getAttachmentById(attachmentId)).toBeNull();
  });

  test("remove returns not_found for unknown ids and other projects' rows", () => {
    expect(removeProjectKnowledge(projectId, "missing")).toBe("not_found");
    const other = createProject({ title: "Other" }).id;
    const item = addProjectLinkKnowledge({
      projectId: other,
      url: "https://example.com",
    });
    expect(removeProjectKnowledge(projectId, item.id)).toBe("not_found");
  });

  test("deleting the project removes its knowledge rows", () => {
    addProjectLinkKnowledge({ projectId, url: "https://example.com" });
    addProjectFileKnowledge({ projectId, attachmentId: uploadTestFile() });
    deleteProject(projectId);
    expect(listProjectKnowledge(projectId)).toHaveLength(0);
  });
});

describe("run-time materialization", () => {
  test("materialized files land inside the sandbox boundary with readable content", () => {
    addProjectFileKnowledge({ projectId, attachmentId: uploadTestFile() });
    const [entry] = ensureProjectKnowledgeFiles(projectId);

    expect(entry.absPath).toBeTruthy();
    // The agent's file tools are bounded to the workspace dir — the path must
    // resolve inside it or file_read would reject it mid-run.
    expect(entry.absPath!.startsWith(getWorkspaceDir())).toBe(true);
    expect(readFileSync(entry.absPath!, "utf8")).toBe(FILE_CONTENT);
  });

  test("ensure is idempotent and re-materializes a deleted file", () => {
    addProjectFileKnowledge({ projectId, attachmentId: uploadTestFile() });
    const [first] = ensureProjectKnowledgeFiles(projectId);
    const [second] = ensureProjectKnowledgeFiles(projectId);
    expect(second.absPath).toBe(first.absPath);

    unlinkSync(first.absPath!);
    const [third] = ensureProjectKnowledgeFiles(projectId);
    expect(third.absPath).toBe(first.absPath);
    expect(readFileSync(third.absPath!, "utf8")).toBe(FILE_CONTENT);
  });

  test("two files with the same name get distinct paths", () => {
    addProjectFileKnowledge({
      projectId,
      attachmentId: uploadTestFile("notes.md"),
    });
    addProjectFileKnowledge({
      projectId,
      attachmentId: uploadTestFile("notes.md"),
    });
    const entries = ensureProjectKnowledgeFiles(projectId);
    expect(entries).toHaveLength(2);
    expect(entries[0].absPath).not.toBe(entries[1].absPath);
    expect(existsSync(entries[0].absPath!)).toBe(true);
    expect(existsSync(entries[1].absPath!)).toBe(true);
  });

  test("links come back with URLs and no path", () => {
    addProjectLinkKnowledge({
      projectId,
      url: "https://example.com/spec",
      label: "Spec",
    });
    const [entry] = ensureProjectKnowledgeFiles(projectId);
    expect(entry.kind).toBe("link");
    expect(entry.url).toBe("https://example.com/spec");
    expect(entry.absPath).toBeNull();
  });
});
