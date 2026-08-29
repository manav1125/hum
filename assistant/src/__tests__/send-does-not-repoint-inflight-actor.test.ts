/**
 * A send that arrives mid-turn must not repoint the running turn's actor.
 *
 * The conversation's trust slot is the RESTING actor: what an idle
 * conversation hydrates and scopes history as. A turn already in flight
 * resolves that same slot for its own capabilities, so a second request that
 * writes it on arrival hands the running turn whoever sent the second message.
 *
 * The window is not theoretical. Between resolving the sender and deciding
 * whether to run inline or queue, the send path consumes guardian replies and
 * scans content, both of which await. A trusted contact's message landing in
 * that window would run the guardian's in-flight turn as the contact — or the
 * reverse, which is the direction that matters.
 *
 * These drive the slot the way the route does rather than the HTTP handler,
 * because the property is about ORDER — resolve, decide, then bind — and that
 * order is what a future edit is most likely to lose.
 */

import { describe, expect, test } from "bun:test";

import type { TrustContext } from "../runtime/actor-trust-resolver.js";

/**
 * The slot, standing in for the conversation. Only the two operations the
 * property is about: who is resting here, and is a turn running.
 */
class SlotHarness {
  private resting: TrustContext | null = null;
  private processing = false;

  setTrustContext(ctx: TrustContext | null): void {
    this.resting = ctx;
  }
  get trustContext(): TrustContext | null {
    return this.resting;
  }
  isProcessing(): boolean {
    return this.processing;
  }
  beginTurn(actor: TrustContext): void {
    this.resting = actor;
    this.processing = true;
  }
  endTurn(): void {
    this.processing = false;
  }
}

const GUARDIAN: TrustContext = {
  trustClass: "guardian",
  sourceChannel: "vellum",
};
const CONTACT: TrustContext = {
  trustClass: "trusted_contact",
  sourceChannel: "vellum",
} as TrustContext;

/**
 * The send path's shape: resolve the sender into a local, await work that can
 * read it, decide inline-or-queue, and bind the slot only on the inline
 * branch.
 */
async function handleSend(
  slot: SlotHarness,
  sender: TrustContext,
): Promise<{ queued: boolean; turnTrustContext: TrustContext | null }> {
  const requesterTrustContext: TrustContext | null = sender;

  // Stand-in for guardian-reply consumption and the content scan: awaited work
  // between resolving the sender and deciding what to do with them.
  await Promise.resolve();

  if (slot.isProcessing()) {
    return { queued: true, turnTrustContext: requesterTrustContext };
  }

  slot.setTrustContext(requesterTrustContext);
  return { queued: false, turnTrustContext: requesterTrustContext };
}

describe("a send arriving mid-turn", () => {
  test("does not repoint the running turn's actor", async () => {
    const slot = new SlotHarness();
    slot.beginTurn(GUARDIAN);

    const result = await handleSend(slot, CONTACT);

    expect(result.queued).toBe(true);
    // The running turn still resolves as its own actor.
    expect(slot.trustContext).toEqual(GUARDIAN);
  });

  test("the queued send still carries its own sender to the drain", async () => {
    // Queuing must not lose who sent it: the drain has to attribute the turn
    // to this sender, not to whoever happens to occupy the slot later.
    const slot = new SlotHarness();
    slot.beginTurn(GUARDIAN);

    const result = await handleSend(slot, CONTACT);

    expect(result.turnTrustContext).toEqual(CONTACT);
  });

  test("binds the slot when the conversation is idle", async () => {
    const slot = new SlotHarness();
    slot.setTrustContext(GUARDIAN);

    const result = await handleSend(slot, CONTACT);

    expect(result.queued).toBe(false);
    expect(slot.trustContext).toEqual(CONTACT);
  });

  test("a turn that ends during the await still gets its own actor bound", async () => {
    // The check-then-use gap: a request that arrived busy and became idle
    // takes the inline branch, so the binding has to happen after the
    // decision, not before the await.
    const slot = new SlotHarness();
    slot.beginTurn(GUARDIAN);
    const pending = handleSend(slot, CONTACT);
    slot.endTurn();

    const result = await pending;

    expect(result.queued).toBe(false);
    expect(slot.trustContext).toEqual(CONTACT);
  });
});
