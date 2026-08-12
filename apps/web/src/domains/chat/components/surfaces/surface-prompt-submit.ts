/**
 * Bridge from in-chat surface renderers to the composer submit path.
 *
 * Template cards (skill_recommendations "Let's do it", channel_showcase
 * "Set up") turn a click into a real user message: the prompt must travel
 * through the same `submitMessage` flow the conversation-starter chips use so
 * the sent text is user-visible in the transcript and the daemon sees an
 * ordinary user turn — not a surface action.
 *
 * Surfaces render deep inside the transcript, far below where
 * `useComposerSubmit` lives (`chat-route-content.tsx`), so rather than
 * threading a callback through every transcript layer this mirrors the
 * window-event pattern of `composer-focus.ts`: the surface dispatches, the
 * mounted chat route listens and calls `submitMessage(prompt)`.
 *
 * If no listener is mounted (e.g. a story/test rendering a surface in
 * isolation) the event is a no-op — the card never blocks on it.
 */
export const SURFACE_PROMPT_SUBMIT_EVENT = "vellum:surface-submit-prompt";

export interface SurfacePromptSubmitDetail {
  prompt: string;
}

/** Submit `prompt` through the chat composer as if the user typed it. */
export function submitPromptFromSurface(prompt: string): void {
  const trimmed = prompt.trim();
  if (!trimmed || typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SurfacePromptSubmitDetail>(SURFACE_PROMPT_SUBMIT_EVENT, {
      detail: { prompt: trimmed },
    }),
  );
}

/** Narrowing helper for the listener side. */
export function readSurfacePromptSubmit(event: Event): string | null {
  const detail = (event as CustomEvent<SurfacePromptSubmitDetail>).detail;
  const prompt = detail?.prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt.trim() : null;
}
