/**
 * Send-time gating for device (APNs) pushes — per-category toggles and
 * quiet hours, both config-backed under `notifications.push` (see
 * config/schemas/notifications.ts):
 *
 *   notifications.push.categories.{needsYou,reviewReady,morningBrief,mentions}
 *   notifications.push.quietHours.{start,end,timezone}
 *
 * Semantics:
 *   - Categories default ON; a disabled category drops that push entirely.
 *   - Quiet hours are active only when both `start` and `end` are set.
 *     A start after the end wraps past midnight (22:00 → 08:00). Inside
 *     the window pushes are DROPPED, not deferred — the underlying items
 *     still surface in-app, so nothing is lost, just not paged to the phone.
 *   - `evaluatePushGate` is pure (config + clock in, verdict out) for
 *     tests; `checkPushGate` is the production wrapper that reads live
 *     config and never throws (any config failure fails open to "allowed"
 *     — a broken config file must not silently kill approval pushes).
 */

import { getConfig } from "../config/loader.js";
import type { PushConfig } from "../config/schemas/notifications.js";
import { localClock } from "./local-clock.js";

/**
 * The push categories the daemon can emit today. `mentions` is reserved:
 * the config key exists but no emission point sends mention pushes yet.
 */
export type PushCategory =
  | "needsYou"
  | "reviewReady"
  | "morningBrief"
  | "mentions";

export type PushGateResult =
  | { allowed: true }
  | { allowed: false; reason: "category_disabled" | "quiet_hours" };

/** Parse "HH:MM" to minutes-of-day, or null when malformed. */
function parseTimeOfDay(raw: string | null): number | null {
  if (!raw) return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Whether `now` falls inside the configured quiet-hours window. False when
 * the window is unset, malformed, or degenerate (start === end).
 */
export function isWithinQuietHours(
  now: Date,
  quietHours: Pick<PushConfig["quietHours"], "start" | "end" | "timezone">,
): boolean {
  const start = parseTimeOfDay(quietHours.start);
  const end = parseTimeOfDay(quietHours.end);
  if (start === null || end === null || start === end) return false;

  const { minutesOfDay } = localClock(now, quietHours.timezone);
  if (start < end) {
    // Same-day window, e.g. 13:00–15:00.
    return minutesOfDay >= start && minutesOfDay < end;
  }
  // Overnight wrap, e.g. 22:00–08:00.
  return minutesOfDay >= start || minutesOfDay < end;
}

/** Pure gate: category toggle first, then quiet hours. */
export function evaluatePushGate(
  category: PushCategory,
  push: PushConfig,
  now: Date,
): PushGateResult {
  if (push.categories[category] === false) {
    return { allowed: false, reason: "category_disabled" };
  }
  if (isWithinQuietHours(now, push.quietHours)) {
    return { allowed: false, reason: "quiet_hours" };
  }
  return { allowed: true };
}

/**
 * Production gate reading live config. Never throws — config-load failures
 * fail open so a corrupt config file cannot silently disable approval pushes.
 */
export function checkPushGate(
  category: PushCategory,
  now: Date = new Date(),
): PushGateResult {
  try {
    return evaluatePushGate(category, getConfig().notifications.push, now);
  } catch {
    return { allowed: true };
  }
}

/**
 * The same two config facts, kept apart rather than collapsed into one
 * verdict, because the interruption budget (`push-budget.ts`) treats them
 * differently: a disabled category outranks every tier, while quiet hours are
 * broken by the correction tier alone. Never throws — a config failure reports
 * "category on, not quiet", matching `checkPushGate`'s fail-open.
 */
export function resolvePushGateInputs(
  category: PushCategory,
  now: Date = new Date(),
): { categoryEnabled: boolean; quietNow: boolean } {
  try {
    const push = getConfig().notifications.push;
    return {
      categoryEnabled: push.categories[category] !== false,
      quietNow: isWithinQuietHours(now, push.quietHours),
    };
  } catch {
    return { categoryEnabled: true, quietNow: false };
  }
}
