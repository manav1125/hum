/**
 * Runtime wrapper for the corner's bridge surface (`window.vellum.corner`),
 * following the same shape as `domains/companion/companion-bridge.ts`: every
 * function degrades to a no-op off-Electron, so the
 * `/assistant/floating/corner` route renders harmlessly in a browser.
 */

import type { CornerContext, CornerSelection } from "@vellumai/ipc-contract";

import { isElectron } from "@/runtime/is-electron";

export type { CornerContext, CornerSelection };

/**
 * What the owner had highlighted when they summoned.
 *
 * `null` is an ordinary answer, not a failure — summoning with nothing
 * selected is the normal way to just ask a question. The panel opens on its
 * plain state rather than reporting an error.
 */
export async function getCornerSelection(): Promise<CornerSelection | null> {
  if (!isElectron()) return null;
  const bridge = window.vellum?.corner;
  if (!bridge) return null;
  return bridge.getSelection();
}

/**
 * Subscribe to selection pushes.
 *
 * Both this and {@link getCornerSelection} exist because the route chunk
 * loads lazily: a cold window has to pull, and a window that was already open
 * has to be told. Neither alone covers both.
 */
export function subscribeCornerSelection(
  callback: (selection: CornerSelection | null) => void,
): () => void {
  if (!isElectron()) return () => {};
  const bridge = window.vellum?.corner;
  if (!bridge) return () => {};
  return bridge.onSelection(callback);
}

/**
 * Close the panel.
 *
 * Closing **never cancels work in flight** — anything running continues and
 * reports in HQ. `esc` reaching this is safe by design, which is why the
 * panel can be dismissed without a moment's thought.
 */
export async function hideCorner(): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.corner?.hide();
}

/** "Open in Cue ›" — hand the exchange to the app and close the panel. */
export async function openInCue(text: string): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.corner?.openInCue(text);
}

/**
 * What the corner knows about the window in front, and whether this summon
 * should offer to read it.
 *
 * Off Electron this is the "never asked, nothing read" shape rather than
 * `null`, so the panel has one code path instead of two.
 */
export async function getCornerContext(): Promise<CornerContext> {
  const fallback: CornerContext = {
    screen: null,
    offerScreenReading: false,
    consent: "unasked",
  };
  if (!isElectron()) return fallback;
  const bridge = window.vellum?.corner;
  if (!bridge?.getContext) return fallback;
  return bridge.getContext();
}

export function subscribeCornerContext(
  callback: (context: CornerContext) => void,
): () => void {
  if (!isElectron()) return () => {};
  const bridge = window.vellum?.corner;
  if (!bridge?.onContext) return () => {};
  return bridge.onContext(callback);
}

/**
 * Answer the screen-reading invite.
 *
 * "Not now" is a real answer that is recorded and honoured — the panel keeps
 * working on the selection alone, and the offer is not made again until the
 * owner changes it. Re-asking is how a permission prompt becomes something
 * people click through to make stop.
 */
export async function setCornerScreenReading(granted: boolean): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.corner?.setScreenReading?.(granted);
}
