/**
 * Mobile-v3 chat power menus — the v3-skinned equivalents of the desktop
 * composer-settings popover and the conversation-actions header menu, rendered
 * as `SheetShell` bottom sheets (spec sheet grammar: glass material, grabber,
 * transform-only entrance).
 *
 * These are MOUNTS, not re-implementations:
 * - `MobileComposerSettingsSheet` consumes `useComposerSettings` (extracted
 *   from `composer-settings-menu.tsx`) — the exact same queries, optimistic
 *   state, and persistence the desktop picker uses (per-conversation model
 *   profile override + Assistant Access threshold override).
 * - `MobileConversationActionsSheet` reuses the same handler sources the
 *   desktop `ChatConversationHeader` menu wires: `headerSupplements` from the
 *   chat-layout slots store (analyze / fork / copy / refresh / inspect /
 *   open-in-new-window, registered by ActiveChatView on every platform) and
 *   `useConversationActions` (pin / rename / archive — TanStack-cache-shared
 *   with the ChatLayout instance, so optimistic updates reconcile the same
 *   caches). Item set + gating mirror the `variant="header"` menu.
 *
 * Only mounted from `mobile-chat-view.tsx` (mobile-gated); desktop paths are
 * untouched.
 */
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  Microscope,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { profilePickerLabel } from "@/assistant/profile-pickers";
import { useProfileQuickAdd } from "@/components/profile-quick-add-provider";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { useComposerSettings } from "@/domains/chat/components/composer-settings-menu";
import { useConversationActions } from "@/domains/chat/hooks/use-conversation-actions";
import { useCanUseLlmInspector } from "@/domains/chat/inspector/access";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { navigateAfterArchive } from "@/domains/chat/utils/conversation-navigation";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { SheetShell, microLabel } from "@/mobile-v3";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useConversationStore } from "@/stores/conversation-store";
import { THRESHOLD_PRESETS } from "@/utils/threshold-presets";
import { haptic } from "@/utils/haptics";
import { toast } from "@vellumai/design-library/components/toast";

// ---------------------------------------------------------------------------
// v3 sheet furniture — section label, divider, 48pt row
// ---------------------------------------------------------------------------

function SheetSectionLabel({
  children,
  trailingAction,
}: {
  children: ReactNode;
  trailingAction?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "8px 8px 4px",
      }}
    >
      <span style={{ ...microLabel, color: "var(--mv3-micro)" }}>
        {children}
      </span>
      {trailingAction}
    </div>
  );
}

function SheetDivider() {
  return (
    <div
      aria-hidden="true"
      style={{ height: 1, background: "var(--mv3-line)", margin: "8px 0" }}
    />
  );
}

/**
 * One v3 sheet row: ≥48pt target, 16px type, quiet icon, optional trailing
 * (active check). `haptic.light()` fires in the caller's onSelect wrapper.
 */
