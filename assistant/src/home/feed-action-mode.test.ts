import { describe, expect, test } from "bun:test";

import type { AutonomyPolicyMap } from "../permissions/autonomy-policy-reader.js";
import {
  allowsBackground,
  classifyFeedActionMode,
  resolveDefaultMode,
} from "./feed-action-mode.js";
import type { FeedAction } from "./feed-types.js";

const SAFE: AutonomyPolicyMap = {
  research: "auto",
  draft: "auto",
  send: "ask",
  money: "ask",
  delete: "ask",
  publish: "ask",
  contact: "ask",
  other: "ask",
};

function action(label: string, prompt = ""): FeedAction {
  return { id: "primary", label, prompt } as FeedAction;
}

describe("classifyFeedActionMode", () => {
  test("research-y actions classify as research", () => {
    expect(classifyFeedActionMode(action("Review On2Cook exit"))).toBe(
      "research",
    );
    expect(classifyFeedActionMode(action("Summarize the thread"))).toBe(
      "research",
    );
    expect(classifyFeedActionMode(action("Confirm Ghita LP pipeline"))).toBe(
      "research",
    );
  });

  test("draft actions classify as draft", () => {
    expect(classifyFeedActionMode(action("Draft reply"))).toBe("draft");
    expect(classifyFeedActionMode(action("Compose a response"))).toBe("draft");
  });

  test("send dominates over draft (draft AND send -> send)", () => {
    expect(classifyFeedActionMode(action("Draft and send the reply"))).toBe(
      "send",
    );
    expect(classifyFeedActionMode(action("Reply on WordPress guidance"))).toBe(
      "send",
    );
  });

  test("money + delete classify correctly and dominate", () => {
    expect(classifyFeedActionMode(action("Pay the Manus AI invoice"))).toBe(
      "money",
    );
    expect(classifyFeedActionMode(action("Cancel the subscription"))).toBe(
      "delete",
    );
    expect(
      classifyFeedActionMode(action("Draft a note then delete the record")),
    ).toBe("delete");
  });

  test("unknown intent falls back to other", () => {
    expect(classifyFeedActionMode(action("Frobnicate the widget"))).toBe(
      "other",
    );
  });
});

describe("resolveDefaultMode", () => {
  test("auto -> background, ask -> needs_you, never -> thread", () => {
    expect(resolveDefaultMode("research", SAFE)).toBe("background");
    expect(resolveDefaultMode("draft", SAFE)).toBe("background");
    expect(resolveDefaultMode("send", SAFE)).toBe("needs_you");
    expect(resolveDefaultMode("money", SAFE)).toBe("needs_you");
    expect(resolveDefaultMode("delete", SAFE)).toBe("needs_you");
  });

  test("never policy opens a manual thread, not auto-run", () => {
    const lockedDown: AutonomyPolicyMap = { ...SAFE, send: "never" };
    expect(resolveDefaultMode("send", lockedDown)).toBe("thread");
  });
});

describe("allowsBackground", () => {
  test("only research/draft are background-eligible by default", () => {
    expect(allowsBackground("research")).toBe(true);
    expect(allowsBackground("draft")).toBe(true);
    expect(allowsBackground("send")).toBe(false);
    expect(allowsBackground("money")).toBe(false);
    expect(allowsBackground("delete")).toBe(false);
    expect(allowsBackground("other")).toBe(false);
  });
});
