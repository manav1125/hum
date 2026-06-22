/**
 * Tests for `readMemoryV2StaticContent` — the loader that powers the
 * `memory-v2-static` user-message auto-injection.
 *   - Returns null when `config.memory.v2.enabled` is off.
 *   - Reads the four files in canonical order and joins them under headings.
 *   - Skips empty / missing files.
 *   - Returns null when every file is empty or missing.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

const noopLogger: Record<string, unknown> = new Proxy(
  {} as Record<string, unknown>,
  {
    get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
  },
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../../../util/logger.js");
mock.module("../../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

let configMemoryV2Enabled = true;
let configMemoryEnabled = true;

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({}),
  loadConfig: () => ({
    memory: {
      enabled: configMemoryEnabled,
      v2: { enabled: configMemoryV2Enabled },
    },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

const { readMemoryV2StaticContent, shouldExposePersonalMemory } =
  await import("../static-context.js");

const MEMORY_FILES = [
  "essentials.md",
  "threads.md",
  "recent.md",
  "buffer.md",
] as const;

function writeMemoryFile(name: string, body: string): void {
  const memoryDir = join(TEST_DIR, "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, name), body);
}

function cleanupMemoryDir(): void {
  const memoryDir = join(TEST_DIR, "memory");
  if (existsSync(memoryDir))
    rmSync(memoryDir, { recursive: true, force: true });
}

describe("readMemoryV2StaticContent", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    configMemoryV2Enabled = true;
    configMemoryEnabled = true;
  });

  afterEach(() => {
    cleanupMemoryDir();
  });

  test("returns null when config.memory.v2.enabled is off", () => {
    configMemoryV2Enabled = false;
    for (const file of MEMORY_FILES) writeMemoryFile(file, `Content ${file}`);
    expect(readMemoryV2StaticContent()).toBeNull();
  });

  test("returns null when config.memory.enabled is off even with v2 on", () => {
    configMemoryEnabled = false;
    for (const file of MEMORY_FILES) writeMemoryFile(file, `Content ${file}`);
    expect(readMemoryV2StaticContent()).toBeNull();
  });

  test("returns headed sections in canonical order when all files have content", () => {
    writeMemoryFile("essentials.md", "Alice prefers dark mode.");
    writeMemoryFile("threads.md", "Open thread: ship PR-123 review.");
    writeMemoryFile(
      "recent.md",
      "Yesterday Alice asked about Postgres tuning.",
    );
    writeMemoryFile(
      "buffer.md",
      "Bob mentioned a pager rotation conflict on Friday.",
    );

    const result = readMemoryV2StaticContent();
    expect(result).not.toBeNull();
    const text = result!;

    expect(text).toContain("## Essentials");
    expect(text).toContain("## Threads");
    expect(text).toContain("## Recent");
    expect(text).toContain("## Buffer");
    expect(text).toContain("Alice prefers dark mode.");
    expect(text).toContain(
      "Bob mentioned a pager rotation conflict on Friday.",
    );

    expect(text.indexOf("## Essentials")).toBeLessThan(
      text.indexOf("## Threads"),
    );
    expect(text.indexOf("## Threads")).toBeLessThan(text.indexOf("## Recent"));
    expect(text.indexOf("## Recent")).toBeLessThan(text.indexOf("## Buffer"));
  });

  test("excludeBuffer drops the Buffer section but keeps the other three", () => {
    for (const file of MEMORY_FILES) writeMemoryFile(file, `Content ${file}`);

    const result = readMemoryV2StaticContent({ excludeBuffer: true });
    expect(result).not.toBeNull();
    expect(result!).toContain("## Essentials");
    expect(result!).toContain("## Threads");
    expect(result!).toContain("## Recent");
    expect(result!).not.toContain("## Buffer");
    expect(result!).not.toContain("Content buffer.md");
  });

  test("omits empty files but keeps populated ones", () => {
    writeMemoryFile("essentials.md", "Alice prefers VS Code.");
    writeMemoryFile("threads.md", "");
    writeMemoryFile("recent.md", "Recent topic: GraphQL pagination.");
    writeMemoryFile("buffer.md", "");

    const text = readMemoryV2StaticContent();
    expect(text).not.toBeNull();
    expect(text).toContain("## Essentials");
    expect(text).toContain("## Recent");
    expect(text).not.toContain("## Threads");
    expect(text).not.toContain("## Buffer");
  });

  test("returns null when every file is empty", () => {
    for (const file of MEMORY_FILES) writeMemoryFile(file, "");
    expect(readMemoryV2StaticContent()).toBeNull();
  });

  test("returns null when memory directory is missing entirely", () => {
    cleanupMemoryDir();
    expect(readMemoryV2StaticContent()).toBeNull();
  });

  describe("buffer origin framing", () => {
    const CURRENT = "conv-current";
    const OTHER = "conv-other";

    test("frames other-conversation entries under a background heading, keeps current primary", () => {
      writeMemoryFile(
        "buffer.md",
        [
          `- [Jun 22, 1:00 PM] Hong Kong cruise sails Friday <!--cid:${CURRENT}-->`,
          `- [Jun 20, 9:00 AM] Bali trip is in July <!--cid:${OTHER}-->`,
        ].join("\n"),
      );

      const text = readMemoryV2StaticContent({
        currentConversationId: CURRENT,
      })!;

      expect(text).toContain("## Buffer");
      expect(text).toContain(
        "From your other chats (background — may not be relevant here)",
      );
      // Current-conversation entry is primary (above the background heading).
      const headingIdx = text.indexOf("From your other chats");
      expect(text.indexOf("Hong Kong cruise")).toBeLessThan(headingIdx);
      // Other-conversation entry sits under the background heading.
      expect(text.indexOf("Bali trip is in July")).toBeGreaterThan(headingIdx);
      // Markers are stripped from rendered output.
      expect(text).not.toContain("cid:");
    });

    test("keeps untagged/legacy entries primary (never hidden as background)", () => {
      writeMemoryFile(
        "buffer.md",
        [
          "- [Jun 22, 1:00 PM] Legacy untagged fact",
          `- [Jun 20, 9:00 AM] Other chat fact <!--cid:${OTHER}-->`,
        ].join("\n"),
      );

      const text = readMemoryV2StaticContent({
        currentConversationId: CURRENT,
      })!;

      const headingIdx = text.indexOf("From your other chats");
      expect(text.indexOf("Legacy untagged fact")).toBeLessThan(headingIdx);
      expect(text.indexOf("Other chat fact")).toBeGreaterThan(headingIdx);
    });

    test("omits the background heading when no entry is from another chat", () => {
      writeMemoryFile(
        "buffer.md",
        `- [Jun 22, 1:00 PM] Only this chat <!--cid:${CURRENT}-->`,
      );

      const text = readMemoryV2StaticContent({
        currentConversationId: CURRENT,
      })!;

      expect(text).toContain("Only this chat");
      expect(text).not.toContain("From your other chats");
      expect(text).not.toContain("cid:");
    });

    test("renders verbatim (no partitioning) when currentConversationId is omitted", () => {
      writeMemoryFile(
        "buffer.md",
        [
          `- [Jun 22, 1:00 PM] Entry A <!--cid:${CURRENT}-->`,
          `- [Jun 20, 9:00 AM] Entry B <!--cid:${OTHER}-->`,
        ].join("\n"),
      );

      const text = readMemoryV2StaticContent()!;

      // No partitioning without a current conversation, but markers are still
      // stripped so the model never sees the write-time metadata.
      expect(text).toContain("Entry A");
      expect(text).toContain("Entry B");
      expect(text).not.toContain("From your other chats");
      expect(text).not.toContain("cid:");
    });
  });
});

describe("shouldExposePersonalMemory", () => {
  test("allows guardian-trusted local conversations", () => {
    expect(
      shouldExposePersonalMemory({
        sourceChannel: "vellum",
        isTrustedActor: true,
      }),
    ).toBe(true);
  });

  test("allows local-channel conversations even when trust class is unknown (analyze runs, dev)", () => {
    expect(
      shouldExposePersonalMemory({
        sourceChannel: "vellum",
        isTrustedActor: false,
      }),
    ).toBe(true);
  });

  test("allows turns with no trust context (work-item task runs, internal background)", () => {
    expect(
      shouldExposePersonalMemory({
        sourceChannel: undefined,
        isTrustedActor: false,
      }),
    ).toBe(true);
  });

  const REMOTE_CHANNELS = [
    "phone",
    "slack",
    "telegram",
    "whatsapp",
    "email",
  ] as const;

  test("allows guardian-trusted remote channels (user's own phone/Slack)", () => {
    for (const channel of REMOTE_CHANNELS) {
      expect(
        shouldExposePersonalMemory({
          sourceChannel: channel,
          isTrustedActor: true,
        }),
      ).toBe(true);
    }
  });

  test("blocks non-guardian remote-channel actors (the leak this gate exists to prevent)", () => {
    for (const channel of REMOTE_CHANNELS) {
      expect(
        shouldExposePersonalMemory({
          sourceChannel: channel,
          isTrustedActor: false,
        }),
      ).toBe(false);
    }
  });
});
