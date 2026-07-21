/**
 * Autonomy cap — THE enforcement point for WS-F.
 *
 * A playbook stores the autonomy the user *requested* ('auto' | 'draft' |
 * 'notify'). It may never actually run more autonomously than the workspace's
 * global trust dial (Observe / Assist / Autonomous) allows. This module is the
 * single server-side place that clamp is computed, so every surface — the
 * runtime that fires a playbook, and the routes that feed the UI's 🔒 capped
 * indicator — reads the same truth. The stored value is never mutated; the cap
 * is applied on top, so the UI can honestly show "you asked for Auto, but the
 * dial holds it at Draft."
 *
 * The global dial is `company_profile.workspace_mode` — the same
 * observe/assist/autonomous posture the mission cadence engine already gates
 * on (see missions/mission-orchestrator.ts). Using it keeps the event-driven
 * (playbook) and clock-driven (mission) layers governed by one dial.
 */

import type { MissionMode } from "../missions/mission-store.js";
import { getCompanyProfile } from "../missions/mission-store.js";
import type { PlaybookAutonomyLevel } from "./types.js";

/** Increasing autonomy: notify (surface only) < draft (prepare) < auto (act). */
const AUTONOMY_RANK: Record<PlaybookAutonomyLevel, number> = {
  notify: 0,
  draft: 1,
  auto: 2,
};

const RANK_TO_AUTONOMY: PlaybookAutonomyLevel[] = ["notify", "draft", "auto"];

/**
 * The most autonomous a playbook may be under each global posture:
 *   observe     → notify  (surface only; never prepares or acts)
 *   assist      → draft   (prepares for review; never acts unattended)
 *   autonomous  → auto    (may act, still subject to the per-category
 *                          autonomy policy + hard-deny guard downstream)
 */
const DIAL_CEILING: Record<MissionMode, PlaybookAutonomyLevel> = {
  observe: "notify",
  assist: "draft",
  autonomous: "auto",
};

export interface CappedAutonomy {
  /** What the playbook asked for. */
  requested: PlaybookAutonomyLevel;
  /** What it will actually do, after the global dial clamp. */
  effective: PlaybookAutonomyLevel;
  /** The global dial ceiling that applied. */
  ceiling: PlaybookAutonomyLevel;
  /** The workspace posture the ceiling came from. */
  dial: MissionMode;
  /** True when the dial held the requested autonomy below what was asked. */
  capped: boolean;
}

/**
 * Clamp a requested autonomy against an explicit global posture. Pure — the
 * unit-testable core with no DB dependency.
 */
export function capAutonomy(
  requested: PlaybookAutonomyLevel,
  dial: MissionMode,
): CappedAutonomy {
  const ceiling = DIAL_CEILING[dial];
  const effectiveRank = Math.min(
    AUTONOMY_RANK[requested],
    AUTONOMY_RANK[ceiling],
  );
  const effective = RANK_TO_AUTONOMY[effectiveRank];
  return {
    requested,
    effective,
    ceiling,
    dial,
    capped: AUTONOMY_RANK[requested] > AUTONOMY_RANK[ceiling],
  };
}

/** Read the live global trust dial (observe | assist | autonomous). */
export function getGlobalDial(): MissionMode {
  return getCompanyProfile().workspaceMode;
}

/**
 * Clamp a requested autonomy against the LIVE global dial. This is what the
 * runtime and routes call.
 */
export function effectiveAutonomy(
  requested: PlaybookAutonomyLevel,
): CappedAutonomy {
  return capAutonomy(requested, getGlobalDial());
}
