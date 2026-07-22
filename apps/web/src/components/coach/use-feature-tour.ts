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
 *   - Treat a tour as ONE RUN rather than a bag of independent tips. Ending the
 *     run — "Got it", the ×, Escape, clicking the target, or "Skip tour" —
 *     retires the whole surface (`cue:coach:surface:<id>`), so a tour a user has
 *     already dealt with can never come back tip-by-tip on a later visit.
 *   - Never resurrect a step whose anchor isn't on this surface. If the current
 *     step's target doesn't mount, the run stops there for this mount; it does
 *     NOT cascade down the list looking for something else to point at (which is
 *     how a lone final tip used to pop, unannounced, tens of seconds after
 *     landing on a page).
 *   - Hard-bound how often a surface may present at all
 *     (`cue:coach:attempts:<id>`, {@link MAX_SURFACE_ATTEMPTS}), so even a user
 *     who never acknowledges a tip stops seeing it.
 *
 * The hook holds no copy and no routing — it takes an ordered list of steps
 * (from the tour registry) and an `enabled` gate, and returns the single step
 * to render plus the controls. See `feature-tour.tsx` for the host.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CoachStep } from "./tour-registry";

export const COACH_NAMESPACE = "cue:coach";
/** Global opt-out set by "Skip tour" — suppresses every remaining tip. */
export const COACH_DISABLED_KEY = "cue:coach:disabled";
/** Per-surface "this tour is retired" flag — written when a run ends. */
const SURFACE_DONE_PREFIX = "cue:coach:surface:";
/** Per-surface count of runs that actually put a tip on screen. */
const SURFACE_ATTEMPTS_PREFIX = "cue:coach:attempts:";

/**
 * How many times a surface's tour may ever present itself. A run normally
 * retires the surface the moment the user acknowledges anything, so this only
 * catches the user who keeps navigating away mid-tip — they still stop being
 * interrupted instead of being asked forever.
 */
export const MAX_SURFACE_ATTEMPTS = 3;

function seenStorageKey(id: string): string {
  return `${COACH_NAMESPACE}:${id}`;
}

function surfaceDoneKey(surfaceId: string): string {
  return `${SURFACE_DONE_PREFIX}${surfaceId}`;
}

