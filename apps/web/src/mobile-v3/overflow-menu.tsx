/**
 * The phone's top chrome — two affordances, one on each side.
 *
 * When the tab bar went from five slots to three (`HQ · ◉ · Work`), the two
 * slots that were cut held things touched weekly or less. They did not
 * disappear; they moved to the corners, which is where a phone puts what you
 * reach for occasionally:
 *
 *   ☰ top-left    — past conversations, search, batch capture.
 *   ◍ top-right   — the CUE group (Agents · Skills · Rhythms · Memory ·
 *                   Library · Watching) and the account cluster (People ·
 *                   Create · Brand · Connections · Trust · Appearance ·
 *                   Settings · Logs).
 *
 * The right-hand menu reads its first six rows from `CUE_NAV`, the same list
 * the desktop sidebar renders under its **CUE** heading — so the two platforms
 * cannot drift about what "what Cue is" contains. A row whose surface does not
 * exist yet (`to: null`) is skipped here rather than rendered disabled: the
 * desktop rail is a persistent map where an honest gap is worth a line, and a
 * transient phone menu is not.
 *
 * Placement note: the right-hand button sits inboard of the true corner
 * because the HQ/Today header still paints its own decorative initial chip
 * there. That chip is meant to BECOME this affordance; until the HQ surface
 * retires it, two circles in the same 34px square would be the collision.
 *
 * Renders ONLY on the primary surfaces where root-layout hides the legacy
 * chrome — detail screens carry their own ‹ back and ⋯ in the v3 grammar.
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { CUE_NAV } from "@/components/nav/nav-model";
import { readStoredThemePreference } from "@/domains/settings/utils/theme-preferences";
import { Mv3AddTasksSheet } from "@/pages/projects/mv3-add-tasks-sheet";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

// The Create sheet — lazy so the create catalogs don't ride in every route's
// bundle; only fetched the first time Create is chosen.
const CreateSheet = lazy(() =>
  import("@/domains/create/create-sheet").then((m) => ({
    default: m.CreateSheet,
  })),
);

const SAFE_TOP = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";

interface MenuEntry {
  label: string;
  meta?: string;
  run: () => void;
}

/** One corner button + its popover menu. */
function CornerMenu({
  side,
  glyph,
  ariaLabel,
  items,
}: {
  side: "left" | "right";
  glyph: string;
  ariaLabel: string;
  items: MenuEntry[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  return (
    <div
      ref={rootRef}
      data-mv3
      data-slot={`mv3-corner-${side}`}
      style={{
        position: "fixed",
        top: `calc(${SAFE_TOP} + 8px)`,
        // See the placement note in the module docblock for the right-hand
        // inset.
        ...(side === "left" ? { left: 18 } : { right: 62 }),
        zIndex: 45,
        fontFamily: "var(--mv3-font)",
      }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
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
          fontSize: 15,
          lineHeight: 1,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          WebkitTapHighlightColor: "transparent",
          padding: 0,
        }}
      >
        {glyph}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={ariaLabel}
          style={{
            position: "absolute",
            top: 40,
            ...(side === "left" ? { left: 0 } : { right: 0 }),
            minWidth: 186,
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
    </div>
  );
}

export function Mv3OverflowMenu() {
  const navigate = useNavigate();
  const toggleCommandPalette = useCommandPaletteStore.use.toggle();
  // These render outside the ActiveAssistantGate, so read the raw store and
  // only offer assistant-scoped rows once one is actually active.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [addTasksOpen, setAddTasksOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMounted, setCreateMounted] = useState(false);
  // Value preview for the Appearance link row ("Appearance · Dark ›"). Read
  // fresh on each render — the leaf writes localStorage, and the menu
  // re-renders when it toggles open.
  const velvet = useClientFeatureFlagStore.use.velvet();
  const themePreference = readStoredThemePreference({ velvetEnabled: velvet });
  const themeLabel =
    themePreference.charAt(0).toUpperCase() + themePreference.slice(1);

  // ☰ — what you have already said, and what you want to capture.
  const historyItems: MenuEntry[] = [
    {
      // The mobile Chats index at /assistant/conversations — routing there
      // directly (not /assistant, which redirects into the most recent
      // conversation) is what makes chat history reachable.
      label: "Past conversations",
      run: () => navigate(routes.conversations),
    },
    { label: "Search", run: () => toggleCommandPalette() },
    ...(assistantId
      ? [{ label: "Add tasks", run: () => setAddTasksOpen(true) }]
      : []),
  ];

  // ◍ — the CUE group, then the account cluster.
  const accountItems: MenuEntry[] = [
    ...CUE_NAV.filter(
      (d): d is typeof d & { to: string } => typeof d.to === "string",
    ).map((d) => ({
      label: d.label,
      run: () => navigate(d.to),
    })),
    {
      label: "Create",
      run: () => {
        setCreateMounted(true);
        setCreateOpen(true);
      },
    },
    // People and Trust are NOT in v15's six. They keep a row here rather than
    // being dropped: both are live surfaces, and design has not yet said where
    // People belongs. Reachable beats tidy while that is open.
    { label: "People", run: () => navigate(routes.people) },
    { label: "Trust & guardrails", run: () => navigate(routes.guardrails) },
    { label: "What Cue does", run: () => navigate(routes.explore) },
    { label: "Brand kit", run: () => navigate(routes.brandKit) },
    { label: "Connections", run: () => navigate(routes.connectors) },
    {
      label: "Appearance",
      meta: themeLabel,
      run: () => navigate(routes.settings.general),
    },
    { label: "Settings", run: () => navigate(routes.settings.root) },
    { label: "Data & logs", run: () => navigate(routes.logs.root) },
  ];

  return (
    <>
      <CornerMenu
        side="left"
        glyph="☰"
        ariaLabel="Conversations and search"
        items={historyItems}
      />
      <CornerMenu
        side="right"
        glyph="◍"
        ariaLabel="You — settings and deeper surfaces"
        items={accountItems}
      />

      {/* Batch task capture — the SheetShell portals itself, so mounting it
          here keeps the whole flow inside the global affordances. */}
      {assistantId ? (
        <Mv3AddTasksSheet
          assistantId={assistantId}
          open={addTasksOpen}
          onClose={() => setAddTasksOpen(false)}
        />
      ) : null}

      {createMounted ? (
        <Suspense fallback={null}>
          <CreateSheet open={createOpen} onClose={() => setCreateOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
