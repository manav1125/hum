/**
 * Minimal visibility store for the global "Add tasks" batch modal (frame D1).
 *
 * Mirrors command-palette-store: layout-level UI (the ⌘⇧A shortcut in
 * useChatLayoutShortcuts, All-work's "＋ Add tasks" button) toggles the modal
 * without waiting for a child route to mount. Draft/parse state stays local
 * to the modal itself.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface AddTasksState {
  isOpen: boolean;
}

interface AddTasksActions {
  open: () => void;
  close: () => void;
  toggle: () => void;
}

type AddTasksStore = AddTasksState & AddTasksActions;

const useAddTasksStoreBase = create<AddTasksStore>((set, get) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set({ isOpen: !get().isOpen }),
}));

export const useAddTasksStore = createSelectors(useAddTasksStoreBase);
