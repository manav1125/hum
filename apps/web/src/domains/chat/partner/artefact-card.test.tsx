/**
 * The artefact card, and the one thing about it that must never regress: a
 * card with Send on it cannot cause a send.
 *
 * A background run once emailed a partner with nobody approving it. The card's
 * only outward edge is `onAction`, which asks the daemon to run the tool; the
 * tool then hits the hard checkpoint in `assistant/src/tools/outbound-send.ts`,
 * which no trust level can clear. The tests below pin that shape — the card
 * never claims a send happened, and it holds no path that could make one.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ArtefactCard } from "@/domains/chat/partner/artefact-card";
import {
  classifyVerb,
  isGatedVerb,
  parseArtefact,
} from "@/domains/chat/partner/artefact";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import { isSurfaceInteractive } from "@/domains/chat/types/types";
import type { Surface } from "@/domains/chat/types/types";

afterEach(() => {
  cleanup();
});

function draftEmail(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "artefact-1",
    surfaceType: "artefact",
    title: "Renewal terms for Northwind",
    data: {
      kind: "Email",
      title: "Renewal terms for Northwind",
      fields: [
        { label: "To", value: "dana@example.com" },
        { label: "Subject", value: "Renewal terms" },
      ],
      body: "$47 a seat on a 24-month term.",
    },
    actions: [
      { id: "send", label: "Send", style: "primary" },
      { id: "edit", label: "Edit" },
    ],
    ...overrides,
  } as Surface;
}

describe("classifyVerb", () => {
  test("the outbound classes match the daemon's hard-checkpoint list", () => {
    expect(classifyVerb("Send")).toBe("send");
    expect(classifyVerb("Reply to Dana")).toBe("send");
    expect(classifyVerb("Call Rachel")).toBe("contact");
    expect(classifyVerb("Pay the invoice")).toBe("money");
    expect(classifyVerb("Publish")).toBe("publish");
    expect(classifyVerb("Delete the record")).toBe("delete");
    expect(classifyVerb("Buy the seats")).toBe("purchase");
  });

  test("preparing something is not doing it", () => {
    expect(isGatedVerb("Save draft")).toBe(false);
    expect(isGatedVerb("Schedule it")).toBe(false);
    expect(isGatedVerb("File under Renew Acme")).toBe(false);
    expect(isGatedVerb("Open")).toBe(false);
  });
});

describe("parseArtefact", () => {
  test("a card with nothing to say is not rendered", () => {
    expect(
      parseArtefact({
        surfaceId: "x",
        surfaceType: "artefact",
        data: {},
      } as Surface),
    ).toBeNull();
  });

  test("flags the card as gated when any verb on it reaches outside", () => {
    expect(parseArtefact(draftEmail())!.hasGatedAction).toBe(true);
    const safe = draftEmail({
      actions: [{ id: "save", label: "Save draft", style: "primary" }],
    } as Partial<Surface>);
    expect(parseArtefact(safe)!.hasGatedAction).toBe(false);
  });
});

describe("ArtefactCard", () => {
  test("work arrives as a card carrying its verb, not as prose", () => {
    const { getByTestId, getByText } = render(
      <ArtefactCard surface={draftEmail()} onAction={() => {}} />,
    );
    const card = getByTestId("artefact-card");
    expect(card).toBeTruthy();
    // The verb is on the card.
    expect(getByText("Send")).toBeTruthy();
    // …and so are the artefact's own facts, as fields — nothing to copy out.
    expect(card.textContent).toContain("dana@example.com");
    expect(card.textContent).toContain("Renewal terms");
  });

  test("says the send needs approval before the button is ever pressed", () => {
    const { getByTestId } = render(
      <ArtefactCard surface={draftEmail()} onAction={() => {}} />,
    );
    expect(getByTestId("artefact-approval-note").textContent).toContain(
      "You approve it before it leaves",
    );
  });

  test("a send artefact cannot fire without approval: the click only asks", async () => {
    const onAction = mock(() => Promise.resolve());
    const { getByText, getByTestId, queryByText } = render(
      <ArtefactCard surface={draftEmail()} onAction={onAction} />,
    );

    fireEvent.click(getByText("Send"));

    await waitFor(() => {
      expect(getByTestId("artefact-awaiting")).toBeTruthy();
    });
    // The one and only outward edge, with the surface's own ids.
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith("artefact-1", "send", undefined);
    // And it never claims the thing happened.
    expect(getByTestId("artefact-awaiting").textContent).toContain(
      "Waiting on your approval",
    );
    expect(queryByText("Sent")).toBeNull();
    expect(getByTestId("artefact-card").textContent).not.toMatch(/\bsent\b/i);
  });

  test("only the server may say it is done", () => {
    const { getByTestId } = render(
      <ArtefactCard
        surface={draftEmail({
          completed: true,
          completionSummary: "Sent to Dana",
        } as Partial<Surface>)}
        onAction={() => {}}
      />,
    );
    expect(getByTestId("artefact-card").textContent).toContain("Sent to Dana");
  });

  test("a non-gated verb carries no approval note and no approval claim", async () => {
    const onAction = mock(() => Promise.resolve());
    const surface = draftEmail({
      surfaceId: "artefact-2",
      actions: [{ id: "save", label: "Save draft", style: "primary" }],
    } as Partial<Surface>);
    const { getByText, getByTestId, queryByTestId } = render(
      <ArtefactCard surface={surface} onAction={onAction} />,
    );
    expect(queryByTestId("artefact-approval-note")).toBeNull();
    fireEvent.click(getByText("Save draft"));
    await waitFor(() => {
      expect(getByTestId("artefact-awaiting").textContent).toContain(
        "Working on it",
      );
    });
  });

  test("the router reaches it, and the turn waits on the user for it", () => {
    const surface = draftEmail();
    const { getByTestId } = render(
      <SurfaceRouter surface={surface} onAction={() => {}} />,
    );
    expect(getByTestId("artefact-card")).toBeTruthy();
    // A card with Send on it genuinely IS the user's move — the live status
    // should read "Waiting on you", not "Working".
    expect(isSurfaceInteractive(surface)).toBe(true);
  });

  test("never praises its own output", () => {
    const { getByTestId } = render(
      <ArtefactCard surface={draftEmail()} onAction={() => {}} />,
    );
    expect(getByTestId("artefact-card").textContent).not.toMatch(
      /great|happy to|perfect|awesome|all set!/i,
    );
  });
});
