/**
 * The approval sheet is the one screen where a UI bug is a bank transfer.
 *
 * Design ruled against an inline Approve (v22 R4) for a geometric reason: at
 * 390px a two-button row puts destructive and constructive 8px apart, and an
 * inline Approve on £4,200 is one mis-tap from a real payment. So the sheet's
 * button GEOMETRY is pinned here — Approve alone on its row, Not now and
 * Decline together on the next — because "someone put two buttons back on one
 * row" is the change that looks harmless in a diff and is the whole ruling.
 *
 * The rest of what is pinned is honesty: the sheet must state the amount, the
 * recipient and that the act cannot be recalled; it must never invent any of
 * them; and Approve must fire a real confirm and invalidate what the row reads,
 * because an approval you cannot actually answer from your phone is worse than
 * one you cannot see.
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
    return { data: { accepted: true }, response: new Response(), error: undefined };
  }),
}));

const {
  ApprovalSheet,
  approvalFacts,
  approvalTitle,
  readConfirmationInput,
  readPausedRuns,
  HARD_CHECKPOINT_REASON,
  NOT_RECALLABLE_LINE,
} = await import("./approval-sheet");
type PausedRun = import("./approval-sheet").PausedRun;

afterEach(() => {
  cleanup();
  confirmCalls.length = 0;
});

function run(overrides: Partial<PausedRun> = {}): PausedRun {
  return {
    requestId: "req-1",
    conversationId: "conv-1",
    toolName: "stripe__PAYMENT_CREATE",
    kind: "confirmation",
    riskLevel: "high",
    input: { amount: "4,200.00", currency: "£", to: "Mafai Ma" },
    detailKnown: true,
    ...overrides,
  };
}

function draw(r: PausedRun) {
  // The sheet portals into `#viewport-overlays` when it exists and falls back
  // to body otherwise — the fallback is what runs here.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ApprovalSheet
        assistantId="asst-1"
        run={r}
        open
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("reading the wire", () => {
  test("drops an entry with no requestId rather than opening a dead sheet", () => {
    const rows = readPausedRuns([
      { requestId: "r1", conversationId: "c1", toolName: "send" },
      { toolName: "send" },
      { requestId: "" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestId).toBe("r1");
    // Nothing from the list read is enriched yet — that is a second request.
    expect(rows[0]!.detailKnown).toBe(false);
    expect(rows[0]!.input).toBeNull();
  });

  test("survives a payload that is not a list", () => {
    expect(readPausedRuns(undefined)).toEqual([]);
    expect(readPausedRuns({ nope: true })).toEqual([]);
  });

  test("an entry with no input is different from no entry at all", () => {
    // The sheet says "this request doesn't name a sum" for the first and
    // "still reading" for the second. Collapsing them would make a missing
    // fetch look like a stated absence.
    expect(
      readConfirmationInput({ confirmations: [{ requestId: "r1" }] }, "r1"),
    ).toEqual({});
    expect(readConfirmationInput({ confirmations: [] }, "r1")).toBeUndefined();
    expect(readConfirmationInput(null, "r1")).toBeUndefined();
  });

  test("pulls the tool input for the right request", () => {
    const input = readConfirmationInput(
      {
        confirmations: [
          { requestId: "other", input: { amount: 1 } },
          { requestId: "r1", input: { amount: 4200, to: "Mafai Ma" } },
        ],
      },
      "r1",
    );
    expect(input).toEqual({ amount: 4200, to: "Mafai Ma" });
  });
});

describe("the facts are only ever as real as the payload", () => {
  test("amount and recipient come off the request, currency included", () => {
    const facts = approvalFacts(run());
    expect(facts.amount).toBe("£ 4,200.00");
    expect(facts.recipient).toBe("Mafai Ma");
    expect(facts.action).toBe("stripe__PAYMENT_CREATE");
  });

  test("a request that names no sum yields no amount — never a zero", () => {
    // A fabricated number on this screen is a fabricated transfer.
    const facts = approvalFacts(run({ input: { to: "someone@example.com" } }));
    expect(facts.amount).toBeNull();
    expect(facts.recipient).toBe("someone@example.com");
  });

  test("a ceiling appears only when the payload names one", () => {
    // Cue enforces no per-payment ceiling: what stops these runs is the
    // hard-checkpoint class rule, which has no number in it.
    expect(approvalFacts(run()).ceiling).toBeNull();
    expect(approvalFacts(run({ input: { limit: "1,000" } })).ceiling).toBe(
      "1,000",
    );
  });

  test("structure is not a fact — an object argument is never printed", () => {
    const facts = approvalFacts(
      run({ input: { amount: { value: 4200 }, to: ["a", "b"] } }),
    );
    expect(facts.amount).toBeNull();
    expect(facts.recipient).toBeNull();
  });

  test("the title is a question and never a bare id", () => {
    expect(approvalTitle(run())).toBe("Approve stripe__PAYMENT_CREATE?");
    expect(
      approvalTitle(run({ toolName: null, kind: null })),
    ).toContain("did not name");
  });
});

describe("the sheet", () => {
  test("states amount, recipient, the ceiling rule and irreversibility", () => {
    draw(run());
    // The sheet portals out of the render root, so every query here is
    // document-level — the same reason `screen` is used for the buttons.
    const text = document.body.textContent ?? "";
    expect(text).toContain("£ 4,200.00");
    expect(text).toContain("Mafai Ma");
    expect(text).toContain(HARD_CHECKPOINT_REASON);
    expect(text).toContain(NOT_RECALLABLE_LINE);
  });

  test("says which of 'no sum' and 'not read yet' it means", () => {
    draw(run({ input: {}, detailKnown: true }));
    expect(document.body.textContent).toContain("doesn't name a sum");
    cleanup();
    draw(run({ input: null, detailKnown: false }));
    expect(document.body.textContent).toContain("Still reading");
  });

  test("Approve is full-width and ALONE on its row", () => {
    // The ruling, enforced: consequential and destructive are never adjacent
    // at thumb width.
    draw(run());
    const primary = document.body.querySelector(
      '[data-slot="approval-primary-row"]',
    );
    const buttons = primary?.querySelectorAll("button") ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Approve");
    expect(buttons[0]!.style.width).toBe("100%");
  });

  test("Not now and Decline share the second row", () => {
    draw(run());
    const secondary = document.body.querySelector(
      '[data-slot="approval-secondary-row"]',
    );
    expect(
      [...(secondary?.querySelectorAll("button") ?? [])].map(
        (b) => b.textContent,
      ),
    ).toEqual(["Not now", "Decline"]);
  });

  test("Approve fires the real confirm", async () => {
    draw(run());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(confirmCalls).toEqual([{ requestId: "req-1", decision: "allow" }]),
    );
  });

  test("Decline fires a deny, not a silent dismiss", async () => {
    draw(run());
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(confirmCalls).toEqual([{ requestId: "req-1", decision: "deny" }]),
    );
  });

  test("Not now decides nothing — the run stays stopped", () => {
    draw(run());
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(confirmCalls).toEqual([]);
  });

  test("a successful approve invalidates what the row reads", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidated: unknown[] = [];
    const real = client.invalidateQueries.bind(client);
    client.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
      invalidated.push(filters?.queryKey);
      return real(filters as never);
    }) as typeof client.invalidateQueries;

    render(
      <QueryClientProvider client={client}>
        <ApprovalSheet
          assistantId="asst-1"
          run={run()}
          open
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    // Both reads: the unfiltered list drives the row, the conversation-scoped
    // one drives this sheet's facts. A stale either re-renders a decided run.
    await waitFor(() => expect(invalidated.length).toBeGreaterThanOrEqual(2));
    expect(JSON.stringify(invalidated)).toContain("conv-1");
  });
});
