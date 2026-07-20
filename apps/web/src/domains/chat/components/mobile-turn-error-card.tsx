/**
 * MobileTurnErrorCard — the mobile chat's quiet error surface.
 *
 * The desktop path renders chat errors as composer Notice banners; the
 * mobile v3 chat screen previously rendered NOTHING for
 * `useChatSessionStore.error`, so a failed turn could look like a silent
 * no-reply. This card fixes that with two treatments:
 *
 *   1. Vision degrade — the daemon's "model doesn't support image input"
 *      error (feature-detected by text/code, since daemons in the field
 *      emit it with varying codes) renders as a calm, helpful card with
 *      honest copy instead of a raw error line. The user's message and
 *      attachment stay visible in the transcript above.
 *   2. Everything else eligible for the generic inline notice renders as
 *      a compact dismissible card with the daemon's message.
 *
 * Errors that already have richer surfaces stay out: `displayAs: "modal"`
 * (SendErrorModal is mounted for both paths in chat-route-content) and the
 * billing/provider-key banner family (`shouldShowGenericChatErrorNotice`
 * returns false for those).
 */

import { ImageOff, X } from "lucide-react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { shouldShowGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";

/**
 * Feature-detect the "model can't see images" family by code or copy —
 * e.g. "This model doesn't support image input. Remove the image or switch
 * to a vision-capable model." Exported for tests.
 */
export function isVisionUnsupportedError(error: {
  message: string;
  code?: string;
}): boolean {
  if (error.code === "VISION_UNSUPPORTED" || error.code === "IMAGE_UNSUPPORTED")
    return true;
  return /(?:(?:doesn'?t|does not|can'?t|cannot)\s+support\s+image|vision[- ]capable|image input)/i.test(
    error.message,
  );
}

export function MobileTurnErrorCard() {
  const error = useChatSessionStore.use.error();
  if (!error) return null;
  if (!shouldShowGenericChatErrorNotice(error)) return null;

  const vision = isVisionUnsupportedError(error);
  const dismiss = () => useChatSessionStore.getState().setError(null);

  return (
    <div
      data-mv3
      data-testid="mobile-turn-error-card"
      role="status"
      style={{
        borderRadius: 18,
        background: "var(--mv3-glass)",
        border: "1px solid var(--mv3-glass-border)",
        boxShadow: "var(--mv3-glass-shadow)",
        padding: "12px 14px",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      {vision ? (
        <span
          aria-hidden
          style={{
            width: 30,
            height: 30,
            borderRadius: 10,
            background: "var(--mv3-btn2-bg)",
            border: "1px solid var(--mv3-btn2-border)",
            color: "var(--mv3-muted)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <ImageOff size={15} />
        </span>
      ) : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        {vision ? (
          <>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.3,
                color: "var(--mv3-text)",
              }}
            >
              Cue's current model can't see images
            </div>
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.4,
                color: "var(--mv3-muted)",
                marginTop: 2,
              }}
            >
              Your message and attachment are safe above. Switch to a
              vision-capable model in settings, or ask again without the
              image.
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.3,
                color: "var(--mv3-text)",
              }}
            >
              That didn't go through
            </div>
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.4,
                color: "var(--mv3-muted)",
                marginTop: 2,
                overflowWrap: "anywhere",
              }}
            >
              {error.message}
            </div>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        style={{
          width: 28,
          height: 28,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          background: "transparent",
          color: "var(--mv3-micro)",
          cursor: "pointer",
          padding: 0,
          marginTop: -2,
          marginRight: -4,
          flexShrink: 0,
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <X size={15} aria-hidden />
      </button>
    </div>
  );
}
