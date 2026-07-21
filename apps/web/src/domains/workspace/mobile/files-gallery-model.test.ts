import { describe, expect, test } from "bun:test";

import {
  fileContext,
  fileTypeChip,
  humanFileTitle,
  isImageFile,
  isTextPreviewable,
  selectNewestFiles,
  type WorkspaceFileEntry,
} from "@/domains/workspace/mobile/files-gallery-model";

function file(partial: Partial<WorkspaceFileEntry>): WorkspaceFileEntry {
  return {
    name: "file.txt",
    path: "file.txt",
    type: "file",
    size: 100,
    mimeType: "text/plain",
    modifiedAt: "2026-07-01T00:00:00Z",
    ...partial,
  };
}

describe("humanFileTitle", () => {
  test("demotes filenames to human titles", () => {
    expect(humanFileTitle("acme-one-pager-v2.pdf")).toBe("Acme one pager v2");
    expect(humanFileTitle("investor_update_june.md")).toBe(
      "Investor update june",
    );
    expect(humanFileTitle("Pricing model v3.xlsx")).toBe("Pricing model v3");
    // No extension, already human.
    expect(humanFileTitle("notes")).toBe("Notes");
  });
});

describe("fileTypeChip", () => {
  test("maps extensions to the spec chips", () => {
    expect(fileTypeChip("a.pdf", null)).toBe("PDF");
    expect(fileTypeChip("a.xlsx", null)).toBe("XLS");
    expect(fileTypeChip("deck.pptx", null)).toBe("DECK");
    expect(fileTypeChip("update.md", null)).toBe("MD");
    expect(fileTypeChip("hero.png", null)).toBe("PNG");
    expect(fileTypeChip("photo.jpeg", null)).toBe("JPG");
    expect(fileTypeChip("noext", "image/png")).toBe("IMG");
    expect(fileTypeChip("noext", null)).toBe("FILE");
    // Long unknown extensions clamp to 4 chars.
    expect(fileTypeChip("a.verylongext", null)).toBe("VERY");
  });
});

describe("isImageFile / isTextPreviewable", () => {
  test("image detection via mime or extension", () => {
    expect(isImageFile({ name: "a.png", mimeType: null })).toBe(true);
    expect(isImageFile({ name: "a", mimeType: "image/webp" })).toBe(true);
    expect(isImageFile({ name: "a.pdf", mimeType: "application/pdf" })).toBe(
      false,
    );
  });

  test("text preview allows small text-ish files only", () => {
    expect(
      isTextPreviewable({ name: "a.md", mimeType: null, size: 1000 }),
    ).toBe(true);
    expect(
      isTextPreviewable({
        name: "a.json",
        mimeType: "application/json",
        size: 1000,
      }),
    ).toBe(true);
    expect(
      isTextPreviewable({ name: "a.md", mimeType: null, size: 5_000_000 }),
    ).toBe(false);
    expect(
      isTextPreviewable({
        name: "a.bin",
        mimeType: "application/octet-stream",
        size: 10,
      }),
    ).toBe(false);
  });
});

describe("fileContext", () => {
  test("parent folder or null at root", () => {
    expect(fileContext("projects/acme/one-pager.pdf")).toBe("acme");
    expect(fileContext("notes.md")).toBe(null);
  });
});

describe("selectNewestFiles", () => {
  test("files only, dotfiles out, newest first, fenced at limit", () => {
    const entries: WorkspaceFileEntry[] = [
      file({ name: "old.md", path: "old.md", modifiedAt: "2026-01-01T00:00:00Z" }),
      file({ name: "dir", path: "dir", type: "directory" }),
      file({ name: ".hidden", path: ".hidden" }),
      file({ name: "new.md", path: "new.md", modifiedAt: "2026-07-19T00:00:00Z" }),
      file({ name: "mid.md", path: "mid.md", modifiedAt: "2026-03-01T00:00:00Z" }),
    ];
    const picked = selectNewestFiles(entries, 2);
    expect(picked.map((e) => e.name)).toEqual(["new.md", "mid.md"]);
  });

  test("runtime droppings (sockets, sqlite sidecars) are hidden", () => {
    const picked = selectNewestFiles([
      file({ name: "assistant.sock", path: "assistant.sock" }),
      file({ name: "gateway.sqlite-wal", path: "gateway.sqlite-wal" }),
      file({ name: "gateway.sqlite-shm", path: "gateway.sqlite-shm" }),
      file({ name: "memory.db", path: "memory.db" }),
      file({ name: "report.md", path: "report.md" }),
    ]);
    expect(picked.map((e) => e.name)).toEqual(["report.md"]);
  });

  test("unparseable dates sink to the bottom, order stable", () => {
    const picked = selectNewestFiles([
      file({ name: "a.md", path: "a.md", modifiedAt: "not-a-date" }),
      file({ name: "b.md", path: "b.md", modifiedAt: "2026-07-19T00:00:00Z" }),
      file({ name: "c.md", path: "c.md", modifiedAt: "also-bad" }),
    ]);
    expect(picked.map((e) => e.name)).toEqual(["b.md", "a.md", "c.md"]);
  });
});
