/**
 * Opening a made thing — one resolver both doors share.
 *
 * A card that goes nowhere is the no-op this product refuses, so every branch
 * lands on something real, in falling order of directness:
 *
 *   file-backed  → the attachment preview (the real bytes)
 *   link-backed  → the external URL it was published to
 *   a document   → the document surface
 *   an app       → the app
 *   filed        → the thing it was made for
 *   run-backed   → the review pager seeded at the work item that produced it
 *
 * The last branch used to be unconditional, on the assumption that every entry
 * came from a work run. Now that the Library also holds documents, apps and
 * files Cue made outside a run, `workItemId` is legitimately null — and
 * `?item=undefined` is a card that goes nowhere, which is the exact thing this
 * file exists to prevent.
 */
import { useCallback } from "react";
import { useNavigate } from "react-router";

import { useAttachmentPreview } from "@/hooks/use-attachment-preview";
import { routes } from "@/utils/routes";

import type { LibraryEntry } from "./library-model";

export function useOpenLibraryEntry(assistantId: string): {
  openEntry: (entry: LibraryEntry) => void;
  previewModal: React.ReactNode;
} {
  const navigate = useNavigate();
  const { openPreview, previewModal } = useAttachmentPreview(assistantId);

  const openEntry = useCallback(
    (entry: LibraryEntry) => {
      if (entry.attachment) {
        openPreview({
          id: entry.attachment.id,
          filename: entry.attachment.filename,
          mimeType: entry.attachment.mimeType,
          sizeBytes: entry.attachment.sizeBytes,
          previewUrl: null,
        });
        return;
      }
      if (entry.externalUrl) {
        window.open(entry.externalUrl, "_blank", "noopener,noreferrer");
        return;
      }
      if (entry.documentId) {
        navigate(routes.document(entry.documentId));
        return;
      }
      if (entry.appId) {
        navigate(routes.library.app(entry.appId));
        return;
      }
      if (entry.projectId) {
        navigate(routes.project(entry.projectId));
        return;
      }
      if (entry.workItemId) {
        navigate(
          `${routes.reviewQueue}?item=${encodeURIComponent(entry.workItemId)}`,
        );
        return;
      }
      // Nothing behind it. The card should not have been tappable, so this is
      // a silent no-navigation rather than a route to a page about nothing.
    },
    [navigate, openPreview],
  );

  return { openEntry, previewModal };
}