function SheetRow({
  icon: Icon,
  label,
  onSelect,
  disabled,
  active,
}: {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className="cue-pressable"
      onClick={disabled ? undefined : onSelect}
      aria-disabled={disabled || undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        minHeight: 48,
        padding: "11px 8px",
        border: "none",
        borderRadius: 12,
        background: "transparent",
        color: "var(--mv3-text)",
        fontFamily: "inherit",
        fontSize: 16,
        lineHeight: 1.3,
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <Icon
        size={18}
        style={{ color: "var(--mv3-muted)", flexShrink: 0 }}
        aria-hidden
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {active ? (
        <Check
          size={16}
          style={{ color: "var(--mv3-green)", flexShrink: 0 }}
          aria-hidden
        />
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Composer settings sheet — model profile + autonomy threshold
// ---------------------------------------------------------------------------

export function MobileComposerSettingsSheet({
  assistantId,
  conversationId,
  open,
  onClose,
}: {
  assistantId: string;
  conversationId: string | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const {
    activePreset,
    isOverride,
    serverGlobalInteractive,
    handleSelect,
    showModelProfileSection,
    profilesLoaded,
    visibleProfileEntries,
    profileActiveKey,
    handleProfileSelect,
    existingProfileNames,
  } = useComposerSettings({ assistantId, conversationId });

  // Same top-level provider the desktop quick-add uses (ProfileEditorModal in
  // create mode). Sheet closes first so the modal doesn't open underneath it.
  const { openProfileQuickAdd } = useProfileQuickAdd();

  return (
    <SheetShell open={open} onClose={onClose} label="Conversation settings">
      <SheetSectionLabel>Assistant access</SheetSectionLabel>
      {THRESHOLD_PRESETS.map((preset) => {
        const isActive = preset.id === activePreset.id;
        const isDefault =
          !isOverride &&
          serverGlobalInteractive !== null &&
          preset.riskThreshold === serverGlobalInteractive;
        return (
          <SheetRow
            key={preset.id}
            icon={preset.icon}
            label={isDefault ? `${preset.label} (default)` : preset.label}
            active={isActive}
            onSelect={() => {
              haptic.light();
              void handleSelect(preset);
              onClose();
            }}
          />
        );
      })}
      {showModelProfileSection ? (
        <>
          <SheetDivider />
          <SheetSectionLabel
            trailingAction={
              <button
                type="button"
                className="cue-pressable"
                aria-label="New profile"
                aria-disabled={!profilesLoaded || undefined}
                onClick={() => {
                  if (!profilesLoaded) return;
                  haptic.light();
                  onClose();
                  openProfileQuickAdd({
                    existingNames: existingProfileNames,
                    onCreated: (name) => {
                      void handleProfileSelect(name).then((selected) => {
                        if (!selected) {
                          toast.error(
                            "Profile created, but couldn't switch to it",
                          );
                        }
                      });
                    },
                  });
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: 44,
                  minHeight: 44,
                  margin: "-14px -12px",
                  border: "none",
                  background: "transparent",
                  color: "var(--mv3-muted)",
                  cursor: profilesLoaded ? "pointer" : "default",
                  opacity: profilesLoaded ? 1 : 0.45,
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <Plus size={16} aria-hidden />
              </button>
            }
          >
            Model profile
          </SheetSectionLabel>
          {visibleProfileEntries.map((entry) => {
            const isActive = entry.name === profileActiveKey;
            return (
              <SheetRow
                key={entry.name}
                icon={Sparkles}
                label={profilePickerLabel(entry)}
                active={isActive}
                onSelect={() => {
                  haptic.light();
                  void handleProfileSelect(entry.name);
                  onClose();
                }}
              />
            );
          })}
        </>
      ) : null}
    </SheetShell>
  );
}

// ---------------------------------------------------------------------------
// Conversation actions sheet — the header "⋯" menu
// ---------------------------------------------------------------------------

export function MobileConversationActionsSheet({
  assistantId,
  open,
  onClose,
}: {
  assistantId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const { conversations } = useConversationListQuery(assistantId);
  const headerSupplements = useChatLayoutSlotsStore.use.headerSupplements();
  const showLlmInspector = useCanUseLlmInspector();
  const isNative = useIsNativePlatform();

  // Same CRUD hook ChatLayout instantiates for the sidebar/header menus.
  // Mutations share the TanStack cache (snapshots + invalidations hit the
  // same conversation-list keys), so this second instance stays consistent.
  const prePinGroupIdsRef = useRef<Map<string, string | undefined>>(new Map());
  // The hook only calls these callbacks from its post-archive paths — route
  // to the Chats index (mobile) / Today instead of the next conversation
  // (UAT P1-9). This sheet only archives the ACTIVE conversation, so the
  // navigate always fires.
  const postArchiveNavigate = useCallback(
    () => navigateAfterArchive(navigate),
    [navigate],
  );
  const {
    handleArchiveConversation,
    handleUnarchiveConversation,
    handleTogglePinConversation,
    handleRenameConversation,
  } = useConversationActions({
    assistantId,
    activeConversationId,
    conversations,
    switchConversation: postArchiveNavigate,
    startNewConversation: postArchiveNavigate,
    prePinGroupIdsRef,
  });

  const activeConversation = useMemo(
    () =>
      conversations.find((c) => c.conversationId === activeConversationId) ??
      null,
    [conversations, activeConversationId],
  );

  if (!activeConversation) return null;

  const isReadonly = isChannelConversation(activeConversation);
  const isPinned =
    activeConversation.isPinned ||
    activeConversation.groupId === "system:pinned";
  const isArchived = activeConversation.archivedAt != null;

  /** Row helper: haptic → action → dismiss (action first so its UI feedback
   *  doesn't fire under a still-open sheet — matches the desktop mobile
   *  BottomSheet's `run(); onClose();` order). */
  const row = (
    key: string,
    icon: LucideIcon,
    label: string,
    run: () => void,
  ) => (
    <SheetRow
      key={key}
      icon={icon}
      label={label}
      onSelect={() => {
        haptic.light();
        run();
        onClose();
      }}
    />
  );

  // Item set + gating mirror ChatConversationHeader's `variant="header"` menu
  // (macOS-parity order), minus open-in-new-window on native platforms —
  // same rule the existing mobile BottomSheet applies.
  return (
    <SheetShell open={open} onClose={onClose} label="Conversation actions">
      {headerSupplements?.onCopyConversation
        ? row("copy", Copy, "Copy full conversation", () =>
            headerSupplements.onCopyConversation!(),
          )
        : null}
      {!isReadonly &&
      headerSupplements?.hasPersistedMessage &&
      headerSupplements?.onForkConversation
        ? row("fork", GitBranch, "Fork conversation", () =>
            headerSupplements.onForkConversation!(),
          )
        : null}
      {!isReadonly && headerSupplements?.onAnalyze
        ? row("analyze", Sparkles, "Analyze conversation", () =>
            headerSupplements.onAnalyze!(activeConversation),
          )
        : null}
      {!isNative && headerSupplements?.onOpenInNewWindow
        ? row("open-in-new-window", ExternalLink, "Open in new window", () =>
            headerSupplements.onOpenInNewWindow!(activeConversation),
          )
        : null}
      {headerSupplements?.onRefresh
        ? row("refresh", RefreshCw, "Refresh", () =>
            headerSupplements.onRefresh!(),
          )
        : null}
      {row(
        "pin",
        isPinned ? PinOff : Pin,
        isPinned ? "Unpin" : "Pin",
        () => handleTogglePinConversation(activeConversation),
      )}
      {row("rename", Pencil, "Rename", () =>
        handleRenameConversation(activeConversation),
      )}
      {isArchived
        ? row("unarchive", ArchiveRestore, "Unarchive", () =>
            handleUnarchiveConversation(activeConversation),
          )
        : row("archive", Archive, "Archive", () =>
            handleArchiveConversation(activeConversation),
          )}
      {showLlmInspector && headerSupplements?.onInspect
        ? row("inspect", Microscope, "Inspect", () =>
            headerSupplements.onInspect!(activeConversation),
          )
        : null}
    </SheetShell>
  );
}
