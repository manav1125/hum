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
 * Checked at tray-menu-build time and on every settings sync, so toggling
 * takes effect without an app restart.
 */
export const isCornerEnabled = (): boolean =>
  flagEnabled(CORNER_FLAG_KEY, CORNER_FLAG_ENV);

/**
 * The legacy always-on orb, **which the corner replaces**.
 *
 * Yields to the corner whenever the corner is on. The stored flag is sticky:
 * an install that switched the companion on before the corner existed keeps
 * that `true` for ever, and would otherwise run both panels at once the day
 * the corner ships. `VELLUM_FLAG_DESKTOP_COMPANION` still force-overrides in
 * either direction, so the two can be compared side by side deliberately.
 */
export const isCompanionEnabled = (): boolean => {
  const override = envFlagOverride(COMPANION_FLAG_ENV);
  if (override !== null) return override;
  if (isCornerEnabled()) return false;
  return readSetting("featureFlags")?.[COMPANION_FLAG_KEY] === true;
};
