/**
 * Round-trip tests for the Notes API.
 *
 * The handlers are called directly (auth lives in the transport layer), but
 * they read and write the real database — the assertions are about rows.
 *
 * What is worth testing at this level rather than in the store: the two
 * zero-result responses a client has to tell apart, and the fact that no
 * route other than accept can put anything into HQ.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import {
  _setNoteExtractionOverridesForTests,
  type ExtractedItem,
} from "../../notes/note-extraction.js";
import { getNote } from "../../notes/note-store.js";
import { createTask } from "../../tasks/task-store.js";
import {
  createWorkItem,
  getWorkItem,
} from "../../work-items/work-item-store.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import { ROUTES } from "./notes-routes.js";

initializeDb();

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM note_extractions");
  db.run("DELETE FROM notes");
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
  _setNoteExtractionOverridesForTests({});
});

function route(operationId: string) {
  const found = ROUTES.find((r) => r.operationId === operationId);
  expect(found).toBeDefined();
  return found!;
}

async function call<T>(
  operationId: string,
  args: Parameters<(typeof ROUTES)[number]["handler"]>[0],
): Promise<T> {
  return (await route(operationId).handler(args)) as T;
}

const task = (title: string): ExtractedItem => ({
  kind: "task",
  confidenceTier: "confident",
  reason: null,
  payload: { title, detail: title, person: null, dueAt: null },
});

async function seedNote(body: string): Promise<string> {
  const created = await call<{ note: { id: string } }>("createNote", {
    body: { body },
  });
  return created.note.id;
}

describe("createNote", () => {
  test("saves without reading, proposing or filing", async () => {
    const created = await call<{ note: Record<string, unknown> }>(
      "createNote",
      { body: { body: "Don't lead with price." } },
    );
    expect(created.note.extractionState).toBe("idle");
    expect(created.note.projectId).toBeNull();
  });

  test("a body is required", async () => {
    await expect(call("createNote", { body: {} })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});

describe("listNotes", () => {
  test("carries the counts the header line prints", async () => {
    await seedNote("a note");
    const listed = await call<{
      notes: unknown[];
      counts: { notes: number; tasks: number; waiting: number };
    }>("listNotes", {});
    expect(listed.notes).toHaveLength(1);
    expect(listed.counts).toMatchObject({ notes: 1, tasks: 0, waiting: 0 });
  });

  test("an unknown filter is refused rather than silently ignored", async () => {
    await expect(
      call("listNotes", { queryParams: { filter: "everything" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("readNote", () => {
  test("'nothing to file' is done-with-nothing, NOT a failure", async () => {
    _setNoteExtractionOverridesForTests({ extractor: async () => [] });
    const id = await seedNote("Been thinking about how the team feels.");

    const result = await call<{
      status: string;
      extractions: unknown[];
    }>("readNote", { pathParams: { id }, body: {} });

    expect(result.status).toBe("done");
    expect(result.extractions).toEqual([]);
  });

  test("'couldn't read it' is a distinct status, and the note survives", async () => {
    _setNoteExtractionOverridesForTests({ extractor: async () => null });
    const id = await seedNote("decide the vendor by Friday");

    const result = await call<{ status: string }>("readNote", {
      pathParams: { id },
      body: {},
    });

    expect(result.status).toBe("failed");
    expect(getNote(id)?.body).toBe("decide the vendor by Friday");
  });

  test("reading proposes and files nothing", async () => {
    _setNoteExtractionOverridesForTests({
      extractor: async () => [task("Send the SOC 2 report")],
    });
    const id = await seedNote("decide the vendor by Friday");

    const result = await call<{
      extractions: { state: string }[];
    }>("readNote", { pathParams: { id }, body: {} });

    expect(result.extractions).toHaveLength(1);
    expect(result.extractions[0]?.state).toBe("proposed");
    expect(getDb().all("SELECT id FROM work_items") as unknown[]).toHaveLength(
      0,
    );
  });

  test("a second read of unchanged text is skipped, and says why", async () => {
    _setNoteExtractionOverridesForTests({
      extractor: async () => [task("Send it")],
    });
    const id = await seedNote("decide the vendor by Friday");
    await call("readNote", { pathParams: { id }, body: {} });

    const again = await call<{ status: string; skippedReason: string }>(
      "readNote",
      { pathParams: { id }, body: {} },
    );
    expect(again.status).toBe("skipped");
    expect(again.skippedReason).toBe("unchanged");
  });
});

describe("accept and dismiss", () => {
  test("accept is what puts work in HQ, and it remembers the note", async () => {
    _setNoteExtractionOverridesForTests({
      extractor: async () => [task("Send the SOC 2 report")],
    });
    const id = await seedNote("decide the vendor by Friday");
    const read = await call<{ extractions: { id: string }[] }>("readNote", {
      pathParams: { id },
      body: {},
    });
    const extractionId = read.extractions[0]!.id;

    const accepted = await call<{ status: string; refId: string }>(
      "acceptNoteExtraction",
      { pathParams: { id, extractionId }, body: {} },
    );

    expect(accepted.status).toBe("accepted");
    expect(getWorkItem(accepted.refId)?.noteId).toBe(id);
  });

  test("dismiss writes nothing", async () => {
    _setNoteExtractionOverridesForTests({
      extractor: async () => [task("Send the report")],
    });
    const id = await seedNote("decide the vendor by Friday");
    const read = await call<{ extractions: { id: string }[] }>("readNote", {
      pathParams: { id },
      body: {},
    });

    const dismissed = await call<{ status: string }>("dismissNoteExtraction", {
      pathParams: { id, extractionId: read.extractions[0]!.id },
    });

    expect(dismissed.status).toBe("dismissed");
    expect(getDb().all("SELECT id FROM work_items") as unknown[]).toHaveLength(
      0,
    );
  });

  test("an unknown proposal is a 404, not a silent no-op", async () => {
    const id = await seedNote("a note");
    await expect(
      call("acceptNoteExtraction", {
        pathParams: { id, extractionId: "nope" },
        body: {},
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("deleteNote", () => {
  test("never deletes the work accepted out of it", async () => {
    const id = await seedNote("send the report");
    const created = createTask({ title: "Send the report", template: "…" });
    const item = createWorkItem({
      taskId: created.id,
      title: "Send the report",
      noteId: id,
    });

    await call("deleteNote", { pathParams: { id } });

    expect(getNote(id)).toBeNull();
    expect(getWorkItem(item.id)).toBeDefined();
  });
});

describe("waiting and accept rates", () => {
  test("waiting lists undecided proposals across every note", async () => {
    _setNoteExtractionOverridesForTests({
      extractor: async () => [task("Send it")],
    });
    const first = await seedNote("decide the vendor by Friday");
    const second = await seedNote("don't forget the redlines");
    await call("readNote", { pathParams: { id: first }, body: {} });
    await call("readNote", { pathParams: { id: second }, body: {} });

    const waiting = await call<{ extractions: unknown[] }>(
      "listWaitingExtractions",
      {},
    );
    expect(waiting.extractions).toHaveLength(2);
  });

  test("accept rate is reported per kind and tier from day one", async () => {
    _setNoteExtractionOverridesForTests({
      extractor: async () => [task("Send it")],
    });
    const id = await seedNote("decide the vendor by Friday");
    const read = await call<{ extractions: { id: string }[] }>("readNote", {
      pathParams: { id },
      body: {},
    });
    await call("acceptNoteExtraction", {
      pathParams: { id, extractionId: read.extractions[0]!.id },
      body: {},
    });

    const rates = await call<{
      rates: { kind: string; confidenceTier: string; accepted: number }[];
    }>("getNoteAcceptRates", {});
    expect(rates.rates).toEqual([
      expect.objectContaining({
        kind: "task",
        confidenceTier: "confident",
        accepted: 1,
      }),
    ]);
  });
});
