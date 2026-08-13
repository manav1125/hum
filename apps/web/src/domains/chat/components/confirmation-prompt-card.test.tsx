/**
 * The two-group confirmation card (temporary approval grants).
 *
 * Layout recovered from upstream's temporary-approval-modes design
 * (e05896063f / 46d64df40d^, design/surfaces/Chat.dc.html "grant once /
 * 10 min / always"): an "Approve all actions" group carrying the timed
 * tiers, and a "This action only" group carrying Allow once / Don't allow
 * plus the make-a-rule affordance.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ConfirmationPromptCard } from "./confirmation-prompt-card";
import type { ConfirmationPromptCardProps } from "./confirmation-prompt-card";

afterEach(() => {
  cleanup();
});

function draw(
  overrides: Partial<ConfirmationPromptCardProps["confirmation"]> = {},
  props: Partial<ConfirmationPromptCardProps> = {},
) {
  const onSubmit = mock((_decision: string) => {});
  render(
    <ConfirmationPromptCard
      confirmation={{
        requestId: "req-1",
        toolName: "host_bash",
        riskLevel: "medium",
        riskReason: "Runs a shell command",
        input: { command: "ls" },
        persistentDecisionsAllowed: true,
        ...overrides,
      }}
      isSubmitting={false}
      onSubmit={onSubmit as never}
      {...props}
    />,
  );
  return { onSubmit };
}

describe("two-group layout", () => {
  test("renders both groups with their labels", () => {
    draw();
    expect(screen.getByText("Approve all actions")).toBeTruthy();
    expect(screen.getByText("This action only")).toBeTruthy();
    expect(
      document.querySelector('[data-slot="approve-all-actions-group"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-slot="this-action-only-group"]'),
    ).toBeTruthy();
  });

  test("the timed tiers submit allow_10m and allow_conversation", () => {
    const { onSubmit } = draw();
    fireEvent.click(
      screen.getByRole("button", { name: "Allow for 10 minutes" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Allow for this conversation" }),
    );
    expect(onSubmit.mock.calls.map((c) => c[0])).toEqual([
      "allow_10m",
      "allow_conversation",
    ]);
  });

  test("the single-action verbs submit allow and deny", () => {
    const { onSubmit } = draw();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Don't allow" }));
    expect(onSubmit.mock.calls.map((c) => c[0])).toEqual(["allow", "deny"]);
  });

  test("fresh-approval prompts (persistentDecisionsAllowed: false) hide the grant group", () => {
    draw({ persistentDecisionsAllowed: false });
    expect(screen.queryByText("Approve all actions")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Allow for 10 minutes" }),
    ).toBeNull();
    // The single-action verbs are unaffected.
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't allow" })).toBeTruthy();
  });

  test("the details expander stays", () => {
    draw();
    expect(screen.queryByText(/"command": "ls"/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /show details/i }));
    expect(screen.getByText(/"command": "ls"/)).toBeTruthy();
  });

  test("the make-this-a-rule affordance stays", () => {
    draw();
    expect(screen.getByText("→ Make this a rule")).toBeTruthy();
  });

  test("the Allow & Create Rule split menu stays when allowlist options exist", () => {
    const onAllowAndCreateRule = mock(() => {});
    draw(
      {
        allowlistOptions: [
          { label: "ls", description: "list", pattern: "bash:ls*" },
        ],
      },
      { onAllowAndCreateRule },
    );
    fireEvent.click(screen.getByRole("button", { name: "More allow options" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Allow & Create Rule" }),
    );
    expect(onAllowAndCreateRule).toHaveBeenCalledTimes(1);
  });
});
