/**
 * The elicitation form renders the question card BEFORE anything is sent, and
 * composing answers hands the caller a concrete prompt.
 *
 * This is the seam the shipped bug missed: the previous fix relied on the model
 * to ask first (and it didn't). Here the form is a pre-send client step — the
 * `onSubmit` fires only after the user answers or accepts defaults, and it
 * carries the composed prompt with the chosen values baked in.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TemplateElicitForm } from "./create-elicit-form";
import type { CreateTemplate } from "./create-templates";

afterEach(() => {
  cleanup();
});

const TEMPLATE: CreateTemplate = {
  id: "financial-model",
  title: "SaaS financial model",
  description: "3-year model with live formulas.",
  prompt: "Build me a SaaS financial model.",
  elicit: [
    {
      question: "What stage are you modelling from?",
      options: [
        { label: "Seed", isDefault: true },
        { label: "Series A" },
      ],
    },
    {
      question: "Monthly churn rate?",
      options: [
        { label: "2% / month", isDefault: true },
        { label: "5% / month" },
      ],
    },
  ],
};

function optionButton(label: string): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.getAttribute("aria-label")?.startsWith(`Option`) && b.textContent?.includes(label));
  if (!button) throw new Error(`no option button for "${label}"`);
  return button;
}

describe("TemplateElicitForm", () => {
  test("renders the questions BEFORE any send", () => {
    const onSubmit = mock(() => {});
    render(
      <TemplateElicitForm
        template={TEMPLATE}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    // The first question and its flagged default are on screen; nothing sent.
    expect(screen.getByText("What stage are you modelling from?")).toBeDefined();
    expect(screen.getByText(/Seed \(default\)/)).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("clicking through the options composes the picked values into the prompt", () => {
    const onSubmit = mock((_: string) => {});
    render(
      <TemplateElicitForm
        template={TEMPLATE}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    // Answer q1 with the non-default, which advances to q2.
    fireEvent.click(optionButton("Series A"));
    // Answer q2 with the non-default → the batch auto-submits.
    fireEvent.click(optionButton("5% / month"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const composed = onSubmit.mock.calls[0][0] as string;
    expect(composed.startsWith("Build me a SaaS financial model.")).toBe(true);
    expect(composed).toContain("- What stage are you modelling from: Series A");
    expect(composed).toContain("- Monthly churn rate: 5% / month");
  });

  test("'Use defaults & generate' composes every default in one tap", () => {
    const onSubmit = mock((_: string) => {});
    render(
      <TemplateElicitForm
        template={TEMPLATE}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const useDefaults = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.includes("Use defaults"));
    if (!useDefaults) throw new Error("no 'Use defaults' button");
    fireEvent.click(useDefaults);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const composed = onSubmit.mock.calls[0][0] as string;
    expect(composed).toContain("- What stage are you modelling from: Seed");
    expect(composed).toContain("- Monthly churn rate: 2% / month");
  });

  test("Back cancels without sending", () => {
    const onSubmit = mock(() => {});
    const onCancel = mock(() => {});
    render(
      <TemplateElicitForm
        template={TEMPLATE}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByLabelText("Back"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
