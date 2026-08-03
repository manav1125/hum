/**
 * The phone's top chrome — two affordances, one on each side, and both of
 * them open **from the bottom**.
 *
 *   ☰ top-left    — search, and batch capture.
 *   ⓶ top-right   — the owner's initial: what accumulates, then Your Cue.
 *
 * ## Why a sheet and not a popover
 *
 * These used to drop a popover from the corner they were tapped in, which put
 * every row inside the top third of an 844px screen. The brief's reach rule:
 * *"every primary action sits below 60% of viewport height. Back chevrons and
 * ⋯ may sit top-side as escapes — provided every screen has swipe-back."* A
 * button is an escape; a menu of destinations is not. Design drew both of
 * these as bottom sheets (v22 M2, v23 C6) for exactly that reason, and
 * `SheetShell` already is that grammar — grabber, scrim, swipe-to-dismiss.
 *
 * ## The ⓶ menu's contents are ruled, not chosen
 *
 * It spent a release listing `CUE_NAV`'s six (Agents · Skills · Rhythms ·
 * Memory · Library · Watching) as if that were "what Cue is". Desktop retired
 * that grouping — four of the six were configuration rather than destinations
 * — and `CUE_NAV` is now **deleted**, its own docstring having asked for that
 * once this menu was revisited. v23 C6 rules what replaces it:
 *
 *   ACCUMULATING   People · All conversations
 *   YOUR CUE       Agents · Skills · All of Your Cue
 *
 * **People leads.** It lost its tab when the bar went to three, and design's
 * mitigation is that contextual entry (a name in a task, a search hit) is the
 * real path while this row is the fallback. **Library is not here**: it became
 * Work's third view, and it also has a card on the ⓶ screen.
 *
 * Create and Data & logs keep their rows below the hairline. C6 does not draw
 * them, but it does not withdraw them either, and this branch has already
 * shipped a screen with no entrance at all — dropping a working door to match
 * a crop is how that happens.
 *
 * ## Why the button carries an initial
 *
 * "Trust / brand / connections / data / settings → **avatar, top-right**"
 * (BRIEF §2). The initial comes from the signed-in user, never a hardcoded
 * letter; with no name on file it falls back to `☺` rather than inventing a
 * plausible one.
 *
 * Renders ONLY on the primary surfaces where root-layout hides the legacy
 * chrome — detail screens carry their own ‹ back and ⋯ in the v3 grammar.
 */
import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router";

import { useConversationListQuery } from "@/hooks/conversation-queries";
import { useHomeStateQuery } from "@/domains/home/hooks/use-home-state-query";
import { Mv3AddTasksSheet } from "@/pages/projects/mv3-add-tasks-sheet";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { microLabel } from "./mv3-kit";
import { SheetShell } from "./sheet-shell";
import { useCueCounts } from "./you/use-cue-counts";

// The Create sheet — lazy so the create catalogs don't ride in every route's
// bundle; only fetched the first time Create is chosen.
const CreateSheet = lazy(() =>
  import("@/domains/create/create-sheet").then((m) => ({
    default: m.CreateSheet,
  })),
);

const SAFE_TOP = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";

interface MenuEntry {
  key: string;
  label: string;
  /** The second line — a real count, or nothing. Never a guess. */
  sub?: string | null;
  /** Mono eyebrow printed above this row, starting a group. */
  group?: string;
  /** Hairline above this row without an eyebrow (the quiet actions group). */
  rule?: boolean;
  run: () => void;
}

