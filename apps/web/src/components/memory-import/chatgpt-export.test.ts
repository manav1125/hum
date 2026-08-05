/**
 * The client-side ChatGPT export parser behind the memory-import flow
 * (v37 §2). What is pinned down:
 *
 * - the conversation walk follows `current_node` → root (the active branch,
 *   not every dead edit), keeps only user/assistant text, and preserves the
 *   export's own timestamps — mirroring the server-side skill parser;
 * - non-conversation material is found by key heuristics, secret-redacted
 *   and deduped BEFORE anything could be written;
 * - authored concept pages carry the provenance contract the memory-v2
 *   ingest defines: `source: import:chatgpt` + an `origin_date` from the
 *   material's own timeline — the fields the "imported from ChatGPT" badge
 *   would read.
 */

import { describe, expect, test } from "bun:test";

import {
  buildConceptPages,
  collectMemoryItems,
  parseChatGptExport,
  parseConversation,
  redactSecrets,
  type ImportMemoryItem,
} from "./chatgpt-export";

// ---------------------------------------------------------------------------
// A minimal ZIP builder (stored entries — method 0, which the reader accepts)
// ---------------------------------------------------------------------------

function buildZip(entries: Array<{ name: string; text: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) =>
    new Uint8Array([
      v & 0xff,
      (v >> 8) & 0xff,
      (v >> 16) & 0xff,
      (v >> 24) & 0xff,
    ]);
  const cat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const local = cat(
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: stored
      u16(0),
      u16(0), // mod time/date
      u32(0), // crc (unchecked by the reader)
      u32(data.length), // compressed size
      u32(data.length), // uncompressed size
      u16(name.length),
      u16(0), // extra length
      name,
      data,
    );
    central.push(
      cat(
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0), // method: stored
        u16(0),
        u16(0),
        u32(0),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset),
        name,
      ),
    );
    chunks.push(local);
    offset += local.length;
  }

  const centralBytes = cat(...central);
  const eocd = cat(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBytes.length),
    u32(offset),
    u16(0),
  );
  return cat(...chunks, centralBytes, eocd);
}

