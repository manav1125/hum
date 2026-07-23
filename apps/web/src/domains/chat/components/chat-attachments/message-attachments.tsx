import type { FC } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import { isViewableSpreadsheet } from "@/domains/chat/components/chat-attachments/utils";

interface MessageAttachmentsProps {
  attachments: DisplayAttachment[];
  /** Forwarded to {@link AttachmentPreviewModal} so it can lazily fetch
   *  attachment content when `previewUrl` is missing. */
  assistantId?: string | null;
  /**
   * Open the native in-Cue spreadsheet viewer for a persisted `.xlsx`
   * attachment. When provided, clicking a viewable spreadsheet chip opens the
   * viewer (the durable entry point that survives thread reloads) instead of
   * the generic preview modal. Omitted → spreadsheets fall back to the modal.
   */
  onOpenSpreadsheet?: (attachmentId: string, filename: string) => void;
}

/**
 * Read-only strip of attachment thumbnails rendered as a separate strip for
 * assistant messages (the user path now renders attachments inside the message
 * bubble via {@link BubbleAttachments}). Every attachment is clickable and
 * opens a full-screen preview modal — the modal handles type-specific
 * rendering (image/video/fallback) and lazily fetches missing content when
 * needed.
 */
export const MessageAttachments: FC<MessageAttachmentsProps> = ({
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
      <div className="flex flex-wrap gap-2">
        {attachments.map((att) => {
          const opensInViewer =
            onOpenSpreadsheet != null &&
            isViewableSpreadsheet(att.mimeType, att.filename);
          return (
            <MessageAttachmentSquare
              key={att.id}
              filename={att.filename}
              mimeType={att.mimeType}
              sizeBytes={att.sizeBytes}
              previewUrl={att.previewUrl}
              onPreview={
                opensInViewer
                  ? () => onOpenSpreadsheet(att.id, att.filename)
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
