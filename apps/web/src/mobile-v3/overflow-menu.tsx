/**
 * Mv3OverflowMenu — the minimal ⋯ affordance kept in the top-right safe area
 * after the legacy mobile chrome (hamburger / home / search pill) is removed
 * (task #96, step 6).
 *
 * Reachability audit (what the old hamburger drawer / header uniquely reached
 * on mobile):
 *   · Chats index + drawer conversation list → "Chats" (opens the chat
 *     surface, which still carries the drawer until the Chat cluster ships
 *     its v3 nav)
 *   · Search (⌘K command palette, the old header's search pill) → "Search"
 *   · Settings (old drawer footer PreferencesMenu) → "Settings"
 *   · Logs → "Logs"
 * Home is NOT listed: /assistant/home is a legacy redirect to /assistant/hq,
 * which the Today tab already owns. Everything else the drawer showed
 * (projects, memory, connections) is reachable via the 5 tabs / You rows.
 *
 * Renders ONLY on the v3 primary surfaces root-layout hides the chrome on;
 * the You cluster's Settings/Notifications rows supersede parts of this menu
 * once they land (coordinator may then prune items).
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { readStoredThemePreference } from "@/domains/settings/utils/theme-preferences";
import { Mv3AddTasksSheet } from "@/pages/projects/mv3-add-tasks-sheet";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

const SAFE_TOP = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";

export function Mv3OverflowMenu() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleCommandPalette = useCommandPaletteStore.use.toggle();
  // Batch task capture ("Add tasks"). This menu renders outside the
  // ActiveAssistantGate, so read the raw store and only offer the item once
  // an assistant is actually active.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [addTasksOpen, setAddTasksOpen] = useState(false);
  // Value preview for the Appearance link row (round-4 frame 63: "Appearance
  // · Dark ›"). Read fresh on each open — the leaf writes localStorage, and
  // the menu re-renders when it toggles open.
  const velvet = useClientFeatureFlagStore.use.velvet();
  const themePreference = readStoredThemePreference({ velvetEnabled: velvet });
  const themeLabel =
    themePreference.charAt(0).toUpperCase() + themePreference.slice(1);

  // Dismiss on outside tap.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const items: Array<{ label: string; meta?: string; run: () => void }> = [
    ...(assistantId
      ? [
          {
            label: "Add tasks",
            run: () => setAddTasksOpen(true),
          },
        ]
      : []),
    {
      // The mobile Chats index (spec frame 21) at /assistant/conversations —
      // routing there directly (not /assistant, which redirects into the most
      // recent conversation) is what makes chat history reachable (UAT P1-2).
      label: "Chats",
      run: () => navigate(routes.conversations),
    },
    {
      // All-work was only reachable under Projects (UAT P2) — surface the
      // flat queue here too.
      label: "All work",
      run: () => navigate(routes.allWork),
    },
    {
      label: "Search",
      run: () => toggleCommandPalette(),
    },
    {
      // Frame 63 (a): value-preview link row → the Appearance radio leaf.
      // Two taps to change a theme, zero to mis-fire.
      label: "Appearance",
      meta: themeLabel,
      run: () => navigate(routes.settings.general),
    },
    {
      label: "Settings",
      run: () => navigate(routes.settings.root),
    },
    {
      label: "Logs",
      run: () => navigate(routes.logs.root),
    },
  ];

  return (
    <div
      ref={rootRef}
      data-mv3
      data-slot="mv3-overflow"
      style={{
        position: "fixed",
        top: `calc(${SAFE_TOP} + 8px)`,
        // Clear of the v3 screens' own top-right ornament (Today's avatar
        // chip sits at right ~22px), per the "status bar only" canvas rule.
        right: 62,
        zIndex: 45,
        fontFamily: "var(--mv3-font)",
      }}
    >
      <button
        type="button"
        aria-label="More"
        aria-expanded={open}
        className="cue-pressable"
        onClick={() => {
          haptic.light();
          setOpen((v) => !v);
        }}
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          border: "1px solid var(--mv3-glass-border)",
          background: "var(--mv3-glass)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          color: "var(--mv3-muted)",
          fontSize: 16,
          lineHeight: 1,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          WebkitTapHighlightColor: "transparent",
          padding: 0,
        }}
      >
        ⋯
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="More options"
          style={{
            position: "absolute",
            top: 40,
            right: 0,
            minWidth: 168,
            background: "var(--mv3-sheet)",
            border: "1px solid var(--mv3-sheet-border)",
            borderRadius: 16,
            padding: 6,
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
            boxShadow: "var(--mv3-glass-shadow)",
            animation: "mv3Fade .18s ease both",
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                setOpen(false);
                item.run();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                borderRadius: 11,
                padding: "12px 14px",
                minHeight: 44,
                fontSize: 14.5,
                color: "var(--mv3-text)",
                fontFamily: "inherit",
                cursor: "pointer",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>{item.label}</span>
              {item.meta ? (
                <>
                  <span
                    style={{
                      fontSize: 12.5,
                      color: "var(--mv3-muted)",
                      flexShrink: 0,
                    }}
                  >
                    {item.meta}
                  </span>
                  <span
                    aria-hidden
                    style={{ color: "var(--mv3-faint)", flexShrink: 0 }}
                  >
                    ›
                  </span>
                </>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {/* Batch task capture — the SheetShell portals itself, so mounting it
          here keeps the whole flow inside the one global affordance. */}
      {assistantId ? (
        <Mv3AddTasksSheet
          assistantId={assistantId}
          open={addTasksOpen}
          onClose={() => setAddTasksOpen(false)}
        />
      ) : null}
    </div>
  );
}
