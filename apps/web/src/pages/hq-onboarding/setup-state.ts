/**
 * HQ first-run setup state — the localStorage progress model shared by the
 * onboarding flow (`/assistant/hq/setup`) and the HQ setup meter.
 *
 * Faithful to the Cue-HQ-Build onboarding frames:
 *  · Step 0 fork ("What's Cue for?" — Me / My work / My company, multi-select)
 *    sets the workspace-mode default and tunes every later line of copy
 *    (the R5·A4 personal fork: no company language anywhere).
 *  · Five tracked steps feed the meter: mode · name · connect · direction ·
 *    mission. Every one is skippable; whatever's skipped becomes the gentle,
 *    non-shaming "SETTING UP · N OF 5" meter on HQ — visible until finished
 *    or dismissed ("this never nags"), hidden the moment all five are done.
 *
 * All reads go through a cached snapshot + subscriber list so components can
 * ride `useSyncExternalStore` without re-parsing JSON per render.
 */

import { useSyncExternalStore } from "react";

import type { WorkspaceMode } from "./use-setup-data";

const STORAGE_KEY = "cue:hq-setup-progress";

/** The five tracked setup steps (the meter's "N OF 5"). */
export type SetupStepId = "mode" | "name" | "connect" | "direction" | "mission";

export const SETUP_STEP_IDS: SetupStepId[] = [
  "mode",
  "name",
  "connect",
  "direction",
  "mission",
];

export type StepOutcome = "done" | "skipped";

/** Step-0 multi-select — which worlds Cue is for. */
export interface ForkSelection {
  me: boolean;
  work: boolean;
  company: boolean;
}

export interface SetupState {
  /** Set the first time the flow opens — gates the never-onboarded auto-show. */
  started: boolean;
  steps: Partial<Record<SetupStepId, StepOutcome>>;
  fork: ForkSelection | null;
  /** The × on the meter — dismissal is forever ("this never nags"). */
  meterDismissed: boolean;
  /** Epoch ms when the user hit "Enter HQ" on the final screen. */
  completedAt: number | null;
}

const EMPTY_STATE: SetupState = {
  started: false,
  steps: {},
  fork: null,
  meterDismissed: false,
  completedAt: null,
};

// ---------------------------------------------------------------------------
// Store plumbing — cached snapshot + subscribers (same-tab writes notify
// immediately; the `storage` event covers other tabs).
// ---------------------------------------------------------------------------

let cache: SetupState | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null): SetupState {
  if (!raw) return EMPTY_STATE;
  try {
    const v = JSON.parse(raw) as Partial<SetupState>;
    return {
      started: v.started === true,
      steps: typeof v.steps === "object" && v.steps !== null ? v.steps : {},
      fork:
        typeof v.fork === "object" && v.fork !== null
          ? {
              me: v.fork.me === true,
              work: v.fork.work === true,
              company: v.fork.company === true,
            }
          : null,
      meterDismissed: v.meterDismissed === true,
      completedAt: typeof v.completedAt === "number" ? v.completedAt : null,
    };
  } catch {
    return EMPTY_STATE;
  }
}

export function readSetupState(): SetupState {
  if (cache === null) {
    try {
      cache = parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null);
    } catch {
      cache = EMPTY_STATE;
    }
  }
  return cache;
}

