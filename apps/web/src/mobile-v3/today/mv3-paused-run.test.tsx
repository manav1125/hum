/**
 * The row's job is to be one door.
 *
 * The version this replaced carried an inline Approve beside a Deny at 390px.
 * Design overturned it: at thumb width that geometry puts a real transfer 8px
 * from a decline, and the row cannot carry the amount, the recipient or the
 * irreversibility that would make either button an informed act.
 *
 * So: **Review, and nothing else.** A later edit that "helpfully" restores a
 * quick Approve on the row fails here.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Mv3PausedRunLine, Mv3PausedRunRow } from "./mv3-paused-run";
import type { PausedRun } from "../approval-sheet";

afterEach(cleanup);

const RUN: PausedRun = {
  requestId: "req-1",
  conversationId: "conv-1",
  toolName: "stripe__PAYMENT_CREATE",
  kind: "confirmation",
  riskLevel: "high",
  input: { amount: "4,200.00", currency: "£", to: "Mafai Ma" },
  detailKnown: true,
};

function draw(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

describe("the paused-run row", () => {
  test("carries exactly one control, and it is Review", () => {
    const { container } = draw(
      <Mv3PausedRunRow assistantId="asst-1" run={RUN} />,
    );
    const card = container.querySelector('[data-slot="mv3-paused-run"]')!;
    const buttons = [...card.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(buttons).toEqual(["Review"]);
  });

  test("no amount is printed on the row — that is the sheet's job", () => {
    // The row cannot carry amount + recipient + ceiling + irreversibility, and
    // an amount without the rest is what makes a mis-tap feel informed.
    const { container } = draw(
      <Mv3PausedRunRow assistantId="asst-1" run={RUN} />,
    );
    const card = container.querySelector('[data-slot="mv3-paused-run"]')!;
    expect(card.textContent).not.toContain("4,200");
  });

  test("says a run is stopped, with the ‖ glyph and not just amber", () => {
    const { container } = draw(
      <Mv3PausedRunRow assistantId="asst-1" run={RUN} />,
    );
    expect(container.textContent).toContain("Paused · waiting on you");
    expect(container.textContent).toContain("‖");
  });

  test("Review opens the sheet, where Approve lives", () => {
    draw(<Mv3PausedRunRow assistantId="asst-1" run={RUN} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(document.body.textContent).toContain("Mafai Ma");
  });

  test("the compact rows below it use the same single door", () => {
    const { container } = draw(
      <Mv3PausedRunLine assistantId="asst-1" run={RUN} />,
    );
    const row = container.querySelector('[data-slot="mv3-paused-run-line"]')!;
    // The whole row is the button; there is no second, inline verb on it.
    expect(row.tagName).toBe("BUTTON");
    expect(row.querySelectorAll("button")).toHaveLength(0);
    fireEvent.click(row);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });
});
