/**
 * HQ first-run setup state — the localStorage progress model shared by the
 * onboarding flow (`/assistant/hq/setup`) and the HQ setup meter.
 *
 * Faithful to the Cue-HQ-Build onboarding frames:
 *  · Step 0 fork ("What's Cue for?" — Me / My work / My company, multi-select)
 *    sets the workspace-mode default and tunes every later line of copy
 *    (the R5·A4 personal fork: no company language anywhere).
 *  · The tracked steps feed the meter: mode · name · think · connect ·
 *    direction · mission ("think" only when the `onboarding-v2` flag is ON).
 *    Every one is skippable; whatever's skipped becomes the gentle,
 *    non-shaming "SETTING UP · N OF total" meter on HQ — visible until
 *    finished or dismissed ("this never nags"), hidden when all are done.
 *
 * All reads go through a cached snapshot + subscriber list so components can
 * ride `useSyncExternalStore` without re-parsing JSON per render.
 */

import { useSyncExternalStore } from "react";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import type { WorkspaceMode } from "./use-setup-data";

const STORAGE_KEY = "cue:hq-setup-progress";

/**
 * Progress-schema version. v1 (or absent) = the original five-step list
 * (mode·name·connect·direction·mission). v2 adds the optional "think" step
 * ("How Cue thinks" — Cue credits vs BYO OpenRouter key) between name and
 * connect. Old values parse unchanged (steps is a partial record, unknown
 * ids are simply absent), and `meterProgress` treats `completedAt` as
 * terminal so a user who finished onboarding on the v1 list is NEVER
 * re-gated by the meter when the list grows.
 */
const SETUP_STATE_VERSION = 2;

/** The tracked setup steps (the meter's "N OF total"). */
export type SetupStepId =
  | "mode"
  | "name"
  | "think"
  | "connect"
  | "direction"
  | "mission";

export const SETUP_STEP_IDS: SetupStepId[] = [
  "mode",
  "name",
  "think",
  "connect",
  "direction",
  "mission",
];

