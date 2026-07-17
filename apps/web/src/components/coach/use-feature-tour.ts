/**
 * `useFeatureTour` — client-side gating + sequencing for coach-mark tips.
 *
 * Responsibilities:
 *   - Show each tip at most ONCE per browser profile, via a namespaced
 *     localStorage flag (`cue:coach:<id>`). Once dismissed or completed a tip
 *     never returns.
 *   - Drive a surface's mini-tour: resolve the current step's target element
 *     (found at runtime by `[data-coach="<anchor>"]`), advance on "Next",
 *     end on dismiss, and opt out globally on "Skip tour".
 *   - No-op cleanly when a target isn't mounted (the surface is still loading,
 *     or the anchor hasn't been wired yet) — it simply waits, then moves on.
 *
 * The hook holds no copy and no routing — it takes an ordered list of steps
 * (from the tour registry) and an `enabled` gate, and returns the single step
 * to render plus the controls. See `feature-tour.tsx` for the host.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type { CoachStep } from "./tour-registry";

export const COACH_NAMESPACE = "cue:coach";
/** Global opt-out set by "Skip tour" — suppresses every remaining tip. */
export const COACH_DISABLED_KEY = "cue:coach:disabled";

function seenStorageKey(id: string): string {
  return `${COACH_NAMESPACE}:${id}`;
}

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) != null;
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    globalThis.localStorage?.setItem(key, "1");
  } catch {
    // Private-mode failures just mean the tip may show again — acceptable.
  }
}

function clearFlag(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // ignore
  }
}

/** Whether the user has globally opted out of tips (clicked "Skip tour"). */
export function coachDisabled(): boolean {
  return readFlag(COACH_DISABLED_KEY);
}

/**
 * Single-tip gate. Useful for a one-off coach mark outside a surface tour.
 */
export function useCoachmark(featureId: string): {
  seen: boolean;
  dismiss: () => void;
  reset: () => void;
} {
  const key = seenStorageKey(featureId);
  const [seen, setSeen] = useState(() => readFlag(key) || coachDisabled());
  const dismiss = useCallback(() => {
    writeFlag(key);
    setSeen(true);
  }, [key]);
  const reset = useCallback(() => {
    clearFlag(key);
    setSeen(false);
  }, [key]);
  return { seen, dismiss, reset };
}

// How long a target must exist before we resolve it — lets a freshly-navigated
// surface settle so the tip doesn't pop mid-transition.
const SETTLE_MS = 450;
// How long to keep looking for a not-yet-mounted target before giving up on
// this mount (the anchor may never render on this instance).
const RESOLVE_TIMEOUT_MS = 6000;

export interface FeatureTourController {
  /** The step to render now, or null when nothing is eligible/mounted. */
  activeStep: CoachStep | null;
  /** The resolved target element for `activeStep`. */
  targetEl: HTMLElement | null;
  /** Active step's index within the full surface step list (for the dots). */
  stepIndex: number;
  /** Total steps in the surface tour. */
  stepCount: number;
  /** True when an eligible (unseen, mountable) step follows the active one. */
  hasNext: boolean;
  /** "Next": mark the active step seen and advance. */
  next: () => void;
  /** Dismiss: mark the active step seen and end this run (× / Escape / click). */
  dismiss: () => void;
  /** "Skip tour": globally opt out and mark every step here seen. */
  skip: () => void;
  /** Dev helper: clear this tour's flags + the global opt-out. */
  reset: () => void;
}

