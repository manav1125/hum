/**
 * Tests for GET /v1/approval-override and POST /v1/approval-override/clear —
 * the status/revoke endpoints backing the temporary-approval countdown chip.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearAll,
  setConversationMode,
  setTimedMode,
} from "../runtime/conversation-approval-overrides.js";
import { ROUTES } from "../runtime/routes/approval-override-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";

function getHandler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`route not found: ${operationId}`);
  return route.handler;
}

const statusHandler = getHandler("approval_override_status");
const clearHandler = getHandler("approval_override_clear");

beforeEach(() => {
  clearAll();
});

describe("GET /v1/approval-override", () => {
  test("requires conversationId", () => {
    expect(() => statusHandler({ queryParams: {} } as never)).toThrow(
      BadRequestError,
    );
  });

  test("reports inactive when no override exists", () => {
    const result = statusHandler({
      queryParams: { conversationId: "conv-1" },
    } as never) as { active: boolean };
    expect(result.active).toBe(false);
  });

  test("reports a timed override with remaining time", () => {
    setTimedMode("conv-1", 60_000);
    const result = statusHandler({
      queryParams: { conversationId: "conv-1" },
    } as never) as {
      active: boolean;
      kind?: string;
      expiresAt?: number;
      remainingMs?: number;
    };
    expect(result.active).toBe(true);
    expect(result.kind).toBe("timed");
    expect(result.remainingMs).toBeGreaterThan(0);
    expect(result.remainingMs).toBeLessThanOrEqual(60_000);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  test("reports a conversation override without expiry", () => {
    setConversationMode("conv-1");
    const result = statusHandler({
      queryParams: { conversationId: "conv-1" },
    } as never) as { active: boolean; kind?: string; expiresAt?: number };
    expect(result.active).toBe(true);
    expect(result.kind).toBe("conversation");
    expect(result.expiresAt).toBeUndefined();
  });

  test("an expired timed override reads as inactive — expiry never allows", async () => {
    setTimedMode("conv-1", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = statusHandler({
      queryParams: { conversationId: "conv-1" },
    } as never) as { active: boolean };
    expect(result.active).toBe(false);
  });
});

describe("POST /v1/approval-override/clear", () => {
  test("requires conversationId", () => {
    expect(() => clearHandler({ body: {} } as never)).toThrow(BadRequestError);
  });

  test("revokes an active override", () => {
    setTimedMode("conv-1", 60_000);
    const result = clearHandler({
      body: { conversationId: "conv-1" },
    } as never) as { cleared: boolean; hadOverride: boolean };
    expect(result.cleared).toBe(true);
    expect(result.hadOverride).toBe(true);

    const status = statusHandler({
      queryParams: { conversationId: "conv-1" },
    } as never) as { active: boolean };
    expect(status.active).toBe(false);
  });

  test("is idempotent when no override exists", () => {
    const result = clearHandler({
      body: { conversationId: "conv-1" },
    } as never) as { cleared: boolean; hadOverride: boolean };
    expect(result.cleared).toBe(true);
    expect(result.hadOverride).toBe(false);
  });

  test("only clears the named conversation", () => {
    setConversationMode("conv-1");
    setConversationMode("conv-2");
    clearHandler({ body: { conversationId: "conv-1" } } as never);
    const other = statusHandler({
      queryParams: { conversationId: "conv-2" },
    } as never) as { active: boolean };
    expect(other.active).toBe(true);
  });
});
