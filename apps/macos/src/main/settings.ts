import Store, { type Schema } from "electron-store";

/**
 * Persisted user preferences shape. The schema below validates writes; reads
 * are returned as `null` when a key has never been written and no default
 * applies. Top-level keys are the renderer-facing categories;
 * additional categories get added here as future tickets need them, with a
 * matching schema entry to keep validation honest.
 *
 * Note: window geometry (position, size) is intentionally NOT here. It's a
 * main-process-managed concern in Electron (system-managed on iOS,
 * browser-managed on web), and the renderer never reads or writes it.
 * The persistence for that lives in `./window-state.ts`, which uses its
 * own `electron-store` instance keyed by window kind so it doesn't have
 * to share this file's strict schema.
 */
export interface AppSettings {
  hotkeys: Record<string, string>;
  theme: "light" | "dark" | "system";
  featureFlags: Record<string, boolean>;
  launchAtLogin: boolean;
  /** Whether the Cue Live overlay + summon hotkey run. Defaults ON. */
  cueLiveEnabled: boolean;
  /** Whether a spoken goal lets Cue Live actually click/type (full auto). */
  cueLiveTakeControl: boolean;
  /**
   * Cue Live voice keys. `assemblyAi`/`elevenLabs` are base64 of
   * safeStorage-encrypted API keys (never stored plaintext);
   * `elevenLabsVoiceId` is a non-secret voice id. Absent keys mean "not set".
   */
  voiceKeys: {
    assemblyAi?: string;
    elevenLabs?: string;
    elevenLabsVoiceId?: string;
  };
  /**
   * Saved Cue Live "auto-run goals": named goals the user can re-run on demand
   * through the existing typed-goal executor. Each carries a stable `id`, a
   * display `label`, the `goal` text, and whether running it takes control.
   */
  cueLiveGoals: Array<{
    id: string;
    label: string;
    goal: string;
    takeControl: boolean;
  }>;
  /**
   * Whether the floating desktop companion orb is shown. Only meaningful
   * while the `desktop-companion` feature flag is enabled; defaults ON so
   * enabling the flag is enough to see the companion. Toggled from the
   * tray's "Show/Hide Cue Companion" item and the companion's own hide
   * action (see `companion-window.ts`).
   */
  companionVisible: boolean;
  /**
   * The creature's size, as a named step (`small` … `ridiculous`).
   *
   * Absent means nobody has chosen, which is not the same as `medium`: a
   * stored choice is never overridden, so the difference has to survive.
   */
  companionSize: string;
  /**
   * Whether `C9`'s long approval sentence has been said.
   *
   * The first window-raise reads as a glitch; said once it becomes protocol,
   * said every time it becomes noise. One bit, and it only ever goes one way.
   */
  companionApprovalExplained: boolean;
  /**
   * The creature's character (`C5`): three traits, composed live. `accent` is
   * a token name so a brand-kit colour can land here later.
   */
  companionCharacter: {
    blink?: "calm" | "lively";
    weight?: "fine" | "regular" | "bold";
    accent?: string;
  };
  /**
   * Quiet hours. Absent means off — and off has to be distinguishable from a
   * range nobody chose, or the creature goes silent on a guess.
   */
  companionQuietHours: { start: string; end: string };
  /**
   * "Hide until tomorrow" (`C5`), as the moment it comes back.
   *
   * Stored as an instant rather than a flag so it cannot get stuck: a flag
   * needs something to clear it, and the thing that clears it is exactly what
   * fails to run when the app was closed all evening.
   */
  companionHiddenUntil: string;
  /**
   * Where the creature was last settled, as the centre of the creature —
   * never the window's bounds.
   *
   * The canvas reserves the card's height on one side only and unfurls
   * whichever way the display allows, so the window's origin means different
   * things in different corners. The creature's centre means the same thing
   * everywhere, which is what makes it the thing worth persisting.
   */
  companionCentre: { x: number; y: number };
  /**
   * Whether the floating corner may read the window in front of you (F1).
   *
   * Three states, and the third is the point: `true` granted, `false`
   * declined, **absent means never asked**. The offer is made once, on the
   * second summon — never in onboarding, where nobody can judge it — and a
   * decline stays declined until the owner changes it. Re-asking is how a
   * permission prompt becomes something people click through to make stop.
   */
  cornerScreenReading?: boolean;
  /**
   * How many times the corner has been summoned, so the screen-reading offer
   * can land on the second use rather than the first.
   */
  cornerSummonCount?: number;
  /**
   * The Cue instance this install is connected to, e.g.
   * `https://cue-ada-1234.justcue.app/assistant/`. Set once, when the owner
   * connects; absent means "not connected yet" and the app opens its own
   * bundled Connect screen. Never defaulted to a real deployment — a build must
   * not point at somebody else's instance.
   */
  selfHostUrl: string;
}

