import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { AttachmentPreviewModal } from "@/domains/chat/components/chat-attachments/attachment-preview-modal";

interface UseAttachmentPreviewResult {
  /** Open the full-screen preview modal for the given attachment. */
  openPreview: (attachment: DisplayAttachment) => void;
  /** The rendered {@link AttachmentPreviewModal}, or `null` when nothing is
   *  open. Render this somewhere stable in the consuming component. */
  previewModal: ReactNode;
}

/**
 * Attachment full-screen preview (shared, top-level).
 *
 * Owns the shared preview plumbing for the attachment renderers
 * ({@link BubbleAttachments} and {@link MessageAttachments}): the open/close
 * state and the {@link AttachmentPreviewModal} element. Consumers call
 * `openPreview(att)` from an item's click handler and render `previewModal`.
 *
 * Lives in the top-level `hooks/` dir (so it MAY import from `chat`) because
 * the Library renders the same preview for its documents and media, and the
 * `library` domain can't reach into `chat` internals — the
 * `no-cross-domain-imports` rule forbids it. The modal itself stays in `chat`:
 * it pulls a 380-line subtree (pdf/text previews, size formatting) that only
 * this hook needs, so lifting the hook alone is what makes the dependency
 * explicit and one-directional.
 *
 * @param assistantId Forwarded to {@link AttachmentPreviewModal} so it can
 *   lazily fetch attachment content when `previewUrl` is missing.
 */
export function useAttachmentPreview(
  assistantId?: string | null,
): UseAttachmentPreviewResult {
  const [previewAttachment, setPreviewAttachment] =
    useState<DisplayAttachment | null>(null);

  const openPreview = useCallback(
    (attachment: DisplayAttachment) => setPreviewAttachment(attachment),
    [],
  );
  const handleClose = useCallback(() => setPreviewAttachment(null), []);

  const previewModal = previewAttachment ? (
    <AttachmentPreviewModal
      open
      onClose={handleClose}
      attachment={previewAttachment}
      assistantId={assistantId}
    />
  ) : null;

  return { openPreview, previewModal };
}
