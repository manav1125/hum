/**
 * "That bubble is the whole product" — and its two constraints are the point.
 * Two is nagging; unrelated is creepy.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import {
  parseAdjacentOffer,
  selectAdjacentOffer,
  suppressedOfferSurfaceIds,
} from "@/domains/chat/partner/adjacent-offer";
import { AdjacentOfferRow } from "@/domains/chat/partner/adjacent-offer-row";
import type { AnswerSource } from "@/domains/chat/partner/answer-sources";
import { isSurfaceInteractive } from "@/domains/chat/types/types";
import type { Surface } from "@/domains/chat/types/types";

afterEach(() => {
  cleanup();
});

function offer(surfaceId: string, note: string, from?: string): Surface {
  return {
    surfaceId,
    surfaceType: "adjacent_offer",
    data: { note, ...(from ? { from } : {}) },
    actions: [{ id: "chase", label: "Chase it too" }],
  } as Surface;
}

const mailSource: AnswerSource = {
  id: "tc-1",
  family: "mail",
  label: "your email",
  toolName: "gmail__GMAIL_FETCH_EMAILS",
};

describe("selectAdjacentOffer", () => {
  test("at most one offer per turn", () => {
    const surfaces = [
      offer(
        "o1",
        "The security questionnaire is still open with Rachel, six days now.",
      ),
      offer("o2", "Also, the Halo invoice is unpaid."),
      offer("o3", "And Sarah asked twice about the data room."),
    ];
    expect(selectAdjacentOffer(surfaces, [])!.surface.surfaceId).toBe("o1");
    expect([...suppressedOfferSurfaceIds(surfaces, [])]).toEqual(["o2", "o3"]);
  });

  test("an offer from something the turn never touched is dropped", () => {
    // Cue read the user's mail this turn. An offer claiming to come from the
    // CRM is a general sweep wearing an adjacency costume.
    const surfaces = [offer("o1", "Three deals went cold in the CRM.", "crm")];
    expect(selectAdjacentOffer(surfaces, [mailSource])).toBeNull();
    expect([...suppressedOfferSurfaceIds(surfaces, [mailSource])]).toEqual([
      "o1",
    ]);
  });

  test("an offer from what the turn did touch is kept", () => {
    const surfaces = [
      offer(
        "o1",
        "Rachel's questionnaire is still open, six days now.",
        "mail",
      ),
    ];
    expect(selectAdjacentOffer(surfaces, [mailSource])!.note).toContain(
      "six days",
    );
  });

  test("when a verifiable offer follows an unverifiable one, the first still wins", () => {
    // We drop only on a positive contradiction; we never invent a reason.
    const surfaces = [
      offer("o1", "Rachel's questionnaire is still open."),
      offer("o2", "The Halo invoice is unpaid.", "mail"),
    ];
    expect(selectAdjacentOffer(surfaces, [mailSource])!.surface.surfaceId).toBe(
      "o1",
    );
  });

  test("no offers means no offer", () => {
    expect(selectAdjacentOffer([], [])).toBeNull();
    expect(suppressedOfferSurfaceIds([], []).size).toBe(0);
  });

  test("an offer with nothing to say is not an offer", () => {
    expect(
      parseAdjacentOffer({
        surfaceId: "o1",
        surfaceType: "adjacent_offer",
        data: {},
      } as Surface),
    ).toBeNull();
  });
});

describe("AdjacentOfferRow", () => {
  test("renders the remark and its verb", () => {
    const { getByTestId, getByText } = render(
      <AdjacentOfferRow
        surface={offer(
          "o1",
          "Rachel's questionnaire is still open, six days now.",
        )}
        onAction={() => {}}
      />,
    );
    expect(getByTestId("adjacent-offer").textContent).toContain("six days now");
    expect(getByText("Chase it too")).toBeTruthy();
  });

  test("the conversation never blocks on it", () => {
    // It has buttons. It is still not a gate — an offer must never park the
    // turn in `awaiting_user_input` over something the user never asked about.
    expect(isSurfaceInteractive(offer("o1", "note"))).toBe(false);
  });
});
