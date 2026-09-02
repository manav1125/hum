import {
  Blocks,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Hash,
  LayoutGrid,
  LayoutList,
  GraduationCap,
  MessagesSquare,
  NotebookPen,
  Pin,
  Plug,
  Rocket,
  Search,
  Settings2,
  Sparkles,
  SquarePen,
  Target,
  Users,
  X,
} from "lucide-react";
import { Fragment, useCallback, useId, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { useCommandPaletteStore } from "@/stores/command-palette-store";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import {
  CollapsedGroupIcon,
  getGroupIndicatorState,
} from "@/domains/chat/components/collapsed-group-icon";
import {
  ConversationActionsMenu,
  renderConversationMenuItems,
  type ConversationMenuItemsProps,
} from "@/domains/chat/components/conversation-actions-menu";
import {
  GroupActionsMenu,
  renderGroupMenuItems,
} from "@/domains/chat/components/group-actions-menu";
import { ThreadPinToggle } from "@/domains/chat/components/thread-pin-toggle";
import { useDragReorder } from "@/domains/chat/hooks/use-drag-reorder";
import {
  SIDEBAR_CONVERSATION_LIMIT,
  useSidebarState,
  type PaginatedSection,
  type UseSidebarStateParams,
} from "@/domains/chat/use-sidebar-state";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { isConversationPinned } from "@/domains/chat/utils/group-conversations";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { Conversation } from "@/types/conversation-types";
import { canMarkRead, canMarkUnread } from "@/utils/conversation-predicates";
import { useNeedsYouBadge } from "@/hooks/use-needs-you-badge";
import {
  PRIMARY_NAV,
  SIDEBAR_DESTINATIONS,
  YOUR_CUE_DOOR,
  takePeek,
  type PeekSectionKey,
  type PrimaryNavKey,
  type SidebarDestination,
} from "@/components/nav/nav-model";
import { usePeopleCount } from "@/components/nav/use-people-count";
import { railToggleLabel } from "@/components/nav/rail-collapse";
import { isElectron } from "@/runtime/is-electron";
import { useNavCounts } from "@/components/nav/use-nav-counts";
import { useRailPeek } from "@/components/nav/use-rail-peek";
import { useRailPeekStore } from "@/components/nav/rail-peek-store";
import { routes } from "@/utils/routes";
import {
  ApertureAvatar,
  Button,
  ContextMenu,
  PanelItem,
  SideMenu,
  Tooltip,
} from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

/** @deprecated Use {@link SIDEBAR_CONVERSATION_LIMIT} from `use-sidebar-state.ts` */
export const ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT =
  SIDEBAR_CONVERSATION_LIMIT;

export interface AssistantSideMenuProps extends UseSidebarStateParams {
  assistantName?: string | null;
  collapsed: boolean;
  /**
   * True while a conversation transcript is the surface on screen — which is
   * when `◧` means *pin the rail open* rather than *collapse it*. The rail
   * needs to know so its own control can say which of the two it does.
   */
  inConversation?: boolean;
  /**
   * `◧` / `⌘\`. Supplied by the layout, which owns the two flags the rule
   * reads (see `rail-collapse.ts`). When omitted the control is not rendered.
   */
  onToggleCollapsed?: () => void;
  variant: "rail" | "overlay";
  width?: number;
  onWidthChange?: (width: number) => void;
  activeConversationId?: string;
  onSelectConversation: (key: string) => void;
  isLibraryActive?: boolean;
  onOpenLibrary?: () => void;
  /**
   * @deprecated The People row reads its own active state off the pathname
   * (its `match` in `SIDEBAR_DESTINATIONS`) and navigates itself. These two
   * are accepted so `chat-layout` keeps compiling and are not read.
   */
  isContactsActive?: boolean;
  /** @deprecated See {@link AssistantSideMenuProps.isContactsActive}. */
  onOpenContacts?: () => void;
  onOpenApp?: (appId: string) => void;
  activeAppId?: string;
  onStartNewConversation?: () => void;
  footerAction?: ReactNode;
  onClose?: () => void;

  onPinConversation?: (conversation: Conversation) => void;
  /**
   * Persist a drag-reorder within a section. Receives the section's full
   * conversation list in its new order. When omitted, rows aren't draggable.
   * Only sections that honor `displayOrder` (Pinned, custom groups) offer
   * drag-reordering — Recents and Slack stay recency-sorted.
   */
  onReorderConversations?: (conversations: Conversation[]) => void;
  onRenameConversation?: (conversation: Conversation) => void;
  onArchiveConversation?: (conversation: Conversation) => void;
  onUnarchiveConversation?: (conversation: Conversation) => void;
  onMarkConversationUnread?: (conversation: Conversation) => void;
  onMarkConversationRead?: (conversation: Conversation) => void;
  onRenameGroup?: (groupId: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onMarkAllReadInGroup?: (conversations: Conversation[]) => void;
  onArchiveAllInGroup?: (
    groupName: string,
    conversations: Conversation[],
  ) => void;
  processingConversationIds?: Set<string>;
  activeConversationProcessing?: boolean;
  onAnalyze?: (conversation: Conversation) => void;
  onOpenInNewWindow?: (conversation: Conversation) => void;
  onShareFeedback?: () => void;
  onInspect?: (conversation: Conversation) => void;
}

function SearchButton({ onClose }: { onClose?: () => void }) {
  const toggle = useCommandPaletteStore.use.toggle();
  const handleClick = useCallback(() => {
    onClose?.();
    toggle();
  }, [onClose, toggle]);
  return (
    <Button
      variant="ghost"
      iconOnly={<Search />}
      aria-label="Search (⌘K)"
      title="Search (⌘K)"
      onClick={handleClick}
    />
  );
}

/**
 * Assistant sidebar content — the v15 rail.
 *
 * The brief was one sentence from the owner: *"the navigation got a bit crazy
 * with so many things."* The rail carried thirteen entries. It now carries
 * three Tier-1 rows, the conversation list, two destinations and a door.
 *
 *   cue.                              ◧
 *   [ ✎ Talk to Cue          ⌘N ]   ← the filled row
 *   ◈ HQ                      7 ▾   ← three most urgent, then "N more ›"
 *   ▤ Work                    5 ▸   ← three with something live
 *   PINNED / RECENT / All conversations ›
 *   ──────────────
 *   👤 People                49     ← ungated by owner decision (nav-model)
 *   ▦ Library                48
 *   ──────────────
 *   ⚙ Your Cue
 *   👤 Manav · Autonomous · $4.10
 *
 * **One column below the divider, on HQ and Work's left margin.** v20 shipped
 * these as a two-column grid and design overturned it: a grid reads as a
 * keypad, breaks vertical scanning, and truncates labels — "Watching" rendered
 * as "Wat…" in the live app. The four rows that made six necessary were
 * configuration, not destinations, and moved into Your Cue.
 *
 * The dividers do the grouping. No headings — two rows do not need a label
 * above them.
 *
 * **Flat hierarchy — no indents.** Expanded peek rows are unindented too; the
 * quieter type does the nesting that position used to. The `▾` sits on the
 * right edge after the count so nothing shifts horizontally when a section
 * opens.
 *
 * The expansion rule is the design, and it lives in three places on purpose:
 *   · `RAIL_PEEK_LIMIT` + `takePeek` (nav-model) — three rows, always;
 *   · `rail-peek-store` — one section open at a time, collapsed on first run,
 *     and it remembers;
 *   · `use-rail-peek` — HQ sorts by urgency, Work by liveness, and a lane that
 *     cannot read its data says so instead of rendering a zero.
 *
 * Displaced, NOT deleted — every one of these still resolves:
 *   · Agents, Skills, Rhythms/Schedules, Memory, Watching, Guardrails, Usage,
 *     Channels, Connectors, Cue Live, Workspace and every Settings panel →
 *     leaves behind ⚙ Your Cue. One door, eighteen rooms.
 *   · Work's Things/Everything views → the Work page's own sub-nav
 *     (`pages/projects/work-views.tsx`). Nesting them here as well was a
 *     second nav path to one destination.
 *   · Connections (`/assistant/contacts`) → reached from Channels and from the
 *     channel-presence dots. It is per-person channel verification, and that
 *     data belongs on the person's row in People — so it gets no leaf.
 *   · Create (`/assistant/create`) and Voice (`/assistant/voice`) → composer
 *     affordances. Voice already has its mic + orb in the composer; Create's
 *     desktop chip is not built yet.
 *
 * And the rail is not there at all while you read a transcript: it collapses
 * to a 52px icon strip on entering a conversation (`rail-collapse.ts`), which
 * is what makes carrying this much affordable.
 */
/**
 * Rail iconography. Lives here rather than in `nav-model` so the model stays
 * a pure, framework-free description of WHERE things are — the phone draws
 * the same destinations with its own stroke glyphs.
 */
const PRIMARY_ICON: Record<PrimaryNavKey, typeof Target> = {
  // ✎ — the compose glyph, because this row is the destination AND the ⌘N
  // action (v14: "the destination keeps the row, the action becomes the icon
  // inside it"). One row where there used to be two.
  talk: SquarePen,
  hq: Target,
  work: LayoutList,
};

const SIDEBAR_ICON: Record<
  | "notes"
  | "people"
  | "library"
  | "apps"
  | "learn"
  | "connectors"
  | "skills"
  | "agents",
  typeof Target
> = {
  notes: NotebookPen,
  people: Users,
  library: LayoutGrid,
  apps: Blocks,
  learn: GraduationCap,
  connectors: Plug,
  skills: Sparkles,
  agents: Bot,
};

/*
 * A note on the tint the peek rows use.
 *
 * They were `--content-tertiary`, which measures **3.98:1** on
 * `--surface-overlay` in the light theme — under the 4.5:1 bar for text. They
 * are now `--content-secondary` (5.77:1 light, 7.01:1 dark, 9.21:1 serif).
 *
 * This is not the token sweep design vetoed: the ramp itself is fine, and
 * `--content-tertiary` still carries the `▾` disclosure glyph below, which is
 * an icon rather than text. What changed is the rule design gave instead —
 * **recede by size or weight, never contrast.** The peek rows already recede by
 * size (`size="compact"`), so they were paying for their quietness twice.
 */

/** What each lane says when it is expanded and has nothing to show. */
const PEEK_EMPTY: Record<PeekSectionKey, string> = {
  hq: "Nothing needs you",
  work: "Nothing live right now",
};

/**
 * What a lane says when it could not read its data.
 *
 * Deliberately not an empty list: "nothing needs you" and "I could not ask"
 * look identical at zero, and only one of them is safe to believe.
 */
const PEEK_UNREADABLE: Record<PeekSectionKey, string> = {
  hq: "⚠ Couldn't read HQ",
  work: "⚠ Couldn't read Work",
};

/**
 * `◧` — the rail's own collapse/pin control.
 *
 * It lives ON the rail, not only in the top bar, because the top bar's button
 * is the thing you have to already know about: entering a conversation shrinks
 * the rail to a 52px strip with no visible way back, and "there is a control
 * for this somewhere" is not discoverability. The glyph is design's, and it
 * carries its meaning in text — nothing here is distinguished by colour.
 */
function RailToggle({
  collapsed,
  inConversation,
  onToggle,
}: {
  collapsed: boolean;
  inConversation: boolean;
  onToggle: () => void;
}) {
  const label = railToggleLabel(collapsed, inConversation);
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border-none bg-transparent text-[13px] leading-none text-[color:var(--content-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[color:var(--content-emphasised)] keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]"
      >
        <span aria-hidden>◧</span>
      </button>
    </Tooltip>
  );
}

export function AssistantSideMenu({
  assistantId,
  collapsed,
  inConversation = false,
  onToggleCollapsed,
  variant,
  width,
  onWidthChange,
  conversations,
  activeConversationId,
  onSelectConversation,
  isLibraryActive = false,
  onOpenLibrary,
  onOpenApp,
  activeAppId,
  onStartNewConversation,
  footerAction,
  onPinConversation,
  onReorderConversations,
  onRenameConversation,
  onArchiveConversation,
  onUnarchiveConversation,
  onMarkConversationUnread,
  onMarkConversationRead,
  conversationGroups,
  onRenameGroup,
  onDeleteGroup,
  onMarkAllReadInGroup,
  onArchiveAllInGroup,
  onClose,
  processingConversationIds,
  attentionConversationIds,
  activeConversationProcessing,
  onAnalyze,
  onOpenInNewWindow,
  onShareFeedback,
  onInspect,
}: AssistantSideMenuProps) {
  // Direct navigation for the v0.3 flagship surfaces (next-moves / meeting /
  // people / trust) — these are reachable by route + the mobile tab bar; the
  // sidebar adds desktop discoverability without threading new callbacks.
  const navigate = useNavigate();
  const location = useLocation();
  const { count: needsYouCount } = useNeedsYouBadge(assistantId);
  // Work's "5 things" and Everything's "31 tasks" come from the same fetches
  // the Work surface itself reads, so the rail can never claim a count the
  // page then contradicts.
  const navCounts = useNavCounts(assistantId);
  // The peek. Reads the same two badge sources above, so the three titles and
  // the "N more" under them can never disagree with the number beside HQ.
  const peek = useRailPeek(assistantId);
  // The number beside `👤 People`. Queried, never guessed — `null` while
  // unread, which renders no badge rather than a `0`.
  const peopleCount = usePeopleCount(assistantId);
  // Flag-gated Tier-2 rows (VentureVerse Apps, Learn). Hidden until the
  // first real /feature-flags response lands — a defaultEnabled:false
  // flag briefly reading as true would flash a row and yank it back.
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const ventureverseAppsOn =
    useAssistantFeatureFlagStore.use.ventureverseApps();
  const learnAppOn = useAssistantFeatureFlagStore.use.learnApp();
  const railFlagOn: Record<
    NonNullable<SidebarDestination["flag"]>,
    boolean
  > = {
    ventureverseApps: ventureverseAppsOn,
    learnApp: learnAppOn,
  };
  const sidebarDestinations = SIDEBAR_DESTINATIONS.filter((d) =>
    d.flag ? flagsHydrated && railFlagOn[d.flag] : true,
  );
  const openSection = useRailPeekStore.use.openSection();
  const togglePeek = useRailPeekStore.use.toggle();
  const peekPanelId = useId();
  const cueNav = useCallback(
    (to: string) => {
      navigate(to);
      onClose?.();
    },
    [navigate, onClose],
  );
  const sidebar = useSidebarState({
    assistantId,
    conversations,
    conversationGroups,
    attentionConversationIds,
  });

  const pinnedApps = usePinnedAppsStore.use.pinnedApps();

  // --- Drag-reorder (Pinned + custom groups; sections sorted by displayOrder) ---

  const dragReorder = useDragReorder<Conversation>({
    getId: (c) => c.conversationId,
    onReorder: (_section, ordered) => onReorderConversations?.(ordered),
  });

  const buildDragProps = (
    section: string | undefined,
    items: Conversation[],
    conversation: Conversation,
  ) => {
    if (!section || !onReorderConversations || items.length < 2) return {};
    const { draggingId, dropIndicator } = dragReorder;
    const edge =
      dropIndicator?.section === section &&
      dropIndicator.itemId === conversation.conversationId
        ? dropIndicator.edge
        : null;
    return {
      ...dragReorder.getItemProps(section, items, conversation),
      className: cn(
        draggingId === conversation.conversationId && "opacity-50",
        edge === "before" && "shadow-[inset_0_2px_0_0_var(--primary-base)]",
        edge === "after" && "shadow-[inset_0_-2px_0_0_var(--primary-base)]",
      ),
    };
  };

  // --- Render helpers (action wiring, context menu, pin toggle) ---

  const renderThreadPinToggle = (conversation: Conversation): ReactNode => {
    const isProcessing =
      conversation.conversationId === activeConversationId
        ? (activeConversationProcessing ?? false)
        : (processingConversationIds?.has(conversation.conversationId) ??
          false);
    const needsAttention =
      attentionConversationIds?.has(conversation.conversationId) ?? false;
    return (
      <ThreadPinToggle
        conversation={conversation}
        isProcessing={isProcessing}
        needsAttention={needsAttention}
        onPinToggle={
          onPinConversation ? () => onPinConversation(conversation) : undefined
        }
      />
    );
  };

  const buildConversationMenuProps = (
    conversation: Conversation,
  ): ConversationMenuItemsProps => {
    const isChannel = isChannelConversation(conversation);
    return {
      isPinned: isConversationPinned(conversation),
      isArchived: conversation.archivedAt != null,
      isReadonly: isChannel,
      onPinToggle: onPinConversation
        ? () => onPinConversation(conversation)
        : undefined,
      onRename: onRenameConversation
        ? () => onRenameConversation(conversation)
        : undefined,
      onArchive: onArchiveConversation
        ? () => onArchiveConversation(conversation)
        : undefined,
      onUnarchive: onUnarchiveConversation
        ? () => onUnarchiveConversation(conversation)
        : undefined,
      onMarkRead:
        onMarkConversationRead && canMarkRead(conversation)
          ? () => onMarkConversationRead(conversation)
          : undefined,
      onMarkUnread:
        onMarkConversationUnread && !canMarkRead(conversation)
          ? () => onMarkConversationUnread(conversation)
          : undefined,
      isMarkUnreadDisabled: !canMarkUnread(conversation),
      onAnalyze:
        onAnalyze && conversation.conversationId != null && !isChannel
          ? () => onAnalyze(conversation)
          : undefined,
      onOpenInNewWindow:
        onOpenInNewWindow && conversation.conversationId != null
          ? () => onOpenInNewWindow(conversation)
          : undefined,
      onShareFeedback,
      onInspect:
        onInspect && conversation.conversationId != null
          ? () => onInspect(conversation)
          : undefined,
    };
  };

  const renderThreadActions = (conversation: Conversation): ReactNode => (
    <ConversationActionsMenu {...buildConversationMenuProps(conversation)} />
  );

  const renderThreadRow = (
    conversation: Conversation,
    panelItem: ReactNode,
  ): ReactNode => {
    const menuProps = buildConversationMenuProps(conversation);
    return (
      <ContextMenu.Root key={conversation.conversationId}>
        <ContextMenu.Trigger>{panelItem}</ContextMenu.Trigger>
        <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
          {renderConversationMenuItems({
            Primitive: ContextMenu,
            ...menuProps,
          })}
        </ContextMenu.Content>
      </ContextMenu.Root>
    );
  };

  const buildGroupContextMenu = (
    groupName: string,
    conversations: Conversation[],
    options?: { onRename?: () => void; onDelete?: () => void },
  ) => {
    const hasAnyAction =
      onMarkAllReadInGroup ||
      onArchiveAllInGroup ||
      options?.onRename ||
      options?.onDelete;
    if (!hasAnyAction) return undefined;

    return renderGroupMenuItems({
      Primitive: ContextMenu,
      onMarkAllRead: onMarkAllReadInGroup
        ? () => onMarkAllReadInGroup(conversations)
        : undefined,
      hasUnreadConversations: conversations.some(
        (c) => c.hasUnseenLatestAssistantMessage,
      ),
      onArchiveAll: onArchiveAllInGroup
        ? () => onArchiveAllInGroup(groupName, conversations)
        : undefined,
      hasConversations: conversations.length > 0,
      onRename: options?.onRename,
      onDelete: options?.onDelete,
    });
  };

  const selectAndClose = useCallback(
    (key: string) => {
      onSelectConversation(key);
      onClose?.();
    },
    [onSelectConversation, onClose],
  );

  // --- Header actions ---
  // A plain icon button that starts a new conversation on click.

  const headerActions = onStartNewConversation ? (
    <Button
      variant="ghost"
      size="compact"
      iconOnly={<SquarePen />}
      aria-label="New conversation"
      tooltip="New conversation"
      tooltipSide="right"
      onClick={() => {
        onStartNewConversation();
        onClose?.();
      }}
    />
  ) : null;

  // --- Flat conversation list renderer ---

  const renderFlatList = (
    items: Conversation[],
    pagination?: Pick<
      PaginatedSection,
      "showMore" | "onShowMore" | "showLess" | "onShowLess"
    >,
    reorderSection?: string,
  ): ReactNode => (
    <SideMenu.SubList>
      {items.map((c) =>
        renderThreadRow(
          c,
          <PanelItem
            leadingSlot={renderThreadPinToggle(c)}
            label={c.title ?? "Untitled"}
            marqueeOnHover
            active={c.conversationId === activeConversationId}
            onSelect={() => selectAndClose(c.conversationId)}
            trailingAction={renderThreadActions(c)}
            {...buildDragProps(reorderSection, items, c)}
          />,
        ),
      )}
      {pagination?.showMore ? (
        <SideMenu.Item
          label="Show more"
          size="compact"
          indent
          emphasized
          onSelect={pagination.onShowMore}
        />
      ) : null}
      {pagination?.showLess ? (
        <SideMenu.Item
          label="Show less"
          size="compact"
          indent
          emphasized
          onSelect={pagination.onShowLess}
        />
      ) : null}
    </SideMenu.SubList>
  );

  // --- Collapsed-rail popover content renderer ---

  const renderCollapsedGroupContent = (
    title: string,
    conversations: Conversation[],
    closePopover?: () => void,
    emptyState?: ReactNode,
  ): ReactNode => (
    <div className="pb-1">
      <div className="flex items-center justify-between px-4 py-1">
        <span className="text-body-small-default text-[var(--content-secondary)]">
          {title}
        </span>
      </div>
      <div className="px-2">
        {conversations.length === 0 ? emptyState : null}
        {conversations.map((c) => (
          <PanelItem
            key={c.conversationId}
            leadingSlot={renderThreadPinToggle(c)}
            label={c.title ?? "Untitled"}
            active={c.conversationId === activeConversationId}
            onSelect={() => {
              closePopover?.();
              selectAndClose(c.conversationId);
            }}
            trailingAction={renderThreadActions(c)}
          />
        ))}
      </div>
    </div>
  );

  // --- JSX ---

  return (
    <SideMenu
      ariaLabel="Assistant navigation"
      collapsed={collapsed}
      variant={variant}
      width={width}
      onWidthChange={onWidthChange}
      className="h-full"
    >
      <SideMenu.Header>
        {/*
          `cue.                              ◧`

          The `◧` is on the rail in BOTH states, which is the fix for the
          complaint that four destinations "looked missing": entering a
          conversation collapses the rail, and until now the only way back was
          a top-bar button that says "Toggle sidebar" and never mentions the
          shortcut. Collapsed, the mark and the control stack.
        */}
        {variant !== "overlay" ? (
          <div
            className={cn(
              "flex pb-2",
              collapsed
                ? "flex-col items-center gap-1 px-0"
                : "items-center gap-2.5 px-2",
            )}
          >
            <ApertureAvatar size={24} />
            {!collapsed ? (
              <span
                className="flex-1 select-none text-[19px] font-medium leading-none tracking-[-0.5px] text-[color:var(--content-emphasised)]"
                style={{ fontFamily: "var(--font-sans)" }}
              >
                cue<span style={{ color: "var(--accent-cue)" }}>.</span>
              </span>
            ) : null}
            {onToggleCollapsed ? (
              <RailToggle
                collapsed={collapsed}
                inConversation={inConversation}
                onToggle={onToggleCollapsed}
              />
            ) : null}
          </div>
        ) : null}
        {variant === "overlay" ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                iconOnly={<X />}
                aria-label="Close navigation"
                onClick={() => onClose?.()}
              />
              <SearchButton onClose={onClose} />
            </div>
            <div className="flex items-center gap-2">{headerActions}</div>
          </div>
        ) : null}
        {/*
          Tier 1 — three rows, from `PRIMARY_NAV`, the same declaration the
          phone's tab bar renders so the two platforms cannot describe
          different information models (v11 finding C1):

            ✎  Talk to Cue          ⌘N
            ◈  HQ                    7 ▾
            ▤  Work                  5 ▸

          "New conversation" is no longer its own row. v13 was right that it
          and "Talk to Cue" are one intent; v14 kept the collapse but inverted
          which one survives — the NAME stays "Talk to Cue" (it names the
          relationship) and the ✎ + ⌘N make it the compose row. Two rows became
          one, and the surface itself is right below in RECENT / All
          conversations, so nothing lost a door.
        */}
        {PRIMARY_NAV.map((destination) => {
          const active = destination.match(location.pathname);
          const section: PeekSectionKey | null =
            destination.key === "hq"
              ? "hq"
              : destination.key === "work"
                ? "work"
                : null;

          if (section === null) {
            return (
              <SideMenu.Item
                key={destination.key}
                icon={PRIMARY_ICON[destination.key]}
                label={destination.label}
                showCollapsedTooltip
                // Collapsed, the label is not rendered and the icon is
                // `aria-hidden`, so the row had NO accessible name — the
                // styled tooltip only reaches a pointer. Every icon in the
                // strip names itself now.
                aria-label={destination.label}
                emphasized
                // ⌘N rides in the badge slot rather than as a second control —
                // the row already IS the action. Shown only on the desktop
                // app, which is the only place the accelerator is registered
                // (`apps/macos/src/main/commands.ts`); printing a shortcut
                // that does nothing in a browser tab is a small lie the rail
                // does not need to tell.
                badge={
                  onStartNewConversation && isElectron() ? "⌘N" : undefined
                }
                active={active}
                onSelect={() => {
                  if (onStartNewConversation) {
                    onStartNewConversation();
                    onClose?.();
                    return;
                  }
                  cueNav(destination.to);
                }}
              />
            );
          }

          const lane = section === "hq" ? peek.hq : peek.work;
          const view = takePeek(lane);
          const open = openSection === section && !collapsed;
          const panelId = `${peekPanelId}-${section}`;
          // HQ carries the app's one badge: approvals parked mid-run plus
          // finished runs nobody has reviewed. Work's number is a count of
          // things, not a demand. Both hide at zero so neither nags.
          const count = section === "hq" ? needsYouCount : navCounts.things;

          return (
            // A Fragment, not a wrapper div: `SideMenu.Header` is the flex
            // column that supplies the rail's row spacing, so wrapping the row
            // AND its panel together would make the panel sit flush while
            // every sibling keeps its gap.
            <Fragment key={destination.key}>
              {/* `relative` wraps the row ALONE so the ▾ can sit on the right
                  edge without being nested inside the row's <button>. That
                  matters twice: nested buttons are invalid, and the disclosure
                  has to be its own hit target — clicking HQ must still go to
                  HQ. */}
              <div className="relative">
                <SideMenu.Item
                  icon={PRIMARY_ICON[destination.key]}
                  label={destination.label}
                  showCollapsedTooltip
                  // The count rides in the name too: collapsed, the badge is
                  // suppressed as well, so "HQ" alone would drop the one
                  // number the strip is carrying.
                  aria-label={
                    count > 0
                      ? `${destination.label} (${count})`
                      : destination.label
                  }
                  badge={count > 0 ? String(count) : undefined}
                  active={active}
                  className={collapsed ? undefined : "pr-8"}
                  onSelect={() => cueNav(destination.to)}
                />
                {collapsed ? null : (
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={open ? panelId : undefined}
                    aria-label={
                      open
                        ? `Hide what's in ${destination.label}`
                        : `Show what's in ${destination.label}`
                    }
                    onClick={() => togglePeek(section)}
                    className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[4px] text-[color:var(--content-tertiary)] outline-none hover:bg-[var(--surface-hover)] keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]"
                  >
                    {open ? (
                      <ChevronDown size={14} aria-hidden />
                    ) : (
                      <ChevronRight size={14} aria-hidden />
                    )}
                  </button>
                )}
              </div>

              {/* The peek. Three rows maximum, always — not "the first three
                  that fit". Unindented, because quieter type does the nesting
                  that position used to. Titles and a deadline, no buttons:
                  acting happens on the surface. */}
              {open ? (
                <div id={panelId} className="flex flex-col gap-[2px]">
                  {lane.status === "unreadable" ? (
                    <SideMenu.Item
                      label={PEEK_UNREADABLE[section]}
                      size="compact"
                      className="text-[color:var(--content-secondary)]"
                    />
                  ) : lane.status === "loading" ? (
                    <SideMenu.Item
                      label="Checking…"
                      size="compact"
                      className="text-[color:var(--content-secondary)]"
                    />
                  ) : view.shown.length === 0 && view.moreCount === 0 ? (
                    <SideMenu.Item
                      label={PEEK_EMPTY[section]}
                      size="compact"
                      className="text-[color:var(--content-secondary)]"
                    />
                  ) : (
                    <>
                      {view.shown.map((item) => (
                        <SideMenu.Item
                          key={item.id}
                          label={item.title}
                          size="compact"
                          badge={item.meta ?? undefined}
                          className="text-[color:var(--content-secondary)]"
                          onSelect={() => cueNav(destination.to)}
                        />
                      ))}
                      {view.moreCount > 0 ? (
                        <SideMenu.Item
                          label={
                            view.shown.length === 0
                              ? `${view.moreCount} in ${destination.label}`
                              : `${view.moreCount} more in ${destination.label}`
                          }
                          size="compact"
                          emphasized
                          trailingIcon={ChevronRight}
                          onSelect={() => cueNav(destination.to)}
                        />
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </Fragment>
          );
        })}

        <SideMenu.Separator />
      </SideMenu.Header>

      <SideMenu.Body className="gap-1 pt-3 max-md:pt-4">
        {collapsed && variant === "rail" ? (
          <div className="flex flex-col items-center gap-1">
            {headerActions}
            {sidebar.pinned.length > 0 ? (
              <CollapsedGroupIcon
                icon={Pin}
                label="Pinned"
                indicatorState={getGroupIndicatorState(
                  sidebar.pinned,
                  processingConversationIds,
                  attentionConversationIds,
                )}
              >
                {(close) =>
                  renderCollapsedGroupContent("Pinned", sidebar.pinned, close)
                }
              </CollapsedGroupIcon>
            ) : null}
            <CollapsedGroupIcon
              icon={Clock}
              label="Recents"
              disabled={sidebar.recents.all.length === 0}
              indicatorState={getGroupIndicatorState(
                sidebar.recents.all,
                processingConversationIds,
                attentionConversationIds,
              )}
            >
              {(close) =>
                renderCollapsedGroupContent(
                  "Recents",
                  sidebar.recents.all,
                  close,
                )
              }
            </CollapsedGroupIcon>
            <CollapsedGroupIcon
              icon={Hash}
              label="Slack"
              disabled={sidebar.slack.totalCount === 0}
              indicatorState={getGroupIndicatorState(
                sidebar.slack.all,
                processingConversationIds,
                attentionConversationIds,
              )}
            >
              {(close) =>
                renderCollapsedGroupContent("Slack", sidebar.slack.all, close)
              }
            </CollapsedGroupIcon>
            {/*
              The collapsed strip used to drop this row entirely — and the
              expanded one was dead (it redirected back where you came from),
              so "All conversations" was reachable from nowhere at all.
            */}
            <SideMenu.Item
              icon={MessagesSquare}
              label="All conversations"
              showCollapsedTooltip
              aria-label="All conversations"
              active={location.pathname === routes.conversations}
              onSelect={() => cueNav(routes.conversations)}
            />
          </div>
        ) : (
          <>
            {sidebar.pinned.length > 0 ? (
              <SideMenu.Section title="Pinned">
                {renderFlatList(sidebar.pinned, undefined, "pinned")}
              </SideMenu.Section>
            ) : null}

            <SideMenu.Section
              title="Chat"
              className="gap-1"
              actions={variant === "overlay" ? undefined : headerActions}
            >
              {renderFlatList(sidebar.recents.items, sidebar.recents)}

              {/* "All conversations ›" — the door to the full index. The rail
                  shows five; finding the one you half-remember is a job for a
                  page with quotes and thing-chips on it (v16 D3), not for an
                  ever-growing list in a 260px column. */}
              <SideMenu.Item
                label="All conversations"
                size="compact"
                emphasized
                trailingIcon={ChevronRight}
                aria-label="All conversations"
                active={location.pathname === routes.conversations}
                onSelect={() => cueNav(routes.conversations)}
              />

              <CollapsibleNavSection.Root
                type="multiple"
                className="gap-1"
                value={sidebar.effectiveOpenCategories}
                onValueChange={sidebar.onOpenCategoriesChange}
              >
                {sidebar.slack.totalCount > 0 ? (
                  <CollapsibleNavSection.Section
                    value="slack"
                    icon={Hash}
                    label="Slack"
                    contextMenuContent={buildGroupContextMenu(
                      "Slack",
                      sidebar.slack.all,
                    )}
                  >
                    {renderFlatList(sidebar.slack.items, sidebar.slack)}
                  </CollapsibleNavSection.Section>
                ) : null}
              </CollapsibleNavSection.Root>

              {sidebar.conversationGroupsEnabled &&
              sidebar.customGroups.length > 0 ? (
                <>
                  <SideMenu.Separator />
                  <SideMenu.Section title="Your Groups">
                    <CollapsibleNavSection.Root
                      type="multiple"
                      className="gap-1"
                      value={sidebar.effectiveOpenCustomGroups}
                      onValueChange={sidebar.onOpenCustomGroupsChange}
                    >
                      {sidebar.customGroups.map((group) => (
                        <CollapsibleNavSection.Section
                          key={group.id}
                          value={group.id}
                          label={group.name}
                          trailing={
                            onRenameGroup || onDeleteGroup ? (
                              <GroupActionsMenu
                                groupId={group.id}
                                onRename={onRenameGroup}
                                onDelete={onDeleteGroup}
                              />
                            ) : null
                          }
                          contextMenuContent={buildGroupContextMenu(
                            group.name,
                            group.conversations,
                            {
                              onRename: onRenameGroup
                                ? () => onRenameGroup(group.id)
                                : undefined,
                              onDelete: onDeleteGroup
                                ? () => onDeleteGroup(group.id)
                                : undefined,
                            },
                          )}
                        >
                          <SideMenu.SubList>
                            {group.conversations.map((c) =>
                              renderThreadRow(
                                c,
                                <PanelItem
                                  leadingSlot={renderThreadPinToggle(c)}
                                  label={c.title ?? "Untitled"}
                                  marqueeOnHover
                                  active={
                                    c.conversationId === activeConversationId
                                  }
                                  onSelect={() =>
                                    selectAndClose(c.conversationId)
                                  }
                                  trailingAction={renderThreadActions(c)}
                                  {...buildDragProps(
                                    `group:${group.id}`,
                                    group.conversations,
                                    c,
                                  )}
                                />,
                              ),
                            )}
                          </SideMenu.SubList>
                        </CollapsibleNavSection.Section>
                      ))}
                    </CollapsibleNavSection.Root>
                  </SideMenu.Section>
                </>
              ) : null}
            </SideMenu.Section>
          </>
        )}

        {/*
          The accumulating destinations — People and Library.

          **One column, same left margin as HQ and Work.** v20 laid this out as
          a two-column grid to fit six rows in; design overturned it and the
          live app proved the point — a grid "reads as a keypad, breaks
          vertical scanning, and truncates labels", and "Watching" shipped
          rendered as "Wat…". The other four rows were configuration, not
          destinations, and are now leaves inside Your Cue.

          No heading. The two separators either side do the grouping, which is
          what the drawing shows: a heading would be a third piece of furniture
          to explain two rows.
        */}
        <SideMenu.Separator />
        <div
          className={cn(
            "flex flex-col gap-[2px]",
            collapsed && variant === "rail" && "items-center",
          )}
        >
          {sidebarDestinations.map((destination) => {
            // Both rows always render. People used to be gated on relationship
            // extraction having written something; the owner overruled that and
            // the predicate was deleted rather than stubbed — see
            // `SIDEBAR_DESTINATIONS` in `nav-model.ts` for the decision.
            const isLibrary = destination.key === "library";
            const count = destination.key === "people" ? peopleCount : null;

            return (
              <SideMenu.Item
                key={destination.key}
                icon={SIDEBAR_ICON[destination.key]}
                label={destination.label}
                showCollapsedTooltip
                aria-label={
                  count && count > 0
                    ? `${destination.label} (${count})`
                    : destination.label
                }
                badge={count && count > 0 ? String(count) : undefined}
                active={
                  isLibrary
                    ? isLibraryActive || destination.match(location.pathname)
                    : destination.match(location.pathname)
                }
                // Library's host callback navigates to the same route this row
                // would; prefer it so the layout keeps whatever panel state it
                // wants to set on the way.
                onSelect={
                  isLibrary && onOpenLibrary
                    ? () => {
                        onOpenLibrary();
                        onClose?.();
                      }
                    : () => cueNav(destination.to)
                }
              />
            );
          })}
        </div>

        {/*
          ⚙ Your Cue — the door. Below the second separator, directly above the
          account line, because it is the row you leave the app's work behind
          to use. Settings used to be a second door to the same rooms; it now
          redirects here.
        */}
        <SideMenu.Separator />
        <div
          className={cn(
            "flex flex-col",
            collapsed && variant === "rail" && "items-center",
          )}
        >
          <SideMenu.Item
            icon={Settings2}
            label={YOUR_CUE_DOOR.label}
            showCollapsedTooltip
            aria-label={YOUR_CUE_DOOR.label}
            active={YOUR_CUE_DOOR.match(location.pathname)}
            onSelect={() => cueNav(YOUR_CUE_DOOR.to)}
          />
        </div>

        {/* Channel presence — live readiness dots (one memory across
            channels). Not a destination; it belongs with the CUE group
            because it answers the same question Watching will. */}
        {/* Channels are INPUTS, not destinations (v15) — they belong in
            Watching, which states what arrived and what Cue did with it.
            Until that surface exists they stay reachable from the Intelligence
            tab strip; a rail heading whose rows had already been pushed below
            the fold was worse than either. */}
        {pinnedApps.map((app) => (
          <SideMenu.Item
            key={app.appId}
            // Apps source their icon as an emoji string on the manifest
            // (`app.icon`). Fall back to the Rocket lucide glyph so unmojified
            // apps still get a leading icon in the rail.
            icon={app.icon ?? Rocket}
            label={app.name}
            showCollapsedTooltip
            aria-label={app.name}
            active={activeAppId === app.appId}
            onSelect={
              onOpenApp
                ? () => {
                    onOpenApp(app.appId);
                    onClose?.();
                  }
                : undefined
            }
          />
        ))}
      </SideMenu.Body>

      {footerAction ? (
        <SideMenu.Footer>
          <SideMenu.Separator />
          {footerAction}
        </SideMenu.Footer>
      ) : null}
    </SideMenu>
  );
}