function surfaceAttemptsKey(surfaceId: string): string {
  return `${SURFACE_ATTEMPTS_PREFIX}${surfaceId}`;
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

function readCount(key: string): number {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw == null) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function bumpCount(key: string): void {
  try {
    globalThis.localStorage?.setItem(key, String(readCount(key) + 1));
  } catch {
    // ignore
  }
}

/** Whether the user has globally opted out of tips (clicked "Skip tour"). */
export function coachDisabled(): boolean {
  return readFlag(COACH_DISABLED_KEY);
}

/**
 * Whether a surface's tour is retired — either it has already been run to an
 * end, or it has presented itself as many times as it is ever allowed to.
 */
export function surfaceTourRetired(surfaceId: string): boolean {
  return (
    readFlag(surfaceDoneKey(surfaceId)) ||
    readCount(surfaceAttemptsKey(surfaceId)) >= MAX_SURFACE_ATTEMPTS
  );
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
  /** Active step's index within THIS RUN's step list (for the dots). */
  stepIndex: number;
  /** Number of steps in this run (not the whole registry list). */
  stepCount: number;
  /** True when an eligible (unseen) step follows the active one. */
  hasNext: boolean;
  /** "Next": mark the active step seen and advance. */
  next: () => void;
  /** Dismiss: end the run and retire this surface (× / Escape / click). */
  dismiss: () => void;
  /** "Skip tour": globally opt out and retire this surface. */
  skip: () => void;
  /** Dev helper: clear this tour's flags + the global opt-out. */
  reset: () => void;
}

function initialSeen(steps: CoachStep[]): Set<string> {
  const set = new Set<string>();
  for (const step of steps) {
    if (readFlag(seenStorageKey(step.id))) set.add(step.id);
  }
  return set;
}

export function useFeatureTour(
  steps: CoachStep[],
  options?: { enabled?: boolean; surfaceId?: string },
): FeatureTourController {
  const enabled = options?.enabled ?? true;
  const surfaceId = options?.surfaceId ?? null;

  // Seen set — initialised from storage, mutated as tips are dismissed.
  const [seenIds, setSeenIds] = useState<Set<string>>(() => initialSeen(steps));
  const [disabled, setDisabled] = useState(() => coachDisabled());
  /** This surface's tour is over — either retired in storage or ended here. */
  const [retired, setRetired] = useState(() =>
    surfaceId != null ? surfaceTourRetired(surfaceId) : false,
  );
  /**
   * The run stopped for THIS mount only, because the current step's target
   * never appeared. Nothing is persisted — the surface simply doesn't have
   * that anchor right now, and we do not go hunting for a later one.
   */
  const [halted, setHalted] = useState(false);

  /**
   * The steps eligible when this run armed. Backs the "N of M" dots so they
   * describe the tour the user is actually being shown, not the registry.
   */
  const [runSteps, setRunSteps] = useState<CoachStep[] | null>(null);
  const runStartedRef = useRef(false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);

  // Re-key the resolution effect so it restarts when the surface changes.
  const stepsKey = useMemo(() => steps.map((s) => s.id).join("|"), [steps]);

  // Reset per-mount state when the surface (step set) changes.
  useEffect(() => {
    runStartedRef.current = false;
    setHalted(false);
    setRunSteps(null);
    setActiveId(null);
    setTargetEl(null);
    setSeenIds(initialSeen(steps));
    setDisabled(coachDisabled());
    setRetired(surfaceId != null ? surfaceTourRetired(surfaceId) : false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepsKey, surfaceId]);

  /** End the run: every step of this surface is done with, forever. */
  const endRun = useCallback(() => {
    for (const step of steps) writeFlag(seenStorageKey(step.id));
    if (surfaceId != null) writeFlag(surfaceDoneKey(surfaceId));
    setSeenIds(new Set(steps.map((s) => s.id)));
    setRetired(true);
    setActiveId(null);
    setTargetEl(null);
  }, [steps, surfaceId]);

  // Held in a ref so the give-up timer (armed inside the resolve effect) can
  // end the run without making `endRun` a dependency of that effect — which
  // would restart the observer every time the step list advanced.
  const endRunRef = useRef(endRun);
  useEffect(() => {
    endRunRef.current = endRun;
  }, [endRun]);

  // The first step that is still unseen, in registry order.
  const candidate = useMemo(() => {
    if (!enabled || disabled || retired || halted) return null;
    return steps.find((s) => !seenIds.has(s.id)) ?? null;
  }, [enabled, disabled, retired, halted, steps, seenIds]);

  // Resolve the candidate's target element in the DOM — waiting for it to
  // mount and settle. If it never appears we stop the run here rather than
  // walking on to a later step that happens to be mounted.
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

    giveUpTimer = setTimeout(() => {
      if (cancelled) return;
      if (!document.querySelector(selector)) {
        observer.disconnect();
        if (runStartedRef.current) {
          // The tour was under way and the surface has run out of anchors —
          // that's the end of it, not a reason to keep re-arming later.
          endRunRef.current();
        } else {
          // Nothing was ever shown: stay quiet for this mount and persist
          // nothing, so a surface that simply hadn't loaded yet isn't burned.
          setHalted(true);
        }
      }
    }, RESOLVE_TIMEOUT_MS);

    return () => {
      cancelled = true;
      observer.disconnect();
      if (settleTimer) clearTimeout(settleTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
    };
  }, [candidate]);

  // Arm the run the first time a tip actually reaches the screen: freeze the
  // step list the dots describe, and spend one of this surface's attempts.
  useEffect(() => {
    if (activeId == null || runStartedRef.current) return;
    runStartedRef.current = true;
    setRunSteps(steps.filter((s) => !seenIds.has(s.id)));
    if (surfaceId != null) bumpCount(surfaceAttemptsKey(surfaceId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const activeStep = useMemo(
    () => steps.find((s) => s.id === activeId) ?? null,
    [steps, activeId],
  );

  const dotSteps = runSteps ?? steps;
  const stepCount = dotSteps.length;
  const stepIndex = activeStep
    ? Math.max(
        0,
        dotSteps.findIndex((s) => s.id === activeStep.id),
      )
    : 0;

  const hasNext = useMemo(() => {
    if (!activeStep) return false;
    const idx = steps.findIndex((s) => s.id === activeStep.id);
    return steps.slice(idx + 1).some((s) => !seenIds.has(s.id));
  }, [activeStep, steps, seenIds]);

  const next = useCallback(() => {
    if (!activeStep) return;
    const id = activeStep.id;
    writeFlag(seenStorageKey(id));
    const remaining = steps.filter((s) => s.id !== id && !seenIds.has(s.id));
    if (remaining.length === 0) {
      // Advancing past the last step finishes the tour for good.
      endRun();
      return;
    }
    setSeenIds((prev) => {
      const set = new Set(prev);
      set.add(id);
      return set;
    });
    setActiveId(null);
    setTargetEl(null);
  }, [activeStep, steps, seenIds, endRun]);

  const dismiss = useCallback(() => {
    if (!activeStep) return;
    endRun();
  }, [activeStep, endRun]);

  const skip = useCallback(() => {
    writeFlag(COACH_DISABLED_KEY);
    setDisabled(true);
    endRun();
  }, [endRun]);

  const reset = useCallback(() => {
    clearFlag(COACH_DISABLED_KEY);
    for (const step of steps) clearFlag(seenStorageKey(step.id));
    if (surfaceId != null) {
      clearFlag(surfaceDoneKey(surfaceId));
      clearFlag(surfaceAttemptsKey(surfaceId));
    }
    runStartedRef.current = false;
    setHalted(false);
    setRunSteps(null);
    setRetired(false);
    setDisabled(false);
    setSeenIds(new Set());
    setActiveId(null);
    setTargetEl(null);
  }, [steps, surfaceId]);

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
