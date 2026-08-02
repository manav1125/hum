/**
 * Paused approvals must be answerable where they are counted.
 *
 * These are runs stopped mid-flight at a high-consequence action — a send, a
 * payment, a publish. The daemon hard-checkpoints them regardless of trust, so
 * until somebody answers, nothing continues.
 *
 * The regression this pins: retiring the deck's approval cards left desktop
 * able to COUNT them and not answer them. The remainder rendered as a line
 * saying "N more approvals are paused for your decision · Decide ›" whose door
 * led to the review queue — a page that completes work items and has no confirm
 * call at all. The label promised the one thing the destination could not do.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const confirmCalls: { requestId: string; decision: string }[] = [];
const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  confirmPost: mock(async (options: { body: Record<string, string> }) => {
    confirmCalls.push({
      requestId: options.body.requestId!,
      decision: options.body.decision!,
    });
    return { data: { ok: true }, response: new Response(), error: undefined };
  }),
}));

const { PausedApprovals, readPausedApprovals, PAUSED_APPROVAL_CAP } =
  await import("./paused-approvals");

afterEach(() => {
  cleanup();
  confirmCalls.length = 0;
});

function draw(approvals: { requestId: string; label: string }[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PausedApprovals assistantId="asst-1" approvals={approvals} />
    </QueryClientProvider>,
  );
}

describe("readPausedApprovals", () => {
  test("prefers the tool name, falls back, never renders a bare id", () => {
    const rows = readPausedApprovals([
      { requestId: "r1", toolName: "gmail__GMAIL_SEND_EMAIL" },
      { requestId: "r2", kind: "purchase" },
      { requestId: "r3" },
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      "gmail__GMAIL_SEND_EMAIL",
      "purchase",
      "Waiting on your decision",
    ]);
  });

  test("drops an entry with no requestId rather than rendering dead buttons", () => {
    // A row whose Approve cannot resolve to a request is the exact failure this
    // component exists to remove — an affordance that looks live and is not.
    expect(readPausedApprovals([{ toolName: "send" }, { requestId: "r1" }])).toHaveLength(1);
  });

  test("survives a payload that is not a list", () => {
    expect(readPausedApprovals(undefined)).toEqual([]);
    expect(readPausedApprovals({ nope: true })).toEqual([]);
  });
});

describe("PausedApprovals", () => {
  test("renders nothing when nothing is paused", () => {
    const { container } = draw([]);
    expect(
      container.querySelector("[data-slot='hq-paused-approvals']"),
    ).toBeNull();
  });

  test("a paused run can be approved from the deck, not just counted", async () => {
    draw([{ requestId: "r1", label: "Send the Acme renewal" }]);
    fireEvent.click(screen.getByRole("button", { name: /Decide/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(confirmCalls).toEqual([{ requestId: "r1", decision: "allow" }]),
    );
  });

  test("and declined", async () => {
    draw([{ requestId: "r1", label: "Send the Acme renewal" }]);
    fireEvent.click(screen.getByRole("button", { name: /Decide/ }));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() =>
      expect(confirmCalls).toEqual([{ requestId: "r1", decision: "deny" }]),
    );
  });

  test("it is a line until asked — the deck does not gain a card", () => {
    // Retiring the board was right. Restoring the function must not restore the
    // chrome: collapsed, this is one sentence.
    draw([{ requestId: "r1", label: "Send it" }]);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  test("the count is real and singularised", () => {
    const { container } = draw([{ requestId: "r1", label: "Send it" }]);
    expect(container.textContent).toContain("1 run is paused");
    cleanup();
    const two = draw([
      { requestId: "r1", label: "a" },
      { requestId: "r2", label: "b" },
    ]);
    expect(two.container.textContent).toContain("2 runs are paused");
  });

  test("the deck never grows — rows cap and say so", () => {
    const many = Array.from({ length: PAUSED_APPROVAL_CAP + 3 }, (_, i) => ({
      requestId: `r${i}`,
      label: `Approval ${i}`,
    }));
    draw(many);
    fireEvent.click(screen.getByRole("button", { name: /Decide/ }));

    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(
      PAUSED_APPROVAL_CAP,
    );
    expect(
      screen.getByText(`${PAUSED_APPROVAL_CAP} of ${many.length} — decide these and the rest follow.`),
    ).toBeTruthy();
  });

  test("state carries a glyph, never colour alone", () => {
    const { container } = draw([{ requestId: "r1", label: "Send it" }]);
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("‖");
  });
});
