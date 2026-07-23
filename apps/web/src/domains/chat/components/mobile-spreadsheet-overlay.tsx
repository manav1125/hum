/**
 * MobileSpreadsheetOverlay — full-screen spreadsheet viewer for mobile.
 *
 * The desktop spreadsheet surface opens as a resizable side panel; on mobile we
 * present the same viewer full-screen. It reuses `SpreadsheetViewerContainer`
 * verbatim (its own header carries the title, download, and close), so the
 * read-only-preview + honest-formula behavior is identical across form factors.
 * Editing on mobile is deferred along with editing on desktop — the container's
 * footer states that boundary.
 *
 * **Mounting constraint**: renders inside RootLayout's `#viewport-overlays`
 * portal (via `MobileChatOverlays`), outside the main content wrapper.
 */

import { SpreadsheetViewerContainer } from "@/domains/chat/components/spreadsheet-viewer-container";
import type { OpenedSpreadsheetState } from "@/stores/viewer-store";

interface MobileSpreadsheetOverlayProps {
  /** When `null`, the overlay renders nothing. */
  openedSpreadsheetState: OpenedSpreadsheetState | null;
  assistantId: string | null;
  onClose: () => void;
}

export function MobileSpreadsheetOverlay({
  openedSpreadsheetState,
  assistantId,
  onClose,
}: MobileSpreadsheetOverlayProps) {
  if (!openedSpreadsheetState || !assistantId) return null;
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 h-[100dvh] bg-[var(--surface-base)]"
      style={{
        paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
      }}
    >
      <SpreadsheetViewerContainer
        key={openedSpreadsheetState.attachmentId}
        attachmentId={openedSpreadsheetState.attachmentId}
        filename={openedSpreadsheetState.filename}
        assistantId={assistantId}
        onClose={onClose}
      />
    </div>
  );
}