export function useFeatureTour(
  steps: CoachStep[],
  options?: { enabled?: boolean },
): FeatureTourController {
  const enabled = options?.enabled ?? true;

  // Seen set — initialised from storage, mutated as tips are dismissed.
  const [seenIds, setSeenIds] = useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const step of steps) {
      if (readFlag(seenStorageKey(step.id))) set.add(step.id);
    }
    return set;
  });
  const [disabled, setDisabled] = useState(() => coachDisabled());

  // Steps ended during THIS mount (dismissed without "Next", or whose target
  // never mounted) so we don't immediately resurface them; they reappear on a
  // fresh visit. Held in state (not a ref) so render-time reads stay valid.
  const [ended, setEnded] = useState<Set<string>>(new Set());

  const [activeId, setActiveId] = useState<string | null>(null);
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);

  // Re-key the resolution effect so it restarts when the surface changes.
  const stepsKey = useMemo(() => steps.map((s) => s.id).join("|"), [steps]);

  // Reset per-mount state when the surface (step set) changes.
  useEffect(() => {
    setEnded(new Set());
    setActiveId(null);
    setTargetEl(null);
    setSeenIds(() => {
      const set = new Set<string>();
      for (const step of steps) {
        if (readFlag(seenStorageKey(step.id))) set.add(step.id);
      }
      return set;
    });
    setDisabled(coachDisabled());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepsKey]);

  // The first step that is unseen, not ended this mount, in registry order.
  const candidate = useMemo(() => {
    if (!enabled || disabled) return null;
    return steps.find((s) => !seenIds.has(s.id) && !ended.has(s.id)) ?? null;
  }, [enabled, disabled, steps, seenIds, ended]);

  // Resolve the candidate's target element in the DOM — waiting for it to
  // mount and settle, and skipping the candidate if it never appears.
  useEffect(() => {
    if (!candidate) {
      setActiveId(null);
      setTargetEl(null);
      return;
    }

    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
    const selector = `[data-coach="${candidate.anchor}"]`;

    const tryResolve = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return;
      // Found — let it settle briefly, then show.
      if (settleTimer) return;
      settleTimer = setTimeout(() => {
        if (cancelled) return;
        const stable = document.querySelector<HTMLElement>(selector);
        if (stable) {
          setTargetEl(stable);
          setActiveId(candidate.id);
          observer.disconnect();
          if (giveUpTimer) clearTimeout(giveUpTimer);
        } else {
          settleTimer = null;
        }
      }, SETTLE_MS);
    };

    const observer = new MutationObserver(tryResolve);
    observer.observe(document.body, { childList: true, subtree: true });
    tryResolve();

    // If the anchor never mounts on this surface instance, mark it ended for
    // this mount so we stop waiting (it stays unseen for a future visit).
    giveUpTimer = setTimeout(() => {
      if (cancelled) return;
      if (!document.querySelector(selector)) {
        observer.disconnect();
        // Give up on this candidate for this mount → re-evaluate for the next.
        setEnded((prev) => {
          const set = new Set(prev);
          set.add(candidate.id);
          return set;
        });
      }
    }, RESOLVE_TIMEOUT_MS);

    return () => {
      cancelled = true;
      observer.disconnect();
      if (settleTimer) clearTimeout(settleTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
    };
  }, [candidate]);

  const activeStep = useMemo(
    () => steps.find((s) => s.id === activeId) ?? null,
    [steps, activeId],
  );

  const stepIndex = activeStep
    ? steps.findIndex((s) => s.id === activeStep.id)
    : 0;
  const stepCount = steps.length;

  const hasNext = useMemo(() => {
    if (!activeStep) return false;
    const idx = steps.findIndex((s) => s.id === activeStep.id);
    return steps
      .slice(idx + 1)
      .some((s) => !seenIds.has(s.id) && !ended.has(s.id));
  }, [activeStep, steps, seenIds, ended]);

  const markSeen = useCallback((id: string) => {
    writeFlag(seenStorageKey(id));
    setSeenIds((prev) => {
      const set = new Set(prev);
      set.add(id);
      return set;
    });
  }, []);

  const next = useCallback(() => {
    if (!activeStep) return;
    markSeen(activeStep.id);
    setActiveId(null);
    setTargetEl(null);
  }, [activeStep, markSeen]);

  const dismiss = useCallback(() => {
    if (!activeStep) return;
    const id = activeStep.id;
    setEnded((prev) => {
      const set = new Set(prev);
      set.add(id);
      return set;
    });
    markSeen(id);
    setActiveId(null);
    setTargetEl(null);
  }, [activeStep, markSeen]);

  const skip = useCallback(() => {
    writeFlag(COACH_DISABLED_KEY);
    for (const step of steps) writeFlag(seenStorageKey(step.id));
    setDisabled(true);
    setActiveId(null);
    setTargetEl(null);
  }, [steps]);

  const reset = useCallback(() => {
    clearFlag(COACH_DISABLED_KEY);
    for (const step of steps) clearFlag(seenStorageKey(step.id));
    setEnded(new Set());
    setDisabled(false);
    setSeenIds(new Set());
    setActiveId(null);
    setTargetEl(null);
  }, [steps]);

  return {
    activeStep,
    targetEl,
    stepIndex,
    stepCount,
    hasNext,
    next,
    dismiss,
    skip,
    reset,
  };
}
