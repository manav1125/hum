import { readSetting } from "./settings";

/**
 * The client feature flags that decide which floating desktop surface exists.
 *
 * These live in their own module rather than in the window files that use
 * them because the *companion* has to know whether the *corner* is on — the
 * corner replaces it, so the two must never both be on screen. Importing
 * `corner-window` from `companion-window` to ask that question drags the
 * corner's whole graph (selection reads, screen reads, `clipboard`) into
 * anything that touches the companion, which is both a cycle risk and, in
 * practice, what broke `companion-window.test.ts` with
 * `Export named 'clipboard' not found`. A flag is a settings read, not window
 * behaviour, so it belongs somewhere neither window owns.
 *
 * Both follow the same contract as every other `VELLUM_FLAG_*` gate: an env
 * override wins in either direction, otherwise the renderer-published flag
 * map decides, and absent means off.
 */

const ENV_TRUE = new Set(["true", "1", "yes", "on"]);
const ENV_FALSE = new Set(["false", "0", "no", "off"]);

const envFlagOverride = (envVar: string): boolean | null => {
  const raw = process.env[envVar]?.trim().toLowerCase();
  if (!raw) return null;
  if (ENV_TRUE.has(raw)) return true;
  if (ENV_FALSE.has(raw)) return false;
  return null;
};

const flagEnabled = (key: string, envVar: string): boolean => {
  const override = envFlagOverride(envVar);
  if (override !== null) return override;
  return readSetting("featureFlags")?.[key] === true;
};

export const CORNER_FLAG_KEY = "desktop-corner";
export const CORNER_FLAG_ENV = "VELLUM_FLAG_DESKTOP_CORNER";

export const COMPANION_FLAG_KEY = "desktop-companion";
export const COMPANION_FLAG_ENV = "VELLUM_FLAG_DESKTOP_COMPANION";

/**
 * The floating corner: one exchange summoned with ⌥C, then finished.
 *
 * **Being retired** in favour of the always-on companion (owner decision,
 * 2026-08-24). Kept behind its flag while the companion's screens are drawn,
 * so the work already built stays reachable — but it no longer suppresses
 * anything, and whether the ⌥C summon survives *inside* the companion is Q1
 * of the design brief.
 */
export const isCornerEnabled = (): boolean =>
  flagEnabled(CORNER_FLAG_KEY, CORNER_FLAG_ENV);

/**
 * The always-on companion — **the direction, as of the owner's decision on
 * 2026-08-24** (`docs/design/companion-always-on/00-BRIEF.md`).
 *
 * This used to yield to the corner, on the reasoning that the corner replaced
 * it. That is now backwards: we are building the creature that lives on the
 * desktop, and the summoned corner is the surface being retired. Nothing here
 * yields — the companion stands on its own flag.
 *
 * `VELLUM_FLAG_DESKTOP_COMPANION` still force-overrides in either direction.
 */
export const isCompanionEnabled = (): boolean =>
  flagEnabled(COMPANION_FLAG_KEY, COMPANION_FLAG_ENV);
