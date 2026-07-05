/**
 * Create Studio — remix provenance store.
 *
 * When a Create generation is seeded (from the Create surface's composer or a
 * gallery selection), the structured `CreateIntent` behind it — the template,
 * style, brand kit, chart types the user picked — is the asset's *origin
 * intent*. Later, when the generated app/deck is opened in the viewer and the
 * remix cluster (Restyle · Rebrand · Make variations) rides under it, that
 * cluster wants the REAL origin intent so Restyle can reopen the gallery
 * pre-selected on the prior template and Rebrand knows the current kit — not
 * just the asset's display name.
 *
 * `OpenedAppState` (viewer-store) is loaded from the daemon and doesn't carry
 * the CreateIntent, and the app-builder doesn't persist it. So we stash the
 * intent here, keyed by the seeding `conversationId`. An opened app links back
 * to its source conversation (`editingConversationId` / `activeConversationId`),
 * so the chat viewer can look the intent up by that id when it assembles the
 * remix descriptor.
 *
 * This is a small, least-invasive side channel: purely client-side, best-effort
 * (a fresh page load loses it — the remix cluster then falls back to keying off
 * the asset name, exactly as it did before). It intentionally lives in the
 * top-level `stores/` dir (not `domains/create/`) so both the create domain
 * (which stamps) and the chat viewer wiring (which reads, via the shared
 * component layer) can touch it without a cross-domain import — the
 * `CreateIntent` type import is allowed here because this file is not itself
 * inside a domain folder.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import type { CreateIntent } from "@/domains/create/create-intent";
import { createSelectors } from "@/utils/create-selectors";

/** Cap on retained entries — provenance is transient; old ids age out. */
const MAX_ENTRIES = 64;

interface CreateProvenanceState {
  /** conversationId → the origin CreateIntent seeded into that conversation. */
  byConversationId: Record<string, CreateIntent>;
}

interface CreateProvenanceActions {
  /** Stamp the origin intent for a seeded conversation. */
  stampIntent: (conversationId: string, intent: CreateIntent) => void;
  /** Read the origin intent for a conversation (undefined when unknown). */
  getIntent: (conversationId: string | null | undefined) => CreateIntent | undefined;
  reset: () => void;
}

type CreateProvenanceStore = CreateProvenanceState & CreateProvenanceActions;

const useCreateProvenanceStoreBase = create<CreateProvenanceStore>()(
  (set, get) => ({
    byConversationId: {},

    stampIntent: (conversationId, intent) => {
      if (!conversationId) return;
      set((state) => {
        const next = { ...state.byConversationId, [conversationId]: intent };
        // Bound the map: when it grows past MAX_ENTRIES, drop the oldest
        // insertion (object key order is insertion order for string keys).
        const keys = Object.keys(next);
        if (keys.length > MAX_ENTRIES) {
          delete next[keys[0]];
        }
        return { byConversationId: next };
      });
    },

    getIntent: (conversationId) => {
      if (!conversationId) return undefined;
      return get().byConversationId[conversationId];
    },

    reset: () => set({ byConversationId: {} }),
  }),
);

export const useCreateProvenanceStore = createSelectors(
  useCreateProvenanceStoreBase,
);
