/**
 * Shared computer-use / app-control mac-helper.
 *
 * Computer-use and app-control actions run through the SAME signed
 * `cue-mac-helper` binary as hotkeys/dictation/Cue Live — so they inherit the
 * exact Accessibility + Screen-Recording TCC grants Cue Live already prompts
 * for (zero new permission prompts). But they run on a SECOND, independent
 * `MacHelperClient` instance:
 *
 *  - **Isolation** — a crash in the CU/app-control surface trips its own
 *    supervisor circuit without tearing down the hotkey/dictation helper that
 *    the whole app depends on, and vice-versa.
 *  - **Timeout** — a single CU step (verify → execute → settle → observe, plus
 *    an AX-tree walk and a screen capture) is far slower than a hotkey toggle.
 *    The response timeout here sits just above the daemon's host-proxy request
 *    timeout so the daemon, not the transport, owns the deadline.
 *
 * Lazily spawned on the first CU/app-control call; torn down with the bridge.
 */

import log from "../logger";
import { getMacHelperPath } from "../hotkey-helper";
import { MacHelperClient } from "./mac-helper";

/**
 * Just above the daemon's 60s host-proxy request timeout, so a slow-but-alive
 * step is decided by the daemon (which posts a clean timeout result) rather
 * than surfacing here as a transport error.
 */
export const CU_HELPER_TIMEOUT_MS = 65_000;

let client: MacHelperClient | null = null;

/**
 * The shared CU/app-control helper client. Reuses the same bundled binary as
 * the hotkey helper (so TCC grants carry over) on its own supervised process.
 */
export function getSharedCuHelper(): MacHelperClient {
  if (!client) {
    client = new MacHelperClient({
      name: "mac helper (computer use)",
      resolveExecutablePath: getMacHelperPath,
      logger: log,
      responseTimeoutMs: CU_HELPER_TIMEOUT_MS,
    });
  }
  return client;
}

/** Tear down the shared CU helper (called from the bridge teardown). */
export function shutdownSharedCuHelper(): void {
  client?.shutdown();
  client = null;
}

/** Test seam. */
export const __testing = {
  reset(): void {
    client?.resetForTesting();
    client = null;
  },
  set(mock: MacHelperClient | null): void {
    client = mock;
  },
};
