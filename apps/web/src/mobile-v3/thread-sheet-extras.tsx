/**
 * The rows below the ☰ sheet's hairline — ONE list, wherever the glyph is.
 *
 * The ☰ sheet opens from two places on a phone: the corner chrome on the tab
 * landings, and the conversation header's own switcher (nothing global paints
 * a ☰ on `/conversations/:id` — see `thread-switcher.test.tsx`). For a while
 * only the corner passed Search, Add tasks and Learn, on the reasoning that
 * inside a conversation the composer already IS capture. That argument covered
 * exactly one of the three rows: the composer sends chat turns, not a pasted
 * task list; Search reaches everything Cue has read or said, which a thread's
 * transcript is not; and Learn's only phone door was this sheet, so reading a
 * thread — where people actually spend their time — was the one place the
 * surface did not exist. One glyph offering two different menus is the kind of
 * disagreement the ⓶ sheet already paid for once (`overflow-menu.tsx`).
 *
 * So the extras are built HERE, once, and both call sites mount what this hook
 * returns. A caller cannot drift a row out of one door without drifting it out
 * of both — which is the point.
 */
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";

import type { MenuEntry } from "@/components/nav/menu-sheet";
import { Mv3AddTasksSheet } from "@/pages/projects/mv3-add-tasks-sheet";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { routes } from "@/utils/routes";

/**
 * The shared tail of the ☰ sheet: Search, then Add tasks, then Learn.
 *
 * Returns the entries AND the sheet that "Add tasks" opens — the row is only
 * honest if tapping it works, so a caller that takes the entries takes the
 * sheet with them (`SheetShell` portals itself, so mounting it costs nothing
 * while closed).
 */
export function useThreadSheetExtras(assistantId: string | null): {
  extras: MenuEntry[];
  /** Render alongside the RecentThreadsSheet, inside the same tree. */
  sheets: ReactNode;
} {
  const navigate = useNavigate();
  const toggleCommandPalette = useCommandPaletteStore.use.toggle();
  // Hydration-paired flag gate, same as the desktop rail: a `false` before
  // `/feature-flags` has answered is a default, not a ruling.
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const learnAppOn = useAssistantFeatureFlagStore.use.learnApp();
  const learnEnabled = flagsHydrated && learnAppOn;
  const [addTasksOpen, setAddTasksOpen] = useState(false);

  const extras: MenuEntry[] = [
    {
      key: "search",
      label: "Search",
      sub: "Anything Cue has read, made or said",
      run: () => toggleCommandPalette(),
    },
    ...(assistantId
      ? [
          {
            key: "add-tasks",
            label: "Add tasks",
            sub: "Paste a list; Cue files each one",
            run: () => setAddTasksOpen(true),
          },
        ]
      : []),
    // Learn — the ☰ sheet is the phone's only global drawer, so without this
    // row the surface simply has no door on mobile (the desktop rail row and
    // mv3-chats-index card are both unreachable here).
    ...(learnEnabled
      ? [
          {
            key: "learn",
            label: "Learn",
            sub: "Courses that teach you back",
            // The eye-and-violet-period glyph from the design handoff (R2-1).
            // currentColor ring follows the row's text color; the period stays
            // the Learn violet in both themes.
            icon: (
              <svg viewBox="0 0 20 20" width="18" height="18">
                <circle
                  cx="9"
                  cy="9"
                  r="6.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                />
                <circle cx="17.5" cy="17.5" r="2.5" fill="#9A93E8" />
              </svg>
            ),
            run: () => void navigate(routes.learn),
          },
        ]
      : []),
  ];

  return {
    extras,
    sheets: assistantId ? (
      <Mv3AddTasksSheet
        assistantId={assistantId}
        open={addTasksOpen}
        onClose={() => setAddTasksOpen(false)}
      />
    ) : null,
  };
}
