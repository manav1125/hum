/**
 * What is at risk here.
 *
 * These two cards are the only part of Create the user reads as a RESULT, so
 * they are where a lie would land hardest. Three specific lies are possible and
 * each one has a test:
 *
 * 1. **A failed build presented as a delivered artefact.** The worst case: a run
 *    that produced nothing shows a cover, an Open button and remix chips. The
 *    card must refuse this even when handed a malformed state that claims both
 *    at once — see the mutation check at the bottom, which builds exactly that
 *    state and asserts the card still shows a failure.
 * 2. **A no-op reported as a success.** A run that ends with no artefact must
 *    become a failure the user sees, not a silently empty card.
 * 3. **A fabricated build reading.** The pipeline emits no artefact ordinal, so
 *    the building card must never render "n of m" or a percentage, and its
 *    structural tiles must carry the sentence that says they are the template's
 *    skeleton and not the user's slides.
 *
 * Plus design's counting rules: the filing line is always present and always
 * true, and there is at most one adjacent offer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import {
  deliverBuild,
  failBuild,
  observeStep,
  startBuild,
  type BuildState,
} from "./create-build-model";
import { filingLine, type FilingDestination } from "./create-filing";
import { adjacentOfferFor, remixChipsFor } from "./create-followups";
import { CreateArtefactCard, CreateBuildingCard } from "./create-thread-cards";

afterEach(cleanup);

const CONVERSATION = "conv-1";
const ASSET = { name: "Northwind — Series A", mode: "slides" };

function baseState(): BuildState {
  return startBuild({
    conversationId: CONVERSATION,
    typeId: "slides",
    templateId: "startup",
    now: Date.now() - 50_000,
  });
}

function renderArtefact(state: BuildState, destination: FilingDestination) {
  return render(
    <CreateArtefactCard
      state={state}
      destination={destination}
      remixChips={remixChipsFor(state.typeId, ASSET)}
      offer={adjacentOfferFor(state.typeId, ASSET)}
      onOpen={() => {}}
      onShare={() => {}}
      onRemix={() => {}}
      onAcceptOffer={() => {}}
      onDeclineOffer={() => {}}
      onRetry={() => {}}
    />,
  );
}

/* --------------------------------------------------------------------- */
/* Delivery                                                              */
/* --------------------------------------------------------------------- */

describe("a delivered artefact", () => {
  const delivered = () =>
    deliverBuild(baseState(), {
      name: "Northwind — Series A",
      typeId: "slides",
      measure: "12 slides",
      openHref: "/apps/1",
    });

  test("renders the artefact with its real name and measure", () => {
    renderArtefact(delivered(), { conversationId: CONVERSATION });
    expect(screen.getByText("Northwind — Series A")).toBeDefined();
    expect(screen.getByText("12 slides")).toBeDefined();
    expect(screen.getByRole("button", { name: "Open" })).toBeDefined();
  });

  test("always states where it filed", () => {
    renderArtefact(delivered(), { conversationId: CONVERSATION });
    // The floor is provable and therefore never absent.
    expect(screen.getByText(/Filed in this thread/)).toBeDefined();
  });

  test("names the project and Library only when both are proven", () => {
    const floor: FilingDestination = { conversationId: CONVERSATION };
    expect(filingLine(floor)).toBe("Filed in this thread");

    const inLibrary: FilingDestination = {
      conversationId: CONVERSATION,
      library: { kind: "document", id: "doc-1" },
    };
    expect(filingLine(inLibrary)).toBe("Filed in Library · in this thread");

    const full: FilingDestination = {
      conversationId: CONVERSATION,
      library: { kind: "document", id: "doc-1" },
      project: "Close the seed",
    };
    expect(filingLine(full)).toBe("Filed onto Close the seed · in Library");
  });

  test("a project title is never invented from an unresolved id", () => {
    // An output row carrying a projectId we could not resolve must not produce
    // a project name — the line degrades instead.
    const line = filingLine({
      conversationId: CONVERSATION,
      library: { kind: "document", id: "doc-1" },
      project: undefined,
    });
    expect(line).not.toContain("onto");
  });

  test("renders exactly one adjacent offer", () => {
    renderArtefact(delivered(), { conversationId: CONVERSATION });
    // "Do it" is the accept control, and there is one offer block, so there is
    // exactly one of it. Two would be nagging.
    expect(screen.getAllByRole("button", { name: "Do it" })).toHaveLength(1);
  });

  test("the offer is derived from what the build touched", () => {
    const offer = adjacentOfferFor("slides", ASSET);
    expect(offer).not.toBeNull();
    expect(offer?.prompt).toContain("Northwind — Series A");
    // No offer at all is a valid outcome, and never a list.
    expect(adjacentOfferFor("audio", { name: "x", mode: "audio" })).toBeNull();
  });

  test("remix chips are type-specific, not generic", () => {
    const slides = remixChipsFor("slides", ASSET).map((c) => c.label);
    const docs = remixChipsFor("docs", { name: "Memo", mode: "docs" }).map(
      (c) => c.label,
    );
    const images = remixChipsFor("images", { name: "Hero", mode: "images" }).map(
      (c) => c.label,
    );
    expect(slides).toContain("Add a slide");
    expect(docs).toContain("Change the tone");
    expect(images).toContain("Upscale it");
    // The three sets are genuinely different.
    expect(slides).not.toEqual(docs);
    expect(docs).not.toEqual(images);
  });

  test("every reseed chip carries a real instruction", () => {
    for (const chip of remixChipsFor("slides", ASSET)) {
      if (chip.action.kind === "reseed") {
        expect(chip.action.prompt.length).toBeGreaterThan(20);
      } else {
        expect(chip.action.typeId).toBeTruthy();
      }
    }
  });
});

