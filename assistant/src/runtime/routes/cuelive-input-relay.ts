/**
 * Cue Live input relay — web click/type → the Mac's mouse and keyboard.
 *
 * The relay deliberately owns **no** input mechanism of its own. It translates
 * a viewer gesture into the same `computer_use_*` request the agent's
 * computer-use tools emit, and hands it to {@link HostCuProxy}, which is the
 * proven path: it resolves a `host_cu`-capable client, enforces the same-actor
 * check, counts steps against the session cap, and lands in the mac-helper's
 * `computeruse.perform` — verify → execute → settle → observe, with
 * ActionVerifier in the middle. A new channel would have inherited none of
 * that.
 *
 * What the relay adds on top is the policy the host path cannot know
 * (see cuelive-input-policy.ts): the global trust dial, explicit take-over
 * arming, a live frame to steer against, and pause. Take-over arming lives
 * here because it is an input concern, and it *expires* — an armed take-over
 * that nobody uses for {@link TAKEOVER_TTL_MS} disarms itself rather than
 * leaving a browser tab permanently able to type on the owner's Mac.
 *
 * Frames arrive in frame-pixel space and the helper acts in screen points, so
 * coordinates are scaled here against the geometry of the frame the viewer is
 * actually looking at.
 */

import { HostCuProxy } from "../../daemon/host-cu-proxy.js";
import type { ToolExecutionResult } from "../../tools/types.js";
import { getLiveFrameGeometry } from "./cuelive-stream.js";

/** An armed take-over disarms itself after this long without an action. */
export const TAKEOVER_TTL_MS = 5 * 60_000;

/**
 * Synthetic conversation id the relay's host-CU requests are registered
 * under. The relay is not a conversation — there is no agent turn behind a
 * person clicking in a viewer — but the host-CU request/result plumbing is
 * keyed by conversation, so it gets a reserved id that no real conversation
 * can collide with.
 */
export const CUELIVE_RELAY_CONVERSATION_ID = "cuelive:remote-relay";

export type RelayActionKind = "click" | "double_click" | "type" | "key" | "scroll";

export interface RelayAction {
  kind: RelayActionKind;
  /** Frame-pixel coordinates (click / double_click / scroll). */
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
}

interface RelayState {
  takeoverArmedAtMs: number | null;
  lastActionMs: number | null;
  proxy: HostCuProxy | null;
}

let state: RelayState = {
  takeoverArmedAtMs: null,
  lastActionMs: null,
  proxy: null,
};

/** The relay's own proxy instance, created lazily so its step cap is per-arm. */
function relayProxy(): HostCuProxy {
  if (!state.proxy) state.proxy = new HostCuProxy();
  return state.proxy;
}

/**
 * Look up the relay's proxy for a host-CU result submission. Returns undefined
 * for any other conversation id, so the normal conversation path is untouched.
 */
export function getRelayHostCuProxy(
  conversationId: string,
): HostCuProxy | undefined {
  return conversationId === CUELIVE_RELAY_CONVERSATION_ID
    ? (state.proxy ?? undefined)
    : undefined;
}

export function isTakeoverArmed(now: number = Date.now()): boolean {
  if (state.takeoverArmedAtMs === null) return false;
  const since = state.lastActionMs ?? state.takeoverArmedAtMs;
  if (now - since > TAKEOVER_TTL_MS) {
    disarmTakeover();
    return false;
  }
  return true;
}

export function armTakeover(now: number = Date.now()): void {
  state.takeoverArmedAtMs = now;
  state.lastActionMs = now;
  // Fresh step budget each time a person takes over.
  state.proxy?.reset();
}

export function disarmTakeover(): void {
  state.takeoverArmedAtMs = null;
  state.lastActionMs = null;
  state.proxy?.reset();
}

export interface TakeoverStatus {
  armed: boolean;
  armedAt: string | null;
  /** Actions relayed under the current arm, against the host-CU step cap. */
  steps: number;
  maxSteps: number;
}

export function getTakeoverStatus(
  now: number = Date.now(),
): TakeoverStatus {
  const armed = isTakeoverArmed(now);
  const proxy = state.proxy;
  return {
    armed,
    armedAt:
      armed && state.takeoverArmedAtMs !== null
        ? new Date(state.takeoverArmedAtMs).toISOString()
        : null,
    steps: proxy?.stepCount ?? 0,
    maxSteps: proxy?.maxSteps ?? 0,
  };
}

