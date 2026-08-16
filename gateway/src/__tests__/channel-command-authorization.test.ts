/**
 * Tests for the fail-closed gateway-terminal channel command gate.
 *
 * Covers the decision table of authorizeChannelCommand (active allow,
 * guardian allow, unknown/blocked/revoked/pending deny, store error deny,
 * missing actor deny) and the handleNewCommand integration: denied actors
 * must get no conversation reset and no channel reply (silent deny), while
 * allowed actors keep the existing reset + confirmation behavior.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";

// Mock the IPC SQL proxy — the gate reads contact_channels through it.
const mockQuery = mock();
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mockQuery,
  assistantDbRun: mock(),
  assistantDbExec: mock(),
}));

const resetConversationMock = mock(() => Promise.resolve());
mock.module("../runtime/client.js", () => ({
  resetConversation: resetConversationMock,
  CircuitBreakerOpenError: class extends Error {
    retryAfterSecs = 5;
  },
}));

const { authorizeChannelCommand } =
  await import("../channel-command-authorization.js");
const { handleNewCommand } = await import("../webhook-pipeline.js");

function makeLogger() {
  const infoMock = mock();
  const logger = {
    debug: mock(),
    info: infoMock,
    warn: mock(),
    error: mock(),
  } as unknown as Logger;
  return { logger, infoMock };
}

const config = {} as GatewayConfig;

beforeEach(() => {
  mockQuery.mockReset();
  resetConversationMock.mockClear();
});

describe("authorizeChannelCommand", () => {
  test("allows an active contact", async () => {
    mockQuery.mockResolvedValue([{ status: "active", role: "contact" }]);
    const { logger } = makeLogger();

    const decision = await authorizeChannelCommand({
      sourceChannel: "telegram",
      actorExternalId: "67890",
      command: "new",
      logger,
    });

    expect(decision).toEqual({ allowed: true, reason: "active_contact" });
  });

  test("allows the guardian via their active binding", async () => {
    mockQuery.mockResolvedValue([{ status: "active", role: "guardian" }]);
    const { logger } = makeLogger();

    const decision = await authorizeChannelCommand({
      sourceChannel: "slack",
      actorExternalId: "U_OWNER",
      command: "mute",
      logger,
    });

    expect(decision).toEqual({ allowed: true, reason: "guardian" });
  });

  test("denies an unknown actor (no contact-channel row)", async () => {
    mockQuery.mockResolvedValue([]);
    const { logger, infoMock } = makeLogger();

    const decision = await authorizeChannelCommand({
      sourceChannel: "telegram",
      actorExternalId: "99999",
      command: "new",
      logger,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unknown_actor");
    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(infoMock.mock.calls[0][0]).toMatchObject({
      decision: "deny",
      reason: "unknown_actor",
      sourceChannel: "telegram",
      command: "new",
    });
  });

  test.each(["blocked", "revoked", "pending", "unverified"])(
    "denies a %s contact",
    async (status) => {
      mockQuery.mockResolvedValue([{ status, role: "contact" }]);
      const { logger } = makeLogger();

      const decision = await authorizeChannelCommand({
        sourceChannel: "whatsapp",
        actorExternalId: "+14155550142",
        command: "new",
        logger,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe(`status_${status}`);
    },
  );

  /**
   * The gate's allow half is an admission floor against the shared
   * `TrustClass` rank, not a bare status-string test. These pin the two
   * things that would otherwise drift silently: that a non-guardian active
   * contact is admitted (raising the floor to `guardian` would lock the owner's
   * own contacts out of `/new`), and that a below-floor denial still says
   * which status caused it.
   */
  test("a guardian-role contact whose channel is not active is still denied", async () => {
    // Role does not rescue status: the classifier maps any non-active row to
    // `unknown`, which clears no floor.
    mockQuery.mockResolvedValue([{ status: "revoked", role: "guardian" }]);
    const { logger } = makeLogger();

    const decision = await authorizeChannelCommand({
      sourceChannel: "telegram",
      actorExternalId: "67890",
      command: "new",
      logger,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("status_revoked");
  });

  test("a below-floor denial logs the class that put them there", async () => {
    mockQuery.mockResolvedValue([{ status: "blocked", role: "contact" }]);
    const { logger, infoMock } = makeLogger();

    await authorizeChannelCommand({
      sourceChannel: "telegram",
      actorExternalId: "67890",
      command: "new",
      logger,
    });

    expect(infoMock.mock.calls[0][0]).toMatchObject({
      decision: "deny",
      reason: "status_blocked",
      trustClass: "unknown",
    });
  });

  test("a null role is an ordinary active contact, not a denial", async () => {
    mockQuery.mockResolvedValue([{ status: "active", role: null }]);
    const { logger } = makeLogger();

    const decision = await authorizeChannelCommand({
      sourceChannel: "telegram",
      actorExternalId: "67890",
      command: "new",
      logger,
    });

    expect(decision).toEqual({ allowed: true, reason: "active_contact" });
  });

  test("denies when the store lookup throws (fail closed)", async () => {
    mockQuery.mockRejectedValue(new Error("IPC socket unavailable"));
    const { logger, infoMock } = makeLogger();

    const decision = await authorizeChannelCommand({
      sourceChannel: "telegram",
      actorExternalId: "67890",
      command: "new",
      logger,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("lookup_failed");
    expect(infoMock.mock.calls[0][0]).toMatchObject({
      decision: "deny",
      reason: "lookup_failed",
    });
  });

  test("denies an empty actor id without touching the store", async () => {
    const { logger } = makeLogger();

    const decision = await authorizeChannelCommand({
      sourceChannel: "slack",
      actorExternalId: "",
      command: "mute",
      logger,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("missing_actor");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("canonicalizes phone-channel actor ids before lookup", async () => {
    mockQuery.mockResolvedValue([{ status: "active", role: "contact" }]);
    const { logger } = makeLogger();

    await authorizeChannelCommand({
      sourceChannel: "sms",
      actorExternalId: "(415) 555-0142",
      command: "new",
      logger,
    });

    const bind = mockQuery.mock.calls[0][1] as string[];
    expect(bind[0]).toBe("sms");
    expect(bind[1]).toBe("+14155550142");
    expect(bind[2]).toBe("+14155550142");
  });
});

describe("handleNewCommand authorization gate", () => {
  test("blocked contact is denied silently: no reset, no reply", async () => {
    mockQuery.mockResolvedValue([{ status: "blocked", role: "contact" }]);
    const { logger } = makeLogger();
    const sendReply = mock(() => Promise.resolve());

    const result = await handleNewCommand(
      config,
      "telegram",
      "67890",
      "12345",
      sendReply,
      logger,
    );

    expect(result).toEqual({ handled: true });
    expect(resetConversationMock).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  test("unknown actor is denied silently: no reset, no reply", async () => {
    mockQuery.mockResolvedValue([]);
    const { logger } = makeLogger();
    const sendReply = mock(() => Promise.resolve());

    await handleNewCommand(
      config,
      "whatsapp",
      "+14155550100",
      "+14155550100",
      sendReply,
      logger,
    );

    expect(resetConversationMock).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  test("store error is denied silently: no reset, no reply", async () => {
    mockQuery.mockRejectedValue(new Error("db proxy down"));
    const { logger } = makeLogger();
    const sendReply = mock(() => Promise.resolve());

    await handleNewCommand(
      config,
      "sms",
      "+14155550142",
      "+14155550142",
      sendReply,
      logger,
    );

    expect(resetConversationMock).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  test("active contact keeps existing behavior: reset + confirmation", async () => {
    mockQuery.mockResolvedValue([{ status: "active", role: "contact" }]);
    const { logger } = makeLogger();
    const sendReply = mock((_text: string) => Promise.resolve());

    const result = await handleNewCommand(
      config,
      "telegram",
      "67890",
      "12345",
      sendReply,
      logger,
    );

    // Let the fire-and-forget confirmation settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(result).toEqual({ handled: true });
    expect(resetConversationMock).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0][0]).toContain("new conversation");
  });
});
