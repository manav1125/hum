import type { CueLiveStatus } from "@vellumai/ipc-contract";

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

/** Fire a summon (same flow as the hotkey) — the in-app "Try it" action. */
export async function summonCueLive(): Promise<void> {
  if (!isCueLiveAvailable()) return;
  await window.vellum!.cueLive!.summon();
}
