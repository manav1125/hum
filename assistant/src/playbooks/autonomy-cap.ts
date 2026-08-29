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

/**
 * The most autonomous an AGENT may be, from its roster tier.
 *
 * The tier is the owner's posture toward one agent, and it sits alongside the
 * global dial rather than under it: an agent set to draft must not act even
 * when the workspace is Autonomous, because that setting is the whole reason
 * the owner staffed it that way.
 *
 * Tiers 3 and 4 both reach `auto`. The difference between them is whether the
 * owner is told afterwards, which is a notification concern; treating tier 3
 * as less permitted would make "acts, tells you after" mean "does not act".
 *
 * An unrecognised tier clamps to `notify`. A tier this code cannot read is a
 * tier whose intent is unknown, and the safe reading of an unknown intent
 * about autonomy is the least of it.
 */
export function agentTierCeiling(tier: string): PlaybookAutonomyLevel {
  switch (tier) {
    case "1":
      return "notify";
    case "2":
      return "draft";
    case "3":
    case "4":
      return "auto";
    default:
      return "notify";
  }
}

/**
 * Clamp a requested autonomy against BOTH an explicit global posture and an
 * agent's tier. Pure — the unit-testable core, mirroring {@link capAutonomy}.
 *
 * With no agent the result is the plain global-dial clamp, which is what the
 * house assistant has always been governed by.
 */
export function capAgentAutonomy(
  requested: PlaybookAutonomyLevel,
  dial: MissionMode,
  agent: { tier: string; paused: number } | undefined,
): CappedAutonomy & { pausedAgent: boolean } {
  const dialCapped = capAutonomy(requested, dial);
  if (!agent) return { ...dialCapped, pausedAgent: false };

  // A paused agent is not a slow agent. Pausing is the owner saying "stop",
  // and the only honest reading of stop is that nothing runs unattended.
  if (agent.paused) {
    return {
      ...dialCapped,
      effective: "notify",
      capped: true,
      pausedAgent: true,
    };
  }

  const tierCeiling = agentTierCeiling(agent.tier);
  const effectiveRank = Math.min(
    AUTONOMY_RANK[dialCapped.effective],
    AUTONOMY_RANK[tierCeiling],
  );
  const effective = RANK_TO_AUTONOMY[effectiveRank];
  return {
    ...dialCapped,
    effective,
    capped: AUTONOMY_RANK[requested] > AUTONOMY_RANK[effective],
    pausedAgent: false,
  };
}

/**
 * Clamp against the LIVE global dial and an agent's tier. This is what the
 * auto-run gate calls.
 */
export function effectiveAgentAutonomy(
  requested: PlaybookAutonomyLevel,
  agent: { tier: string; paused: number } | undefined,
): CappedAutonomy & { pausedAgent: boolean } {
  return capAgentAutonomy(requested, getGlobalDial(), agent);
}
