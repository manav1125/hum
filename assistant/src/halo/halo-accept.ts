/**
 * Accepting a proposal — the only place a Halo proposal becomes work.
 *
 * `halo-store.ts` deliberately imports no work-item writer, so "nothing files
 * without acceptance" is a property of the module graph rather than a habit.
 * This module is the single exception, and it is small on purpose: one
 * function that writes work, one that records a dismissal.
 *
 * ## What the ✓ actually does
 *
 * The design's signature interaction is the dock: accepting visibly flies the
 * card into its named mission, and the destination is printed on the chip
 * *before* you accept. So acceptance must land the work where the chip said it
 * would — `destinationRef` is honoured, not re-decided here. A proposal whose
 * destination changed between being read and being tapped would make the
 * animation a lie.
 *
 * ## The pill travels
 *
 * `◉ heard · 10:31 · Verve` is stored on the work item itself, as JSON, not
 * looked up through the episode. It is one object doing two jobs — the
 * product's proof-of-magic and its audit trail — and both fail if it
 * disappears when the episode is forgotten. Same one-way rule as `noteId`:
 * the work remembers where it came from, and forgetting a day never deletes
 * somebody's commitments.
 *
 * ## The ✓ on a draft chip does not dock
 *
 * S6's third ruling: a `draft` verb runs the agent and opens the composer
 * with the real draft in it; the dock animation fires on **send or park**,
 * not on ✓, because the thing that docks has to be the real artifact. So
 * acceptance returns a `presentation` telling the client which of the two
 * happened. Without it the client would fly a card into a mission the moment
 * you tapped, and the funnel's promise — "done for you, *shown to you*" —
 * would be an animation over an empty box.
 *
 * ## Parked, always
 *
 * Work minted here is created and then triaged like any other, and the
 * autonomy default the design settles on is parked-and-propose. Acceptance is
 * the human act; it is not permission to run unattended.
 */

import { createTask } from "../tasks/task-store.js";
import { getLogger } from "../util/logger.js";
import { createWorkItemWithPermissions } from "../work-items/work-item-store.js";
import {
  conservativeRequiredToolsForCapture,
  triageAndMaybeAutoRunWorkItem,
} from "../work-items/work-item-triage.js";
import { decideProposal, getProposal } from "./halo-store.js";

const log = getLogger("halo-accept");

/** The provenance pill, as it rides on a work item. */
export interface HeardPill {
  quote: string | null;
  at: number | null;
  place: string | null;
  speaker: string | null;
}

/**
 * What the client should do with the acceptance it just made.
 *
 * `dock` — fly the card into its mission now; the work is the artifact.
 * `composer` — open the draft sheet instead and hold the dock until send or
 * park (S6 ruling 3).
 */
export type HaloAcceptPresentation = "dock" | "composer";

export type HaloAcceptOutcome =
  | {
      status: "accepted";
      workItemId: string;
      presentation: HaloAcceptPresentation;
    }
  | { status: "not_found" }
  /** Already decided. Idempotent: a double-tap must not mint a second item. */
  | { status: "already_decided"; state: string; workItemId: string | null };

/**
 * Turn one proposal into work.
 *
 * Idempotent on the proposal's state: tapping ✓ twice — which a spring
 * animation and a 5-second undo pill make easy — returns the first work item
 * rather than creating a second.
 */
export async function acceptHaloProposal(
  proposalId: string,
): Promise<HaloAcceptOutcome> {
  const proposal = getProposal(proposalId);
  if (!proposal) return { status: "not_found" };
  if (proposal.state !== "proposed") {
    return {
      status: "already_decided",
      state: proposal.state,
      workItemId: proposal.workItemId,
    };
  }

  const heard: HeardPill = {
    quote: proposal.heardQuote,
    at: proposal.heardAt,
    place: proposal.heardPlace,
    speaker: proposal.heardSpeaker,
  };

  const title = proposal.title;
  const task = createTask({ title, template: title });

  // The card's own words, so the item reads the way the proposal did.
  const notes = proposal.heardQuote
    ? `Heard: “${proposal.heardQuote}”`
    : "From your day";
  const requiredTools = conservativeRequiredToolsForCapture(title, notes);

  const workItem = createWorkItemWithPermissions({
    taskId: task.id,
    title,
    notes,
    priorityTier: 1,
    haloEpisodeId: proposal.episodeId ?? undefined,
    haloHeard: JSON.stringify(heard),
    // Parked-and-propose: acceptance files the work, it does not launch it.
    autoRunEligibility: "parked",
    ...(requiredTools ? { requiredTools } : {}),
  });

  decideProposal(proposalId, "accepted", workItem.id);

  // Triage decides filing and ranking; the parked flag above is what keeps it
  // from running on its own regardless of what triage concludes.
  try {
    await triageAndMaybeAutoRunWorkItem(workItem.id);
  } catch (err) {
    // The work exists and the proposal is decided. Triage failing means the
    // item is unfiled, not lost — never fail an acceptance the owner made.
    log.warn(
      { err, workItemId: workItem.id },
      "Halo triage failed after accept",
    );
  }

  // A draft is shown before it is filed; everything else docks on ✓.
  const presentation: HaloAcceptPresentation =
    proposal.verb === "draft" ? "composer" : "dock";

  log.info(
    {
      proposalId,
      workItemId: workItem.id,
      destination: proposal.destinationLabel,
      presentation,
    },
    "Halo proposal accepted",
  );

  return { status: "accepted", workItemId: workItem.id, presentation };
}

/**
 * Record a ✕.
 *
 * Dismissal is written rather than dropped because the design's queue footer
 * is a trust ledger — "34 accepted · 7 dismissed · Cue is learning your bar" —
 * and ✕ can only teach if it is data.
 */
export function dismissHaloProposal(proposalId: string): HaloAcceptOutcome {
  const proposal = getProposal(proposalId);
  if (!proposal) return { status: "not_found" };
  if (proposal.state !== "proposed") {
    return {
      status: "already_decided",
      state: proposal.state,
      workItemId: proposal.workItemId,
    };
  }
  decideProposal(proposalId, "dismissed");
  return { status: "already_decided", state: "dismissed", workItemId: null };
}
