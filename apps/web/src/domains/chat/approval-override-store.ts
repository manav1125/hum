/**
 * Client-side state for the active temporary approval override
 * (allow_10m / allow_conversation grants).
 *
 * The daemon owns the authoritative override (in-memory, per-conversation —
 * see assistant/src/runtime/conversation-approval-overrides.ts). This store
 * only mirrors what the confirm response echoed so the countdown chip can
 * tick locally; expiry here is display-only and the backend expires lazily
 * on its own. Nothing in this store can widen an approval.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

export interface ActiveApprovalOverride {
  /** Daemon conversation id — used for the status/clear API calls. */
  conversationId: string;
  /**
   * The web-side active conversation key at grant time, used to scope the
   * chip's visibility to the conversation that granted it. `null` when the
   * key was unknown (chip shows regardless).
   */
  conversationKey: string | null;
  kind: "timed" | "conversation";
  /** Epoch ms when a timed grant lapses; `null` for conversation grants. */
  expiresAt: number | null;
}

interface ApprovalOverrideStore {
  activeOverride: ActiveApprovalOverride | null;
  setActiveOverride: (override: ActiveApprovalOverride | null) => void;
  clearActiveOverride: () => void;
}

const useApprovalOverrideStoreBase = create<ApprovalOverrideStore>()((set) => ({
  activeOverride: null,
  setActiveOverride: (override) => set({ activeOverride: override }),
  clearActiveOverride: () => set({ activeOverride: null }),
}));

export const useApprovalOverrideStore = createSelectors(
  useApprovalOverrideStoreBase,
);
