import { z } from "zod";

import type { NeedsYouItem } from "@vellumai/ipc-contract";

import { on } from "./ipc";

/**
 * What is waiting on the owner, held for the menu bar.
 *
 * ## Why this exists at all
 *
 * The floating corner **never appears unbidden**. The obvious alternative —
 * let it pop up for the urgent things — sounds helpful and quietly destroys
 * the thing that makes a summon feel safe, which is that it only exists when
 * you call it. A panel that seizes focus over your work to ask for money is
 * the behaviour that gets an app quit.
 *
 * So approvals reach the owner as a count they **pull down**. One surface you
 * summon, one that waits. This module is the second one.
 *
 * ## The count is HQ's count
 *
 * The number here is published by the renderer from `useNeedsYouBadge` — the
 * single hook the sidebar and the mobile tab bar already read. That is
 * deliberate and load-bearing: a menu bar that counted for itself would
 * become a second, louder number that disagrees with the app, and two
 * disagreeing counts mean neither gets believed.
 *
 * Main therefore stores what it is told and never computes. If this file ever
 * grows a query, that invariant is gone.
 */

/** Beyond this the pull-down is a list to manage, not a glance. */
const MAX_LISTED = 5;

interface NeedsYouState {
  count: number;
  items: NeedsYouItem[];
}

let state: NeedsYouState = { count: 0, items: [] };

const listeners = new Set<() => void>();

export const getNeedsYou = (): NeedsYouState => state;

/** The few the menu lists, under the count that speaks for all of them. */
export const listedNeedsYou = (): NeedsYouItem[] =>
  state.items.slice(0, MAX_LISTED);

/**
 * How many are not shown, so the menu can say "and 4 more" rather than
 * silently truncating. A count that quietly disagrees with its own list is
 * the small dishonesty this whole surface is trying not to commit.
 */
export const hiddenNeedsYouCount = (): number =>
  Math.max(0, state.count - listedNeedsYou().length);

export const onNeedsYouChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const needsYouItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string().optional(),
});

const needsYouPayloadSchema = z.object({
  count: z.number().int().min(0),
  items: z.array(needsYouItemSchema),
});

let installed = false;

/**
 * Listen for the renderer's publishes. Call once from `whenReady`.
 *
 * One-way and fire-and-forget, the same shape as the dock badge and the tray
 * status: the renderer owns the number, main owns the presentation.
 */
export const installNeedsYou = (): void => {
  if (installed) return;
  installed = true;

  on("vellum:needsYou:set", z.tuple([needsYouPayloadSchema]), ([payload]) => {
    state = { count: payload.count, items: payload.items };
    for (const listener of listeners) listener();
  });
};

/** Test seam — exported only for unit-test setup. */
export const __resetForTesting = (): void => {
  installed = false;
  state = { count: 0, items: [] };
  listeners.clear();
};
