import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div>{content}</div>
  ),
}));

import { CardSurface } from "@/domains/chat/components/surfaces/card-surface";
import {
  CHANNEL_SHOWCASE_METADATA,
  ChannelShowcaseDisplay,
  parseChannelShowcase,
} from "@/domains/chat/components/surfaces/channel-showcase-display";
import { SURFACE_PROMPT_SUBMIT_EVENT } from "@/domains/chat/components/surfaces/surface-prompt-submit";
import type { Surface } from "@/domains/chat/types/types";

afterAll(() => {
  mock.restore();
});

afterEach(() => {
  cleanup();
});

const TEMPLATE_DATA = {
  intro: "You can reach me on any of these.",
  channels: [
    { id: "slack", status: "live" },
    { id: "telegram", status: "available" },
    { id: "whatsapp", status: "available" },
  ],
};

function makeSurface(templateData: Record<string, unknown>): Surface {
  return {
    surfaceId: "surface-channels",
    surfaceType: "card",
    data: {
      title: "How to reach me",
      body: "Slack is live; more channels are one setup away.",
      template: "channel_showcase",
      templateData,
    },
  };
}

describe("parseChannelShowcase", () => {
  test("keeps known channels, dropping unknown ids and duplicates", () => {
    const parsed = parseChannelShowcase({
      channels: [
        { id: "slack", status: "live" },
        { id: "slack", status: "available" },
        { id: "carrier-pigeon", status: "available" },
        { id: "email" },
        "not-an-object",
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.channels).toEqual([
      { id: "slack", label: undefined, status: "live" },
      { id: "email", label: undefined, status: "available" },
    ]);
  });

  test("returns null when channels is missing or yields no known rows", () => {
    expect(parseChannelShowcase({})).toBeNull();
    expect(parseChannelShowcase({ channels: "nope" })).toBeNull();
    expect(
      parseChannelShowcase({ channels: [{ id: "carrier-pigeon" }] }),
    ).toBeNull();
  });
});

describe("ChannelShowcaseDisplay", () => {
  test("live channels get a LIVE pill; available ones get a Set up button", () => {
    const { getByText, getAllByText } = render(
      <ChannelShowcaseDisplay
        templateData={TEMPLATE_DATA}
        fallback={<div>fallback body</div>}
      />,
    );

    expect(getByText("You can reach me on any of these.")).toBeTruthy();
    expect(getByText("Slack")).toBeTruthy();
    expect(getByText("LIVE")).toBeTruthy();
    // Two available channels → two Set up buttons; the live one has none.
    expect(getAllByText("Set up")).toHaveLength(2);
  });

  test("Set up submits the channel's guardian setup seed prompt", () => {
    const prompts: string[] = [];
    const listener = (event: Event) => {
      prompts.push((event as CustomEvent<{ prompt: string }>).detail.prompt);
    };
    window.addEventListener(SURFACE_PROMPT_SUBMIT_EVENT, listener);
    try {
      const { getAllByText } = render(
        <ChannelShowcaseDisplay
          templateData={TEMPLATE_DATA}
          fallback={<div>fallback body</div>}
        />,
      );

      // First available row is telegram.
      fireEvent.click(getAllByText("Set up")[0]);

      expect(prompts).toEqual([
        CHANNEL_SHOWCASE_METADATA.telegram.setupPrompt,
      ]);
    } finally {
      window.removeEventListener(SURFACE_PROMPT_SUBMIT_EVENT, listener);
    }
  });

  test("always appends the static interface rows", () => {
    const { getByText } = render(
      <ChannelShowcaseDisplay
        templateData={TEMPLATE_DATA}
        fallback={<div>fallback body</div>}
      />,
    );

    expect(getByText("Also available on")).toBeTruthy();
    expect(getByText("Desktop app")).toBeTruthy();
    expect(getByText("Web")).toBeTruthy();
    expect(getByText("iOS")).toBeTruthy();
    expect(getByText("CLI")).toBeTruthy();
  });

  test("degrades to the fallback body when template data is malformed", () => {
    const { getByText, queryByText } = render(
      <ChannelShowcaseDisplay
        templateData={{ channels: [{ id: "carrier-pigeon" }] }}
        fallback={<div>fallback body</div>}
      />,
    );

    expect(getByText("fallback body")).toBeTruthy();
    expect(queryByText("Set up")).toBeNull();
    expect(queryByText("Also available on")).toBeNull();
  });
});

describe("CardSurface channel_showcase dispatch", () => {
  test("a card advertising the template renders the showcase rows", async () => {
    const { findByText } = render(
      <CardSurface
        surface={makeSurface(TEMPLATE_DATA)}
        onAction={() => undefined}
      />,
    );

    // Lazy chunk: wait for the template renderer to resolve.
    expect(await findByText("Slack")).toBeTruthy();
    expect(await findByText("LIVE")).toBeTruthy();
    expect(await findByText("How to reach me")).toBeTruthy();
  });
});
