/**
 * Mv3 entrance guard — makes the staggered entrances (rise / fade / sheet-in /
 * pop) fail SAFE instead of fail INVISIBLE.
 *
 * Root cause (QA night 2026-07-19, P1-1): every mv3 entrance uses
 * `animation-fill-mode: both` with a stagger delay, so an element rests at the
 * 0% keyframe (opacity 0) until the animation actually starts. A CSS animation
 * only receives its start time on the next RENDERING FRAME — and if the
 * document isn't producing frames when the element mounts (backgrounded /
 * occluded WKWebView, hidden tab, embedded webview panes, a stalled main
 * thread), the animation sits play-pending forever: the data is in the DOM at
 * opacity 0 and the surface looks blank/hung for 5–15s+.
 *
 * The guard: watch for newly-mounted mv3 entrance animations and, ~300ms after
 * the DOM settles, snap any animation that STILL never started (startTime ===
 * null while "running" — i.e. play-pending) straight to its finished, resting
 * state. On a healthy frame-producing device an entrance gets its start time
 * within one frame (~16ms), so the sweep finds nothing and the designed
 * stagger plays untouched; only the pathological stuck case is short-circuited
 * so content is visible ≤300ms after it lands.
 *
 * Installed once per document (ref-counted) via {@link useMv3EntranceGuard} —
 * AuroraBackdrop (every mv3 screen) and SheetShell (every mv3 sheet) mount it.
 */
import { useEffect } from "react";

/** The finite mv3 entrance keyframes (never touch the infinite loops). */
const ENTRANCE_NAMES = new Set(["mv3Rise", "mv3Fade", "mv3SheetIn", "mv3Pop"]);

/** How long after the last DOM change a pending entrance may stay hidden. */
const SETTLE_MS = 300;

/** Minimum currentTime progress between sweeps for a "live" animation (ms). */
const MIN_PROGRESS_MS = 40;

let refs = 0;
let observer: MutationObserver | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** currentTime seen at the previous sweep — stall detection (strike two). */
let lastSeen = new WeakMap<Animation, number>();

function finishQuietly(anim: Animation): void {
  try {
    anim.finish();
  } catch {
    // Detached target or non-finite effect — leave it be.
  }
}

function sweep(): void {
  if (typeof document.getAnimations !== "function") return;
  let stillRunning = false;
  for (const anim of document.getAnimations()) {
    const name = (anim as CSSAnimation).animationName;
    if (typeof name !== "string" || !ENTRANCE_NAMES.has(name)) continue;
    if (anim.playState !== "running") continue;
    // Stuck mode 1 — play-pending: never granted a start time by a rendering
    // frame. A healthy entrance leaves this state within one frame of mount.
    if (anim.startTime === null) {
      finishQuietly(anim);
      continue;
    }
    // Stuck mode 2 — frozen timeline: the animation started on a lone frame
    // (e.g. the navigation paint) and the document timeline then stopped
    // advancing, holding the 0% opacity-0 fill through the delay. A healthy
    // running entrance advances its currentTime between two sweeps ≥300ms
    // apart (currentTime ticks through the delay phase too).
    const cur = typeof anim.currentTime === "number" ? anim.currentTime : null;
    if (cur != null) {
      const prev = lastSeen.get(anim);
      if (prev != null && cur - prev < MIN_PROGRESS_MS) {
        finishQuietly(anim);
        continue;
      }
      lastSeen.set(anim, cur);
    }
    stillRunning = true;
  }
  // Re-check while entrances are in flight so a mid-flight freeze (no further
  // DOM mutations to re-trigger us) still gets its second strike.
  if (stillRunning) schedule();
}

function schedule(): void {
  if (timer != null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    sweep();
  }, SETTLE_MS);
}

function start(): void {
  observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", schedule);
  schedule();
}

function stop(): void {
  observer?.disconnect();
  observer = null;
  document.removeEventListener("visibilitychange", schedule);
  if (timer != null) clearTimeout(timer);
  timer = null;
  lastSeen = new WeakMap();
}

/**
 * Keep the document-wide entrance guard alive while any mv3 surface is
 * mounted. Idempotent across instances (single shared observer).
 */
export function useMv3EntranceGuard(): void {
  useEffect(() => {
    refs += 1;
    if (refs === 1) start();
    return () => {
      refs -= 1;
      if (refs === 0) stop();
    };
  }, []);
}
