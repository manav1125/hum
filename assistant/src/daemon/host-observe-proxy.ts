/**
 * Asks the desktop for one read-only look at the screen.
 *
 * This is the capture source behind {@link startObservationDriver}: the driver
 * decides *when* to look, this decides *how* to ask, and
 * `observation-capture.ts` decides whether the answer may be used.
 *
 * ## Why this is not `host_cu`
 *
 * `host_cu` is the channel that CLICKS AND TYPES on the guardian's machine —
 * it is wrapped by `ax-send-guard` precisely because that path is dangerous.
 * Observation only reads. Sending it down the acting channel would weld two
 * very different permissions together: a person could not let Cue watch them
 * demonstrate a workflow without also enabling the channel that can act on
 * their machine, and revoking one would take the other with it. Those are
 * separately reasonable answers, so they get separate capabilities.
 *
 * The split also lets the desktop apply its own policy and show its own state
 * for watching, rather than inheriting the semantics of an acting loop —
 * `host_cu`'s step counter and loop detection exist for a thing that acts.
 *
 * ## Inert until a client says otherwise
 *
 * {@link HostObserveProxy.isAvailable} reads what a CONNECTED client
 * advertises, not what the interface type claims. A desktop build that
 * predates this capability simply never advertises it, so the driver asks
 * nothing and captures nothing. There is no version negotiation to get wrong
 * and no failure mode where an old client is asked something it cannot answer.
 */

import type { ScreenObservationInput } from "../cue-live/observation-capture.js";
import { getLogger } from "../util/logger.js";
import { HostProxyBase } from "./host-proxy-base.js";

const log = getLogger("host-observe-proxy");

/**
 * What the desktop sends back for one look.
 *
 * `description` is the accessibility text — the cheap, private path the
 * capture contract already prefers over pixels. `imageBase64` remains possible
 * for a client that can only screenshot, and is dropped after the model reads
 * it; the daemon never persists screen bytes.
 */
export interface HostObserveResultPayload {
  description?: string;
  imageBase64?: string;
  mediaType?: string;
  appName?: string;
}

/**
 * A single look is bounded well under the driver's shortest interval, so a
 * wedged host cannot hold a capture open across ticks. The driver refuses to
 * start a second look while one is outstanding, and this is what guarantees
 * that promise terminates.
 */
const OBSERVE_TIMEOUT_MS = 10_000;

export class HostObserveProxy extends HostProxyBase<
  Record<string, unknown>,
  HostObserveResultPayload
> {
  private static _instance: HostObserveProxy | null = null;

  constructor() {
    super({
      capabilityName: "host_observe",
      requestEventName: "host_observe_request",
      cancelEventName: "host_observe_cancel",
      resultPendingKind: "host_observe",
      timeoutMs: OBSERVE_TIMEOUT_MS,
      disposedMessage: "Host observe proxy disposed",
    });
  }

  static get instance(): HostObserveProxy {
    if (!HostObserveProxy._instance) {
      HostObserveProxy._instance = new HostObserveProxy();
    }
    return HostObserveProxy._instance;
  }

  static disposeInstance(): void {
    if (HostObserveProxy._instance) {
      HostObserveProxy._instance.dispose();
      HostObserveProxy._instance = null;
    }
  }

  /** For tests. */
  static reset(): void {
    HostObserveProxy._instance = null;
  }

  /**
   * Ask the connected desktop for one observation.
   *
   * `sessionId` stands where a conversation id would: a capture session is the
   * real lifetime this request belongs to, and there is no conversation behind
   * a background demonstration. Putting a made-up conversation id into the
   * envelope would make the request look like something it is not to every
   * consumer downstream.
   */
  async observe(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<HostObserveResultPayload> {
    return this.dispatchRequest("observe_screen", {}, sessionId, signal);
  }
}

/**
 * The driver's capture source, or `null` when no client can answer.
 *
 * Returns `null` — never a throw and never an empty description — for every
 * "could not look" case. The distinction is load-bearing downstream: an empty
 * description is a CLAIM that the screen held nothing, and the capture seam
 * would be entitled to act on it.
 */
export async function observeHostScreen(
  sessionId: string,
  signal: AbortSignal,
): Promise<ScreenObservationInput | null> {
  const proxy = HostObserveProxy.instance;

  // No desktop, or a desktop too old to advertise the capability. Not an
  // error and not worth a log line on every tick — the driver simply has
  // nothing to look through.
  if (!proxy.isAvailable()) return null;

  try {
    const result = await proxy.observe(sessionId, signal);
    // A reply carrying neither text nor a frame tells us nothing. Forwarding
    // it would spend an extraction on emptiness.
    if (!result.description && !result.imageBase64) return null;
    return {
      description: result.description,
      imageBase64: result.imageBase64,
      mediaType: result.mediaType,
      appName: result.appName,
      at: Date.now(),
    };
  } catch (err) {
    if (signal.aborted) return null;
    log.debug({ err }, "host declined or failed to answer an observation");
    return null;
  }
}