const schema: Schema<AppSettings> = {
  hotkeys: {
    type: "object",
    additionalProperties: { type: "string" },
    default: {},
  },
  theme: {
    type: "string",
    enum: ["light", "dark", "system"],
    default: "system",
  },
  featureFlags: {
    type: "object",
    additionalProperties: { type: "boolean" },
    default: {},
  },
  launchAtLogin: {
    type: "boolean",
  },
  cueLiveEnabled: {
    type: "boolean",
    default: true,
  },
  cueLiveTakeControl: {
    type: "boolean",
    default: true,
  },
  voiceKeys: {
    type: "object",
    properties: {
      assemblyAi: { type: "string" },
      elevenLabs: { type: "string" },
      elevenLabsVoiceId: { type: "string" },
    },
    additionalProperties: false,
    default: {},
  },
  cueLiveGoals: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        label: { type: "string" },
        goal: { type: "string" },
        takeControl: { type: "boolean" },
      },
      required: ["id", "label", "goal", "takeControl"],
      additionalProperties: false,
    },
    default: [],
  },
  companionVisible: {
    type: "boolean",
    default: true,
  },
  // No defaults for either: an unchosen size must stay distinguishable from a
  // chosen `medium`, and a creature that has never been placed must fall
  // through to its first-run home rather than to somebody's guess at one.
  companionSize: {
    type: "string",
    enum: ["small", "medium", "large", "huge", "ridiculous"],
  },
  companionApprovalExplained: {
    type: "boolean",
    default: false,
  },
  companionCharacter: {
    type: "object",
    properties: {
      blink: { type: "string", enum: ["calm", "lively"] },
      weight: { type: "string", enum: ["fine", "regular", "bold"] },
      accent: { type: "string" },
    },
    additionalProperties: false,
    default: {},
  },
  // No default: off must stay distinguishable from a range nobody chose.
  companionQuietHours: {
    type: "object",
    properties: {
      start: { type: "string" },
      end: { type: "string" },
    },
    required: ["start", "end"],
    additionalProperties: false,
  },
  companionHiddenUntil: {
    type: "string",
  },
  companionCentre: {
    type: "object",
    properties: {
      x: { type: "number" },
      y: { type: "number" },
    },
    required: ["x", "y"],
    additionalProperties: false,
  },
  // No default: "never asked" has to be distinguishable from "declined", and
  // a default of false would erase that difference on first launch.
  cornerScreenReading: {
    type: "boolean",
  },
  cornerSummonCount: {
    type: "number",
    default: 0,
  },
  // No default: an unconnected install must have no instance, not a guess.
  selfHostUrl: {
    type: "string",
  },
};

let instance: Store<AppSettings> | null = null;

const store = (): Store<AppSettings> => {
  if (!instance) {
    instance = new Store<AppSettings>({
      schema,
      // Close the root so a renderer typo (e.g. `set("them", "dark")`) is
      // rejected at validation time instead of silently persisted as an
      // unknown top-level key. Per-key shapes are still validated by `schema`.
      rootSchema: { additionalProperties: false },
    });
  }
  return instance;
};

/**
 * Read a setting. Returns `null` (not `undefined`) when the key is absent so
 * the IPC channel marshals cleanly across the contextBridge. Keyed on
 * `keyof AppSettings` so the return type is the stored value's type and
 * callers no longer have to re-cast.
 */
export const readSetting = <K extends keyof AppSettings>(
  key: K,
): AppSettings[K] | null => {
  const value = store().get(key);
  return value === undefined ? null : value;
};

/**
 * Write a setting. electron-store validates the value against the schema and
 * throws `SyntaxError` (with the ajv error message) when invalid. Keyed on
 * `keyof AppSettings` with a value typed to that key, so an out-of-shape write
 * is caught at compile time rather than relying on the runtime schema alone.
 */
export const writeSetting = <K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): void => {
  try {
    store().set(key, value);
  } catch (err) {
    // electron-store writes synchronously; a full disk throws ENOSPC. A
    // failed settings write must degrade, not crash the main process —
    // losing one preference save is survivable, taking down the whole app
    // is not.
    console.error(`[settings] failed to persist "${String(key)}"`, err);
  }
};

/**
 * Remove a setting entirely.
 *
 * Not the same as writing a falsy value: several settings distinguish "never
 * chosen" from "chosen and off", and a key that is absent is the only way to
 * say the first. Fails the same way `writeSetting` does — losing one
 * preference is survivable, taking down the main process is not.
 */
export const clearSetting = (key: keyof AppSettings): void => {
  try {
    store().delete(key);
  } catch (err) {
    console.error(`[settings] failed to clear "${String(key)}"`, err);
  }
};

/**
 * Read the user's override for a single hotkey command, or `null` when none is
 * set. An explicit empty string is a real value — it means the user disabled
 * the binding — and is returned as-is; only an absent key yields `null`, in
 * which case the caller falls back to the compiled default. Shared by
 * `commands.ts` (menu accelerators) and `global-shortcuts.ts` (system-wide
 * shortcuts) so the override-resolution rule lives in one place.
 */
export const readHotkeyOverride = (key: string): string | null => {
  const override = readSetting("hotkeys")?.[key];
  return typeof override === "string" ? override : null;
};

/**
 * Subscribe to changes on a specific settings key. Fires when the value
 * changes (deep equality check by electron-store). Returns an unsubscribe
 * function.
 */
export const onSettingChange = <K extends keyof AppSettings>(
  key: K,
  callback: (newValue: AppSettings[K], oldValue: AppSettings[K]) => void,
): (() => void) => {
  return store().onDidChange(
    key,
    callback as (
      newValue: AppSettings[K] | undefined,
      oldValue: AppSettings[K] | undefined,
    ) => void,
  );
};
