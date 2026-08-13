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

export async function setCompanionExpanded(expanded: boolean): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.companion?.setExpanded(expanded);
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
