/**
 * Opening a made thing — one resolver both doors share.
 *
 * A card that goes nowhere is the no-op this product refuses, so every branch
 * lands on something real, in falling order of directness:
 *
 *   file-backed  → the attachment preview (the real bytes)
 *   link-backed  → the external URL it was published to
 *   filed        → the thing it was made for
 *   otherwise    → the review pager seeded at the work item that produced it
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
      if (entry.projectId) {
        navigate(routes.project(entry.projectId));
        return;
      }
      navigate(
        `${routes.reviewQueue}?item=${encodeURIComponent(entry.workItemId)}`,
      );
    },
    [navigate, openPreview],
  );

  return { openEntry, previewModal };
}
