/**
 * Boot-time gate for the "Your Home is now HQ" orientation
 * (see `hq-orientation.tsx`).
 *
 * The orientation explains where old-Home modules moved, so it must only
 * show to users who actually USED the old Home. A brand-new browser/instance
 * must never see it. Evidence of prior usage = long-standing localStorage
 * keys every pre-HQ client wrote (assistant selection, sidebar prefs, …).
 *
 * `markHqNativeIfFresh()` runs at app boot, BEFORE onboarding/selection can
 * write any of those keys in the current session: if the orientation hasn't
 * been seen and there's no prior-usage evidence, this profile is "HQ-native"
 * — set the seen-flag immediately so the orientation is suppressed forever.
 * Upgrading profiles have the evidence keys at boot, skip the mark, and get
 * the orientation once on their first HQ visit.
 *
 * Kept free of React/page imports so `main.tsx` can call it without pulling
 * the HQ page chunk into the boot path.
 */

export const HQ_ORIENTATION_SEEN_KEY = "cue:hq-orientation-seen";

/**
 * Keys that pre-HQ clients wrote during normal use. Fresh profiles have none
 * of these at first boot (this check runs before anything else writes them).
 */
const PRIOR_USAGE_KEYS = [
  "vellum:selectedAssistantId",
  "vellum:sidebar:collapsed",
  "vellum:sidebar:width",
  "vellum:pinnedApps",
  "vellum:local:lockfile",
];

/** Suppress the HQ orientation forever on profiles with no prior usage. */
export function markHqNativeIfFresh(): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    if (storage.getItem(HQ_ORIENTATION_SEEN_KEY) != null) return;
    const hasPriorUsage = PRIOR_USAGE_KEYS.some(
      (key) => storage.getItem(key) != null,
    );
    if (!hasPriorUsage) {
      storage.setItem(HQ_ORIENTATION_SEEN_KEY, "native");
    }
  } catch {
    // Private-mode storage failures: the orientation hook has its own
    // try/catch and defaults to not showing, so nothing to do here.
  }
}
