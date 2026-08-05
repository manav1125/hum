/**
 * Client-side parsing for the memory import flow (v37 §2 / W4).
 *
 * "Nothing leaves your machine during import": the ChatGPT export ZIP is
 * read entirely in the browser — nothing is uploaded anywhere except the
 * user's own daemon, through the two routes that already exist for this
 * material:
 *
 *   - conversations  → `POST …/conversations/import` (stamps
 *     `source=import:chatgpt` server-side via the sourceKey convention);
 *   - saved memories / custom instructions → `POST …/memory/ingest`, as a
 *     small number of concept pages carrying the provenance frontmatter the
 *     memory-v2 ingest contract defines (`source: import:chatgpt` +
 *     `origin_date`).
 *
 * The conversation walk is a browser port of the server-side skill parser
 * (`skills/chatgpt-import/scripts/parse-export.ts`); the non-conversation
 * heuristics are a deliberately thin port of
 * `skills/memory-corpus-ingest/scripts/parse-chatgpt-memory.ts` (name/key
 * heuristics + secret redaction). Both are deterministic — no LLM work
 * happens in this flow.
 */

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** One conversation in the daemon's `conversations/import` body shape. */
export interface ImportConversation {
  sourceKey: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{
    role: string;
    content: Array<{ type: string; text: string }>;
    createdAt: number;
  }>;
}

/** One memory-material candidate found outside the conversation history. */
export interface ImportMemoryItem {
  /** The candidate text, secret-redacted. */
  text: string;
  /** ISO date the item originally dates from, when the export carried one. */
  originDate?: string;
  /** Where in the export it came from (entry name + key path). */
  context: string;
}

/** Live counts surfaced while the export is being read (step 2's ticker). */
export interface ParseProgress {
  conversationsFound: number;
  messagesFound: number;
  memoryItemsFound: number;
  /** The year of the conversation currently being walked ("working through 2024…"). */
  workingThroughYear: number | null;
}

export interface ParsedChatGptExport {
  conversations: ImportConversation[];
  memoryItems: ImportMemoryItem[];
  /** Count of secret-shaped values replaced inside memory material. */
  redactions: number;
}

// ---------------------------------------------------------------------------
// ZIP reading (browser-side; stored + deflate entries)
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End-of-central-directory signature 0x06054b50, scanned from the tail.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error("Not a ZIP file (no end-of-central-directory record).");
  }
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Corrupt ZIP central directory.");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) {
    throw new Error(`Corrupt ZIP local header for ${entry.name}.`);
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const localCompressedSize = view.getUint32(offset + 18, true);
  const compressedSize =
    entry.compressedSize > 0 ? entry.compressedSize : localCompressedSize;
  const dataOffset = offset + 30 + nameLength + extraLength;
  const data = bytes.subarray(dataOffset, dataOffset + compressedSize);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method === 8) {
    return new TextDecoder().decode(await inflateRaw(data));
  }
  throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
}

// ---------------------------------------------------------------------------
// Conversation walk (port of chatgpt-import/scripts/parse-export.ts)
// ---------------------------------------------------------------------------

interface ChatGptContent {
  content_type?: string;
  parts?: unknown[];
}

interface ChatGptNode {
  message: {
    author?: { role?: string };
    content?: ChatGptContent;
    create_time?: number | null;
  } | null;
  parent: string | null;
}

interface ChatGptConversation {
  id?: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  current_node?: string;
  mapping?: Record<string, ChatGptNode>;
}

function extractText(content: ChatGptContent | undefined): string {
  if (!content?.parts) return "";
  return content.parts
    .filter((p): p is string => typeof p === "string")
    .join("");
}

export function parseConversation(
  conv: ChatGptConversation,
): ImportConversation | null {
  const mapping = conv.mapping;
  const currentNode = conv.current_node;
  if (!mapping || !currentNode || !mapping[currentNode]) return null;

  // Walk current_node → root via parent pointers, then reverse.
  const nodeIds: string[] = [];
  let nodeId: string | null = currentNode;
  while (nodeId) {
    nodeIds.push(nodeId);
    nodeId = mapping[nodeId]?.parent ?? null;
  }
  nodeIds.reverse();

  const createTime = conv.create_time ?? 0;
  const messages: ImportConversation["messages"] = [];
  for (const id of nodeIds) {
    const node = mapping[id];
    if (!node?.message) continue;
    const role = node.message.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(node.message.content);
    if (!text) continue;
    messages.push({
      role,
      content: [{ type: "text", text }],
      createdAt: Math.round((node.message.create_time ?? createTime) * 1000),
    });
  }
  if (messages.length === 0) return null;

  const sourceId = conv.id ?? `${conv.title ?? "untitled"}-${createTime}`;
  return {
    sourceKey: `chatgpt:${sourceId}`,
    title: conv.title || "Untitled",
    createdAt: Math.round(createTime * 1000),
    updatedAt: Math.round((conv.update_time ?? createTime) * 1000),
    messages,
  };
}

