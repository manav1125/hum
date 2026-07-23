/**
 * Portal-based mobile overlay container for app, document, subagent-detail,
 * and tool-detail viewers. Reads from Zustand stores directly so the parent
 * (ActiveChatView) doesn't need to assemble inline handlers.
 *
 * Renders nothing on desktop viewports (useMobileOverlayTarget returns null).
 */

import { useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useDeployStore } from "@/stores/deploy-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

import type { AppViewerRemix } from "@/components/app-viewer-container";
import { MobileAppOverlay } from "@/domains/chat/components/mobile-app-overlay";
import { MobileDocumentOverlay } from "@/domains/chat/components/mobile-document-overlay";
import { MobileSpreadsheetOverlay } from "@/domains/chat/components/mobile-spreadsheet-overlay";
import { MobileSubagentDetailOverlay } from "@/domains/chat/components/mobile-subagent-detail-overlay";
import { MobileToolDetailOverlay } from "@/domains/chat/components/mobile-tool-detail-overlay";
import { useMobileOverlayTarget } from "@/domains/chat/hooks/use-mobile-overlay-target";
import { useRemixDescriptor } from "@/hooks/use-remix-descriptor";

export function MobileChatOverlays() {
  const overlayTarget = useMobileOverlayTarget();
  const navigate = useNavigate();

  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const editingConversationId =
    useConversationStore.use.editingConversationId();
  const mainView = useViewerStore.use.mainView();
  const openedAppState = useViewerStore.use.openedAppState();
  const openedDocumentState = useViewerStore.use.openedDocumentState();
  const openedSpreadsheetState = useViewerStore.use.openedSpreadsheetState();
  const isAppMinimized = useViewerStore.use.isAppMinimized();
  const activeSubagentId = useViewerStore.use.activeSubagentId();
  const activeToolDetail = useViewerStore.use.activeToolDetail();
  const subagentById = useSubagentStore.use.byId();
  const isSharing = useDeployStore.use.isSharing();
  const isDeploying = useDeployStore.use.isDeploying();
  const handleCloseApp = useCallback(() => {
    useViewerStore.getState().closeApp();
    useConversationStore.getState().setEditingConversationId(null);
  }, []);

  const handleShareApp = useCallback(() => {
    const app = useViewerStore.getState().openedAppState;
    const aid = useResolvedAssistantsStore.getState().activeAssistantId;
    if (app && aid)
      void useDeployStore.getState().shareApp(aid, app.appId, app.name);
  }, []);

  const handleDeployApp = useCallback(() => {
    const app = useViewerStore.getState().openedAppState;
    const aid = useResolvedAssistantsStore.getState().activeAssistantId;
    if (app && aid)
      void useDeployStore
        .getState()
        .deployApp(aid, app.appId, app.name, app.html);
  }, []);

  const handleCloseDocument = useCallback(() => {
    useViewerStore.getState().closeDocument();
  }, []);

  const handleCloseSpreadsheet = useCallback(() => {
    useViewerStore.getState().closeSpreadsheet();
  }, []);

  const handleCloseSubagentDetail = useCallback(() => {
    useViewerStore.getState().closeSubagentDetail();
  }, []);

  const handleStopSubagent = useCallback(
    (subagentId: string) =>
      void useSubagentStore.getState().abortSubagent(subagentId),
    [],
  );

  const handleRequestSubagentDetail = useCallback((subagentId: string) => {
    const aid = useResolvedAssistantsStore.getState().activeAssistantId;
    if (!aid) return;
    void useSubagentStore.getState().fetchDetailIfNeeded(aid, subagentId);
  }, []);

  const handleCloseToolDetail = useCallback(() => {
    useViewerStore.getState().closeToolDetail();
  }, []);

  const handleToolDetailRiskBadgeClick = useCallback(() => {
    useViewerStore.getState().requestRuleEditorForActiveTool();
  }, []);

  // Create Studio remix (SET 3 · mobile). Re-seeds the source conversation via
  // the same `?prompt=` path as the desktop layout (see chat-content-layout).
  const reseedConversation = useCallback(
    (prompt: string) => {
      const cid =
        useConversationStore.getState().editingConversationId ??
        useConversationStore.getState().activeConversationId;
      if (!cid) return;
      navigate(
        `${routes.conversation(cid)}?prompt=${encodeURIComponent(prompt)}`,
      );
    },
    [navigate],
  );

  const handleNewBrandKit = useCallback(() => {
    navigate(routes.settings.brand);
  }, [navigate]);

  // Remix descriptor from the shared hook — reads real origin provenance and
  // wires Restyle to summon the gallery over the chat asset (see the desktop
  // chat-content-layout wiring for the full note).
  const remixSourceConversationId =
    editingConversationId ??
    useConversationStore.getState().activeConversationId;
  const remix: AppViewerRemix | undefined = useRemixDescriptor({
    assetName: openedAppState?.name ?? null,
    sourceConversationId: openedAppState ? remixSourceConversationId : null,
    onReseed: reseedConversation,
    onNewBrandKit: handleNewBrandKit,
    enableFanout: true,
  });

  if (!overlayTarget) return null;

  return createPortal(
    <>
      <MobileAppOverlay
        openedAppState={mainView === "app" ? openedAppState : null}
        isAppMinimized={isAppMinimized}
        assistantId={assistantId}
        onToggleMinimized={() => {
          useViewerStore.getState().toggleAppMinimized();
        }}
        onClose={handleCloseApp}
        onShare={handleShareApp}
        isSharing={isSharing}
        onDeploy={handleDeployApp}
        isDeploying={isDeploying}
        remix={remix}
      />
      <MobileDocumentOverlay
        openedDocumentState={
          mainView === "document" ? openedDocumentState : null
        }
        assistantId={assistantId}
        onClose={handleCloseDocument}
      />
      <MobileSpreadsheetOverlay
        openedSpreadsheetState={
          mainView === "spreadsheet" ? openedSpreadsheetState : null
        }
        assistantId={assistantId}
        onClose={handleCloseSpreadsheet}
      />
      <MobileSubagentDetailOverlay
        entry={
          mainView === "subagent-detail" && activeSubagentId
            ? (subagentById[activeSubagentId] ?? null)
            : null
        }
        onClose={handleCloseSubagentDetail}
        onStop={handleStopSubagent}
        onRequestDetail={handleRequestSubagentDetail}
      />
      <MobileToolDetailOverlay
        detail={mainView === "tool-detail" ? activeToolDetail : null}
        onClose={handleCloseToolDetail}
        onRiskBadgeClick={handleToolDetailRiskBadgeClick}
      />
    </>,
    overlayTarget,
  );
}
