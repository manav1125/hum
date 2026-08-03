/**
 * Mobile v3 Create — the open/close store.
 *
 * This is the seam other mobile surfaces use to summon Create. It exists so the
 * chat composer's ✎ (owned by the chats workstream) can open Create with one
 * call and no knowledge of the sheet, the stack, or the detents.
 *
 * It is a store rather than a prop chain because the composer and the sheet have
 * no common ancestor that isn't the app root — the same reason
 * `stores/create-gallery-summon-store.ts` exists for the desktop gallery.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/** Optional context the summoning surface can pass in. */
export interface CreateSummonContext {
  /**
   * Seed the composer with text the user already typed, so tapping ✎ mid-
   * sentence carries the sentence in rather than dropping it.
   */
  seedText?: string;
  /**
   * A real project title the artefact should be filed onto, when the summoning
   * surface knows one. Only pass a title you actually resolved — this rides
   * into the artefact card's filing line, which must never be invented.
   */
  projectTitle?: string;
}

interface CreateStoreState {
  open: boolean;
  context: CreateSummonContext | null;
}

interface CreateStoreActions {
  /** Open Create. Safe to call when already open — the context is replaced. */
  openCreate: (context?: CreateSummonContext) => void;
  closeCreate: () => void;
}

const useMv3CreateStoreBase = create<CreateStoreState & CreateStoreActions>()(
  (set) => ({
    open: false,
    context: null,
    openCreate: (context) => set({ open: true, context: context ?? null }),
    closeCreate: () => set({ open: false, context: null }),
  }),
);

export const useMv3CreateStore = createSelectors(useMv3CreateStoreBase);

/**
 * Imperative opener — the one-liner for a button handler.
 *
 * ```ts
 * import { openMv3Create } from "@/mobile-v3/create";
 * <button onClick={() => openMv3Create({ seedText: draft })}>✎</button>
 * ```
 */
export function openMv3Create(context?: CreateSummonContext): void {
  useMv3CreateStoreBase.getState().openCreate(context);
}

/** Imperative close, for hosts that dismiss Create from outside the sheet. */
export function closeMv3Create(): void {
  useMv3CreateStoreBase.getState().closeCreate();
}