// ---------------------------------------------------------------------------
// Non-conversation memory material (thin port of parse-chatgpt-memory.ts)
// ---------------------------------------------------------------------------

/** JSON keys whose values look like memories or custom instructions. */
const MEMORY_KEY =
  /memor(y|ies)|instruction|about_user|about_model|know_about|should_know|how.*respond|persona/i;

/** Object fields that carry the text of a memory-shaped record. */
const TEXT_FIELDS = ["content", "memory", "text", "value", "summary", "title"];

/** Object fields that may carry the record's original timestamp. */
const DATE_FIELDS = [
  "created_at",
  "create_time",
  "updated_at",
  "update_time",
  "timestamp",
  "date",
];

const MEDIA_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|svg|mp3|wav|m4a|mp4|webm|pdf|dat|html|css|js)$/i;

const MAX_WALK_DEPTH = 12;

/**
 * Light secret redaction over memory material, mirroring the shapes the
 * server-side parsers scrub. Conversations are NOT redacted (they import
 * verbatim, exactly as the server-side conversation import does); only the
 * material headed for concept pages is.
 */
export function redactSecrets(text: string): {
  text: string;
  redactions: number;
} {
  let redactions = 0;
  let out = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    () => {
      redactions++;
      return "[redacted:private-key]";
    },
  );
  const shapes: Array<[string, RegExp]> = [
    ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g],
    ["api-key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
    ["aws-key", /\bAKIA[0-9A-Z]{16}\b/g],
    ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
    ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g],
    [
      "credential-assignment",
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\b(\s*[=:]\s*)(["']?)[^\s"']{6,}/gi,
    ],
  ];
  for (const [kind, regex] of shapes) {
    out = out.replace(regex, (...match) => {
      redactions++;
      if (kind === "credential-assignment") {
        const [, key, sep, quote] = match as string[];
        return `${key}${sep}${quote}[redacted:${kind}]`;
      }
      return `[redacted:${kind}]`;
    });
  }
  return { text: out, redactions };
}

function toIsoDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Heuristic: epoch seconds vs milliseconds.
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime())
      ? undefined
      : date.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? undefined
      : date.toISOString().slice(0, 10);
  }
  return undefined;
}

function itemFromRecord(
  record: Record<string, unknown>,
  context: string,
): ImportMemoryItem | null {
  for (const field of TEXT_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) {
      const item: ImportMemoryItem = { text: value.trim(), context };
      for (const dateField of DATE_FIELDS) {
        const originDate = toIsoDate(record[dateField]);
        if (originDate) {
          item.originDate = originDate;
          break;
        }
      }
      return item;
    }
  }
  return null;
}

function itemsFromMatchedValue(
  value: unknown,
  context: string,
  depth = 0,
): ImportMemoryItem[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [{ text: value.trim(), context }];
  }
  if (Array.isArray(value)) {
    const items: ImportMemoryItem[] = [];
    for (const element of value) {
      if (typeof element === "string" && element.trim().length > 0) {
        items.push({ text: element.trim(), context });
      } else if (element && typeof element === "object") {
        const item = itemFromRecord(
          element as Record<string, unknown>,
          context,
        );
        if (item) items.push(item);
      }
    }
    return items;
  }
  if (value && typeof value === "object") {
    const item = itemFromRecord(value as Record<string, unknown>, context);
    if (item) return [item];
    // A matched object with no recognized text field (e.g.
    // `custom_instructions: { about_user_message: … }`) is walked again so
    // nested memory-shaped keys are still found.
    return collectMemoryItems(value, context, depth + 1);
  }
  return [];
}

