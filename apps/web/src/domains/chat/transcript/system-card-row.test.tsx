import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import {
  SystemCardRow,
  splitSystemCardText,
  systemCardText,
} from "@/domains/chat/transcript/system-card-row";
import type { DisplayMessage } from "@/domains/chat/types/types";

afterEach(() => {
  cleanup();
});

describe("splitSystemCardText", () => {
  test("first line is the microlabel, the rest is the body", () => {
    const { label, body } = splitSystemCardText(
      "Compacted · 41 messages → 1 summary\nContext 41,200 → 12,400 tokens (28,800 saved) · 12 recent messages kept in full",
    );
    expect(label).toBe("Compacted · 41 messages → 1 summary");
    expect(body).toBe(
      "Context 41,200 → 12,400 tokens (28,800 saved) · 12 recent messages kept in full",
    );
  });

  test("a single-line card is all label, no body", () => {
    const { label, body } = splitSystemCardText("Compaction skipped");
    expect(label).toBe("Compaction skipped");
    expect(body).toBe("");
  });

  test("extra body lines collapse into one muted line", () => {
    const { body } = splitSystemCardText("Cleaned\nfact one\nfact two");
    expect(body).toBe("fact one · fact two");
  });
});

describe("systemCardText", () => {
  test("prefers contentBlocks text and falls back to textSegments", () => {
    const withBlocks: DisplayMessage = {
      id: "m1",
      role: "assistant",
      contentBlocks: [{ type: "text", text: "From blocks" }],
      textSegments: ["From segments"],
    };
    expect(systemCardText(withBlocks)).toBe("From blocks");

    const segmentsOnly: DisplayMessage = {
      id: "m2",
      role: "assistant",
      textSegments: ["From segments"],
    };
    expect(systemCardText(segmentsOnly)).toBe("From segments");
  });
});

describe("SystemCardRow", () => {
  const message: DisplayMessage = {
    id: "m1",
    role: "assistant",
    systemCard: "summarize",
    timestamp: Date.UTC(2026, 7, 5, 14, 2, 0),
    contentBlocks: [
      {
        type: "text",
        text: "Summarized · 34 messages → 1 summary\n12 recent messages kept in full · context 12,400 → 1,100 tokens (11,300 saved)",
      },
    ],
  };

  test("renders microlabel, muted body, and timestamp — no bubble, no avatar", () => {
    const { container, getByText } = render(
      <SystemCardRow message={message} />,
    );

    // Ruling 4: centered hairline-bounded row carrying the card kind.
    const row = container.querySelector('[data-system-card="summarize"]');
    expect(row).toBeTruthy();

    expect(getByText("Summarized · 34 messages → 1 summary")).toBeTruthy();
    expect(
      getByText(
        "12 recent messages kept in full · context 12,400 → 1,100 tokens (11,300 saved)",
      ),
    ).toBeTruthy();
    expect(container.querySelector("time")).toBeTruthy();
  });

  test("renders nothing for an empty card body", () => {
    const { container } = render(
      <SystemCardRow
        message={{ id: "m2", role: "assistant", systemCard: "clean" }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
