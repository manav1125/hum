/**
 * Host observation executor — answers one `host_observe_request` by reading
 * the focused window's accessibility tree via the native mac-helper's
 * read-only `observe.screen` JSON-RPC method.
 *
 * ## Why this is not the CU executor with a different action
 *
 * `host_cu` is the channel that clicks and types. Its helper method runs the
 * verify → execute → settle cycle, and the daemon wraps it in `ax-send-guard`
 * precisely because that path can act on the guardian's machine. Observation
 * only reads. Keeping it on its own capability and its own helper method is
 * what lets a person grant "watch me demonstrate this" without also granting
 * "act on my machine", and revoke either one without taking the other.
 *
 * ## A failed look is not an error
 *
 * The helper answers `ok: false` for the ordinary ways a look can fail —
 * Accessibility not granted, no focused window, an unresponsive app. Those are
 * posted back as a result with no description rather than as an execution
 * error, because the daemon's capture source treats "could not look" and
 * "nothing there" identically: it skips the tick. What must never happen is an
 * empty description being posted as though the screen were blank, which is a
 * claim the helper never made — so a failed read posts NOTHING at all.
 */

import { z } from "zod";

import type { HostProxyExecutor } from "../host-proxy-router";
import { getSharedCuHelper } from "../sidecar/shared-cu-helper";
import {
  HostHelperProxyExecutor,
  type CuHelperClient,
  type HostHelperProxyConfig,
} from "./host-helper-proxy-executor";

export interface HostObserveExecutorDeps {
  helper?: CuHelperClient;
}

/** The mac-helper JSON-RPC method this executor delegates to. */
export const OBSERVE_HELPER_METHOD = "observe.screen";

// Passthrough so a newer helper can add fields without breaking this client.
const OBSERVE_RESULT_SCHEMA = z
  .object({
    ok: z.boolean().optional(),
    reason: z.string().optional(),
    description: z.string().optional(),
    appName: z.string().optional(),
  })
  .passthrough();

type ObserveResult = z.infer<typeof OBSERVE_RESULT_SCHEMA>;

function config(
  deps: HostObserveExecutorDeps,
): HostHelperProxyConfig<ObserveResult> {
  return {
    label: "host-observe-executor",
    method: OBSERVE_HELPER_METHOD,
    resolveHelper: deps.helper
      ? () => deps.helper as CuHelperClient
      : getSharedCuHelper,
    schema: OBSERVE_RESULT_SCHEMA,
    // An observation takes no input: it is "what is on screen right now".
    // There is no target, no selector and no action to validate, which is
    // most of the reason this channel is safe to expose separately.
    buildParams: (_message, requestId) => ({ params: { requestId } }),
    postSuccess: (poster, requestId, result) => {
      // `ok: false`, or a read that produced no text, means we could not look.
      // Posting an empty description would assert an empty screen; posting
      // nothing lets the daemon's request time out into its own "could not
      // look" path, which is the same outcome without the false claim.
      if (result.ok === false || !result.description) return;
      void poster.postObserveResult({
        requestId,
        description: result.description,
        ...(result.appName ? { appName: result.appName } : {}),
      });
    },
    postError: () => {
      // Deliberately silent, for the same reason. The daemon bounds every
      // observe request itself, and a look that failed is not information.
    },
  };
}

export function createHostObserveExecutor(
  deps: HostObserveExecutorDeps = {},
): HostProxyExecutor {
  return new HostHelperProxyExecutor(config(deps));
}

export const hostObserveExecutor: HostProxyExecutor =
  createHostObserveExecutor();
