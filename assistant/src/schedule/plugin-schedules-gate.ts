/**
 * Plugin-declared schedules feature gate.
 *
 * Ported from upstream ede433188c. The flag key is declared in
 * `meta/feature-flags/feature-flag-registry.json` with `defaultEnabled:
 * false`, matching upstream's default and our `external-plugins` flag —
 * the surface plugin schedules hang off.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";

const PLUGIN_SCHEDULES_FLAG_KEY = "plugin-schedules" as const;

/**
 * Whether plugins may declare schedules that register and run automatically.
 *
 * The flag is a kill switch, not just a launch gate. `reconcilePluginSchedules`
 * treats an off flag as an empty desired set and still runs its disarm branch,
 * so the next pass after turning the flag off disarms every declared row and
 * the next pass after turning it back on re-arms them.
 */
export function isPluginSchedulesEnabled(config?: AssistantConfig): boolean {
  let resolved: AssistantConfig;
  try {
    resolved = config ?? getConfig();
  } catch {
    // Config unreadable (early boot, test harness). The resolver only reads
    // the flag registry + gateway overrides, so pass an empty config object.
    resolved = {} as AssistantConfig;
  }
  return isAssistantFeatureFlagEnabled(PLUGIN_SCHEDULES_FLAG_KEY, resolved);
}
