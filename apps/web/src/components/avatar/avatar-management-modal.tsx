import { Image as ImageIcon, RotateCcw, Sparkles, X } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { removeAvatarImage, uploadAvatarImage } from "@/assistant/avatar-api";

interface AvatarManagementModalProps {
  open: boolean;
  onClose: () => void;
  assistantId: string;
  customImageUrl: string | null;
  /** Invalidate cached avatar data after an upload or reset. */
  onAvatarChange: () => void;
  onGenerateWithAI?: () => void;
}

/**
 * Cue avatar panel. Cue's identity is the single aperture mark (BRAND.md), so
 * there is no per-assistant "creature" to customize — `ChatAvatar` renders the
 * aperture by default and only honors a user-uploaded `customImageUrl`. This
 * modal therefore offers just three actions: upload a custom image, optionally
 * generate one via chat, and reset back to the aperture.
 */
export function AvatarManagementModal({
  open,
  onClose,
  assistantId,
  customImageUrl,
  onAvatarChange,
  onGenerateWithAI,
}: AvatarManagementModalProps) {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  useEffect(() => {
    if (open) {
      closeButtonRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === overlayRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  const handleFileSelect = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }

      setIsUploading(true);
      const ok = await uploadAvatarImage(assistantId, file);
      setIsUploading(false);

      if (ok) {
        onAvatarChange();
        onClose();
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [assistantId, onAvatarChange, onClose],
  );

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleGenerateWithAI = useCallback(() => {
    onClose();
    onGenerateWithAI?.();
  }, [onClose, onGenerateWithAI]);

  const handleReset = useCallback(async () => {
    setIsRemoving(true);
    const ok = await removeAvatarImage(assistantId);
    setIsRemoving(false);

    if (ok) {
      onAvatarChange();
      onClose();
    }
  }, [assistantId, onAvatarChange, onClose]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
    >
      <div
        className="mx-4 flex w-full max-w-md flex-col rounded-xl border shadow-xl"
        style={{
          backgroundColor: "var(--surface-lift)",
          borderColor: "var(--border-base)",
          maxHeight: "85vh",
        }}
      >
        <div
          className="flex items-center justify-between border-b px-6 py-4"
          style={{ borderColor: "var(--border-base)" }}
        >
          <h2
            id={titleId}
            className="text-title-small"
            style={{ color: "var(--content-default)" }}
          >
            Update Avatar
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            aria-label="Close"
          >
            <X
              className="h-4 w-4"
              style={{ color: "var(--content-secondary)" }}
            />
          </button>
        </div>

        <div className="overflow-y-auto p-6">
          <div className="flex flex-col items-center gap-6">
            <ChatAvatar
              components={null}
              traits={null}
              customImageUrl={customImageUrl}
              size={120}
              interactive
            />

            <div className="w-full space-y-2">
              <button
                type="button"
                onClick={handleUploadClick}
                disabled={isUploading}
                className="flex w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  borderColor: "var(--border-base)",
                  backgroundColor: "var(--surface-lift)",
                }}
              >
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor:
                      "color-mix(in oklab, var(--content-tertiary) 16%, transparent)",
                  }}
                >
                  <ImageIcon
                    className="h-4 w-4"
                    style={{ color: "var(--content-secondary)" }}
                  />
                </div>
                <div className="flex-1 text-left">
                  <p
                    className="text-body-medium-default"
                    style={{ color: "var(--content-default)" }}
                  >
                    {isUploading ? "Uploading..." : "Upload Image"}
                  </p>
                  <p
                    className="text-body-small-default"
                    style={{ color: "var(--content-tertiary)" }}
                  >
                    Choose an image from your computer
                  </p>
                </div>
              </button>

              {onGenerateWithAI && (
                <button
                  type="button"
                  onClick={handleGenerateWithAI}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors hover:opacity-80"
                  style={{
                    borderColor: "var(--border-base)",
                    backgroundColor: "var(--surface-lift)",
                  }}
                >
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      backgroundColor:
                        "color-mix(in oklab, var(--content-tertiary) 16%, transparent)",
                    }}
                  >
                    <Sparkles
                      className="h-4 w-4"
                      style={{ color: "var(--content-secondary)" }}
                    />
                  </div>
                  <div className="flex-1 text-left">
                    <p
                      className="text-body-medium-default"
                      style={{ color: "var(--content-default)" }}
                    >
                      Generate with AI
                    </p>
                    <p
                      className="text-body-small-default"
                      style={{ color: "var(--content-tertiary)" }}
                    >
                      Create an avatar through chat
                    </p>
                  </div>
                </button>
              )}

              {customImageUrl && (
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={isRemoving}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    borderColor: "var(--border-base)",
                    backgroundColor: "var(--surface-lift)",
                  }}
                >
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      backgroundColor:
                        "color-mix(in oklab, var(--content-tertiary) 16%, transparent)",
                    }}
                  >
                    <RotateCcw
                      className="h-4 w-4"
                      style={{ color: "var(--content-secondary)" }}
                    />
                  </div>
                  <div className="flex-1 text-left">
                    <p
                      className="text-body-medium-default"
                      style={{ color: "var(--content-default)" }}
                    >
                      {isRemoving ? "Resetting..." : "Reset to Cue aperture"}
                    </p>
                    <p
                      className="text-body-small-default"
                      style={{ color: "var(--content-tertiary)" }}
                    >
                      Remove the custom image and use Cue's default mark
                    </p>
                  </div>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={handleFileSelect}
      />
    </div>,
    document.body,
  );
}
