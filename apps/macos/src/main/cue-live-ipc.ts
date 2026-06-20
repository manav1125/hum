import { randomUUID } from "node:crypto";

import type { CueLiveGoal } from "@vellumai/ipc-contract";
import { z } from "zod";

import {
  CUE_LIVE_HOTKEY,
  isAccessibilityTrusted,
  isStarted,
  pushVoiceConfig,
  runTypedGoal,
  start as startCueLive,
  stop as stopCueLive,
  triggerSummon,
} from "./cue-live-service";
import {
  getVoiceKeysStatus,
  setElevenLabsVoiceId,
  setVoiceSecret,
  type VoiceKeysStatus,
} from "./cue-voice-keys";
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
  /** Whether a spoken goal lets Cue Live click/type for you (full auto). */
  takeControl: boolean;
}

const cueLiveStatus = (): CueLiveStatus => ({
  enabled: readSetting("cueLiveEnabled") ?? true,
  running: isStarted(),
  accessibilityTrusted: isAccessibilityTrusted(),
  hotkey: CUE_LIVE_HOTKEY,
  takeControl: readSetting("cueLiveTakeControl") ?? true,
});

/**
 * Minimal persistence seam for the auto-run goals list. The real
 * implementation reads/writes the `cueLiveGoals` settings key; tests inject a
 * fake so the CRUD logic can be exercised without electron-store.
 */
export interface CueLiveGoalsStore {
  read(): CueLiveGoal[];
  write(goals: CueLiveGoal[]): void;
}

const settingsGoalsStore: CueLiveGoalsStore = {
  read: () => readSetting("cueLiveGoals") ?? [],
  write: (goals) => writeSetting("cueLiveGoals", goals),
};

/** Return the persisted goals. */
export const listGoals = (store: CueLiveGoalsStore): CueLiveGoal[] =>
  store.read();

/**
 * Upsert a goal. When `id` is present and already exists, the matching entry is
 * replaced in place; otherwise a new entry is appended with a freshly generated
 * id. Returns the full updated list.
 */
export const saveGoal = (
  store: CueLiveGoalsStore,
  input: Omit<CueLiveGoal, "id"> & { id?: string },
): CueLiveGoal[] => {
  const current = store.read();
  const existingIndex =
    input.id !== undefined
      ? current.findIndex((g) => g.id === input.id)
      : -1;
  const goal: CueLiveGoal = {
    id: input.id ?? randomUUID(),
    label: input.label,
    goal: input.goal,
    takeControl: input.takeControl,
  };
  const next =
    existingIndex >= 0
      ? current.map((g, i) => (i === existingIndex ? goal : g))
      : [...current, goal];
  store.write(next);
  return next;
};

/** Remove a goal by id and return the updated list. */
export const deleteGoal = (
  store: CueLiveGoalsStore,
  id: string,
): CueLiveGoal[] => {
  const next = store.read().filter((g) => g.id !== id);
  store.write(next);
  return next;
};

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

  // Typed-goal test box: run a goal by text (no mic/voice). takeControl=true
  // engages the act loop; false runs a look-only "explain" pass.
  handle(
    "vellum:cueLive:runGoal",
    z.tuple([z.string(), z.boolean()]),
    async ([goal, takeControl]): Promise<void> => {
      await runTypedGoal(goal, takeControl);
    },
  );

  handle(
    "vellum:cueLive:setTakeControl",
    z.tuple([z.boolean()]),
    ([enabled]): CueLiveStatus => {
      writeSetting("cueLiveTakeControl", enabled);
      return cueLiveStatus();
    },
  );

  // Voice keys: the renderer reads presence (never the secret values) and sets
  // them. Setting re-pushes the (decrypted) config to the running helper.
  handle(
    "vellum:cueLive:voiceKeysStatus",
    z.tuple([]),
    (): VoiceKeysStatus => getVoiceKeysStatus(),
  );

  handle(
    "vellum:cueLive:setVoiceKey",
    z.tuple([
      z.enum(["assemblyAi", "elevenLabs", "elevenLabsVoiceId"]),
      z.string().nullable(),
    ]),
    async ([which, value]): Promise<VoiceKeysStatus> => {
      if (which === "elevenLabsVoiceId") {
        setElevenLabsVoiceId(value);
      } else {
        setVoiceSecret(which, value);
      }
      await pushVoiceConfig();
      return getVoiceKeysStatus();
    },
  );

  // Auto-run goals: a persisted list of named goals the user re-runs on demand
  // through the existing runGoal executor. CRUD over the `cueLiveGoals` setting.
  handle(
    "vellum:cueLive:listGoals",
    z.tuple([]),
    (): CueLiveGoal[] => listGoals(settingsGoalsStore),
  );

  handle(
    "vellum:cueLive:saveGoal",
    z.tuple([
      z.object({
        id: z.string().optional(),
        label: z.string(),
        goal: z.string(),
        takeControl: z.boolean(),
      }),
    ]),
    ([input]): CueLiveGoal[] => saveGoal(settingsGoalsStore, input),
  );

  handle(
    "vellum:cueLive:deleteGoal",
    z.tuple([z.string()]),
    ([id]): CueLiveGoal[] => deleteGoal(settingsGoalsStore, id),
  );
};
