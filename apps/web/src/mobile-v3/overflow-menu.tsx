/**
 * The phone's top chrome — two affordances, one on each side.
 *
 * When the tab bar went from five slots to three (`HQ · ◉ · Work`), the two
 * slots that were cut held things touched weekly or less. They did not
 * disappear; they moved to the corners, which is where a phone puts what you
 * reach for occasionally:
 *
 *   ☰ top-left    — past conversations, search, batch capture.
 *   ⓜ top-right   — the owner's initial: the two accumulating destinations,
 *                   then the single door to everything you configure.
 *
 * ## The right-hand menu is the same model the desktop rail renders
 *
 * It used to list `CUE_NAV`'s six (Agents · Skills · Rhythms · Memory ·
 * Library · Watching) as if that were "what Cue is". Desktop retired that
 * grouping: four of the six were configuration rather than destinations, and
 * they are now leaves behind **Your Cue**. The phone kept rendering the old
 * list, so the two platforms had quietly started describing different
 * products — which is worse than either being wrong alone.
 *
 * The menu now mirrors the shipped model exactly:
 *
 *   People · Library      the two rows that accumulate on their own
 *   ─────────
 *   Your Cue              the door — every configuration surface
 *   ─────────
 *   Create · Data & logs  actions, not places
 *
 * Nothing became unreachable. Every row this menu dropped (Agents, Skills,
 * Automations, Memory, Connections, Brand kit, Explore, Trust, Appearance,
 * Notifications, Settings) is a row on the You screen, one tap behind
 * **Your Cue** — that screen IS the phone's Your Cue, and design's mobile
 * ruling already said this cluster lives behind the avatar, top-right.
 *
 * ## Why the button carries an initial
 *
 * "Trust / brand / connections / data / settings → **avatar, top-right**"
 * (BRIEF-FOR-CODE §2). It rendered a `◍` glyph inboard of the true corner,
 * because the HQ/Today header painted its own initial chip in that corner —
 * so the thing that LOOKED like the door was a decorative `<span>` and the
 * live affordance was the anonymous circle beside it. The Today chip is gone
 * (it never navigated); this button took over its position and its initial,
 * which is what the placement note here always said should happen.
 *
 * The initial comes from the signed-in user, never a hardcoded letter — the
 * same `homeState.userName` the You screen reads. With no name on file the
 * button falls back to `☺`, matching the You screen's avatar rather than
 * inventing a plausible letter.
 *
 * Renders ONLY on the primary surfaces where root-layout hides the legacy
 * chrome — detail screens carry their own ‹ back and ⋯ in the v3 grammar.
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  SIDEBAR_DESTINATIONS,
  YOUR_CUE_DOOR,
} from "@/components/nav/nav-model";
import { useHomeStateQuery } from "@/domains/home/hooks/use-home-state-query";
import { Mv3AddTasksSheet } from "@/pages/projects/mv3-add-tasks-sheet";
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
  /** Draw a hairline above this row — separates destinations, door, actions. */
  startsGroup?: boolean;
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
        // Both corners now sit on the same 18px gutter. The right-hand button
        // used to be inset to 62px to clear Today's decorative initial chip;
        // that chip is gone (see the module docblock), so the live affordance
        // takes the corner the spec asks for.
        ...(side === "left" ? { left: 18 } : { right: 18 }),
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
          // The right-hand button inherits Today's avatar material — it IS the
          // avatar now, so it must not read as a second, weaker chip.
          border:
            side === "right"
              ? "1px solid var(--mv3-avatar-border)"
              : "1px solid var(--mv3-glass-border)",
          background:
            side === "right" ? "var(--mv3-avatar-bg)" : "var(--mv3-glass)",
          boxShadow: side === "right" ? "var(--mv3-avatar-shadow)" : undefined,
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          color: side === "right" ? "var(--mv3-text)" : "var(--mv3-muted)",
          fontSize: side === "right" ? 13 : 15,
          fontWeight: side === "right" ? 600 : 400,
          lineHeight: 1,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          WebkitTapHighlightColor: "transparent",
          padding: 0,
        }}
      >
        <span aria-hidden>{glyph}</span>
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
                // The hairline is the group boundary — destinations, then the
                // door, then actions. `borderTop` rather than a separate <hr>
                // so the rule can never drift away from the row it belongs to.
                borderTop: item.startsGroup
                  ? "1px solid var(--mv3-sheet-border)"
                  : "none",
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
  // The button's initial. Same source as the You screen's avatar — never a
  // hardcoded letter, and `☺` (not a plausible-looking initial) when no name
  // is on file.
  const stateQuery = useHomeStateQuery(assistantId ?? null);
  const ownerName =
    (stateQuery.data as { userName?: string } | undefined)?.userName?.trim() ||
    null;
  const ownerInitial = (ownerName ?? "").charAt(0).toUpperCase() || "☺";

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

  // ⓜ — the two destinations, the door, then the actions.
  const accountItems: MenuEntry[] = [
    // The rows that accumulate on their own. Labels come from the shared
    // model so People cannot be called one thing on a phone and another on a
    // desktop; only the ORDER and the grouping are the phone's own.
    ...SIDEBAR_DESTINATIONS.map((d) => ({
      label: d.label,
      run: () => navigate(d.to),
    })),
    {
      // The door. The LABEL is `YOUR_CUE_DOOR`'s, so the two platforms can
      // never disagree about what the settings door is called.
      //
      // The DESTINATION is not: `YOUR_CUE_DOOR.to` redirects into the Identity
      // leaf, which is the right landing for a desktop rail that renders the
      // leaf column beside it, and the wrong one for a phone that would arrive
      // inside a single setting with no map. The phone's Your Cue is the v3
      // You screen at `routes.channels` — the mode dial, the track record and
      // every leaf as a row — and every one of those leaves already carries
      // `back={routes.channels}`. This row is what those back arrows were
      // pointing at: until now nothing on the phone navigated FORWARD to it,
      // so the whole screen was reachable only by leaving somewhere else.
      label: YOUR_CUE_DOOR.label,
      meta: ownerName ?? undefined,
      startsGroup: true,
      run: () => navigate(routes.channels),
    },
    {
      label: "Create",
      startsGroup: true,
      run: () => {
        setCreateMounted(true);
        setCreateOpen(true);
      },
    },
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
        glyph={ownerInitial}
        // The accessible name says whose workspace and where the button goes.
        // It must not depend on the glyph: a single letter is meaningless to a
        // screen reader, and `☺` is worse than meaningless.
        ariaLabel={
          ownerName
            ? `${ownerName} — People, Library and Your Cue`
            : "You — People, Library and Your Cue"
        }
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
