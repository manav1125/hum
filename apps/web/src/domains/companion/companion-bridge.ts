/**
 * Runtime wrapper for the desktop-companion bridge surface
 * (`window.vellum.companion`), following the `runtime/quick-input.ts`
 * shape: feature code imports these functions instead of touching the
 * bridge directly, and every function degrades to a no-op off-Electron
 * (or against an older preload that predates the surface) so the
 * `/assistant/floating/companion` route renders harmlessly in a browser.
 *
 * Lives inside the companion domain rather than `src/runtime/` to keep
 * slice 1 inside its own territory; promote to `src/runtime/companion.ts`
 * if another domain ever needs it.
 */

import type { CompanionStatePayload } from "@vellumai/ipc-contract";

import { isElectron, type AssistantStatus } from "@/runtime/is-electron";

export type { AssistantStatus };

/**
 * Report whether the pointer is over anything actually drawn.
 *
 * Main hands the canvas back the moment this says no, which is what keeps the
 * empty region of an oversized always-on-top window transparent to clicks
 * meant for the application behind it. Deliberately not awaited anywhere: a
 * hover report is not something a pointer move may wait on.
 */
export function setCompanionPointerOver(over: boolean): void {
  if (!isElectron()) return;
  window.vellum?.companion?.setPointerOver?.(over);
}

/**
 * A press landed on the creature.
 *
 * Main reads the cursor itself from here on — the renderer's own coordinates
 * are exactly what a fast drag outruns, since the window is moved one IPC
 * message at a time.
 */
export function companionDragBegin(): void {
  if (!isElectron()) return;
  window.vellum?.companion?.dragBegin?.();
}

/** The button came up. Safe to call twice; main ignores an idle release. */
export function companionDragEnd(): void {
  if (!isElectron()) return;
  window.vellum?.companion?.dragEnd?.();
}

/**
 * One-shot pull of the geometry main owns, for a cold window whose route
 * chunk is still loading when main first publishes. `null` off-Electron.
 */
export async function getCompanionState(): Promise<CompanionStatePayload | null> {
  if (!isElectron()) return null;
  const bridge = window.vellum?.companion;
  if (!bridge?.getState) return null;
  return bridge.getState();
}

/**
 * Pop the right-click menu (`C5`).
 *
 * Native, and main's to build: the menu is routinely taller than the creature,
 * and a drawn one would have to grow the canvas to hold it.
 */
export function openCompanionMenu(): void {
  if (!isElectron()) return;
  void window.vellum?.companion?.menu?.();
}

/**
 * Advance the introduction (`C4`).
 *
 * The beat the press was made against travels with it: the card is drawn by a
 * renderer one IPC message behind, so a press can describe a beat that is no
 * longer on screen, and main discards it rather than skipping one.
 */
export function companionIntroNext(fromBeat: number): void {
  if (!isElectron()) return;
  void window.vellum?.companion?.introNext?.(fromBeat);
}

export function companionIntroDismiss(): void {
  if (!isElectron()) return;
  void window.vellum?.companion?.introDismiss?.();
}

/**
 * Subscribe to the geometry + hover pushes main publishes. Returns an
 * unsubscribe function; a no-op unsubscribe off-Electron.
 */
export function subscribeCompanionState(
  callback: (state: CompanionStatePayload) => void,
): () => void {
  if (!isElectron()) return () => {};
  const bridge = window.vellum?.companion;
  if (!bridge?.onState) return () => {};
  return bridge.onState(callback);
}

export async function companionTalk(): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.companion?.talk();
}

export async function companionOpenCue(): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.companion?.openCue();
}

export async function hideCompanion(): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.companion?.hide();
}
