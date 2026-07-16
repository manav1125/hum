import { describe, expect, test } from "bun:test";

import { buildAgentCard } from "../agent-card.js";
import type { A2ATask } from "../protocol-types.js";
import {
  normalizeInboundMessage,
  normalizeSendConfiguration,
  normalizeTaskIdParam,
  toWireCard,
  toWireMessage,
  toWireTask,
} from "../wire-format.js";

describe("wire-format: outbound (camelCase)", () => {
  test("toWireCard emits protocolVersion, url, camelCase fields + securitySchemes", () => {
    const card = buildAgentCard({
      assistantName: "Alice",
      baseUrl: "https://alice.example.com",
    });
    const wire = toWireCard(card) as Record<string, unknown>;

    expect(wire.protocolVersion).toBe("1.0");
    expect(wire.url).toBe("https://alice.example.com/a2a/message:send");
    expect(wire.preferredTransport).toBe("JSONRPC");
    expect(wire.defaultInputModes).toEqual(["text/plain"]);
    expect(wire.defaultOutputModes).toEqual(["text/plain"]);

    const capabilities = wire.capabilities as Record<string, unknown>;
    expect(capabilities.pushNotifications).toBe(true);
    expect(capabilities.streaming).toBe(false);

    // No snake_case keys should leak onto the wire.
    expect(wire.default_input_modes).toBeUndefined();
    expect(wire.supported_interfaces).toBeUndefined();
    expect(wire.push_notifications).toBeUndefined();

    expect(wire.securitySchemes).toBeDefined();
    const schemes = wire.securitySchemes as Record<string, { scheme: string }>;
    expect(schemes.bearer.scheme).toBe("bearer");
  });

  test("toWireMessage renames message_id → messageId and file media_type → mediaType", () => {
    const wire = toWireMessage({
      message_id: "m-1",
      context_id: "c-1",
      role: "agent",
      parts: [
        { kind: "text", text: "hi" },
        {
          kind: "file",
          url: "https://x/y",
          filename: "y",
          media_type: "text/plain",
        },
      ],
    }) as Record<string, unknown>;

    expect(wire.messageId).toBe("m-1");
    expect(wire.contextId).toBe("c-1");
    expect(wire.message_id).toBeUndefined();
    const parts = wire.parts as Array<Record<string, unknown>>;
    expect(parts[1].mediaType).toBe("text/plain");
    expect(parts[1].media_type).toBeUndefined();
  });

  test("toWireTask emits artifactId + kind and preserves state", () => {
    const task: A2ATask = {
      id: "t-1",
      context_id: "c-1",
      status: { state: "completed", timestamp: "2026-01-01T00:00:00Z" },
      artifacts: [
        { artifact_id: "a-1", parts: [{ kind: "text", text: "done" }] },
      ],
    };
    const wire = toWireTask(task) as Record<string, unknown>;

    expect(wire.kind).toBe("task");
    expect(wire.id).toBe("t-1");
    expect(wire.contextId).toBe("c-1");
    const status = wire.status as Record<string, unknown>;
    expect(status.state).toBe("completed");
    const artifacts = wire.artifacts as Array<Record<string, unknown>>;
    expect(artifacts[0].artifactId).toBe("a-1");
    expect(artifacts[0].artifact_id).toBeUndefined();
  });
});

describe("wire-format: inbound (tolerant of both casings)", () => {
  test("normalizeInboundMessage accepts camelCase", () => {
    const msg = normalizeInboundMessage({
      messageId: "m-1",
      contextId: "c-1",
      taskId: "t-1",
      role: "user",
      parts: [{ kind: "text", text: "hello" }],
    });
    expect(msg.message_id).toBe("m-1");
    expect(msg.context_id).toBe("c-1");
    expect(msg.task_id).toBe("t-1");
    expect(msg.role).toBe("user");
    expect(msg.parts[0]).toEqual({ kind: "text", text: "hello" });
  });

  test("normalizeInboundMessage accepts snake_case (legacy Cue↔Cue)", () => {
    const msg = normalizeInboundMessage({
      message_id: "m-2",
      context_id: "c-2",
      role: "user",
      parts: [{ kind: "text", text: "legacy" }],
    });
    expect(msg.message_id).toBe("m-2");
    expect(msg.context_id).toBe("c-2");
  });

  test("normalizeInboundMessage synthesizes a message id when absent", () => {
    const msg = normalizeInboundMessage({
      role: "user",
      parts: [{ kind: "text", text: "no id" }],
    });
    expect(msg.message_id).toBeTruthy();
  });

  test("normalizeInboundMessage rejects missing/empty parts and bad role", () => {
    expect(() => normalizeInboundMessage({ role: "user", parts: [] })).toThrow(
      /at least one valid part/,
    );
    expect(() =>
      normalizeInboundMessage({
        role: "bogus",
        parts: [{ kind: "text", text: "x" }],
      }),
    ).toThrow(/role/);
    expect(() => normalizeInboundMessage(null)).toThrow(/object/);
  });

  test("normalizeSendConfiguration reads push config from either casing", () => {
    const camel = normalizeSendConfiguration({
      pushNotificationConfig: { url: "https://p/1", authentication: { x: 1 } },
    });
    expect(camel?.task_push_notification_config?.url).toBe("https://p/1");

    const snake = normalizeSendConfiguration({
      task_push_notification_config: { url: "https://p/2" },
    });
    expect(snake?.task_push_notification_config?.url).toBe("https://p/2");
  });

  test("normalizeTaskIdParam accepts id, taskId, task_id, or bare string", () => {
    expect(normalizeTaskIdParam({ id: "t-1" })).toBe("t-1");
    expect(normalizeTaskIdParam({ taskId: "t-2" })).toBe("t-2");
    expect(normalizeTaskIdParam({ task_id: "t-3" })).toBe("t-3");
    expect(normalizeTaskIdParam("t-4")).toBe("t-4");
    expect(normalizeTaskIdParam({})).toBeNull();
  });
});
