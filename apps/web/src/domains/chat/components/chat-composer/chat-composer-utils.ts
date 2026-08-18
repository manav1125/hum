/** Pure helper functions for the chat composer.
 *
 *  Separated from the React component (`ChatComposer`) so they can be
 *  unit-tested without a DOM or component render cycle. */

// ---------------------------------------------------------------------------
// Keyboard policy
// ---------------------------------------------------------------------------

export interface ComposerKeyDownPolicy {
  input: string;
  canSendAttachments: boolean;
  sendDisabled: boolean;
  attachmentsUploadingCount: number;
  cmdEnterMode: boolean;
}

/**
 * Is there anything to send? An attachment on its own counts — "here, look at
 * this" is how a photo gets sent, and on a phone it is the common case.
 *
 * Split out because the two ways to send diverged. {@link shouldSubmitOnEnter}
 * has always honoured attachments, but the mobile composer's tap-to-send gate
 * was written as `input.trim().length > 0` alone, so picking a file and tapping
 * send did nothing at all — no send, no error, no explanation. Both paths call
 * this now, so a future change cannot move one without the other.
 */
export function hasSomethingToSend(policy: {
  input: string;
  canSendAttachments: boolean;
}): boolean {
  return policy.input.trim().length > 0 || policy.canSendAttachments;
}

// ---------------------------------------------------------------------------
// Attachment policy
// ---------------------------------------------------------------------------

/**
 * Shown when nothing in the workspace can read an image. Exported so every
 * input path words it identically — the picker, the paste handler and the drop
 * zone all reach this state and used to phrase it (or not phrase it)
 * separately.
 *
 * The wording names the real condition. It used to say the *current model*
 * doesn't support image input, which was both the wrong reason and, on the
 * usual setup, simply untrue: the daemon reroutes image-bearing rounds to a
 * vision model, so a text-only chat model refuses nothing. This state is now
 * only reached when the daemon reports that no vision path exists at all.
 */
export const NON_VISION_IMAGE_NOTICE =
  "No model available here can read images, so they can't be attached. Other files still work.";

/**
 * Split picked / pasted / dropped files into the ones that can be attached and
 * a count of the images nothing could have read.
 *
 * `imagesAreReadable` answers "does this workspace have somewhere to send an
 * image" — see `useImageInputSupported`. It is not "is the conversation's model
 * multimodal": that question has a different, usually wronger answer, because
 * image-bearing rounds are rerouted to a vision model before they are sent.
 *
 * Either way this is a question about **images**, and only about images. A PDF,
 * a spreadsheet or a `.txt` reaches the model as a `file` block, which the
 * providers serialize as extracted text (`fileBlockToText`) — it never touches
 * the vision path at all. Gating the whole paperclip on vision support is
 * therefore an answer to a question nobody asked, and on a text-only brain it
 * is what "I can't upload a file" means: not that one image was refused, but
 * that the picker never opened for anything.
 */
export function partitionAttachableFiles(
  files: readonly File[],
  imagesAreReadable: boolean,
): { accepted: File[]; blockedImages: number } {
  if (imagesAreReadable) return { accepted: [...files], blockedImages: 0 };
  const accepted = files.filter((file) => !file.type.startsWith("image/"));
  return { accepted, blockedImages: files.length - accepted.length };
}

/**
 * Why the paperclip is disabled, or `null` when it is usable.
 *
 * The string is the button's tooltip, so a disabled control always states its
 * own reason rather than just going grey. Note what is NOT here: a text-only
 * model. That never made the button unusable, it made it silent.
 */
export function attachDisabledReason(policy: {
  typingDisabled: boolean;
  assistantId: string | null;
}): string | null {
  if (!policy.assistantId) return "No assistant is connected yet";
  if (policy.typingDisabled)
    return "This conversation isn't accepting input right now";
  return null;
}

/**
 * Pure-logic mirror of the textarea `onKeyDown` policy. Returns whether the
 * Enter keypress should submit the form. The production handler delegates to
 * this helper to keep behavior in lockstep.
 *
 * Returns:
 *   - `"ignore"`: the event is not Enter-without-shift, IME composition, or
 *     pointer is coarse — let the browser handle the keypress.
 *   - `"submit"`: caller should `preventDefault()` and invoke `onSubmit`.
 *   - `"prevent"`: caller should `preventDefault()` but NOT submit (sendDisabled,
 *     uploading attachments, or no content).
 */
export function shouldSubmitOnEnter(
  event: {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
    keyCode: number;
  },
  isPointerCoarse: boolean,
  policy: ComposerKeyDownPolicy,
): "ignore" | "submit" | "prevent" {
  if (event.key !== "Enter" || event.shiftKey) {
    return "ignore";
  }
  // Don't intercept IME composition (CJK input confirmation)
  if (event.isComposing || event.keyCode === 229) {
    return "ignore";
  }
  // Coarse primary pointer = phone/tablet; fine = mouse/trackpad.
  // Touch-screen laptops (Surface, etc.) report "fine" and keep desktop
  // Enter-to-send behavior.
  if (isPointerCoarse) {
    return "ignore";
  }
  // Cmd+Enter mode: only Cmd+Enter (Mac) or Ctrl+Enter (Win/Linux) submits;
  // bare Enter inserts a newline.
  if (policy.cmdEnterMode) {
    if (!event.metaKey && !event.ctrlKey) return "ignore";
  }
  const hasContent = hasSomethingToSend(policy);
  if (
    hasContent &&
    !policy.sendDisabled &&
    policy.attachmentsUploadingCount === 0
  ) {
    return "submit";
  }
  return "prevent";
}

// ---------------------------------------------------------------------------
// Ghost-suggestion overlay policy
// ---------------------------------------------------------------------------

interface GhostSuffixPolicy {
  pointerCoarse: boolean;
  suggestion: string | null;
  input: string;
  hasAttachments: boolean;
}

/**
 * Returns the visible suffix of an autocomplete suggestion to render as
 * ghost text behind the textarea, or `null` to render no ghost.
 *
 * Suppressed when the primary pointer is coarse (touch devices): the only
 * acceptance gesture is `Tab`, which is not present on iOS/Android soft
 * keyboards, so rendering the overlay there is purely visual noise — and
 * because the underlying textarea is `rows={1}`, multi-line ghost text
 * gets clipped on narrow viewports.
 */
export function computeGhostSuffix(policy: GhostSuffixPolicy): string | null {
  if (policy.pointerCoarse) return null;
  if (!policy.suggestion || policy.hasAttachments) return null;
  if (policy.suggestion.startsWith(policy.input)) {
    return policy.suggestion.slice(policy.input.length) || null;
  }
  if (!policy.input) return policy.suggestion;
  return null;
}
