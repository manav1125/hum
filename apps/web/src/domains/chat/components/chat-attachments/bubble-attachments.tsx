import type { FC } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import { useAttachmentPreview } from "@/hooks/use-attachment-preview";
import {
  classifyAttachment,
  isViewableSpreadsheet,
} from "@/domains/chat/components/chat-attachments/utils";
import { useViewerStore } from "@/stores/viewer-store";

interface BubbleAttachmentsProps {
  attachments: DisplayAttachment[];
  /** Forwarded to {@link AttachmentPreviewModal} so it can lazily fetch
   *  attachment content when `previewUrl` is missing. */
  assistantId?: string | null;
  /** Open the native spreadsheet viewer for a persisted `.xlsx` attachment.
   *  See {@link MessageAttachments} for the rationale. */
  onOpenSpreadsheet?: (attachmentId: string, filename: string) => void;
}

/**
 * In-bubble attachment renderer for sent user messages. Image attachments with
 * a usable `previewUrl` render as large inline previews; every other
 * attachment (non-images, plus images whose preview is missing) renders as a
 * compact {@link MessageAttachmentSquare} chip. Both kinds are clickable and
 * open the full-screen {@link AttachmentPreviewModal}.
 *
 * Distinct from {@link MessageAttachments}, the legacy separate-strip renderer
 * still used for assistant messages, which renders every attachment as a chip.
 */
export const BubbleAttachments: FC<BubbleAttachmentsProps> = ({
  attachments,
  assistantId,
  onOpenSpreadsheet,
}) => {
  const { openPreview, previewModal } = useAttachmentPreview(assistantId);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {attachments.map((att) => {
          const isInlineImage =
            classifyAttachment(att.mimeType, att.filename) === "image" &&
            att.previewUrl != null;

          // Route any viewable .xlsx to the native grid viewer, using the
          // threaded prop when present but falling back to the viewer store
          // directly so a durable spreadsheet always opens the grid rather
          // than the download modal. See {@link MessageAttachments}.
          const opensInViewer = isViewableSpreadsheet(
            att.mimeType,
            att.filename,
          );
          const openSpreadsheet =
            onOpenSpreadsheet ??
            ((id: string, filename: string) =>
              useViewerStore.getState().loadSpreadsheet(id, filename));

          if (isInlineImage) {
            return (
              <img
                key={att.id}
                src={att.previewUrl ?? undefined}
                alt={att.filename}
                role="button"
                aria-label={att.filename}
                title={att.filename}
                tabIndex={0}
                onClick={() => openPreview(att)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openPreview(att);
                  }
                }}
                className="max-h-[320px] max-w-full cursor-pointer rounded-lg object-contain"
              />
            );
          }

          return (
            <MessageAttachmentSquare
              key={att.id}
              filename={att.filename}
              mimeType={att.mimeType}
              sizeBytes={att.sizeBytes}
              previewUrl={att.previewUrl}
              onPreview={
                opensInViewer
                  ? () => openSpreadsheet(att.id, att.filename)
                  : () => openPreview(att)
              }
            />
          );
        })}
      </div>
      {previewModal}
    </>
  );
};