/** Map a viewer gesture onto the computer-use tool that already performs it. */
export function toolNameForAction(kind: RelayActionKind): string {
  switch (kind) {
    case "click":
      return "computer_use_click";
    case "double_click":
      return "computer_use_double_click";
    case "type":
      return "computer_use_type_text";
    case "key":
      return "computer_use_key";
    case "scroll":
      return "computer_use_scroll";
  }
}

export interface RelayGeometry {
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
}

/**
 * Frame pixels → screen points, clamped to the screen. Pure so the mapping is
 * testable without a Mac attached.
 */
export function scalePoint(
  point: { x: number; y: number },
  geometry: RelayGeometry,
): { x: number; y: number } {
  const scaleX = geometry.screenWidth / geometry.width;
  const scaleY = geometry.screenHeight / geometry.height;
  return {
    x: Math.round(
      Math.min(Math.max(point.x * scaleX, 0), geometry.screenWidth),
    ),
    y: Math.round(
      Math.min(Math.max(point.y * scaleY, 0), geometry.screenHeight),
    ),
  };
}

/** Build the `computer_use_*` input payload for a relayed gesture. */
export function buildRelayInput(
  action: RelayAction,
  geometry: RelayGeometry,
): Record<string, unknown> {
  const reasoning = "Relayed from the Cue Live web viewer by the owner.";
  switch (action.kind) {
    case "click":
    case "double_click": {
      const p = scalePoint({ x: action.x ?? 0, y: action.y ?? 0 }, geometry);
      return { ...p, reasoning, click_type: action.kind === "click" ? "single" : "double" };
    }
    case "type":
      return { text: action.text ?? "", reasoning };
    case "key":
      return { key: action.key ?? "", reasoning };
    case "scroll": {
      const p = scalePoint({ x: action.x ?? 0, y: action.y ?? 0 }, geometry);
      return {
        ...p,
        direction: action.direction ?? "down",
        amount: Math.min(Math.max(action.amount ?? 3, 1), 10),
        reasoning,
      };
    }
  }
}

export interface RelayDispatchResult {
  /** True when the helper executed without reporting an error. */
  performed: boolean;
  /** One line about what happened, safe to show in the viewer. */
  detail: string;
}

/**
 * Send one relayed action through the host-CU proxy and summarise the result.
 * Caller must have already run the policy gate.
 */
export async function dispatchRelayAction(
  action: RelayAction,
  options: { actorPrincipalId?: string; signal?: AbortSignal } = {},
  now: number = Date.now(),
): Promise<RelayDispatchResult> {
  const geometry = getLiveFrameGeometry(now);
  if (!geometry) {
    return { performed: false, detail: "No live frame to steer against." };
  }
  const toolName = toolNameForAction(action.kind);
  const input = buildRelayInput(action, geometry);
  const proxy = relayProxy();
  proxy.recordAction(toolName, input);
  state.lastActionMs = now;

  const result: ToolExecutionResult = await proxy.request(
    toolName,
    input,
    CUELIVE_RELAY_CONVERSATION_ID,
    proxy.stepCount,
    "Relayed from the Cue Live web viewer by the owner.",
    options.signal,
    undefined,
    options.actorPrincipalId,
  );

  return {
    performed: !result.isError,
    detail: summarise(result),
  };
}

/**
 * The host-CU observation is an agent-shaped payload (AX tree, warnings). The
 * viewer needs one honest line, not the tree, and the tree must not be echoed
 * to the browser wholesale — it is screen content by another name.
 */
function summarise(result: ToolExecutionResult): string {
  if (result.isError) {
    const first = result.content.split("\n").find((l) => l.trim().length > 0);
    return (first ?? "The action failed.").slice(0, 200);
  }
  return "Done — the Mac verified the action.";
}

/** Test-only: wipe relay state (take-over arm + the proxy's step budget). */
export function resetCueLiveRelayForTest(): void {
  state.proxy?.dispose();
  state = { takeoverArmedAtMs: null, lastActionMs: null, proxy: null };
}
