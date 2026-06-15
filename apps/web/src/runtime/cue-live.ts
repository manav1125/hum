import type {
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

/** Whether the voice-keys IPC is present (older preloads may lack it). */
function voiceKeysSupported(): boolean {
  return (
    isCueLiveAvailable() &&
    typeof window.vellum?.cueLive?.voiceKeysStatus === "function"
  );
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
