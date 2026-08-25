/**
 * The confirmation payload has to say whether the action can be taken back.
 *
 * `riskLevel` does not answer that question and never did: a high-risk file
 * write is still undoable, and a perfectly routine email is not. The surface
 * needs both, because they drive different affordances — a reversible call can
 * be a row that Enter approves, while an irreversible one has to name the act
 * on its button and can never be standing-approved.
 *
 * The grade comes from `requiresHumanApprovalForAction`, the same predicate the
 * outbound-send gate enforces. That is the point of these tests: if the two
 * ever drift, the card would offer a one-key approval for something the gate
 * treats as unsendable without a human.
 */

import { describe, expect, test } from "bun:test";

import { requiresHumanApprovalForAction } from "../tools/outbound-send.js";

const grade = (name: string, input: Record<string, unknown>) =>
  requiresHumanApprovalForAction(name, input) ? "irreversible" : "reversible";

describe("confirmation reversibility grade", () => {
  test("ordinary local work is reversible", () => {
    expect(grade("file_write", { path: "/tmp/a.txt" })).toBe("reversible");
    expect(grade("file_read", { path: "/tmp/a.txt" })).toBe("reversible");
    expect(grade("bash", { command: "ls -la" })).toBe("reversible");
  });

  // The 96.5% the owner approves anyway are these — and they are exactly the
  // ones that should stop demanding a full card.
  test("a risky but undoable call is still reversible", () => {
    expect(grade("bash", { command: "rm -rf ./build" })).toBe("reversible");
  });

  test("anything that leaves the machine is irreversible", () => {
    expect(grade("gmail__GMAIL_SEND_EMAIL", { to: "a@b.c" })).toBe(
      "irreversible",
    );
    expect(grade("messaging_send", { to: "a@b.c" })).toBe("irreversible");
  });

  // The proxy form is how the model actually reaches Gmail; grading the name
  // alone would call it reversible and offer Enter-to-approve on a send.
  test("a send hidden behind the Composio proxy is irreversible", () => {
    expect(
      grade("mcp__composio__COMPOSIO_EXECUTE_TOOL", {
        tool_slug: "GMAIL_SEND_EMAIL",
      }),
    ).toBe("irreversible");
  });

  test("a shell that reaches the network is irreversible", () => {
    expect(grade("bash", { command: "curl -X POST https://example.com" })).toBe(
      "irreversible",
    );
  });

  // Drafting is the counter-case: it looks like sending and is not.
  test("drafting is reversible", () => {
    expect(grade("gmail__GMAIL_CREATE_EMAIL_DRAFT", { to: "a@b.c" })).toBe(
      "reversible",
    );
  });
});