/* --------------------------------------------------------------------- */
/* Failure                                                               */
/* --------------------------------------------------------------------- */

describe("a failed build", () => {
  const failed = () =>
    failBuild(baseState(), {
      message: "Replicate rejected the request — no API token is configured.",
      retryable: true,
    });

  test("renders as a failure, in Cue's own words", () => {
    renderArtefact(failed(), { conversationId: CONVERSATION });
    expect(screen.getByText(/couldn't finish/i)).toBeDefined();
    expect(screen.getByText(/no API token is configured/)).toBeDefined();
  });

  test("shows no success affordances", () => {
    renderArtefact(failed(), { conversationId: CONVERSATION });
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Do it" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a slide" })).toBeNull();
  });

  test("never claims a filing destination", () => {
    renderArtefact(failed(), { conversationId: CONVERSATION });
    expect(screen.queryByText(/Filed/)).toBeNull();
  });

  test("a run that ends with no artefact is a failure, not a success", () => {
    // A no-op is not a success: delivering nothing routes to the failure path.
    const state = deliverBuild(baseState(), null);
    expect(state.phase).toBe("failed");
    expect(state.artefact).toBeNull();
    expect(state.failure?.message).toContain("didn't produce a file");
  });

  test("failure is terminal — a late delivery cannot resurrect it", () => {
    const state = deliverBuild(failed(), {
      name: "Northwind — Series A",
      typeId: "slides",
    });
    expect(state.phase).toBe("failed");
    expect(state.artefact).toBeNull();
  });

  /**
   * MUTATION CHECK.
   *
   * The state below is the bug this whole file guards: `phase: "failed"` while
   * an artefact is attached — precisely what a regression that "helpfully" kept
   * the last artefact around on failure would produce. If the card branched on
   * the artefact's presence instead of the phase, it would render a cover, an
   * Open button and a filing line for a run that produced nothing.
   *
   * Deleting the phase check in `CreateArtefactCard` turns this test red.
   */
  test("a card handed a failed state WITH an artefact still refuses to claim success", () => {
    const mutant: BuildState = {
      ...failed(),
      artefact: {
        name: "Northwind — Series A",
        typeId: "slides",
        measure: "12 slides",
        openHref: "/apps/1",
      },
    };
    renderArtefact(mutant, {
      conversationId: CONVERSATION,
      library: { kind: "document", id: "doc-1" },
      project: "Close the seed",
    });

    expect(screen.getByText(/couldn't finish/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.queryByText("12 slides")).toBeNull();
    expect(screen.queryByText(/Filed onto Close the seed/)).toBeNull();
  });
});

/* --------------------------------------------------------------------- */
/* Building                                                              */
/* --------------------------------------------------------------------- */

describe("the building card", () => {
  test("narrates the real step it was given", () => {
    const state = observeStep(baseState(), "writing the traction slide");
    render(<CreateBuildingCard state={state} />);
    expect(screen.getByText(/writing the traction slide/)).toBeDefined();
  });

  test("says something honest before the first step arrives", () => {
    render(<CreateBuildingCard state={baseState()} />);
    expect(screen.getByText("Starting…")).toBeDefined();
  });

  test("renders no ordinal and no percentage", () => {
    const state = observeStep(baseState(), "writing the traction slide");
    const { container } = render(<CreateBuildingCard state={state} />);
    const text = container.textContent ?? "";
    // No "7 of 12", no "58%" — the pipeline emits neither, so neither is shown.
    expect(text).not.toMatch(/\d+\s*(of|\/)\s*\d+/);
    expect(text).not.toMatch(/\d+\s*%/);
  });

  test("labels its structural tiles as the template skeleton", () => {
    const state = observeStep(baseState(), "writing the traction slide");
    render(<CreateBuildingCard state={state} />);
    // Rule B: a preview that is not a real generation must say what it is.
    expect(screen.getByText(/Template structure/)).toBeDefined();
  });

  test("promises the run can be left, which the conversation id makes true", () => {
    const state = baseState();
    render(<CreateBuildingCard state={state} />);
    expect(screen.getByText(/You can leave/)).toBeDefined();
    expect(state.conversationId).toBe(CONVERSATION);
  });

  test("stops rendering once the run is over", () => {
    const done = deliverBuild(baseState(), { name: "Deck", typeId: "slides" });
    const { container } = render(<CreateBuildingCard state={done} />);
    expect(container.textContent).toBe("");
  });
});
