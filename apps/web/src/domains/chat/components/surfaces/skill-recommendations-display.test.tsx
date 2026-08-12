import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div>{content}</div>
  ),
}));

import { CardSurface } from "@/domains/chat/components/surfaces/card-surface";
import {
  SkillRecommendationsDisplay,
  parseSkillRecommendations,
} from "@/domains/chat/components/surfaces/skill-recommendations-display";
import { SURFACE_PROMPT_SUBMIT_EVENT } from "@/domains/chat/components/surfaces/surface-prompt-submit";
import type { Surface } from "@/domains/chat/types/types";

afterAll(() => {
  mock.restore();
});

afterEach(() => {
  cleanup();
});

const TEMPLATE_DATA = {
  intro: "Here's where I can help right now.",
  skills: [
    {
      id: "inbox-management",
      title: "Inbox management",
      iconKey: "inbox",
      description: "Keep your inbox at zero without you reading the noise.",
      prompt: "Declutter my inbox",
      capabilities: ["Archive noise", "Surface threads that need you"],
      requirements: [
        { label: "Gmail", status: "ready" },
        { label: "Calendar", status: "connect", hint: "Optional" },
      ],
    },
    {
      id: "research",
      title: "Research",
      iconKey: "search",
      description: "Deep-dive any topic and return a brief.",
      prompt: "Research a topic for me",
    },
  ],
};

function makeSurface(templateData: Record<string, unknown>): Surface {
  return {
    surfaceId: "surface-skills",
    surfaceType: "card",
    data: {
      title: "What I can do for you",
      body: "A few skills that fit you best.",
      template: "skill_recommendations",
      templateData,
    },
  };
}

describe("parseSkillRecommendations", () => {
  test("keeps well-formed rows and drops rows missing a title or prompt", () => {
    const parsed = parseSkillRecommendations({
      skills: [
        ...TEMPLATE_DATA.skills,
        { id: "no-prompt", title: "Broken row" },
        { id: "no-title", prompt: "Do a thing" },
        "not-an-object",
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.skills.map((s) => s.id)).toEqual([
      "inbox-management",
      "research",
    ]);
  });

  test("returns null when skills is missing, not an array, or all-invalid", () => {
    expect(parseSkillRecommendations({})).toBeNull();
    expect(parseSkillRecommendations({ skills: "nope" })).toBeNull();
    expect(parseSkillRecommendations({ skills: [{ id: "x" }] })).toBeNull();
  });
});

describe("SkillRecommendationsDisplay", () => {
  test("renders collapsed rows with title and one-line description", () => {
    const { getByText, queryByText } = render(
      <SkillRecommendationsDisplay
        templateData={TEMPLATE_DATA}
        fallback={<div>fallback body</div>}
      />,
    );

    expect(getByText("Here's where I can help right now.")).toBeTruthy();
    expect(getByText("Inbox management")).toBeTruthy();
    expect(getByText("Research")).toBeTruthy();
    // Detail content stays hidden until a row is expanded.
    expect(queryByText("Let's do it")).toBeNull();
    expect(queryByText("Archive noise")).toBeNull();
    expect(queryByText("fallback body")).toBeNull();
  });

  test("expanding a row reveals requirements, capabilities, and the primary button", () => {
    const { getByText, getAllByRole } = render(
      <SkillRecommendationsDisplay
        templateData={TEMPLATE_DATA}
        fallback={<div>fallback body</div>}
      />,
    );

    fireEvent.click(getAllByRole("button", { expanded: false })[0]);

    expect(getByText("Here's what we'll need")).toBeTruthy();
    expect(getByText("Gmail")).toBeTruthy();
    expect(getByText("Calendar")).toBeTruthy();
    expect(getByText("Things we can do")).toBeTruthy();
    expect(getByText("Archive noise")).toBeTruthy();
    expect(getByText("Let's do it")).toBeTruthy();
  });

  test("Let's do it submits the row's Try-me prompt through the composer bridge", () => {
    const prompts: string[] = [];
    const listener = (event: Event) => {
      prompts.push((event as CustomEvent<{ prompt: string }>).detail.prompt);
    };
    window.addEventListener(SURFACE_PROMPT_SUBMIT_EVENT, listener);
    try {
      const { getByText, getAllByRole } = render(
        <SkillRecommendationsDisplay
          templateData={TEMPLATE_DATA}
          fallback={<div>fallback body</div>}
        />,
      );

      fireEvent.click(getAllByRole("button", { expanded: false })[0]);
      fireEvent.click(getByText("Let's do it"));

      expect(prompts).toEqual(["Declutter my inbox"]);
    } finally {
      window.removeEventListener(SURFACE_PROMPT_SUBMIT_EVENT, listener);
    }
  });

  test("degrades to the fallback body when template data is malformed", () => {
    const { getByText, queryByText } = render(
      <SkillRecommendationsDisplay
        templateData={{ skills: { item: [] } }}
        fallback={<div>fallback body</div>}
      />,
    );

    expect(getByText("fallback body")).toBeTruthy();
    expect(queryByText("Let's do it")).toBeNull();
  });
});

describe("CardSurface skill_recommendations dispatch", () => {
  test("a card advertising the template renders the recommendation rows", async () => {
    const { findByText } = render(
      <CardSurface
        surface={makeSurface(TEMPLATE_DATA)}
        onAction={() => undefined}
      />,
    );

    // Lazy chunk: wait for the template renderer to resolve.
    expect(await findByText("Inbox management")).toBeTruthy();
    expect(await findByText("What I can do for you")).toBeTruthy();
  });

  test("malformed template data falls back to the plain card body", async () => {
    const { findByText, queryByText } = render(
      <CardSurface surface={makeSurface({})} onAction={() => undefined} />,
    );

    expect(await findByText("A few skills that fit you best.")).toBeTruthy();
    await waitFor(() => {
      expect(queryByText("Inbox management")).toBeNull();
    });
  });
});
