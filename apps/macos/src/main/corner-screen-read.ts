import { z } from "zod";

import { readSetting, writeSetting } from "./settings";
import { getSharedCuHelper } from "./sidecar/shared-cu-helper";

/**
 * F1 — the corner reading the window in front of you.
 *
 * ## Off until asked, and asked on SECOND use
 *
 * Never in onboarding, where nobody can judge it. Someone who has used the
 * corner once knows what it is for and can weigh the offer; someone on their
 * first launch is being asked to agree to something abstract. So the invite
 * appears on the second summon, and "Not now" is not a dead end — the panel
 * works without it, on the selection alone, and the offer returns later as a
 * one-line prompt.
 *
 * ## Only while the panel is open
 *
 * There is **no background watching here and no code path that could start
 * any**. Each read is one call, made during a summon, for one window. Nothing
 * polls, nothing subscribes, nothing runs on a timer. That is why the footer
 * sentence can be stated as fact rather than as policy.
 *
 * ## Why this rides `observe.screen` and not the computer-use channel
 *
 * `host_cu` is the channel that clicks and types, and it is wrapped in a send
 * guard precisely because it can act on the owner's machine. `observe.screen`
 * only reads. Keeping the corner on the read-only method is what lets someone
 * grant "you may look at what I'm looking at" without also granting "you may
 * act on it" — and revoke either without the other.
 *
 * ## The distinction from Cue Live, which must stay sharp
 *
 * Cue Live watches **continuously**, with a visible session the owner starts
 * and ends. The corner reads **one window, once, while you are looking at
 * it**. Same product, different consent. If this file ever grows a loop, the
 * corner has become Cue Live without Cue Live's ceremony, which is the
 * failure the design names explicitly.
 */

/** Persisted answer to the invite. Absent means never asked. */
const CONSENT_KEY = "cornerScreenReading" as const;
/** How many times the corner has been summoned, so the ask lands on the 2nd. */
const SUMMON_COUNT_KEY = "cornerSummonCount" as const;

const OBSERVE_METHOD = "observe.screen";

/** A read must never make a summon feel slow. */
const OBSERVE_TIMEOUT_MS = 2_500;

const observeResultSchema = z
  .object({
    ok: z.boolean().optional(),
    reason: z.string().optional(),
    description: z.string().optional(),
    appName: z.string().optional(),
  })
  .passthrough();

export interface ScreenRead {
  description: string;
  appName: string | null;
}

export type ScreenReadConsent = "granted" | "declined" | "unasked";

export const screenReadConsent = (): ScreenReadConsent => {
  const value = readSetting(CONSENT_KEY);
  if (value === true) return "granted";
  if (value === false) return "declined";
  return "unasked";
};

export const setScreenReadConsent = (granted: boolean): void => {
  writeSetting(CONSENT_KEY, granted);
};

/**
 * Record a summon and say whether this is the moment to offer screen-reading.
 *
 * The offer belongs on the second use and nowhere else: once, so it is not
 * nagging, and on the second so the person has something to judge it against.
 * A declined offer stays declined until the owner changes it themselves —
 * re-asking every few days is how a permission prompt becomes something
 * people click through to make it stop.
 */
export const noteSummonAndShouldOffer = (): boolean => {
  const count = (readSetting(SUMMON_COUNT_KEY) ?? 0) + 1;
  writeSetting(SUMMON_COUNT_KEY, count);
  return count === 2 && screenReadConsent() === "unasked";
};

/**
 * Read the window in front, or `null`.
 *
 * `null` covers every ordinary way this does not happen — consent not given,
 * Accessibility not granted, no focused window, an app that answers nothing.
 * The corner opens regardless and simply has no context; a failed look is not
 * information and is never reported as though the screen were blank.
 *
 * **Nothing is stored.** A read that produced no accepted action leaves no
 * trace: the description is handed to the panel for this one exchange and is
 * not written anywhere.
 */
export const readFrontWindow = async (): Promise<ScreenRead | null> => {
  if (screenReadConsent() !== "granted") return null;

  try {
    const helper = getSharedCuHelper();
    const raw = await Promise.race([
      helper.call(OBSERVE_METHOD, { requestId: crypto.randomUUID() }),
      new Promise((resolve) =>
        setTimeout(() => resolve(null), OBSERVE_TIMEOUT_MS),
      ),
    ]);
    if (!raw) return null;

    const parsed = observeResultSchema.safeParse(raw);
    if (!parsed.success) return null;
    // `ok: false` or an empty description means we could not look. Returning
    // an empty string would assert a blank screen, which the helper never
    // claimed.
    if (parsed.data.ok === false || !parsed.data.description) return null;

    return {
      description: parsed.data.description,
      appName: parsed.data.appName ?? null,
    };
  } catch {
    return null;
  }
};

/** Test seam — exported only for unit-test setup. */
export const __resetForTesting = (): void => {
  writeSetting(SUMMON_COUNT_KEY, 0);
};
