/**
 * Cross-surface projection coverage for `withdrawGuardianRequestCards`.
 *
 * Deliveries come from the real canonical guardian store; the per-surface
 * projections (in-app persist/broadcast, Telegram keyboard withdrawal) are
 * the mocked seams.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const withdrawTelegramApprovalCard = mock(async () => {});
const actualTelegramWithdraw =
  await import("../../messaging/providers/telegram-bot/withdraw.js");
mock.module("../../messaging/providers/telegram-bot/withdraw.js", () => ({
  ...actualTelegramWithdraw,
  withdrawTelegramApprovalCard,
}));

const markSurfaceCompleted = mock(() => {});
const actualSurfaces = await import("../../daemon/conversation-surfaces.js");
mock.module("../../daemon/conversation-surfaces.js", () => ({
  ...actualSurfaces,
  markSurfaceCompleted,
}));

const broadcasts: Array<Record<string, unknown>> = [];
const actualHub = await import("../../runtime/assistant-event-hub.js");
mock.module("../../runtime/assistant-event-hub.js", () => ({
  ...actualHub,
  broadcastMessage: (msg: Record<string, unknown>) => {
    broadcasts.push(msg);
  },
}));

import {
  createCanonicalGuardianDelivery,
  createCanonicalGuardianRequest,
} from "../../memory/canonical-guardian-store.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";

initializeDb();

const { withdrawGuardianRequestCards } =
  await import("../guardian-card-withdrawal.js");

const TEST_PRINCIPAL = "withdrawal-test-principal";

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
}

function makeRequest(kind = "access_request") {
  return createCanonicalGuardianRequest({
    kind,
    sourceType: "channel",
    sourceChannel: "telegram",
    guardianPrincipalId: TEST_PRINCIPAL,
  });
}

beforeEach(() => {
  resetTables();
  withdrawTelegramApprovalCard.mockClear();
  markSurfaceCompleted.mockClear();
  broadcasts.length = 0;
});

describe("withdrawGuardianRequestCards — Telegram projection", () => {
  test("withdraws the Telegram card in place using the recorded message id", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-9",
      destinationMessageId: "314",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "approved",
      originChannel: "vellum",
    });

    expect(withdrawTelegramApprovalCard).toHaveBeenCalledTimes(1);
    expect(withdrawTelegramApprovalCard).toHaveBeenCalledWith({
      chatId: "chat-9",
      messageId: "314",
      status: "approved",
      postStatusReply: true,
    });
  });

  test("no-ops when the delivery never recorded a message id", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-9",
    });

    await withdrawGuardianRequestCards({ request: req, status: "expired" });

    expect(withdrawTelegramApprovalCard).not.toHaveBeenCalled();
  });

  test("suppresses the status reply only for a Telegram-origin decision whose flow replies to the guardian", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-9",
      destinationMessageId: "1",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "approved",
      originChannel: "telegram",
      hasOriginGuardianReply: true,
    });

    expect(withdrawTelegramApprovalCard).toHaveBeenCalledWith(
      expect.objectContaining({ postStatusReply: false }),
    );
  });

  test("keeps the status reply for a Telegram-origin decision whose resolver replies to the requester", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-9",
      destinationMessageId: "1",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "denied",
      originChannel: "telegram",
    });

    expect(withdrawTelegramApprovalCard).toHaveBeenCalledWith(
      expect.objectContaining({ postStatusReply: true }),
    );
  });

  test("a failing Telegram withdrawal never propagates and other surfaces still run", async () => {
    withdrawTelegramApprovalCard.mockImplementationOnce(async () => {
      throw new Error("telegram down");
    });
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-9",
      destinationMessageId: "1",
    });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "approved",
      originChannel: "telegram",
    });

    expect(markSurfaceCompleted).toHaveBeenCalledTimes(1);
  });
});

describe("withdrawGuardianRequestCards — in-app projection", () => {
  test("persists the completion without broadcasting when the decision originated in-app", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "approved",
      originChannel: "vellum",
    });

    // The acting client's optimistic completion is in-memory only, so the
    // terminal state still has to reach history or a re-entry re-renders the
    // undecided button group.
    expect(markSurfaceCompleted).toHaveBeenCalledTimes(1);
    expect(markSurfaceCompleted).toHaveBeenCalledWith(
      { conversationId: "conv-1" },
      `access-request-${req.id}`,
      "Approved",
    );
    // No broadcast: it would replace the resolver's reply text already on
    // screen with the canonical status label.
    expect(broadcasts.filter((m) => m.type === "ui_surface_complete")).toEqual(
      [],
    );
  });

  test("persists and broadcasts when the decision came from another surface", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "denied",
      originChannel: "telegram",
    });

    expect(markSurfaceCompleted).toHaveBeenCalledWith(
      { conversationId: "conv-1" },
      `access-request-${req.id}`,
      "Denied",
    );
    expect(broadcasts.filter((m) => m.type === "ui_surface_complete")).toEqual([
      {
        type: "ui_surface_complete",
        conversationId: "conv-1",
        surfaceId: `access-request-${req.id}`,
        summary: "Denied",
      },
    ]);
  });

  test("broadcasts on a system-driven expiry (no origin channel)", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    await withdrawGuardianRequestCards({ request: req, status: "expired" });

    expect(markSurfaceCompleted).toHaveBeenCalledWith(
      { conversationId: "conv-1" },
      `access-request-${req.id}`,
      "Expired",
    );
    expect(
      broadcasts.filter((m) => m.type === "ui_surface_complete"),
    ).toHaveLength(1);
  });

  test("skips kinds that never render an in-app approval card", async () => {
    const req = makeRequest("tool_grant_request");
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "approved",
      originChannel: "telegram",
    });

    expect(markSurfaceCompleted).not.toHaveBeenCalled();
    expect(broadcasts).toEqual([]);
  });

  test("skips deliveries with no destination conversation", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "approved",
      originChannel: "telegram",
    });

    expect(markSurfaceCompleted).not.toHaveBeenCalled();
  });
});
