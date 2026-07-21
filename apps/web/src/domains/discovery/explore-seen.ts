/**
 * First-run "seen" flag for the Explore / "What Cue can now do" surface.
 *
 * The design pack drew D1 full-screen at first run but never specified how it
 * ends, which would have left a screen with no exit. The contract here:
 *
 *  - unset → Explore renders in first-run mode: an intro line plus a footer
 *    with **Skip** and **Done** (both set the flag, Done is the primary);
 *  - set   → Explore is the ordinary persistent surface at You → Explore, with
 *    no first-run chrome and no nagging.
 *
 * Device-scoped and best-effort: losing it costs one extra glance at a screen
 * the user asked for, so it deliberately does not round-trip to the server.
 */
import { getLocalBool, setLocalBool } from "@/utils/local-settings";

/** localStorage key: the user finished (or skipped) the first-run Explore. */
export const KEY_EXPLORE_FIRST_RUN_SEEN = "cue:explore:firstrun:v1";

export function readExploreSeen(): boolean {
  return getLocalBool(KEY_EXPLORE_FIRST_RUN_SEEN, false);
}

export function writeExploreSeen(): void {
  setLocalBool(KEY_EXPLORE_FIRST_RUN_SEEN, true);
}
