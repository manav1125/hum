/**
 * Cue Live input-relay policy — the gate between the web viewer and the Mac's
 * mouse and keyboard.
 *
 * Steering a Mac from a browser is the single most dangerous thing this
 * product does, so the relay is deliberately *not* a new capability: it is a
 * strictly narrower entrance to the host computer-use path the agent already
 * uses (`computeruse.perform`), and it inherits that path's ActionVerifier,
 * step cap, and same-actor checks. What this module adds is the part the
 * host path cannot know: whether the workspace's global trust dial permits
 * acting at all, and whether a human explicitly took over.
 *
 * The rules, in order:
 *
 * 1. **The global trust dial wins.** `observe` means watch-only, so every
 *    relayed action is refused — the web must never be a way around a dial the
 *    owner set. `assist` and `autonomous` permit *attended* action, which is
 *    what a person clicking in the viewer is.
 * 2. **Take-over must be armed explicitly.** There is no implicit input
 *    channel: opening the viewer, or even streaming, never makes the Mac
 *    clickable. The owner arms take-over, the arm expires on its own, and
 *    every action re-checks it.
 * 3. **You may only steer what you can see.** Input needs a live frame. No
 *    frame, stale frame, stopped stream → refused, because the coordinates
 *    would be resolved against a screen the operator is not actually looking
 *    at.
 * 4. **Pause means paused.** A paused session refuses input for the same
 *    reason it refuses guidance.
 *
 * Pure and dependency-free so the whole matrix is unit-testable; the live
 * values are read by the caller.
 */

import type { MissionMode } from "../../missions/mission-store.js";

export interface InputRelayContext {
  /** Global trust dial: observe | assist | autonomous. */
  dial: MissionMode;
  /** True when take-over is armed and unexpired. */
  takeoverArmed: boolean;
  /** True when a frame arrived recently enough to steer against. */
  liveFrame: boolean;
  /** True when the session is held by a remote pause. */
  paused: boolean;
}

export type InputRelayDecision =
  | { allowed: true; dial: MissionMode }
  | { allowed: false; dial: MissionMode; code: RelayDenialCode; reason: string };

export type RelayDenialCode =
  | "trust_dial"
  | "takeover_not_armed"
  | "no_live_frame"
  | "paused";

/**
 * The most a Cue Live surface may do under each global posture. `observe` is
 * the only posture that forbids acting outright; `assist` still allows
 * attended action (a person is watching and driving), which is the same
 * reading the Mac's own take-control uses.
 */
export function dialAllowsCueLiveAction(dial: MissionMode): boolean {
  return dial !== "observe";
}

const DIAL_DENIAL =
  "Your trust dial is set to Observe — Cue can watch this Mac but not act on " +
  "it. Raise the dial to Assist or Autonomous to steer from the web.";

export function evaluateInputRelay(ctx: InputRelayContext): InputRelayDecision {
  if (!dialAllowsCueLiveAction(ctx.dial)) {
    return {
      allowed: false,
      dial: ctx.dial,
      code: "trust_dial",
      reason: DIAL_DENIAL,
    };
  }
  if (ctx.paused) {
    return {
      allowed: false,
      dial: ctx.dial,
      code: "paused",
      reason: "The session is paused. Resume it before steering.",
    };
  }
  if (!ctx.takeoverArmed) {
    return {
      allowed: false,
      dial: ctx.dial,
      code: "takeover_not_armed",
      reason:
        "Take over isn't armed. Press Take over first — Cue never accepts " +
        "input from the web implicitly.",
    };
  }
  if (!ctx.liveFrame) {
    return {
      allowed: false,
      dial: ctx.dial,
      code: "no_live_frame",
      reason:
        "No live frame. Cue won't relay a click at a screen you can't see — " +
        "start the screen stream first.",
    };
  }
  return { allowed: true, dial: ctx.dial };
}
