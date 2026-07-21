/**
 * Host computer-use executor — proxies a single `host_cu_request` action
 * (observe / click / type / key / scroll / drag / wait / open-app /
 * run-applescript) to the native mac-helper's `computeruse.perform` JSON-RPC
 * method, then posts the resulting observation (AX tree, AX diff, screenshot,
 * and px/pt screen metadata) back to the daemon.
 *
 * The helper owns the verify → execute → settle → observe cycle natively
 * (ActionVerifier + AX-element grounding); this executor only translates the
 * SSE request into the helper call and shuttles the observation back.
 */

import { z } from "zod";

import type { HostProxyExecutor } from "../host-proxy-router";
import { getSharedCuHelper } from "../sidecar/shared-cu-helper";
import {
  HostHelperProxyExecutor,
  type CuHelperClient,
  type HostHelperProxyConfig,
} from "./host-helper-proxy-executor";

export interface HostCuExecutorDeps {
  helper?: CuHelperClient;
}

/** The mac-helper JSON-RPC method the CU executor delegates to. */
export const CU_HELPER_METHOD = "computeruse.perform";

// The helper returns only the observation fields; `requestId` is added when
// posting. Unknown keys are tolerated (passthrough) so a newer helper can
// extend the observation without breaking an older client.
const CU_RESULT_SCHEMA = z
  .object({
    axTree: z.string().optional(),
    axDiff: z.string().optional(),
    screenshot: z.string().optional(),
    screenshotWidthPx: z.number().optional(),
    screenshotHeightPx: z.number().optional(),
    screenWidthPt: z.number().optional(),
    screenHeightPt: z.number().optional(),
    executionResult: z.string().optional(),
    executionError: z.string().optional(),
    secondaryWindows: z.string().optional(),
    userGuidance: z.string().optional(),
  })
  .passthrough();

type CuResult = z.infer<typeof CU_RESULT_SCHEMA>;

function config(deps: HostCuExecutorDeps): HostHelperProxyConfig<CuResult> {
  return {
    label: "host-cu-executor",
    method: CU_HELPER_METHOD,
    resolveHelper: deps.helper
      ? () => deps.helper as CuHelperClient
      : getSharedCuHelper,
    schema: CU_RESULT_SCHEMA,
    buildParams: (message, requestId) => {
      const toolName = message.toolName as string | undefined;
      if (!toolName) return { error: "Missing toolName" };
      return {
        params: {
          requestId,
          conversationId:
            (message.conversationId as string | undefined) ?? "",
          toolName,
          input: (message.input as Record<string, unknown> | undefined) ?? {},
          stepNumber: (message.stepNumber as number | undefined) ?? 1,
          ...(typeof message.reasoning === "string"
            ? { reasoning: message.reasoning }
            : {}),
        },
      };
    },
    postSuccess: (poster, requestId, result) => {
      void poster.postCuResult({ requestId, ...result });
    },
    postError: (poster, requestId, message) => {
      void poster.postCuResult({ requestId, executionError: message });
    },
  };
}

export function createHostCuExecutor(
  deps: HostCuExecutorDeps = {},
): HostProxyExecutor {
  return new HostHelperProxyExecutor(config(deps));
}

export const hostCuExecutor: HostProxyExecutor = createHostCuExecutor();
