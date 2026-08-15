/**
 * The Create surface renders the elicitation form on template CLICK — before
 * any run — for templates that carry `elicit`, and fires instantly for those
 * that don't. This is the wiring the shipped bug missed: the old path only
 * added a model directive on one button path and relied on the model to ask.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts).
 * `useActiveBrand`'s query stays disabled without an active assistant, so a
 * bare QueryClientProvider is all the context CreateView needs.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { CreateView } from "./create-view";
import { TEMPLATE_DEFINITIONS } from "./create-form-templates";

afterEach(() => {
  cleanup();
});

function renderView(onRunPrompt = mock((_: string) => {})) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <CreateView onRunPrompt={onRunPrompt} />
    </QueryClientProvider>,
  );
  return { onRunPrompt, ...utils };
}

/**
 * The quick-start card (a button) whose heading matches `title`. Form-template
 * cards can share a title, but they carry a "Fill & build" action — the
 * quick-start card doesn't — so exclude those.
 */
function quickStartCard(title: string): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => {
    const h3 = b.querySelector("h3");
    const titleMatches = h3?.textContent?.trim() === title;
    const isFormCard = b.textContent?.includes("Fill") ?? false;
    return titleMatches && !isFormCard;
  });
  if (!button) throw new Error(`no quick-start card titled "${title}"`);
  return button;
}

/** Switch the surface to a mode tab by its visible label. */
function switchMode(label: string): void {
  const tab = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
  ).find((b) => b.textContent?.trim() === label);
  if (!tab) throw new Error(`no mode tab labelled "${label}"`);
  fireEvent.click(tab);
}

describe("CreateView — client-side elicitation wiring", () => {
  test("clicking a template WITH elicit opens the question form before any run", () => {
    const { onRunPrompt } = renderView();
    // Default mode is Slides; "Investor pitch deck" carries elicit fields.
    fireEvent.click(quickStartCard("Investor pitch deck"));

    // The first elicitation question is on screen and nothing was sent.
    const questionShown = Array.from(document.querySelectorAll("div")).some(
      (el) => el.textContent === "Which round are you raising?",
    );
    expect(questionShown).toBe(true);
    expect(onRunPrompt).not.toHaveBeenCalled();
  });

  test("clicking a template WITHOUT elicit runs immediately", () => {
    const { onRunPrompt } = renderView();
    // Every Slides template is input-dependent and now carries `elicit`
    // (create-templates.test.ts pins that classification), so the stay-instant
    // path is exercised from a creative mode: "Hero image" has no elicit.
    switchMode("Images");
    fireEvent.click(quickStartCard("Hero image"));

    expect(onRunPrompt).toHaveBeenCalledTimes(1);
    const sent = onRunPrompt.mock.calls[0][0] as string;
    expect(sent.startsWith("Generate a striking hero/banner image")).toBe(true);
  });

  test("answering the form composes the values into the sent prompt", () => {
    const { onRunPrompt } = renderView();
    fireEvent.click(quickStartCard("Investor pitch deck"));

    // Accept all defaults in one tap.
    const useDefaults = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.includes("Use defaults"));
    if (!useDefaults) throw new Error("no 'Use defaults' button");
    fireEvent.click(useDefaults);

    expect(onRunPrompt).toHaveBeenCalledTimes(1);
    const sent = onRunPrompt.mock.calls[0][0] as string;
    expect(sent.startsWith("Build me an investor pitch deck")).toBe(true);
    // The default answers are baked into the prompt as concrete inputs.
    expect(sent).toContain("- Which round are you raising: Seed");
    expect(sent).toContain("- What sector: SaaS / software");
    // …and no style chip rides along: v29 deleted the "Visual direction?"
    // picker because the gallery shows the look (create-templates.test.ts
    // pins the catalog side).
    expect(sent).not.toContain("Visual direction");
  });
});

/**
 * v29 split the card's secondary label in two: "See the outline" where a real
 * skeleton exists (Slides, Docs), "What's in it" everywhere else, because
 * "outline" over-promised on eight types. The label is derived from
 * `template.outline`, so these tests pin both halves — the copy, and the data
 * that entitles the copy to appear.
 */
describe("Create — the secondary action names what you'll actually see", () => {
  /** Every visible label on the surface, trimmed. */
  function labels(): string[] {
    return Array.from(document.querySelectorAll("button, span"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean);
  }

  test("Slides templates offer the outline; the bare word Preview is gone", () => {
    renderView();
    const text = document.body.textContent ?? "";
    expect(text).toContain("See the outline");
    expect(labels()).not.toContain("Preview");
  });

  test("a mode with no skeleton says 'What's in it' instead", () => {
    renderView();
    // Images templates produce a picture, not a section list.
    switchMode("Images");
    const text = document.body.textContent ?? "";
    expect(text).toContain("What's in it");
    expect(text).not.toContain("See the outline");
  });

  test("only Slides and Docs carry an outline — the label can't outrun the data", () => {
    const withOutline = TEMPLATE_DEFINITIONS.filter(
      (t) => (t.outline?.length ?? 0) > 0,
    );
    expect(withOutline.length).toBeGreaterThan(0);
    expect([...new Set(withOutline.map((t) => t.mode))].sort()).toEqual([
      "docs",
      "slides",
    ]);
    // …and every Slides/Docs template has one, so the split is by mode in
    // practice as design specified, not a ragged per-template thing.
    const slidesAndDocs = TEMPLATE_DEFINITIONS.filter(
      (t) => t.mode === "slides" || t.mode === "docs",
    );
    expect(withOutline.length).toBe(slidesAndDocs.length);
  });

  test("the outline shown is the section list the model is asked for", () => {
    // One array, two uses. If someone edits the prompt sentence by hand the
    // sections stop matching and this fails — which is the whole point of
    // showing a skeleton rather than describing one.
    for (const t of TEMPLATE_DEFINITIONS) {
      if (!t.outline?.length) continue;
      const prompt = t.composePrompt({});
      expect(prompt).toContain(t.outline.join(", "));
    }
  });
});