/** One row of a menu sheet. */
function MenuRow({ item, onDone }: { item: MenuEntry; onDone: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="cue-pressable"
      data-slot="mv3-menu-row"
      data-menu-key={item.key}
      onClick={() => {
        haptic.light();
        onDone();
        item.run();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderTop: item.rule ? "1px solid var(--mv3-sheet-border)" : "none",
        borderRadius: 12,
        padding: "12px 12px",
        minHeight: 48,
        fontFamily: "inherit",
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
        color: "var(--mv3-text)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, display: "block" }}>
          {item.label}
        </span>
        {item.sub ? (
          <span
            style={{
              fontSize: 10,
              color: "var(--mv3-muted)",
              display: "block",
              marginTop: 1,
            }}
          >
            {item.sub}
          </span>
        ) : null}
      </span>
      <span aria-hidden style={{ color: "var(--mv3-muted)", flexShrink: 0 }}>
        ›
      </span>
    </button>
  );
}

/** The corner button. The sheet it opens is rendered by the caller. */
function CornerButton({
  side,
  glyph,
  ariaLabel,
  expanded,
  onPress,
}: {
  side: "left" | "right";
  glyph: string;
  ariaLabel: string;
  expanded: boolean;
  onPress: () => void;
}) {
  return (
    <div
      data-mv3
      data-slot={`mv3-corner-${side}`}
      style={{
        position: "fixed",
        top: `calc(${SAFE_TOP} + 8px)`,
        ...(side === "left" ? { left: 18 } : { right: 18 }),
        zIndex: 45,
        fontFamily: "var(--mv3-font)",
      }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={expanded}
        aria-haspopup="menu"
        className="cue-pressable"
        onClick={() => {
          haptic.light();
          onPress();
        }}
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          // The right-hand button IS the avatar, so it must not read as a
          // second, weaker chip beside one.
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
    </div>
  );
}

/** A grouped sheet of menu rows. */
function MenuSheet({
  open,
  onClose,
  label,
  items,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  items: MenuEntry[];
}) {
  return (
    <SheetShell open={open} onClose={onClose} label={label} maxHeight="72%">
      <div role="menu" aria-label={label}>
        {items.map((item) => (
          <div key={item.key}>
            {item.group ? (
              <div
                style={{
                  ...microLabel,
                  fontSize: 8.5,
                  letterSpacing: ".12em",
                  color: "var(--mv3-micro)",
                  padding: "10px 4px 6px",
                }}
              >
                {item.group}
              </div>
            ) : null}
            <MenuRow item={item} onDone={onClose} />
          </div>
        ))}
      </div>
    </SheetShell>
  );
}

/**
 * The ⓶ sheet's rows. A separate component so its queries only run once the
 * sheet is actually open — this chrome mounts on every primary route, and a
 * menu nobody opened should not be reading the contact list.
 */
function AccountSheet({
  open,
  onClose,
  assistantId,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  assistantId: string;
  onCreate: () => void;
}) {
  const navigate = useNavigate();
  const counts = useCueCounts(assistantId);
  const { conversations } = useConversationListQuery(assistantId);

  const items: MenuEntry[] = [
    {
      key: "people",
      group: "Accumulating",
      label: "People",
      // Design's frame reads "214 · 7 going quiet". The going-quiet signal is
      // not computed anywhere in this codebase yet, and a number invented to
      // match a frame is the one thing this product may never print.
      sub: counts.people == null ? null : `${counts.people} known`,
      run: () => navigate(routes.people),
    },
    {
      key: "conversations",
      label: "All conversations",
      sub: conversations.length > 0 ? String(conversations.length) : null,
      run: () => navigate(routes.conversations),
    },
    {
      key: "agents",
      group: "Your Cue",
      label: "Agents",
      sub: counts.agents == null ? null : `${counts.agents} on staff`,
      run: () => navigate(routes.hqAgents),
    },
    {
      key: "skills",
      label: "Skills",
      sub: counts.skills == null ? null : `${counts.skills} learned`,
      run: () => navigate(routes.skills),
    },
    {
      // Design's C6 row is "All of Your Cue · 18", i.e. the leaf list, because
      // in that frame the mark is the ⓶ screen's only door.
      //
      // On this build that door does not reliably exist: `/assistant` resolves
      // into a conversation, and the conversation surface hides the tab bar —
      // so "press the mark when already home" has no mark to press. Until that
      // is true, this row lands on the ⓶ SCREEN, which carries its own door to
      // the full list. A screen whose only entrance is a gesture that cannot
      // fire is a screen with no entrance, and this branch has shipped one.
      key: "your-cue",
      label: "All of Your Cue",
      sub: "What it's doing, and how it's set up",
      run: () => navigate(routes.yourCue),
    },
    {
      key: "create",
      label: "Create",
      rule: true,
      run: onCreate,
    },
    {
      key: "logs",
      label: "Data & logs",
      run: () => navigate(routes.logs.root),
    },
  ];

  return (
    <MenuSheet
      open={open}
      onClose={onClose}
      label="People, conversations and Your Cue"
      items={items}
    />
  );
}

export function Mv3OverflowMenu() {
  const toggleCommandPalette = useCommandPaletteStore.use.toggle();
  // These render outside the ActiveAssistantGate, so read the raw store and
  // only offer assistant-scoped rows once one is actually active.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [addTasksOpen, setAddTasksOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMounted, setCreateMounted] = useState(false);

  // The button's initial. Same source as the ⓶ screen's header — never a
  // hardcoded letter, and `☺` (not a plausible-looking initial) when no name
  // is on file.
  const stateQuery = useHomeStateQuery(assistantId ?? null);
  const ownerName =
    (stateQuery.data as { userName?: string } | undefined)?.userName?.trim() ||
    null;
  const ownerInitial = (ownerName ?? "").charAt(0).toUpperCase() || "☺";

  // ☰ — finding and capturing. Conversations are NOT duplicated here: they
  // live under Accumulating in the ⓶ sheet, and one destination with two nav
  // paths is the duplication this codebase keeps having to remove.
  const historyItems: MenuEntry[] = [
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
  ];

  return (
    <>
      <CornerButton
        side="left"
        glyph="☰"
        ariaLabel="Search and capture"
        expanded={historyOpen}
        onPress={() => setHistoryOpen((v) => !v)}
      />
      <CornerButton
        side="right"
        glyph={ownerInitial}
        // The accessible name says whose workspace and where the button goes.
        // It must not depend on the glyph: a single letter is meaningless to a
        // screen reader, and `☺` is worse than meaningless.
        ariaLabel={
          ownerName
            ? `${ownerName} — People, conversations and Your Cue`
            : "You — People, conversations and Your Cue"
        }
        expanded={accountOpen}
        onPress={() => setAccountOpen((v) => !v)}
      />

      <MenuSheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        label="Search and capture"
        items={historyItems}
      />

      {assistantId ? (
        <AccountSheet
          open={accountOpen}
          onClose={() => setAccountOpen(false)}
          assistantId={assistantId}
          onCreate={() => {
            setCreateMounted(true);
            setCreateOpen(true);
          }}
        />
      ) : null}

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
