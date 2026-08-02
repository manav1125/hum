/**
 * Paused approvals must be answerable where they are counted.
 *
 * These are runs stopped mid-flight at a high-consequence action — a send, a
 * payment, a publish. The daemon hard-checkpoints them regardless of trust, so
 * until somebody answers, nothing continues.
 *
 * Two regressions are pinned here.
 *
 * First: retiring the deck's approval cards left desktop able to COUNT them and
 * not answer them — a line reading "Decide ›" whose door led to the review
 * queue, which completes work items and has no confirm call at all.
 *
 * Second, and the reason these are rows rather than that line: "needs you" is
 * defined as things blocked on a human decision, and a stopped run is the most
 * literal instance of it. A separate lane broke the one-definition rule shared
 * by the badge, the headline and the rows — which is exactly how the door came
 * to point somewhere that could not act.
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

const { PausedNeedsYouRow, readPausedApprovals } = await import(
  "./paused-approvals"
);

afterEach(() => {
  cleanup();
  confirmCalls.length = 0;
});

function draw(approval: { requestId: string; label: string }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PausedNeedsYouRow assistantId="asst-1" approval={approval} />
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

describe("PausedNeedsYouRow", () => {
  test("a paused run is answerable from the lane, not just counted", async () => {
    draw({ requestId: "r1", label: "Send the Acme renewal" });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(confirmCalls).toEqual([{ requestId: "r1", decision: "allow" }]),
    );
  });

  test("and declined", async () => {
    draw({ requestId: "r1", label: "Send the Acme renewal" });
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() =>
      expect(confirmCalls).toEqual([{ requestId: "r1", decision: "deny" }]),
    );
  });

  test("carries ⏸, not ‖ — a run is stopped, not a thing waiting", () => {
    // Same amber, different glyph. A reader scanning the lane needs to know
    // which rows will not move again until they act.
    const { container } = draw({ requestId: "r1", label: "Send it" });
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("⏸");
  });

  test("says why nothing is moving", () => {
    const { container } = draw({ requestId: "r1", label: "Send it" });
    expect(container.textContent).toContain(
      "A run is stopped here until you decide.",
    );
  });

  test("shows what Cue is asking to do", () => {
    const { container } = draw({
      requestId: "r1",
      label: "gmail__GMAIL_SEND_EMAIL",
    });
    expect(container.textContent).toContain("gmail__GMAIL_SEND_EMAIL");
  });
});
