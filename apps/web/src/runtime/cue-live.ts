import type {
  CueLiveGoal,
  CueLivePermissions,
  CueLiveSettingsPane,
  CueLiveStatus,
  CueLiveVoiceKeyField,
  CueLiveVoiceKeysStatus,
} from "@vellumai/ipc-contract";

import { isElectron } from "@/runtime/is-electron";

/** Whether Cue Live (a native macOS-only capability) is reachable at all. */
export function isCueLiveAvailable(): boolean {
  return isElectron() && Boolean(window.vellum?.cueLive);
}

/** Read the live Cue Live status, or `null` when the bridge isn't present. */
export async function getCueLiveStatus(): Promise<CueLiveStatus | null> {
  if (!isCueLiveAvailable()) return null;
  return window.vellum!.cueLive!.status();
}

/** Toggle Cue Live on/off; returns the fresh status, or `null` off-desktop. */
export async function setCueLiveEnabled(
  enabled: boolean,
): Promise<CueLiveStatus | null> {
  if (!isCueLiveAvailable()) return null;
  return window.vellum!.cueLive!.setEnabled(enabled);
}

/** Toggle full-auto take-control; returns the fresh status, or `null`. */
export async function setCueLiveTakeControl(
  enabled: boolean,
): Promise<CueLiveStatus | null> {
  if (!isCueLiveAvailable() || !window.vellum?.cueLive?.setTakeControl) {
    return null;
  }
  return window.vellum.cueLive.setTakeControl(enabled);
}

/** Fire a summon (same flow as the hotkey) — the in-app "Try it" action. */
export async function summonCueLive(): Promise<void> {
  if (!isCueLiveAvailable()) return;
  await window.vellum!.cueLive!.summon();
}

/** Whether the permissions IPC is present (older preloads may lack it). */
export function isCueLivePermissionsSupported(): boolean {
  return (
    isCueLiveAvailable() &&
    typeof window.vellum?.cueLive?.permissions === "function"
  );
}

/**
 * Read the live macOS permission grants (non-prompting). Returns `null` when
 * off-desktop or on an older preload without the IPC, so callers can fall back
 * to the coarser `status.accessibilityTrusted` flag.
 */
export async function getCueLivePermissions(): Promise<CueLivePermissions | null> {
  if (!isCueLivePermissionsSupported()) return null;
  return window.vellum!.cueLive!.permissions!();
}

/** Deep-link the user to a System Settings privacy pane. */
export async function openCueLiveSystemSettings(
  pane: CueLiveSettingsPane,
): Promise<void> {
  if (
    !isCueLiveAvailable() ||
    typeof window.vellum?.cueLive?.openSystemSettings !== "function"
  ) {
    return;
  }
  await window.vellum.cueLive.openSystemSettings(pane);
}

/** Stop everything — abort any auto-run and hide the overlay (⌥ esc mirror). */
export async function stopCueLive(): Promise<void> {
  if (!isCueLiveAvailable() || typeof window.vellum?.cueLive?.stop !== "function") {
    return;
  }
  await window.vellum.cueLive.stop();
}

/** Whether the typed-goal test box is available (newer preloads only). */
export function isRunGoalSupported(): boolean {
  return (
    isCueLiveAvailable() && typeof window.vellum?.cueLive?.runGoal === "function"
  );
}

/** Run a typed goal. takeControl=true engages the act loop; false explains. */
export async function runGoal(
  goal: string,
  takeControl: boolean,
): Promise<void> {
  if (!isRunGoalSupported()) return;
  await window.vellum!.cueLive!.runGoal!(goal, takeControl);
}

/** Whether the voice-keys IPC is present (older preloads may lack it). */
function voiceKeysSupported(): boolean {
  return (
    isCueLiveAvailable() &&
    typeof window.vellum?.cueLive?.voiceKeysStatus === "function"
  );
}

/** Whether the saved auto-run goals IPC is present (newer preloads only). */
export function isCueLiveGoalsSupported(): boolean {
  return (
    isCueLiveAvailable() &&
    typeof window.vellum?.cueLive?.listGoals === "function"
  );
}

/** List the persisted auto-run goals, or `[]` when off-desktop/unsupported. */
export async function listCueLiveGoals(): Promise<CueLiveGoal[]> {
  if (!isCueLiveGoalsSupported()) return [];
  return window.vellum!.cueLive!.listGoals!();
}

/** Upsert a goal (id absent → create); returns the refreshed list. */
export async function saveCueLiveGoal(
  goal: Omit<CueLiveGoal, "id"> & { id?: string },
): Promise<CueLiveGoal[]> {
  if (!isCueLiveGoalsSupported()) return [];
  return window.vellum!.cueLive!.saveGoal!(goal);
}

/** Remove a goal by id; returns the refreshed list. */
export async function deleteCueLiveGoal(id: string): Promise<CueLiveGoal[]> {
  if (!isCueLiveGoalsSupported()) return [];
  return window.vellum!.cueLive!.deleteGoal!(id);
}

/** Which voice keys are configured (never the secret values themselves). */
export async function getVoiceKeysStatus(): Promise<CueLiveVoiceKeysStatus | null> {
  if (!voiceKeysSupported()) return null;
  return window.vellum!.cueLive!.voiceKeysStatus!();
}

/** Set or clear a voice key; returns the refreshed status. */
export async function setVoiceKey(
  field: CueLiveVoiceKeyField,
  value: string | null,
): Promise<CueLiveVoiceKeysStatus | null> {
  if (!voiceKeysSupported()) return null;
  return window.vellum!.cueLive!.setVoiceKey!(field, value);
}
