/**
 * Acceptance — the only door from a proposal to work.
 *
 * What matters here is that the ✓ does exactly what the chip promised, that
 * the provenance pill rides along on the work item, and that a double-tap on
 * a spring-animated card cannot mint two tasks.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  haloDays,
  haloEpisodes,
  haloProposals,
  haloSegments,
} from "../memory/schema.js";
import { getWorkItem } from "../work-items/work-item-store.js";
import { acceptHaloProposal, dismissHaloProposal } from "./halo-accept.js";
import {
  createEpisode,
  createProposal,
  ensureDay,
  forgetEpisode,
  getProposal,
  readTrustLedger,
} from "./halo-store.js";

initializeDb();

const T0 = Date.UTC(2026, 7, 30, 10, 31, 0);

function seedProposal() {
  const dayId = ensureDay("2026-08-30");
  const episodeId = createEpisode({
    dayId,
    chapterIndex: 1,
    startedAt: T0,
    endedAt: T0 + 600_000,
    placeLabel: "Verve",
  });
  const proposalId = createProposal({
    dayId,
    episodeId,
    title: "Send the one-pager to Dana by Thursday",
    verb: "file",
    destinationLabel: "Renew Acme",
    destinationRef: "project:acme",
    heard: {
      quote: "I'll get you the one-pager before Thursday",
      at: T0,
      place: "Verve",
      speaker: "You",
    },
  });
  return { dayId, episodeId, proposalId };
}

beforeEach(() => {
  const db = getDb();
  for (const table of [haloProposals, haloEpisodes, haloSegments, haloDays]) {
    db.delete(table).run();
  }
});

describe("accepting", () => {
  test("mints work carrying the heard pill", async () => {
    const { episodeId, proposalId } = seedProposal();
    const outcome = await acceptHaloProposal(proposalId);
    expect(outcome.status).toBe("accepted");

    const workItem = getWorkItem(
      (outcome as { workItemId: string }).workItemId,
    )!;
    expect(workItem.title).toBe("Send the one-pager to Dana by Thursday");
    expect(workItem.haloEpisodeId).toBe(episodeId);

    const heard = JSON.parse(workItem.haloHeard!);
    expect(heard.quote).toContain("one-pager");
    expect(heard.place).toBe("Verve");
    expect(heard.speaker).toBe("You");
  });

  test("acceptance never launches the work by itself", async () => {
    // Parked-and-propose: the ✓ files it; it does not run it.
    const { proposalId } = seedProposal();
    const outcome = await acceptHaloProposal(proposalId);
    const workItem = getWorkItem(
      (outcome as { workItemId: string }).workItemId,
    )!;
    expect(workItem.autoRunEligibility).toBe("parked");
  });

  test("the proposal records which work item it became", async () => {
    const { proposalId } = seedProposal();
    const outcome = await acceptHaloProposal(proposalId);
    const proposal = getProposal(proposalId)!;
    expect(proposal.state).toBe("accepted");
    expect(proposal.workItemId).toBe(
      (outcome as { workItemId: string }).workItemId,
    );
  });

  test("a double-tap returns the first item, never a second", async () => {
    // A spring animation plus a 5s undo pill makes this easy to do by hand.
    const { proposalId } = seedProposal();
    const first = await acceptHaloProposal(proposalId);
    const second = await acceptHaloProposal(proposalId);

    expect(second.status).toBe("already_decided");
    expect((second as { workItemId: string }).workItemId).toBe(
      (first as { workItemId: string }).workItemId,
    );
  });

  test("the pill survives the episode being forgotten", async () => {
    // An audit trail that vanishes with its source is not an audit trail.
    const { episodeId, proposalId } = seedProposal();
    const outcome = await acceptHaloProposal(proposalId);
    forgetEpisode(episodeId);

    const workItem = getWorkItem(
      (outcome as { workItemId: string }).workItemId,
    )!;
    expect(JSON.parse(workItem.haloHeard!).quote).toContain("one-pager");
    // And the work itself is untouched — forgetting a day deletes memories,
    // not commitments.
    expect(workItem.title).toBe("Send the one-pager to Dana by Thursday");
  });

  test("a draft chip opens the composer instead of docking", async () => {
    // S6 ruling 3: the thing that docks has to be the real artifact, so the
    // dock waits for send or park rather than firing on ✓.
    const dayId = ensureDay("2026-08-30");
    const proposalId = createProposal({
      dayId,
      title: "Draft the reply to Dana",
      verb: "draft",
      destinationLabel: "Dana",
    });
    const outcome = await acceptHaloProposal(proposalId);
    expect(outcome).toMatchObject({
      status: "accepted",
      presentation: "composer",
    });
  });

  test("every other verb docks immediately", async () => {
    const { proposalId } = seedProposal();
    const outcome = await acceptHaloProposal(proposalId);
    expect(outcome).toMatchObject({ presentation: "dock" });
  });

  test("a missing proposal is reported, not thrown", async () => {
    expect(await acceptHaloProposal("nope")).toEqual({ status: "not_found" });
  });
});

describe("dismissing", () => {
  test("is recorded, because ✕ only teaches if it is data", () => {
    const { proposalId } = seedProposal();
    dismissHaloProposal(proposalId);

    expect(getProposal(proposalId)!.state).toBe("dismissed");
    expect(readTrustLedger()).toMatchObject({ dismissed: 1, accepted: 0 });
  });

  test("cannot un-decide something already accepted", async () => {
    const { proposalId } = seedProposal();
    await acceptHaloProposal(proposalId);
    const outcome = dismissHaloProposal(proposalId);
    expect(outcome).toMatchObject({
      status: "already_decided",
      state: "accepted",
    });
    expect(getProposal(proposalId)!.state).toBe("accepted");
  });
});