/** The v1 step list — what the meter tracks when `onboarding-v2` is OFF. */
export const LEGACY_SETUP_STEP_IDS: SetupStepId[] = [
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
  /**
   * Progress-schema version this value was last written with. Parsed values
   * missing the field are v1 (the pre-"think" step list). Read-only signal —
   * every mutation rewrites at the current version.
   */
  version: number;
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
  version: SETUP_STATE_VERSION,
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
      // Absent = v1 (written before the field existed). Tolerated as-is —
      // v1 values need no rewriting, only the completedAt terminal rule.
      version: typeof v.version === "number" ? v.version : 1,
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

/**
 * Drop the cached snapshot so the next read re-parses localStorage. Only
 * needed when localStorage is mutated behind the store's back (tests
 * seeding old-schema values); real writes go through `write()` and real
 * cross-tab changes arrive via the `storage` event.
 */
export function resetSetupStateCache(): void {
  cache = null;
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
  // Every write re-stamps the current schema version (an old-version value
  // being mutated is thereby migrated in place — its fields all parse).
  next = { ...next, version: SETUP_STATE_VERSION };
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
    case "think":
      return "Choose how Cue thinks";
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

export function meterProgress(
  state: SetupState,
  stepIds: SetupStepId[] = SETUP_STEP_IDS,
): MeterProgress {
  // Backward-compat rule for a grown step list: once the user has hit
  // "Enter HQ" (`completedAt` set), steps added AFTER v1 ("think") drop out
  // of the tracked list — a finished user is never re-gated by an upgrade.
  // Legacy steps they explicitly skipped keep the meter alive exactly as
  // before (the gentle, dismissible "finish when you like" behavior).
  const effective =
    state.completedAt !== null
      ? stepIds.filter((id) => LEGACY_SETUP_STEP_IDS.includes(id))
      : stepIds;
  const doneCount = effective.filter(
    (id) => state.steps[id] === "done",
  ).length;
  const next = effective.find((id) => state.steps[id] !== "done") ?? null;
  return { doneCount, total: effective.length, next };
}

// ---------------------------------------------------------------------------
// "Is this actually a first run?" — the honesty gate on the meter
// ---------------------------------------------------------------------------

/**
 * Live evidence, read from the daemon on HQ, that this account is already in
 * use. Counts are whatever the page has loaded; `hasIdentity` is true once the
 * company profile carries a name or a direction.
 */
export interface AccountUsageSignals {
  missionCount: number;
  projectCount: number;
  scheduleCount: number;
  /** Work items in any lane (inbound / running / review / done). */
  workItemCount: number;
  hasIdentity: boolean;
}

/** Any real usage at all — one mission, one project, one captured item… */
export function hasRealUsage(s: AccountUsageSignals): boolean {
  return (
    s.missionCount > 0 ||
    s.projectCount > 0 ||
    s.scheduleCount > 0 ||
    s.workItemCount > 0 ||
    s.hasIdentity
  );
}

/**
 * Whether the "SETTING UP · N OF M" meter is allowed to show.
 *
 * The progress record lives only in this browser profile's localStorage and is
 * written only by `/assistant/hq/setup`. An account that predates that flow —
 * or that reached HQ from a different browser, or from the desktop app's
 * bundled `app://` origin — therefore reads a pristine "0 of 6" no matter how
 * long it has been running missions. Nagging that user to "choose what Cue is
 * for" is the product claiming a state it cannot back up.
 *
 * So: when there is no local record that setup was ever STARTED, but the
 * account demonstrably has real work in it, stay quiet. A user who did start
 * the flow and skipped steps keeps the gentle meter — that one is theirs.
 */
export function shouldShowSetupMeter(
  state: SetupState,
  progress: MeterProgress,
  usage: AccountUsageSignals,
): boolean {
  if (state.meterDismissed) return false;
  if (progress.next === null) return false;
  if (progress.doneCount >= progress.total) return false;
  if (!state.started && hasRealUsage(usage)) return false;
  return true;
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
  /** The tracked first-run steps (6 with `onboarding-v2`, else 5). */
  total: number;
  /** First not-yet-done step id, or null when finished. */
  nextStep: SetupStepId | null;
  /** Fork-aware human label for `nextStep` (personal never hears "company"). */
  nextLabel: string | null;
}

/**
 * Whether the `onboarding-v2` assistant flag is ON — gates the "think" step,
 * the connect-tools grid, and the command-center build-out tiles. Reads the
 * live flag store (registry default `true`; a real /feature-flags response
 * can turn it off centrally).
 */
export function useOnboardingV2Enabled(): boolean {
  const enabled = useAssistantFeatureFlagStore(
    (s) => (s as Record<string, unknown>).onboardingV2,
  );
  return enabled !== false;
}

/** The tracked step list for the current flag state. */
export function useSetupStepIds(): SetupStepId[] {
  return useOnboardingV2Enabled() ? SETUP_STEP_IDS : LEGACY_SETUP_STEP_IDS;
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
  const stepIds = useSetupStepIds();
  const { doneCount, total, next } = meterProgress(state, stepIds);
  const personal = isPersonalFork(state.fork);
  return {
    done: doneCount,
    total,
    nextStep: next,
    nextLabel: next ? stepLabel(next, personal) : null,
  };
}

/**
 * Whether HQ first-run setup is complete — the gate the command-center
 * build-out tiles use ("don't fight the setup meter for attention").
 * True once the user hit "Enter HQ", or once every tracked step is done.
 */
export function useSetupComplete(): boolean {
  const state = useSetupState();
  const stepIds = useSetupStepIds();
  if (state.completedAt !== null) return true;
  const { doneCount, total } = meterProgress(state, stepIds);
  return total > 0 && doneCount >= total;
}
