/**
 * Rehydration coverage for in-app guardian decision cards.
 *
 * Tapping Approve / Reject on the in-app access-request card resolves the
 * request server-side and the acting client completes its own card
 * optimistically. That optimistic completion is in-memory only, so the
 * terminal state must also reach the conversation's persisted `ui_surface`
 * block, or re-entering the conversation rebuilds history from a card that
 * still looks undecided and re-renders the raw button group.
 *
 * This exercises the real withdrawal → `markSurfaceCompleted` →
 * history-render chain, asserting on what a returning client actually reads
 * back.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Stand in for the messages table: `markSurfaceCompleted` scans it for the
// block carrying the surface id and writes the patched content back.
let rows: Array<{
  id: string;
  conversationId: string;
  content: string;
}> = [];

const actualCrud = await import("../../memory/conversation-crud.js");
mock.module("../../memory/conversation-crud.js", () => ({
  ...actualCrud,
  getMessages: (conversationId: string) =>
    rows.filter((r) => r.conversationId === conversationId),
  updateMessageContent: (id: string, content: string) => {
    const row = rows.find((r) => r.id === id);
    if (row) {
      row.content = content;
    }
  },
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
const { renderHistoryContent } =
  await import("../../daemon/handlers/shared.js");

const CONVERSATION_ID = "conv-rehydration-1";
const TEST_PRINCIPAL = "rehydration-test-principal";

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
}

/** The two-button access-request card as it is first persisted. */
function seedUndecidedCard(requestId: string): void {
  rows = [
    {
      id: "msg-card",
      conversationId: CONVERSATION_ID,
      content: JSON.stringify([
        {
          type: "ui_surface",
          surfaceId: `access-request-${requestId}`,
          surfaceType: "card",
          title: "Access Request",
          data: {
            title: "Alice",
            subtitle: "Requesting access to the assistant",
            body: "",
          },
          actions: [
            {
              id: `apr:${requestId}:approve_once`,
              label: "Approve",
              style: "primary",
            },
            {
              id: `apr:${requestId}:reject`,
              label: "Reject",
              style: "destructive",
            },
          ],
        },
      ]),
    },
  ];
}

/** The surface a returning client reads off the rehydrated history row. */
function rehydratedSurface() {
  const row = rows.find((r) => r.id === "msg-card")!;
  return renderHistoryContent(JSON.parse(row.content)).surfaces[0];
}

/** A pending access request whose in-app card sits in the conversation. */
function seedPendingRequest() {
  const request = createCanonicalGuardianRequest({
    kind: "access_request",
    sourceType: "channel",
    sourceChannel: "telegram",
    guardianPrincipalId: TEST_PRINCIPAL,
  });
  createCanonicalGuardianDelivery({
    requestId: request.id,
    destinationChannel: "vellum",
    destinationConversationId: CONVERSATION_ID,
  });
  seedUndecidedCard(request.id);
  return request;
}

describe("in-app access-request decision rehydration", () => {
  beforeEach(() => {
    resetTables();
    broadcasts.length = 0;
  });

  test("an undecided card still carries its action buttons", () => {
    seedPendingRequest();

    const surface = rehydratedSurface();
    expect(surface?.completed).toBeUndefined();
    expect(surface?.actions).toHaveLength(2);
  });

  test("a decision made in-app rehydrates as completed, not as the button group", async () => {
    const request = seedPendingRequest();

    await withdrawGuardianRequestCards({
      request,
      status: "denied",
      originChannel: "vellum",
    });

    const surface = rehydratedSurface();
    expect(surface?.completed).toBe(true);
    expect(surface?.completionSummary).toMatch(
      /^Denied · by you · \d{2}:\d{2}$/,
    );
    // The card keeps its content for the audit trail; only the live
    // affordances stop rendering, which the client drives off `completed`.
    expect(surface?.data).toMatchObject({ title: "Alice" });
  });

  test("an approval made in-app rehydrates as approved", async () => {
    const request = seedPendingRequest();

    await withdrawGuardianRequestCards({
      request,
      status: "approved",
      originChannel: "vellum",
    });

    const surface = rehydratedSurface();
    expect(surface?.completed).toBe(true);
    expect(surface?.completionSummary).toMatch(
      /^Approved · by you · \d{2}:\d{2}$/,
    );
  });

  test("an in-app decision does not re-broadcast over the acting client's own summary", async () => {
    const request = seedPendingRequest();

    await withdrawGuardianRequestCards({
      request,
      status: "approved",
      originChannel: "vellum",
    });

    expect(
      broadcasts.filter((m) => m.type === "ui_surface_complete"),
    ).toHaveLength(0);
  });

  test("a decision made on another surface both persists and broadcasts", async () => {
    const request = seedPendingRequest();

    await withdrawGuardianRequestCards({
      request,
      status: "denied",
      originChannel: "telegram",
    });

    expect(rehydratedSurface()?.completionSummary).toMatch(
      /^Denied · by you · \d{2}:\d{2}$/,
    );
    expect(
      broadcasts.filter((m) => m.type === "ui_surface_complete"),
    ).toHaveLength(1);
  });
});
