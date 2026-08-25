import {
  COMPANION_SIZES,
  type CompanionSize,
} from "./companion-geometry";

/**
 * The right-click menu — design `C5`, which is the companion's whole settings
 * surface.
 *
 * **Hide is never buried.** An uninvited guest must be easy to ask to leave,
 * so both hide options sit one right-click away at the top level, with no
 * confirmation and no guilt copy, and the menu-bar icon is the way back. That
 * is the rule this file exists to keep: it is checkable here, and it would not
 * be checkable if the template were assembled inline where the menu is popped.
 *
 * Built as a plain template rather than an Electron `Menu` so the rules can be
 * tested without a window — what is in it, what is checked, and what is
 * offered depend on persisted state, and all three are easy to get wrong in a
 * way nobody notices until somebody cannot find "Hide".
 */

/** Blink rate, surfaced as the character's name — see `characterName`. */
export type CompanionBlink = "calm" | "lively";
export type CompanionWeight = "fine" | "regular" | "bold";

export interface CompanionMenuState {
  size: CompanionSize;
  blink: CompanionBlink;
  weight: CompanionWeight;
  /** `null` when quiet hours are off. */
  quietHours: { start: string; end: string } | null;
  /** Whether a window is being read right now (`Q5`). */
  watching: boolean;
}

export type CompanionMenuAction =
  | { kind: "newNote" }
  | { kind: "readWindow" }
  | { kind: "stopReading" }
  | { kind: "openCue" }
  | { kind: "setSize"; size: CompanionSize }
  | { kind: "setBlink"; blink: CompanionBlink }
  | { kind: "setWeight"; weight: CompanionWeight }
  | { kind: "setQuietHours"; enabled: boolean }
  | { kind: "hideUntilTomorrow" }
  | { kind: "hide" };

export interface CompanionMenuItem {
  label?: string;
  /** The muted trailing text — "· asks first", "medium". */
  sublabel?: string;
  type?: "separator" | "radio";
  checked?: boolean;
  submenu?: CompanionMenuItem[];
  action?: CompanionMenuAction;
}

/**
 * The character's name.
 *
 * Character is three traits composed live — accent, ring weight, blink rate —
 * but the menu row shows one word, and design's frame shows the blink rate
 * there ("calm"). It is the trait you can actually perceive at a glance, so it
 * is the one that names the whole.
 */
export const characterName = (blink: CompanionBlink): string => blink;

const SIZE_LABELS: Record<CompanionSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  huge: "Huge",
  // The joke at the end of the scale, and a real size: it ships drawn by the
  // same code as the other four, so it gets checked like the others (`C12`).
  ridiculous: "Ridiculous",
};

const WEIGHT_LABELS: Record<CompanionWeight, string> = {
  fine: "Fine",
  regular: "Regular",
  bold: "Bold",
};

const BLINK_LABELS: Record<CompanionBlink, string> = {
  calm: "Calm",
  lively: "Lively",
};

export function buildCompanionMenu(
  state: CompanionMenuState,
): CompanionMenuItem[] {
  return [
    { label: "New note here", action: { kind: "newNote" } },
    // `Q5`: screen reading lives here — an explicit act on a chosen window,
    // never in onboarding. While it is on, the same row stops it, because the
    // thing you look for when you want it to stop is the thing that started
    // it.
    state.watching
      ? { label: "Stop reading this window", action: { kind: "stopReading" } }
      : {
          label: "Read this window",
          sublabel: "asks first",
          action: { kind: "readWindow" },
        },
    { label: "Open Cue", action: { kind: "openCue" } },
    { type: "separator" },
    {
      label: "Size",
      sublabel: SIZE_LABELS[state.size].toLowerCase(),
      submenu: COMPANION_SIZES.map((size) => ({
        label: SIZE_LABELS[size],
        type: "radio" as const,
        checked: size === state.size,
        action: { kind: "setSize" as const, size },
      })),
    },
    {
      label: "Character",
      sublabel: characterName(state.blink),
      submenu: [
        ...Object.entries(BLINK_LABELS).map(([blink, label]) => ({
          label,
          type: "radio" as const,
          checked: blink === state.blink,
          action: { kind: "setBlink" as const, blink: blink as CompanionBlink },
        })),
        { type: "separator" as const },
        ...Object.entries(WEIGHT_LABELS).map(([weight, label]) => ({
          label: `${label} ring`,
          type: "radio" as const,
          checked: weight === state.weight,
          action: {
            kind: "setWeight" as const,
            weight: weight as CompanionWeight,
          },
        })),
      ],
    },
    {
      label: "Quiet hours",
      sublabel: state.quietHours
        ? `${state.quietHours.start}–${state.quietHours.end}`
        : "off",
      submenu: [
        {
          label: "On",
          type: "radio",
          checked: state.quietHours !== null,
          action: { kind: "setQuietHours", enabled: true },
        },
        {
          label: "Off",
          type: "radio",
          checked: state.quietHours === null,
          action: { kind: "setQuietHours", enabled: false },
        },
      ],
    },
    { type: "separator" },
    // Both hide options at the top level, no confirmation, no guilt copy.
    { label: "Hide until tomorrow", action: { kind: "hideUntilTomorrow" } },
    {
      label: "Hide Cue",
      sublabel: "bring back from the menu bar",
      action: { kind: "hide" },
    },
  ];
}