/** Walk a parsed JSON value collecting values under memory-shaped keys. */
export function collectMemoryItems(
  value: unknown,
  entryName: string,
  depth = 0,
): ImportMemoryItem[] {
  if (depth > MAX_WALK_DEPTH || !value || typeof value !== "object") return [];
  const items: ImportMemoryItem[] = [];
  if (Array.isArray(value)) {
    for (const element of value) {
      items.push(...collectMemoryItems(element, entryName, depth + 1));
    }
    return items;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (MEMORY_KEY.test(key)) {
      items.push(...itemsFromMatchedValue(child, `${entryName}:${key}`, depth));
    } else {
      items.push(...collectMemoryItems(child, entryName, depth + 1));
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// The parse entry point
// ---------------------------------------------------------------------------

const PROGRESS_EVERY = 20;

/**
 * Parse a dropped ChatGPT export. Accepts the export ZIP or a bare
 * `conversations.json`. `onProgress` fires as material is found — the live
 * counts of step 2 — and the walk yields to the event loop between batches
 * so the ticker actually paints.
 */
export async function parseChatGptExport(
  file: { name: string; arrayBuffer: () => Promise<ArrayBuffer> },
  onProgress?: (progress: ParseProgress) => void,
): Promise<ParsedChatGptExport> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  let conversationsJson: string | null = null;
  const rawMemoryItems: ImportMemoryItem[] = [];

  if (/\.zip$/i.test(file.name)) {
    const entries = readZipDirectory(bytes);
    for (const entry of entries) {
      if (entry.name.endsWith("/")) continue;
      if (
        entry.name === "conversations.json" ||
        entry.name.endsWith("/conversations.json")
      ) {
        conversationsJson = await readZipEntry(bytes, entry);
        continue;
      }
      // Non-conversation material: small JSON entries, scanned by key
      // heuristics. Media and oversized entries are skipped unread.
      if (MEDIA_EXTENSIONS.test(entry.name)) continue;
      if (!/\.json$/i.test(entry.name)) continue;
      if (entry.compressedSize > 10 * 1024 * 1024) continue;
      try {
        const parsed: unknown = JSON.parse(await readZipEntry(bytes, entry));
        rawMemoryItems.push(...collectMemoryItems(parsed, entry.name));
      } catch {
        // An unreadable side entry never sinks the import.
      }
    }
  } else {
    conversationsJson = new TextDecoder().decode(bytes);
  }

  if (conversationsJson == null) {
    throw new Error("No conversations.json found in the export.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(conversationsJson);
  } catch {
    throw new Error("conversations.json is not valid JSON.");
  }
  if (!Array.isArray(raw)) {
    throw new Error("Expected conversations.json to contain a JSON array.");
  }

  const conversations: ImportConversation[] = [];
  let messagesFound = 0;
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseConversation(raw[i] as ChatGptConversation);
    if (parsed) {
      conversations.push(parsed);
      messagesFound += parsed.messages.length;
    }
    if (onProgress && (i % PROGRESS_EVERY === 0 || i === raw.length - 1)) {
      const createTime = (raw[i] as ChatGptConversation)?.create_time;
      onProgress({
        conversationsFound: conversations.length,
        messagesFound,
        memoryItemsFound: rawMemoryItems.length,
        workingThroughYear:
          typeof createTime === "number" && createTime > 0
            ? new Date(createTime * 1000).getFullYear()
            : null,
      });
      // Yield so the ticker paints while a big export is walked.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  // Redact and dedupe the memory material.
  let redactions = 0;
  const seen = new Set<string>();
  const memoryItems: ImportMemoryItem[] = [];
  for (const item of rawMemoryItems) {
    const redacted = redactSecrets(item.text);
    redactions += redacted.redactions;
    const key = redacted.text.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    memoryItems.push({ ...item, text: redacted.text });
  }

  return { conversations, memoryItems, redactions };
}

// ---------------------------------------------------------------------------
// Concept-page authoring for `POST …/memory/ingest`
// ---------------------------------------------------------------------------

export interface ConceptPageInput {
  slug: string;
  content: string;
  /** How many memory items this page carries (for honest summary counts). */
  itemCount: number;
}

/** Items per authored page — the map stays small, per the corpus-ingest rule. */
const ITEMS_PER_PAGE = 80;

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Bundle the memory material into a small number of concept pages carrying
 * the provenance frontmatter the ingest contract defines: `source:
 * import:chatgpt` plus an `origin_date` (the newest date the material
 * carries), so origin-aware recency ranks the archive by its own timeline
 * and the detail surface can say "imported from ChatGPT".
 */
export function buildConceptPages(
  items: readonly ImportMemoryItem[],
  importedAt: Date,
): ConceptPageInput[] {
  if (items.length === 0) return [];
  const pages: ConceptPageInput[] = [];
  const importedLabel = importedAt.toISOString().slice(0, 10);
  for (let start = 0; start < items.length; start += ITEMS_PER_PAGE) {
    const chunk = items.slice(start, start + ITEMS_PER_PAGE);
    const pageIndex = pages.length + 1;
    const slug =
      pageIndex === 1
        ? "imported/chatgpt-memories"
        : `imported/chatgpt-memories-${pageIndex}`;
    const newestDate = chunk
      .map((item) => item.originDate)
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1);
    const lines = chunk.map((item) => {
      const dated = item.originDate ? ` (${item.originDate})` : "";
      return `- ${item.text.replace(/\s*\n\s*/g, " ")}${dated}`;
    });
    const frontmatter = [
      "---",
      "source: import:chatgpt",
      ...(newestDate ? [`origin_date: ${newestDate}`] : []),
      `title: ${yamlQuote(
        pageIndex === 1
          ? "Imported from ChatGPT"
          : `Imported from ChatGPT (${pageIndex})`,
      )}`,
      `summary: ${yamlQuote(
        `${chunk.length} things the user told ChatGPT about themselves (saved memories and custom instructions), imported ${importedLabel}.`,
      )}`,
      "---",
    ].join("\n");
    const body = [
      "",
      "# Imported from ChatGPT",
      "",
      `Saved memories and custom instructions carried over on ${importedLabel}. Each line is verbatim from the export (secrets redacted).`,
      "",
      ...lines,
      "",
    ].join("\n");
    pages.push({
      slug,
      content: `${frontmatter}\n${body}`,
      itemCount: chunk.length,
    });
  }
  return pages;
}
