/**
 * Which rail section is expanded — at most one, ever.
 *
 * Two rules from v15 live here rather than in the component, because both are
 * about state that outlives a render:
 *
 *   · **Only one expands at a time.** Opening Work closes HQ. The point is not
 *     tidiness — it is that the rail's height stays constant, so the CUE group
 *     and the avatar row below never move under the cursor.
 *   · **Collapsed by default on first run, and it remembers.** The default is
 *     `null` (nothing open); after that the last choice is restored.
 *
 * Persisted per browser, not per assistant: it is a preference about how much
 * rail you want, and carrying it across assistant switches is the behaviour a
 * user would predict.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { PeekSectionKey } from "@/components/nav/nav-model";

const STORAGE_KEY = "cue:nav:peek-section";

/** Read the stored section, tolerating anything a hand-edited value may hold. */
export function readStoredPeekSection(): PeekSectionKey | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw === "hq" || raw === "work" ? raw : null;
  } catch {
    // Private-mode / disabled storage. Collapsed is the correct fallback —
    // it is also the first-run default, so nothing special-cases it.
    return null;
  }
}

function persist(section: PeekSectionKey | null): void {
  try {
    if (section === null) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, section);
  } catch {
    /* storage unavailable — the session still behaves, it just forgets */
  }
}

export interface RailPeekState {
  /** The open section, or null when the rail is showing none. */
  openSection: PeekSectionKey | null;
}

export interface RailPeekActions {
  /** Open `section`, or close it when it is already the open one. */
  toggle: (section: PeekSectionKey) => void;
  /** Open `section` unconditionally, closing whichever was open. */
  open: (section: PeekSectionKey) => void;
  close: () => void;
}

const useRailPeekStoreBase = create<RailPeekState & RailPeekActions>()(
  (set, get) => ({
    openSection: readStoredPeekSection(),

    toggle: (section) => {
      const next = get().openSection === section ? null : section;
      set({ openSection: next });
      persist(next);
    },

    // Assignment, not a merge: this is what makes "only one at a time"
    // structural rather than a rule the component has to remember.
    open: (section) => {
      if (get().openSection === section) return;
      set({ openSection: section });
      persist(section);
    },

    close: () => {
      if (get().openSection === null) return;
      set({ openSection: null });
      persist(null);
    },
  }),
);

export const useRailPeekStore = createSelectors(useRailPeekStoreBase);
