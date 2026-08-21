/**
 * The two lines that, read together, say why a turn was stranded.
 *
 * `audience: 0` at publish plus a late discovery means the prompt was never
 * sent to anyone — a connection problem. A non-zero audience plus a late
 * discovery means it was delivered to a live client that did not act on it —
 * a client problem. Neither line alone separates the two, and after the fact
 * neither is recoverable: by the time anyone notices, a client has usually
 * reconnected.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

interface LogLine {
  level: string;
  fields: Record<string, unknown>;
  msg: string;
}

const lines: LogLine[] = [];

const actualLogger = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...actualLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get:
        (_t, level: string) =>
        (fields: Record<string, unknown>, msg: string) => {
          lines.push({ level, fields: fields ?? {}, msg: msg ?? "" });
        },
    }),
}));

const { recordInteractionAudience, assistantEventHub } =
  await import("../assistant-event-hub.js");
const { recordLateDiscovery, LATE_DISCOVERY_THRESHOLD_MS } =
  await import("../routes/approval-routes.js");

afterEach(() => {
  lines.length = 0;
});

function confirmation(conversationId: string) {
  return {
    type: "confirmation_request",
    requestId: "req-1",
    conversationId,
    toolName: "bash",
  } as never;
}

describe("publish-time audience line", () => {
  test("warns when a prompt is published with nobody listening", () => {
    // The stranded turn: the daemon is waiting on an answer it never asked
    // anyone for.
    recordInteractionAudience(confirmation("conv-1"), "conv-1");

    const line = lines.at(-1)!;
    expect(line.level).toBe("warn");
    expect(line.fields.audience).toBe(0);
    expect(line.fields.requestId).toBe("req-1");
    expect(line.fields.kind).toBe("confirmation_request");
    expect(line.msg).toContain("no client listening");
  });

  test("records at info, not warn, when someone is listening", () => {
    const sub = assistantEventHub.subscribe({
      type: "client",
      clientId: "c-listening",
      interfaceId: "web",
      capabilities: [],
      callback: () => {},
    });
    try {
      recordInteractionAudience(confirmation("conv-1"), "conv-1");
      const line = lines.at(-1)!;
      expect(line.level).toBe("info");
      expect(line.fields.audience as number).toBeGreaterThan(0);
    } finally {
      sub.dispose();
    }
  });

  test("says nothing about messages that are not user prompts", () => {
    // Only a prompt blocking on a person can strand a turn; logging the
    // rest would bury the signal.
    recordInteractionAudience(
      { type: "assistant_text_delta", conversationId: "conv-1" } as never,
      "conv-1",
    );
    expect(lines).toEqual([]);
  });

  test("covers every prompt kind that blocks a run", () => {
    for (const type of [
      "confirmation_request",
      "secret_request",
      "question_request",
      "contact_prompt_request",
    ]) {
      lines.length = 0;
      recordInteractionAudience(
        { type, requestId: "r", conversationId: "conv-1" } as never,
        "conv-1",
      );
      expect(lines.length).toBe(1);
    }
  });
});

describe("late-discovery line", () => {
  test("warns when a client first asks about a long-waiting prompt", () => {
    const old = Date.now() - (LATE_DISCOVERY_THRESHOLD_MS + 5_000);
    recordLateDiscovery("conv-1", new Map([["req-1", old]]));

    const line = lines.at(-1)!;
    expect(line.level).toBe("warn");
    expect(line.fields.requestId).toBe("req-1");
    expect(line.fields.ageMs as number).toBeGreaterThanOrEqual(
      LATE_DISCOVERY_THRESHOLD_MS,
    );
  });

  test("stays quiet for a prompt the client is asking about promptly", () => {
    // A normal first poll after a legitimate reconnect is not a miss.
    recordLateDiscovery("conv-1", new Map([["req-1", Date.now() - 1_000]]));
    expect(lines).toEqual([]);
  });

  test("stays quiet when the age is unknown", () => {
    // No timestamp is not evidence of lateness.
    recordLateDiscovery("conv-1", new Map([["req-1", undefined]]));
    expect(lines).toEqual([]);
  });

  test("reports each late prompt separately", () => {
    const old = Date.now() - (LATE_DISCOVERY_THRESHOLD_MS + 5_000);
    recordLateDiscovery(
      "conv-1",
      new Map([
        ["req-1", old],
        ["req-2", old],
        ["req-3", Date.now()],
      ]),
    );
    expect(lines.length).toBe(2);
  });

  test("the threshold sits above the client watchdog's own interval", () => {
    // The watchdog polls every 15s; a first answer after a legitimate
    // reconnect must not be reported as a missed publish.
    expect(LATE_DISCOVERY_THRESHOLD_MS).toBeGreaterThan(15_000);
  });
});
