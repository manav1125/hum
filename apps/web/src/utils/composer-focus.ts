/**
 * Coordinates focus requests for the chat composer textarea across route
 * boundaries. The textarea ref lives in `chat-page.tsx`; callers in
 * higher-level layouts (and the Electron command bus) request focus via
 * `requestComposerFocus()`, which:
 *
 * - fires a window event consumed by `chat-page`'s mounted listener
 *   (for the same-route case), AND
 * - sets a one-shot pending flag that `chat-page` drains on its next
 *   mount (for the case where the caller navigated to the conversation
 *   route from elsewhere — `/assistant/home`, `/assistant/library`,
 *   etc. — and the listener doesn't exist yet at dispatch time).
 *
 * Without the pending-flag drain, File > Current Conversation would no-op
 * when invoked from non-chat routes.
 */
export const COMPOSER_FOCUS_EVENT = "vellum:focus-composer";

let pending = false;
let pendingDraft: string | null = null;

/**
 * @param draft Words to put in the composer along with the focus.
 *
 * For buttons that name an action Cue performs by being asked — "Create a
 * skill" is the one that prompted this. Focusing an empty composer is a
 * cursor blinking in a box: it moved you somewhere and left you to guess the
 * sentence. Arriving with the sentence already written, unsent, is the button
 * doing what it says while leaving the words yours to change.
 */
export function requestComposerFocus(draft?: string): void {
  pending = true;
  if (draft !== undefined) pendingDraft = draft;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(COMPOSER_FOCUS_EVENT));
  }
}

/**
 * Returns and clears the pending draft in one step.
 *
 * One-shot like the focus flag beside it, and for the same reason: the
 * composer may mount after the request, so this has to survive the gap — but
 * exactly once, or every later visit to chat would re-seed a sentence the
 * owner already dismissed.
 */
export function consumePendingComposerDraft(): string | null {
  const draft = pendingDraft;
  pendingDraft = null;
  return draft;
}

/** Returns and clears the pending flag in one step. */
export function consumePendingComposerFocus(): boolean {
  const wasPending = pending;
  pending = false;
  return wasPending;
}

type ComposerTypingKeyEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "ctrlKey"
  | "defaultPrevented"
  | "isComposing"
  | "key"
  | "keyCode"
  | "metaKey"
>;

const TEXT_ENTRY_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="textbox"]',
].join(",");

function isTextEntryElement(element: Element | null): boolean {
  return Boolean(element?.closest(TEXT_ENTRY_SELECTOR));
}

function isKeyboardActivationElement(element: Element | null): boolean {
  return Boolean(element?.closest("a[href], button, summary"));
}

export function shouldFocusComposerForTyping(
  event: ComposerTypingKeyEvent,
  activeElement: Element | null,
): boolean {
  if (event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  // `event.key` is typed as `string` but synthetic / extension-dispatched
  // KeyboardEvents observed in production have arrived with no `key`
  // property at all. Guard before reading `.length`.
  if (typeof event.key !== "string" || event.key.length !== 1) return false;
  if (isTextEntryElement(activeElement)) return false;
  if (event.key === " " && isKeyboardActivationElement(activeElement)) {
    return false;
  }
  return true;
}

export function insertTextAtSelection({
  value,
  text,
  selectionStart,
  selectionEnd,
}: {
  value: string;
  text: string;
  selectionStart: number | null | undefined;
  selectionEnd: number | null | undefined;
}): { value: string; cursor: number } {
  const start = Math.max(
    0,
    Math.min(selectionStart ?? value.length, value.length),
  );
  const end = Math.max(start, Math.min(selectionEnd ?? start, value.length));
  const nextValue = value.slice(0, start) + text + value.slice(end);
  return { value: nextValue, cursor: start + text.length };
}
