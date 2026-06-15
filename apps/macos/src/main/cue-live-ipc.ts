import { z } from "zod";

import {
  CUE_LIVE_HOTKEY,
  isAccessibilityTrusted,
  isStarted,
  start as startCueLive,
  stop as stopCueLive,
  triggerSummon,
} from "./cue-live-service";
import { handle } from "./ipc";
import log from "./logger";
import { readSetting, writeSetting } from "./settings";

/** Live status of Cue Live, surfaced to the renderer "How it works" page. */
export interface CueLiveStatus {
  /** Whether the user has Cue Live enabled (persisted setting, default ON). */
  enabled: boolean;
  /** Whether the overlay/subscriptions are currently running. */
  running: boolean;
  /** Whether the helper is trusted for macOS Accessibility (hotkey armed). */
  accessibilityTrusted: boolean;
  /** The summon hotkey, for display. */
  hotkey: string;
}

const cueLiveStatus = (): CueLiveStatus => ({
  enabled: readSetting("cueLiveEnabled") ?? true,
  running: isStarted(),
  accessibilityTrusted: isAccessibilityTrusted(),
  hotkey: CUE_LIVE_HOTKEY,
});

/**
 * IPC for the renderer Cue Live surface: read live status, flip the persisted
 * enable toggle (starting/stopping the overlay to match), and summon on demand
 * (the in-app "Try it" button — works even when the global hotkey isn't armed).
 */
export const installCueLiveIpc = (): void => {
  handle("vellum:cueLive:status", z.tuple([]), () => cueLiveStatus());

  handle(
    "vellum:cueLive:setEnabled",
    z.tuple([z.boolean()]),
    async ([enabled]): Promise<CueLiveStatus> => {
      writeSetting("cueLiveEnabled", enabled);
      try {
        if (enabled) {
          await startCueLive();
        } else {
          await stopCueLive();
        }
      } catch (err) {
        log.warn(
          `[cue-live] toggle to ${enabled} failed: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      return cueLiveStatus();
    },
  );

  handle("vellum:cueLive:summon", z.tuple([]), async (): Promise<void> => {
    await triggerSummon();
  });
};
