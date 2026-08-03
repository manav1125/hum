/**
 * The phone's top chrome — two affordances, one on each side, and both of
 * them open **from the bottom**.
 *
 *   ☰ top-left    — your chats, then search and batch capture.
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
 *   ACCUMULATING   People · All conversations · Library
 *   YOUR CUE       Agents · Skills · All of Your Cue
 *
 * **People leads.** It lost its tab when the bar went to three, and design's
 * mitigation is that contextual entry (a name in a task, a search hit) is the
 * real path while this row is the fallback.
 *
 * **Library IS here now**, against C6's crop and against this file's own
 * previous instruction. It became Work's third view, so the argument was that
 * a row here would be a second nav path to one destination — but the owner
 * read this exact sheet looking for it (*"the swipe up is not showing library
 * either"*) and did not find it. A view buried one tab deep inside another
 * surface is not discoverable from a menu that lists everything else that
 * accumulates, and the duplication rule exists to stop two navs DISAGREEING,
 * not to stop a thing being reachable. The row lands on `?view=library` — the
 * same URL Work's own tab uses — so there is still exactly one Library.
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

import { MenuSheet, type MenuEntry } from "@/components/nav/menu-sheet";
import {
  RecentThreadsSheet,
  allConversationsSub,
} from "@/components/nav/recent-threads-sheet";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { useLibraryOutputs } from "@/mobile-v3/library/use-library-outputs";
import { useHomeStateQuery } from "@/domains/home/hooks/use-home-state-query";
import { Mv3AddTasksSheet } from "@/pages/projects/mv3-add-tasks-sheet";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { openMv3Create } from "@/mobile-v3/create";

import { useCueCounts } from "./you/use-cue-counts";

// The phone's Create sheet — v27's spine, lazy so the create catalogs don't
// ride in every route's bundle.
//
// This used to mount `@/domains/create/create-sheet`, the DESKTOP sheet, which
// is a different surface with a different routing rule and no detents. The
// phone flow shipped without an entry point and this row went on quietly
// opening the old one, so the only door to Create on a phone led somewhere
// design did not draw.
const Mv3CreateSheet = lazy(() =>
  import("@/mobile-v3/create").then((m) => ({
    default: m.Mv3CreateSheet,
  })),
);

const SAFE_TOP = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";

/**
 * The ceiling `useLibraryOutputs` asks the daemon for.
 *
 * A mirror, not a source — the hook lives under `mobile-v3/library/`, which
 * another workstream owns, so this file states the number and
 * `overflow-menu.test.tsx` reads that file and fails if the two ever disagree.
 * It matters because at exactly the cap the count is ambiguous ("200" or "200
 * and more"), and the Library row prints no number rather than the wrong one.
 */
export const LIBRARY_FETCH_LIMIT = 200;

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
  const { conversations, isLoading, isError } =
    useConversationListQuery(assistantId);
  // The Library's own fetch, not `counts.library`. `useCueCounts` counts
  // DOCUMENTS; the Library gallery lists OUTPUTS, and they are different
  // endpoints with different totals — printing one beside the other's door is
  // the kind of number this product may not print. Sharing the gallery's hook
  // also means the count follows the gallery if its source changes.
  const library = useLibraryOutputs(open ? assistantId : null);

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
      // This row is where the phone said "151" to an owner with 420 active
      // conversations on the server: `conversations.length` is the client's
      // drained window, not a total, and the daemon publishes no count. The
      // shared helper prints the number only when the window provably IS the
      // list. See `recent-threads-sheet.tsx`.
      sub: allConversationsSub(conversations.length, { isLoading, isError }),
      run: () => navigate(routes.conversations),
    },
    {
      // The row the owner went looking for and did not find. It lands on
      // Work's `?view=library` — the SAME url Work's own tab uses, so this is
      // a second door onto one Library, not a second Library.
      key: "library",
      label: "Library",
      // Real or nothing: no number while it is loading, none if the read
      // failed, and none at the fetch's 200-row ceiling, where the true total
      // is "200 or more" and the list cannot tell which.
      sub:
        library.isLoading ||
        library.isError ||
        library.entries.length === 0 ||
        library.entries.length >= LIBRARY_FETCH_LIMIT
          ? null
          : `${library.entries.length} made`,
      run: () => navigate(routes.workView("library")),
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
  // `createMounted` only controls the lazy import; the sheet's own store owns
  // whether it is showing.
  const [createMounted, setCreateMounted] = useState(false);

  // The button's initial. Same source as the ⓶ screen's header — never a
  // hardcoded letter, and `☺` (not a plausible-looking initial) when no name
  // is on file.
  const stateQuery = useHomeStateQuery(assistantId ?? null);
  const ownerName =
    (stateQuery.data as { userName?: string } | undefined)?.userName?.trim() ||
    null;
  const ownerInitial = (ownerName ?? "").charAt(0).toUpperCase() || "☺";

  // ☰ — YOUR CHATS first, then finding and capturing.
  //
  // This corner used to open Search and Add tasks alone, on the reasoning that
  // conversations already had a row in the ⓶ sheet and one destination should
  // not have two nav paths. The owner, on his own phone with 151 threads, could
  // not find them: *"there is no easy way to navigate back to the live chat
  // threads … the same way other llm's have it on the top left."* The top-left
  // control IS the thread list in every product he was comparing against, and
  // it is now the thread list here — the ⓶ row survives as the ledger entry
  // beside People, while this one is the switcher that opens a thread in one
  // tap. Search and capture ride below the hairline; they lost no reach, and
  // they were never what the corner was for.
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
        ariaLabel="Your chats, search and capture"
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

      <RecentThreadsSheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        assistantId={assistantId}
        extras={historyItems}
      />

      {assistantId ? (
        <AccountSheet
          open={accountOpen}
          onClose={() => setAccountOpen(false)}
          assistantId={assistantId}
          onCreate={() => {
            setCreateMounted(true);
            openMv3Create();
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

      {/* The v27 sheet reads its own store rather than taking `open` — the
          composer's ✎ and this row are two doors onto one flow, and a second
          source of truth for "is Create open" is how they would drift. */}
      {createMounted ? (
        <Suspense fallback={null}>
          <Mv3CreateSheet />
        </Suspense>
      ) : null}
    </>
  );
}
