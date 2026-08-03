/**
 * The one description of what a SPOKEN turn looks like (mobile v3 frame 37).
 *
 * Three surfaces draw the same spoken turn — the in-thread live strip, the
 * reloaded transcript in `MobileChatView`, and the full-screen voice surface —
 * and a user who says one sentence and sees it rendered three different ways
 * does not believe they are looking at one conversation. It lives here, in the
 * voice module, because every one of those consumers is downstream of it;
 * putting it in any of them would make the other two import a component.
 */
export const VOICE_BUBBLE_LOOK = {
  background: "rgba(61,110,232,.2)",
  border: "1px solid rgba(61,110,232,.35)",
  borderRadius: "18px 18px 6px 18px",
  fontSize: 13.5,
  lineHeight: 1.45,
  fontStyle: "italic",
  color: "#C7D6F5",
} as const;

/** The assistant's side of a spoken exchange (frame 37's glass reply bubble). */
export const VOICE_REPLY_LOOK = {
  background: "rgba(28,32,44,.85)",
  border: "1px solid rgba(255,255,255,.09)",
  borderRadius: "18px 18px 18px 6px",
  fontSize: 14,
  lineHeight: 1.5,
  color: "var(--mv3-text)",
} as const;
