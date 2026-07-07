/**
 * Marketplace feature gate.
 *
 * Two switches, both default ON for dev:
 *  - the `marketplace` assistant feature flag (registry-declared,
 *    `defaultEnabled: true`, centrally overridable via the gateway), and
 *  - `skills.marketplace.enabled` in `assistant.json`
 *    (`assistant/src/config/schemas/skills.ts`).
 *
 * Every marketplace route handler calls `assertMarketplaceEnabled()` first —
 * when OFF the routes answer 404 and perform no work (no index fetches, no
 * cache writes, no source seeding), so the disabled state has zero side
 * effects.
 */

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { NotFoundError } from "../../runtime/routes/errors.js";

export const MARKETPLACE_FLAG_KEY = "marketplace";

export function isMarketplaceEnabled(): boolean {
  const config = getConfig();
  if (!config.skills.marketplace.enabled) return false;
  return isAssistantFeatureFlagEnabled(MARKETPLACE_FLAG_KEY, config);
}

/** Throws the route-layer 404 when the marketplace is disabled. */
export function assertMarketplaceEnabled(): void {
  if (!isMarketplaceEnabled()) {
    throw new NotFoundError("Marketplace is disabled");
  }
}