function asFile(name: string, bytes: Uint8Array) {
  return {
    name,
    arrayBuffer: async () =>
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000; // epoch seconds, late 2023

/** A conversation with a dead edit branch — only the active path imports. */
const CONVERSATION = {
  id: "conv-1",
  title: "Trip planning",
  create_time: T0,
  update_time: T0 + 100,
  current_node: "n3",
  mapping: {
    root: { message: null, parent: null, children: ["n1"] },
    n1: {
      message: {
        author: { role: "user" },
        content: { content_type: "text", parts: ["Plan my trip"] },
        create_time: T0,
      },
      parent: "root",
      children: ["n2", "dead"],
    },
    dead: {
      message: {
        author: { role: "assistant" },
        content: { content_type: "text", parts: ["An abandoned edit"] },
        create_time: T0 + 5,
      },
      parent: "n1",
      children: [],
    },
    n2: {
      message: {
        author: { role: "tool" },
        content: { content_type: "text", parts: ["tool noise"] },
        create_time: T0 + 8,
      },
      parent: "n1",
      children: ["n3"],
    },
    n3: {
      message: {
        author: { role: "assistant" },
        content: { content_type: "text", parts: ["Here's an itinerary."] },
        create_time: T0 + 10,
      },
      parent: "n2",
      children: [],
    },
  },
};

describe("the conversation walk", () => {
  test("follows the active branch, keeps user/assistant text, preserves timestamps", () => {
    const parsed = parseConversation(CONVERSATION);
    expect(parsed).not.toBeNull();
    expect(parsed?.sourceKey).toBe("chatgpt:conv-1");
    expect(parsed?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // The dead edit and the tool message never import.
    expect(JSON.stringify(parsed)).not.toContain("abandoned");
    expect(JSON.stringify(parsed)).not.toContain("tool noise");
    expect(parsed?.messages[0]?.createdAt).toBe(T0 * 1000);
    expect(parsed?.createdAt).toBe(T0 * 1000);
  });

  test("a conversation with no importable messages is dropped, not invented", () => {
    expect(
      parseConversation({
        id: "empty",
        title: "Empty",
        create_time: T0,
        update_time: T0,
        current_node: "x",
        mapping: { x: { message: null, parent: null } },
      }),
    ).toBeNull();
  });
});

describe("memory material heuristics", () => {
  test("finds items under memory-shaped keys, with origin dates", () => {
    const items = collectMemoryItems(
      {
        account: { plan: "plus" },
        saved_memories: [
          { content: "Prefers window seats", created_at: "2024-05-01" },
          "Allergic to shellfish",
        ],
        custom_instructions: {
          about_user_message: "I run a robotics company.",
        },
      },
      "user.json",
    );
    const texts = items.map((i) => i.text);
    expect(texts).toContain("Prefers window seats");
    expect(texts).toContain("Allergic to shellfish");
    expect(texts).toContain("I run a robotics company.");
    expect(
      items.find((i) => i.text === "Prefers window seats")?.originDate,
    ).toBe("2024-05-01");
  });

  test("secret-shaped values are redacted", () => {
    const { text, redactions } = redactSecrets(
      "My key is sk-ant-abc123def456ghi789 and password: hunter2secret",
    );
    expect(text).not.toContain("sk-ant-abc123def456ghi789");
    expect(text).not.toContain("hunter2secret");
    expect(redactions).toBe(2);
  });
});

describe("the parse entry point", () => {
  test("reads a ZIP: conversations + memory material, redacted and deduped, with live counts", async () => {
    const zip = buildZip([
      { name: "conversations.json", text: JSON.stringify([CONVERSATION]) },
      {
        name: "user.json",
        text: JSON.stringify({
          memories: [
            { content: "Prefers window seats", created_at: "2024-05-01" },
            { content: "Prefers window seats" }, // duplicate — deduped
            { content: "API key sk-ant-abc123def456ghi789 works" },
          ],
        }),
      },
      { name: "chat.html", text: "<html>media-ish, skipped</html>" },
    ]);
    const progress: number[] = [];
    const parsed = await parseChatGptExport(asFile("export.zip", zip), (p) =>
      progress.push(p.conversationsFound),
    );
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.memoryItems.map((i) => i.text)).toContain(
      "Prefers window seats",
    );
    expect(parsed.memoryItems).toHaveLength(2); // deduped
    expect(JSON.stringify(parsed.memoryItems)).not.toContain(
      "sk-ant-abc123def456ghi789",
    );
    expect(parsed.redactions).toBe(1);
    expect(progress.length).toBeGreaterThan(0);
  });

  test("accepts a bare conversations.json too", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify([CONVERSATION]));
    const parsed = await parseChatGptExport(
      asFile("conversations.json", bytes),
    );
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.memoryItems).toHaveLength(0);
  });

  test("a non-export file fails loudly, not silently", async () => {
    const bytes = new TextEncoder().encode("not json at all");
    await expect(
      parseChatGptExport(asFile("conversations.json", bytes)),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("authored concept pages carry the provenance contract", () => {
  const items: ImportMemoryItem[] = [
    {
      text: "Prefers window seats",
      originDate: "2024-05-01",
      context: "user.json:memories",
    },
    { text: "Runs a robotics company", context: "user.json:about" },
  ];

  test("source + origin_date frontmatter, item counts intact", () => {
    const pages = buildConceptPages(items, new Date("2026-08-05T00:00:00Z"));
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page?.slug).toBe("imported/chatgpt-memories");
    expect(page?.itemCount).toBe(2);
    expect(page?.content).toContain("source: import:chatgpt");
    // The newest date the material carries — origin-aware recency's input.
    expect(page?.content).toContain("origin_date: 2024-05-01");
    expect(page?.content).toContain("- Prefers window seats (2024-05-01)");
    expect(page?.content).toContain("- Runs a robotics company");
  });

  test("the map stays small: chunked pages, numbered slugs", () => {
    const many = Array.from({ length: 170 }, (_, i) => ({
      text: `Memory ${i}`,
      context: "user.json:memories",
    }));
    const pages = buildConceptPages(many, new Date());
    expect(pages.map((p) => p.slug)).toEqual([
      "imported/chatgpt-memories",
      "imported/chatgpt-memories-2",
      "imported/chatgpt-memories-3",
    ]);
    expect(pages.reduce((n, p) => n + p.itemCount, 0)).toBe(170);
  });

  test("no material, no pages", () => {
    expect(buildConceptPages([], new Date())).toHaveLength(0);
  });
});