function write(next: SetupState): void {
  cache = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private-mode storage failures degrade to per-session progress.
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cache = null;
      fn();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

/** Live setup state — updates on any same-tab write or cross-tab change. */
export function useSetupState(): SetupState {
  return useSyncExternalStore(subscribe, readSetupState, readSetupState);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function markSetupStarted(): void {
  const s = readSetupState();
  if (!s.started) write({ ...s, started: true });
}

export function markStep(id: SetupStepId, outcome: StepOutcome): void {
  const s = readSetupState();
  // "done" always wins — finishing a previously-skipped step upgrades it.
  if (s.steps[id] === "done" && outcome === "skipped") return;
  write({ ...s, steps: { ...s.steps, [id]: outcome } });
}

export function setFork(fork: ForkSelection): void {
  write({ ...readSetupState(), fork });
}

export function dismissMeter(): void {
  write({ ...readSetupState(), meterDismissed: true });
}

export function markSetupCompleted(now: number): void {
  const s = readSetupState();
  write({ ...s, completedAt: s.completedAt ?? now });
}

// ---------------------------------------------------------------------------
// Derivations — fork → mode + copy variant, meter progress
// ---------------------------------------------------------------------------

/** The R5·A4 personal fork: the user picked ONLY "Me" at Step 0. */
export function isPersonalFork(fork: ForkSelection | null): boolean {
  return fork != null && fork.me && !fork.work && !fork.company;
}

/**
 * Step-0 → workspace-mode default (per the design's mapping line, e.g.
 * "Sets your default mode: Assist + Autonomous"): Me → Observe,
 * My work → Assist, My company → Autonomous. The single stored mode is the
 * widest leash selected.
 */
export function modeForFork(fork: ForkSelection): WorkspaceMode {
  if (fork.company) return "autonomous";
  if (fork.work) return "assist";
  return "observe";
}

/** "Observe + Assist"-style caption for the step-0 footer line. */
export function modeCaption(fork: ForkSelection): string {
  const parts: string[] = [];
  if (fork.me) parts.push("Observe");
  if (fork.work) parts.push("Assist");
  if (fork.company) parts.push("Autonomous");
  return parts.join(" + ");
}

/** Meter labels per step — tuned by fork (personal never hears "company"). */
export function stepLabel(id: SetupStepId, personal: boolean): string {
  switch (id) {
    case "mode":
      return "Choose what Cue is for";
    case "name":
      return personal ? "Name your space" : "Name your HQ";
    case "connect":
      return personal ? "Connect your world" : "Connect where work flows";
    case "direction":
      return personal ? "Tell Cue about you" : "Give Cue your direction";
    case "mission":
      return personal ? "Give Cue its first thing" : "Start your first mission";
  }
}

export interface MeterProgress {
  doneCount: number;
  total: number;
  /** First step that isn't done yet (skipped steps still count as open). */
  next: SetupStepId | null;
}

export function meterProgress(state: SetupState): MeterProgress {
  const doneCount = SETUP_STEP_IDS.filter(
    (id) => state.steps[id] === "done",
  ).length;
  const next = SETUP_STEP_IDS.find((id) => state.steps[id] !== "done") ?? null;
  return { doneCount, total: SETUP_STEP_IDS.length, next };
}

// ---------------------------------------------------------------------------
// Public meter contract — the tiny hook the HQ setup meter consumes.
// ---------------------------------------------------------------------------

/**
 * The shape the HQ "SETTING UP · N OF 5" meter reads. `nextStep`/`nextLabel`
 * are null once every tracked step is done (the meter then hides itself).
 */
export interface SetupProgress {
  /** Steps completed (skipped steps do NOT count as done). */
  done: number;
  /** Always 5 — the tracked first-run steps. */
  total: number;
  /** First not-yet-done step id, or null when finished. */
  nextStep: SetupStepId | null;
  /** Fork-aware human label for `nextStep` (personal never hears "company"). */
  nextLabel: string | null;
}

/**
 * `useSetupProgress()` — live first-run progress for the HQ setup meter.
 *
 * Reads the same `cue:hq-setup-progress` localStorage the onboarding flow
 * writes, so the meter on HQ updates the instant a step is finished (same tab)
 * or when another tab advances it. Returns `{ done, total, nextStep, nextLabel }`.
 * The consuming meter decides visibility (hide when `done === total`, or when
 * the user has dismissed it — read `meterDismissed` via `readSetupState()` if
 * that gate is wanted).
 */
export function useSetupProgress(): SetupProgress {
  const state = useSetupState();
  const { doneCount, total, next } = meterProgress(state);
  const personal = isPersonalFork(state.fork);
  return {
    done: doneCount,
    total,
    nextStep: next,
    nextLabel: next ? stepLabel(next, personal) : null,
  };
}
