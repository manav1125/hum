/**
 * Tests for `<ProvenanceTrace/>` — the rendered half of "why is this here".
 *
 * The vocabulary tests (`work-provenance.test.ts`) prove the WORDS are right.
 * These prove the component honours them: that an item with nothing to say
 * renders nothing at all rather than an empty pill or a guessed origin, that
 * the answer really is one click away, and that opening the trace inside a
 * clickable row does not also open the row.
 *
 * Mounted via `@testing-library/react` (happy-dom — see `test-setup.ts`).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ProvenanceTrace } from "@/pages/hq/provenance-trace";

afterEach(cleanup);

describe("renders nothing when there is nothing to say", () => {
  test("a null sourceType renders NO provenance affordance at all", () => {
    const { container } = render(
      <ProvenanceTrace item={{ sourceType: null }} />,
    );
    // Not an empty pill, not a guess — nothing.
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("an item with no provenance columns renders nothing", () => {
    const { container } = render(<ProvenanceTrace item={{}} />);
    expect(container.innerHTML).toBe("");
  });

  test("a null item renders nothing", () => {
    const { container } = render(<ProvenanceTrace item={null} />);
    expect(container.innerHTML).toBe("");
  });

  test("a user-filed item claims no filing judgement", () => {
    // projectId set but autoFiledBy null: the user filed it, Cue did not.
    const { container } = render(
      <ProvenanceTrace
        item={{ sourceType: null, projectId: "p1", autoFiledBy: null }}
        projectTitle="Seed raise"
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("the answer is one click away", () => {
  const item = {
    sourceType: "gmail_watcher",
    sourceContext: '{"sender":"Sarah Chen"}',
    projectId: "p1",
    autoFiledBy: "cue",
    autoFileConfidence: 0.62,
    ranProvenance: "auto" as const,
  };

  test("the pill states the origin in words before anything is clicked", () => {
    render(<ProvenanceTrace item={item} projectTitle="Seed raise" />);
    expect(screen.getByText("Watcher · Gmail")).toBeTruthy();
  });

  test("one click reveals origin, sender, filing and run", () => {
    render(<ProvenanceTrace item={item} projectTitle="Seed raise" />);
    expect(screen.queryByText(/A watcher picked this up/)).toBeNull();

    fireEvent.click(screen.getByRole("button"));

    expect(
      screen.getByText("A watcher picked this up from Gmail"),
    ).toBeTruthy();
    expect(screen.getByText("Sent by Sarah Chen")).toBeTruthy();
    expect(
      screen.getByText(
        "Cue filed this into Seed raise itself — it was fairly sure",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Cue ran this on its own")).toBeTruthy();
  });

  test("confidence reads as words, and no percentage is shown", () => {
    render(<ProvenanceTrace item={item} projectTitle="Seed raise" />);
    fireEvent.click(screen.getByRole("button"));
    const panel = screen.getByLabelText("Where this came from");
    expect(panel.textContent).toContain("fairly sure");
    expect(panel.textContent).not.toContain("%");
    expect(panel.textContent).not.toContain("0.62");
  });

  test("no raw id is rendered anywhere in the trace", () => {
    render(
      <ProvenanceTrace
        item={{ ...item, originConversationId: "conv_0193abcd" }}
        projectTitle="Seed raise"
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const panel = screen.getByLabelText("Where this came from");
    expect(panel.textContent).not.toContain("conv_0193abcd");
    expect(panel.textContent).not.toContain("p1");
    expect(panel.textContent).not.toContain("gmail_watcher");
  });

  test("the screen-reader label carries the whole answer, not just the pill", () => {
    render(<ProvenanceTrace item={item} projectTitle="Seed raise" />);
    const label = screen.getByRole("button").getAttribute("aria-label") ?? "";
    expect(label).toContain("Why is this here?");
    expect(label).toContain("A watcher picked this up from Gmail");
    expect(label).toContain("Cue ran this on its own");
  });
});

describe("the conversation link", () => {
  test("is offered when the item names one AND a handler exists", () => {
    const onOpen = mock(() => {});
    render(
      <ProvenanceTrace
        item={{ sourceType: "chat", originConversationId: "conv_1" }}
        onOpenConversation={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByText("Open the conversation ›"));
    expect(onOpen).toHaveBeenCalledWith("conv_1");
  });

  test("is not offered without a handler — no dead ends", () => {
    render(
      <ProvenanceTrace
        item={{ sourceType: "chat", originConversationId: "conv_1" }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("Open the conversation ›")).toBeNull();
  });
});

describe("living inside a clickable row", () => {
  test("opening the trace does not also open the row", () => {
    const onRowClick = mock(() => {});
    render(
      <div onClick={onRowClick}>
        <ProvenanceTrace item={{ sourceType: "slack" }} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Came in from Slack")).toBeTruthy();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  test("Escape closes the panel", () => {
    render(<ProvenanceTrace item={{ sourceType: "slack" }} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Came in from Slack")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Came in from Slack")).toBeNull();
  });
});
