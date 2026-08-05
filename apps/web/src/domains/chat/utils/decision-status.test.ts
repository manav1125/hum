import { describe, expect, test } from "bun:test";
import { CheckCircle, Clock, XCircle } from "lucide-react";

import {
  decisionStatusKind,
  decisionStatusPresentation,
} from "@/domains/chat/utils/decision-status";

describe("decisionStatusKind", () => {
  test("classifies by the shared status word at the head of the summary", () => {
    expect(decisionStatusKind("Approved · by you · 14:02")).toBe("approved");
    expect(decisionStatusKind("Denied · by you · 14:02")).toBe("denied");
    expect(
      decisionStatusKind("Expired · never answered — nothing was sent"),
    ).toBe("expired");
    expect(decisionStatusKind("Cancelled")).toBe("cancelled");
  });

  test("bare status words from older daemons still classify", () => {
    expect(decisionStatusKind("Approved")).toBe("approved");
    expect(decisionStatusKind("Denied")).toBe("denied");
    expect(decisionStatusKind("Expired")).toBe("expired");
  });

  test("the client-side stale-tap notice classifies as expired", () => {
    expect(decisionStatusKind("Request expired")).toBe("expired");
  });

  test("non-decision summaries stay generic", () => {
    expect(decisionStatusKind('User chose: "Clean up my inbox"')).toBe(
      "generic",
    );
    expect(decisionStatusKind("Connected Google: user@example.com")).toBe(
      "generic",
    );
    expect(decisionStatusKind(undefined)).toBe("generic");
  });
});

describe("decisionStatusPresentation", () => {
  test("per-state in-app glyphs: ✓ green · ✕ red · ◷ grey", () => {
    const approved = decisionStatusPresentation("Approved · by you · 14:02");
    expect(approved.Icon).toBe(CheckCircle);
    expect(approved.textClass).toContain("system-positive");

    const denied = decisionStatusPresentation("Denied · by you · 14:02");
    expect(denied.Icon).toBe(XCircle);
    expect(denied.textClass).toContain("system-negative");

    const expired = decisionStatusPresentation(
      "Expired · never answered — nothing was sent",
    );
    expect(expired.Icon).toBe(Clock);
    expect(expired.textClass).toContain("content-secondary");
  });

  test("generic summaries keep the green done treatment", () => {
    const generic = decisionStatusPresentation('User chose: "Weekly digest"');
    expect(generic.Icon).toBe(CheckCircle);
    expect(generic.textClass).toContain("system-positive");
  });
});
