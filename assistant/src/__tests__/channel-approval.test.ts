import { describe, expect, test } from "bun:test";

import {
  type ApprovalAction,
  composeDecisionStatusLine,
} from "../runtime/channel-approval-types.js";
import { parseCallbackData } from "../runtime/routes/channel-route-shared.js";

// ═══════════════════════════════════════════════════════════════════════════
// Callback data parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parseCallbackData", () => {
  test.each([
    ["apr:req-123:approve_once", "approve_once"],
    ["apr:req-123:reject", "reject"],
  ] as const)('parses "%s" as action "%s"', (data, expectedAction) => {
    const result = parseCallbackData(data);
    expect(result).not.toBeNull();
    expect(result!.action).toBe(expectedAction);
    expect(result!.requestId).toBe("req-123");
    expect(result!.source).toBe("telegram_button");
  });

  test.each<[string, string]>([
    ["apr:req-123:approve_10m", "approve_once"],
    ["apr:req-123:approve_conversation", "approve_once"],
    ["apr:req-123:approve_always", "approve_once"],
  ])(
    'maps legacy action "%s" to %s (backward compat)',
    (data, expectedAction) => {
      const result = parseCallbackData(data);
      expect(result).not.toBeNull();
      expect(result!.action).toBe(expectedAction as ApprovalAction);
      expect(result!.requestId).toBe("req-123");
    },
  );

  test("parses slack source channel", () => {
    const result = parseCallbackData("apr:req-789:approve_once", "slack");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_once");
    expect(result!.requestId).toBe("req-789");
    expect(result!.source).toBe("slack_button");
  });

  test("returns null for unknown action", () => {
    expect(parseCallbackData("apr:req-123:unknown_action")).toBeNull();
  });

  test("returns null for missing prefix", () => {
    expect(parseCallbackData("xyz:req-123:approve_once")).toBeNull();
  });

  test("returns null for incomplete data", () => {
    expect(parseCallbackData("apr:req-123")).toBeNull();
  });

  test("returns null for empty requestId", () => {
    expect(parseCallbackData("apr::approve_once")).toBeNull();
  });
});

// Shared decided-card status wording (design ruling 5, Wave C): one source
// for in-app, Slack, and Telegram — surfaces add only their own glyphs.
describe("composeDecisionStatusLine", () => {
  test("approved composes by-whom and wall-clock time", () => {
    const line = composeDecisionStatusLine("approved", {
      // 2026-08-05T14:02:00Z rendered in UTC.
      decidedAtMs: Date.UTC(2026, 7, 5, 14, 2, 0),
      timeZone: "UTC",
    });
    expect(line).toBe("Approved · by you · 14:02");
  });

  test("denied composes the same shape as approved", () => {
    const line = composeDecisionStatusLine("denied", {
      decidedAtMs: Date.UTC(2026, 7, 5, 9, 7, 0),
      timeZone: "UTC",
    });
    expect(line).toBe("Denied · by you · 09:07");
  });

  test("an explicit decider replaces the default 'you'", () => {
    const line = composeDecisionStatusLine("approved", {
      decidedBy: "Manav",
      decidedAtMs: Date.UTC(2026, 7, 5, 14, 2, 0),
      timeZone: "UTC",
    });
    expect(line).toBe("Approved · by Manav · 14:02");
  });

  test("omits the time segment when no decision instant is known", () => {
    expect(composeDecisionStatusLine("approved")).toBe("Approved · by you");
  });

  test("expired states the consequence and ignores by-whom/time", () => {
    const line = composeDecisionStatusLine("expired", {
      decidedAtMs: Date.UTC(2026, 7, 5, 14, 2, 0),
      timeZone: "UTC",
    });
    expect(line).toBe("Expired · never answered — nothing was sent");
  });

  test("cancelled keeps the bare status word", () => {
    expect(
      composeDecisionStatusLine("cancelled", {
        decidedAtMs: Date.UTC(2026, 7, 5, 14, 2, 0),
        timeZone: "UTC",
      }),
    ).toBe("Cancelled");
  });

  test("time renders in the provided zone", () => {
    const line = composeDecisionStatusLine("approved", {
      decidedAtMs: Date.UTC(2026, 7, 5, 14, 2, 0),
      timeZone: "Asia/Singapore",
    });
    expect(line).toBe("Approved · by you · 22:02");
  });

  test("an invalid zone falls back to the host zone instead of throwing", () => {
    const line = composeDecisionStatusLine("approved", {
      decidedAtMs: Date.UTC(2026, 7, 5, 14, 2, 0),
      timeZone: "Not/AZone",
    });
    expect(line).toMatch(/^Approved · by you · \d{2}:\d{2}$/);
  });
});
