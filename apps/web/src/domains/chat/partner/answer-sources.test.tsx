/**
 * The provenance line — and, more importantly, its absence.
 *
 * The standing rule in this codebase is that we never assert provenance we do
 * not have. The mutation check for that rule lives here: delete the
 * `sources.length === 0` guard in `AnswerSources` and "renders no sources line
 * at all when the answer came from the model's own knowledge" fails.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { AnswerSources } from "@/domains/chat/partner/answer-sources-line";
import {
  deriveAnswerSources,
  summarizeSources,
} from "@/domains/chat/partner/answer-sources";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

afterEach(() => {
  cleanup();
});

function call(
  overrides: Partial<ChatMessageToolCall> & { name: string },
): ChatMessageToolCall {
  return {
    id: `tc-${overrides.name}-${Math.random().toString(36).slice(2, 7)}`,
    input: {},
    result: "ok",
    completedAt: 1,
    ...overrides,
  } as ChatMessageToolCall;
}

describe("deriveAnswerSources", () => {
  test("names the families the turn actually read", () => {
    const sources = deriveAnswerSources([
      call({
        name: "gmail__GMAIL_FETCH_EMAILS",
        input: { query: "Northwind" },
      }),
      call({ name: "google_calendar_list_events" }),
    ]);
    expect(sources.map((s) => s.family)).toEqual(["mail", "calendar"]);
    expect(sources[0]!.detail).toBe("Northwind");
  });

  test("sees through the Composio proxy to the real action", () => {
    const sources = deriveAnswerSources([
      call({
        name: "mcp__composio__COMPOSIO_EXECUTE_TOOL",
        input: {
          tool_slug: "GMAIL_FETCH_EMAILS",
          arguments: { query: "pricing" },
        },
      }),
    ]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.label).toBe("your email");
    expect(sources[0]!.detail).toBe("pricing");
  });

  test("a send is never listed as a source", () => {
    expect(
      deriveAnswerSources([call({ name: "gmail__GMAIL_SEND_EMAIL" })]),
    ).toEqual([]);
  });

  test("a failed read is not a source", () => {
    expect(
      deriveAnswerSources([
        call({ name: "gmail__GMAIL_FETCH_EMAILS", isError: true }),
      ]),
    ).toEqual([]);
  });

  test("a read still running is not a source yet", () => {
    expect(
      deriveAnswerSources([
        {
          id: "tc-live",
          name: "gmail__GMAIL_FETCH_EMAILS",
          input: {},
        } as ChatMessageToolCall,
      ]),
    ).toEqual([]);
  });

  test("the agent's own machinery is not the user's data", () => {
    expect(
      deriveAnswerSources([
        call({ name: "bash", input: { command: "ls" } }),
        call({ name: "ui_show" }),
        call({ name: "todo_write" }),
      ]),
    ).toEqual([]);
  });

  test("one family is claimed once however many times it was read", () => {
    const sources = deriveAnswerSources([
      call({ name: "gmail__GMAIL_FETCH_EMAILS" }),
      call({
        name: "gmail__GMAIL_FETCH_EMAILS",
        input: { subject: "Renewal" },
      }),
    ]);
    expect(sources).toHaveLength(1);
    // The read that names something wins, so the line stays checkable.
    expect(sources[0]!.detail).toBe("Renewal");
  });

  test("no tool calls at all means no sources", () => {
    expect(deriveAnswerSources(undefined)).toEqual([]);
    expect(deriveAnswerSources([])).toEqual([]);
  });
});

describe("summarizeSources", () => {
  test("reads as a sentence, not a list", () => {
    const sources = deriveAnswerSources([
      call({ name: "gmail__GMAIL_FETCH_EMAILS" }),
      call({ name: "calendar_list_events" }),
      call({ name: "web_search", input: { query: "x" } }),
    ]);
    expect(summarizeSources(sources)).toBe(
      "your email, your calendar and the web",
    );
  });

  test("an empty list makes no claim", () => {
    expect(summarizeSources([])).toBe("");
  });
});

describe("AnswerSources", () => {
  test("renders the sources collapsed, one click away", () => {
    const sources = deriveAnswerSources([
      call({
        name: "gmail__GMAIL_FETCH_EMAILS",
        input: { subject: "Renewal" },
      }),
    ]);
    const { getByTestId, queryByTestId } = render(
      <AnswerSources sources={sources} />,
    );

    // Collapsed: the summary shows, the detail does not.
    const toggle = getByTestId("answer-sources").querySelector("button")!;
    expect(toggle.textContent).toContain("from your email");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(queryByTestId("answer-sources-detail")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(getByTestId("answer-sources-detail").textContent).toContain(
      "Renewal",
    );
  });

  test("renders no sources line at all when there are none", () => {
    // MUTATION CHECK: drop the `sources.length === 0` early return in
    // `AnswerSources` and this fails. That guard is the thing standing between
    // us and a line that implies Cue read the user's data when it did not.
    const { container, queryByTestId } = render(<AnswerSources sources={[]} />);
    expect(queryByTestId("answer-sources")).toBeNull();
    expect(container.textContent).toBe("");
  });

  test("never hedges the answer above it", () => {
    const sources = deriveAnswerSources([
      call({ name: "gmail__GMAIL_FETCH_EMAILS" }),
    ]);
    const { container } = render(<AnswerSources sources={sources} />);
    expect(container.textContent).not.toMatch(
      /I think|it appears|possibly|maybe/i,
    );
  });
});
