/**
 * The create path in the trust rule form.
 *
 * Until now this modal could only edit an existing rule's risk and
 * description, and rules only came into existence by classifying an action
 * from a permission prompt. A tool that never prompts — a browser write op,
 * which the interactive threshold already auto-approves — therefore had no
 * way to get a rule at all, which is why a background run could not be
 * granted the click it needed.
 *
 * These tests pin the create path and, more importantly, the exact body it
 * sends: a whole-tool rule names one tool and carries the literal `*`, so it
 * cannot be read as a grant over anything else.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const addCalls: Array<{ assistantId: string; body: unknown }> = [];
const updateCalls: Array<{ ruleId: string; body: unknown }> = [];

mock.module("@/lib/trust-rules-api", () => ({
  addTrustRule: async (assistantId: string, body: unknown) => {
    addCalls.push({ assistantId, body });
  },
  updateTrustRule: async (
    _assistantId: string,
    ruleId: string,
    body: unknown,
  ) => {
    updateCalls.push({ ruleId, body });
  },
}));

const { TrustRuleFormModal } =
  await import("@/components/trust-rules/trust-rule-form-modal");

afterEach(() => {
  cleanup();
  addCalls.length = 0;
  updateCalls.length = 0;
});

function renderCreateForm() {
  return render(
    <TrustRuleFormModal
      assistantId="asst_1"
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
}

function selectTool(container: HTMLElement, tool: string) {
  const trigger = container.querySelector('[role="combobox"]');
  if (!trigger) throw new Error("tool dropdown not found");
  fireEvent.click(trigger);
  const option = Array.from(container.querySelectorAll('[role="option"]')).find(
    (el) => el.textContent?.trim() === tool,
  );
  if (!option) throw new Error(`tool option not found: ${tool}`);
  fireEvent.click(option);
}

function submit(getByText: (text: string) => HTMLElement) {
  fireEvent.click(getByText("Save"));
}

describe("creating a trust rule", () => {
  test("a browser write op is saved as a whole-tool rule", async () => {
    const { baseElement, getByText } = renderCreateForm();

    selectTool(baseElement as HTMLElement, "browser_click");
    submit(getByText);

    await waitFor(() => expect(addCalls.length).toBe(1));
    expect(addCalls[0].assistantId).toBe("asst_1");
    expect(addCalls[0].body).toMatchObject({
      tool: "browser_click",
      pattern: "*",
      risk: "low",
    });
  });

  test("the rule names exactly one tool", async () => {
    const { baseElement, getByText } = renderCreateForm();

    selectTool(baseElement as HTMLElement, "browser_type");
    submit(getByText);

    await waitFor(() => expect(addCalls.length).toBe(1));
    const body = addCalls[0].body as { tool: string; pattern: string };
    expect(body.tool).toBe("browser_type");
    // Not a glob over the tool column, and not a wildcard risk grant.
    expect(body.pattern).toBe("*");
  });

  test("a classifier-backed tool still asks for a pattern", async () => {
    const { baseElement, getByText, getByPlaceholderText } = renderCreateForm();

    selectTool(baseElement as HTMLElement, "bash");
    // Nothing is saved while the pattern is empty — a whole-tool `*` must
    // never be inferred for a tool that scopes on a command.
    submit(getByText);
    expect(addCalls.length).toBe(0);

    fireEvent.change(getByPlaceholderText("e.g., git *"), {
      target: { value: "git status" },
    });
    submit(getByText);

    await waitFor(() => expect(addCalls.length).toBe(1));
    expect(addCalls[0].body).toMatchObject({
      tool: "bash",
      pattern: "git status",
    });
  });

  test("editing an existing rule still updates rather than creates", async () => {
    const { getByText } = render(
      <TrustRuleFormModal
        assistantId="asst_1"
        existingRule={{
          id: "rule_1",
          tool: "browser_click",
          pattern: "*",
          risk: "low",
          description: "unattended clicking",
          origin: "user_defined",
          userModified: false,
          deleted: false,
          createdAt: "",
          updatedAt: "",
        }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    submit(getByText);

    await waitFor(() => expect(updateCalls.length).toBe(1));
    expect(updateCalls[0].ruleId).toBe("rule_1");
    expect(addCalls.length).toBe(0);
  });
});
