/**
 * Share Feedback — what the two toggles actually ship.
 *
 * The dialog offers "Include diagnostics" and "Include the most recent
 * conversation". They shipped the owner's data, so what each one attaches has
 * to be pinned at the byte level, not inferred from the label.
 *
 * The defect: the conversation rode out under the diagnostics toggle. The
 * in-memory transcript (`_vellumDebug.chat.getClientMessages()`, which carries
 * message `content` verbatim) was captured whenever diagnostics were on, and
 * on web the active conversation id was forwarded to the server-side export —
 * widening it from daemon logs to that conversation's messages, model
 * requests, and tool calls — regardless of the conversation toggle, which the
 * web build did not even render (it was gated on `isElectron()`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The daemon log export is the server-side half of the bundle. Capture the
// body so the test can assert whether a conversation id was disclosed.
let exportCalls: Array<{ conversationId?: string }> = [];
const daemonSdk = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  logsExportPost: async (opts: { body?: { conversationId?: string } }) => {
    exportCalls.push({ ...(opts.body ?? {}) });
    return { data: new Blob([new Uint8Array([1, 2, 3])]), error: undefined };
  },
}));

const { buildClientLogsFile } = await import("./share-feedback-modal");

const ASSISTANT_ID = "asst-test";
const CONVERSATION_ID = "conv-test";
const SECRET_LINE = "my bank password is hunter2";

beforeEach(() => {
  exportCalls = [];
  // Stand in for the live chat debug API the transcript capture reads.
  (window as unknown as { _vellumDebug?: unknown })._vellumDebug = {
    chat: {
      getClientMessages: () => [{ role: "user", content: SECRET_LINE }],
      getTranscriptItems: () => [{ kind: "message", content: SECRET_LINE }],
      thinkingIndicator: () => null,
      streamingRing: () => null,
      getReconciliationDiagnostics: () => null,
    },
    events: {
      getClients: () => [{ id: "c1", abortSignal: { aborted: false } }],
      getEvents: () => [{ kind: "open" }],
    },
  };
});

afterEach(() => {
  delete (window as unknown as { _vellumDebug?: unknown })._vellumDebug;
});

/** Unpack the gzipped tar and return `{ filename → contents }`. */
async function readBundle(file: File): Promise<Record<string, string>> {
  const gz = new Uint8Array(await file.arrayBuffer());
  const tar = Bun.gunzipSync(gz);
  const decoder = new TextDecoder();
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    if (!name) break;
    const sizeOctal = decoder
      .decode(header.subarray(124, 136))
      .replace(/\0.*$/, "")
      .trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const start = offset + 512;
    out[name] = decoder.decode(tar.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("the diagnostics toggle", () => {
  test("attaches environment context only — no messages, no conversation id", async () => {
    const file = await buildClientLogsFile(
      "past_hour",
      ASSISTANT_ID,
      CONVERSATION_ID,
      { diagnostics: true, conversation: false },
    );
    expect(file).not.toBeNull();
    const bundle = await readBundle(file!);

    // What it claims: browser/device context, debug flags, connection state.
    expect(Object.keys(bundle)).toContain("web-client-context.json");
    expect(Object.keys(bundle)).toContain("web-debug-flags.json");

    // MUTATION GUARD: the transcript capture must NOT be here. If this file
    // reappears under the diagnostics toggle, message text is leaving the
    // machine under a label that says it isn't.
    expect(Object.keys(bundle)).not.toContain("web-chat-debug-api-triage.json");
    const everything = JSON.stringify(bundle);
    expect(everything).not.toContain(SECRET_LINE);

    // And the id that widens the server export to a conversation's messages,
    // model requests, and tool calls must not be sent.
    expect(everything).not.toContain(CONVERSATION_ID);
    expect(exportCalls).toHaveLength(1);
    expect(exportCalls[0]!.conversationId).toBeUndefined();
  });

  test("the manifest states what the user consented to", async () => {
    const file = await buildClientLogsFile(
      "past_hour",
      ASSISTANT_ID,
      CONVERSATION_ID,
      { diagnostics: true, conversation: false },
    );
    const manifest = JSON.parse(
      (await readBundle(file!))["bundle-manifest.json"]!,
    );
    expect(manifest.includes_environment_diagnostics).toBe(true);
    expect(manifest.includes_conversation).toBe(false);
  });
});

describe("the conversation toggle", () => {
  test("attaches the transcript and scopes the server export to it", async () => {
    const file = await buildClientLogsFile(
      "past_hour",
      ASSISTANT_ID,
      CONVERSATION_ID,
      { diagnostics: false, conversation: true },
    );
    const bundle = await readBundle(file!);

    expect(Object.keys(bundle)).toContain("web-chat-debug-api-triage.json");
    expect(bundle["web-chat-debug-api-triage.json"]).toContain(SECRET_LINE);
    expect(exportCalls[0]!.conversationId).toBe(CONVERSATION_ID);

    // Environment diagnostics were NOT requested, so they are not along for
    // the ride either — the toggles are disjoint in both directions.
    expect(Object.keys(bundle)).not.toContain("web-client-context.json");
    expect(Object.keys(bundle)).not.toContain("web-debug-flags.json");
  });

  test("both toggles on ships both halves", async () => {
    const file = await buildClientLogsFile(
      "past_hour",
      ASSISTANT_ID,
      CONVERSATION_ID,
      { diagnostics: true, conversation: true },
    );
    const bundle = await readBundle(file!);
    expect(Object.keys(bundle)).toContain("web-client-context.json");
    expect(Object.keys(bundle)).toContain("web-chat-debug-api-triage.json");
    expect(exportCalls[0]!.conversationId).toBe(CONVERSATION_ID);
  });

  test("both toggles off ships neither", async () => {
    const file = await buildClientLogsFile(
      "past_hour",
      ASSISTANT_ID,
      CONVERSATION_ID,
      { diagnostics: false, conversation: false },
    );
    const bundle = await readBundle(file!);
    expect(Object.keys(bundle)).not.toContain("web-client-context.json");
    expect(Object.keys(bundle)).not.toContain("web-chat-debug-api-triage.json");
    expect(JSON.stringify(bundle)).not.toContain(SECRET_LINE);
  });
});
