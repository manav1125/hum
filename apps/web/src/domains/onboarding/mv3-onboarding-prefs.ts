/**
 * Mobile-v3 onboarding persistence (task #96, frames 26/27/28).
 *
 * Two small durable values the v3 funnel steps capture:
 *
 *  · SCOPE — the Step-1 chip row ("Founder" / "Founder + personal" /
 *    "Just life"). Persisted to localStorage next to the other onboarding
 *    prefs so downstream personalization can read it.
 *
 *  · WORKSPACE MODE — the Step-3 autonomy pick (observe / assist /
 *    autonomous). This is the SAME setting the HQ / You mode dial writes
 *    (`PUT /company-profile` → `workspaceMode`). The funnel runs before the
 *    assistant daemon is necessarily reachable, so the pick is parked here
 *    as a PENDING value and applied by root-layout the moment an assistant
 *    is active (then cleared). If an assistant is already active during the
 *    step, the flow also applies it immediately — the pending write is the
 *    safety net, not the only path.
 */
import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";

export type OnboardingScope = "founder" | "founder-personal" | "life";

export const ONBOARDING_SCOPES: Array<{
  id: OnboardingScope;
  label: string;
}> = [
  { id: "founder", label: "Founder" },
  { id: "founder-personal", label: "Founder + personal" },
  { id: "life", label: "Just life" },
];

const KEY_SCOPE = "vellum:onboarding:mv3Scope";
const KEY_PENDING_MODE = "vellum:onboarding:mv3PendingWorkspaceMode";

export function readOnboardingScope(): OnboardingScope | null {
  try {
    const v = getLocalSetting(KEY_SCOPE, "");
    return v === "founder" || v === "founder-personal" || v === "life"
      ? v
      : null;
  } catch {
    return null;
  }
}

export function writeOnboardingScope(scope: OnboardingScope): void {
  try {
    setLocalSetting(KEY_SCOPE, scope);
  } catch {
    // Storage unavailable — the chip stays session-local.
  }
}

export type PendingWorkspaceMode = "observe" | "assist" | "autonomous";

export function readPendingWorkspaceMode(): PendingWorkspaceMode | null {
  try {
    const v = getLocalSetting(KEY_PENDING_MODE, "");
    return v === "observe" || v === "assist" || v === "autonomous" ? v : null;
  } catch {
    return null;
  }
}

export function writePendingWorkspaceMode(mode: PendingWorkspaceMode): void {
  try {
    setLocalSetting(KEY_PENDING_MODE, mode);
  } catch {
    /* best-effort */
  }
}

export function clearPendingWorkspaceMode(): void {
  try {
    removeLocalSetting(KEY_PENDING_MODE);
  } catch {
    /* best-effort */
  }
}
