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
export async function getCompanionState(): Promise<Record<
  string,
  unknown
> | null> {
  if (!isElectron()) return null;
  const bridge = window.vellum?.companion;
  if (!bridge?.getState) return null;
  return bridge.getState();
}

/**
 * Subscribe to the geometry + hover pushes main publishes. Returns an
 * unsubscribe function; a no-op unsubscribe off-Electron.
 */
export function subscribeCompanionState(
  callback: (state: Record<string, unknown>) => void,
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

/**
 * One-shot pull of the assistant status main already tracks for the tray.
 * `null` when the bridge is absent so the page can keep its idle default.
 */
export async function getCompanionStatus(): Promise<AssistantStatus | null> {
  if (!isElectron()) return null;
  const bridge = window.vellum?.companion;
  if (!bridge) return null;
  return bridge.getStatus();
}

/**
 * Subscribe to status pushes (`vellum:companion:status`). Returns an
 * unsubscribe function; a no-op unsubscribe off-Electron.
 */
export function subscribeCompanionStatus(
  callback: (status: AssistantStatus) => void,
): () => void {
  if (!isElectron()) return () => {};
  const bridge = window.vellum?.companion;
  if (!bridge) return () => {};
  return bridge.onStatus(callback);
}
