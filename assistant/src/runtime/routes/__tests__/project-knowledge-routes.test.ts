/**
 * Tests for the project-knowledge route handlers in
 * `project-knowledge-routes.ts`.
 *
 * Covers:
 *   - POST file (attachmentId) + POST link (url) round-trips with GET
 *   - POST validation: exactly one of attachmentId/url, valid http(s) URL,
 *     existing attachment, existing project
 *   - DELETE removes the entry; unknown ids → 404
 *   - `tasks_changed` SSE publication on mutations
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Capture publish() invocations so the tests can assert on emitted events
// without spinning up real SSE infrastructure.
const publishCalls: unknown[] = [];

mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async (event: unknown) => {
      publishCalls.push(event);
    },
    subscribe: () => () => {},
  },
  broadcastMessage: async () => {},
}));

import { uploadAttachment } from "../../../memory/attachments-store.js";
import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { createProject } from "../../../work-items/project-store.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { ROUTES as KNOWLEDGE_ROUTES } from "../project-knowledge-routes.js";
import type { RouteDefinition } from "../types.js";

initializeDb();

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = KNOWLEDGE_ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

const listHandler = findHandler("listProjectKnowledge");
const addHandler = findHandler("addProjectKnowledge");
const deleteHandler = findHandler("deleteProjectKnowledge");

function uploadTestFile(filename = "spec.md"): string {
  return uploadAttachment(
    filename,
    "text/markdown",
    Buffer.from("# spec\n").toString("base64"),
  ).id;
}

/** Events flow through buildAssistantEvent, which wraps them in an envelope. */
function publishedTypes(): string[] {
  return publishCalls.map(
    (e) => (e as { message: { type: string } }).message.type,
  );
}

interface KnowledgeItem {
  id: string;
  kind: string;
  attachmentId: string | null;
  url: string | null;
  label: string | null;
  filename: string | null;
}

let projectId = "";
beforeEach(() => {
  publishCalls.length = 0;
  getDb().run("DELETE FROM project_knowledge");
  getDb().run("DELETE FROM message_attachments");
  getDb().run("DELETE FROM attachments");
  getDb().run("DELETE FROM projects");
  projectId = createProject({ title: "Launch" }).id;
});

describe("POST projects/:id/knowledge", () => {
  test("links an uploaded attachment as file knowledge", async () => {
    const attachmentId = uploadTestFile();
    const result = (await addHandler({
      pathParams: { id: projectId },
      body: { attachmentId },
    })) as { item: KnowledgeItem };

    expect(result.item.kind).toBe("file");
    expect(result.item.attachmentId).toBe(attachmentId);
    expect(result.item.filename).toBe("spec.md");

    const listed = (await listHandler({
      pathParams: { id: projectId },
    })) as { items: KnowledgeItem[] };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].id).toBe(result.item.id);
  });

  test("adds a link with an optional label", async () => {
    const result = (await addHandler({
      pathParams: { id: projectId },
      body: { url: "https://example.com/roadmap", label: "Roadmap" },
    })) as { item: KnowledgeItem };
    expect(result.item.kind).toBe("link");
    expect(result.item.url).toBe("https://example.com/roadmap");
    expect(result.item.label).toBe("Roadmap");
  });

  test("rejects neither / both of attachmentId and url", () => {
    expect(() =>
      addHandler({ pathParams: { id: projectId }, body: {} }),
    ).toThrow(BadRequestError);
    expect(() =>
      addHandler({
        pathParams: { id: projectId },
        body: { attachmentId: uploadTestFile(), url: "https://example.com" },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects non-http(s) URLs", () => {
    expect(() =>
      addHandler({
        pathParams: { id: projectId },
        body: { url: "not a url" },
      }),
    ).toThrow(BadRequestError);
    expect(() =>
      addHandler({
        pathParams: { id: projectId },
        body: { url: "file:///etc/passwd" },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects unknown attachments and unknown projects", () => {
    expect(() =>
      addHandler({
        pathParams: { id: projectId },
        body: { attachmentId: "missing" },
      }),
    ).toThrow(BadRequestError);
    expect(() =>
      addHandler({
        pathParams: { id: "no-such-project" },
        body: { url: "https://example.com" },
      }),
    ).toThrow(NotFoundError);
  });

  test("publishes tasks_changed", async () => {
    await addHandler({
      pathParams: { id: projectId },
      body: { url: "https://example.com" },
    });
    expect(publishedTypes()).toContain("tasks_changed");
  });
});

describe("GET projects/:id/knowledge", () => {
  test("404s for an unknown project", () => {
    expect(() =>
      listHandler({ pathParams: { id: "no-such-project" } }),
    ).toThrow(NotFoundError);
  });

  test("returns files and links oldest-first", async () => {
    const file = (await addHandler({
      pathParams: { id: projectId },
      body: { attachmentId: uploadTestFile() },
    })) as { item: KnowledgeItem };
    const link = (await addHandler({
      pathParams: { id: projectId },
      body: { url: "https://example.com" },
    })) as { item: KnowledgeItem };

    const listed = (await listHandler({
      pathParams: { id: projectId },
    })) as { items: KnowledgeItem[] };
    expect(listed.items.map((i) => i.id)).toEqual([file.item.id, link.item.id]);
  });
});

describe("DELETE projects/:id/knowledge/:knowledgeId", () => {
  test("removes the entry", async () => {
    const added = (await addHandler({
      pathParams: { id: projectId },
      body: { url: "https://example.com" },
    })) as { item: KnowledgeItem };
    publishCalls.length = 0;

    const result = (await deleteHandler({
      pathParams: { id: projectId, knowledgeId: added.item.id },
    })) as { id: string; success: boolean };
    expect(result.success).toBe(true);

    const listed = (await listHandler({
      pathParams: { id: projectId },
    })) as { items: KnowledgeItem[] };
    expect(listed.items).toHaveLength(0);
    expect(publishedTypes()).toContain("tasks_changed");
  });

  test("404s for unknown entries", () => {
    expect(() =>
      deleteHandler({
        pathParams: { id: projectId, knowledgeId: "missing" },
      }),
    ).toThrow(NotFoundError);
  });
});
