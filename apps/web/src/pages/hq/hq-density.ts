/**
 * The Glance / Deck toggle — one control, top-right, remembered per device.
 *
 * HQ is one surface at two densities, so this is deliberately NOT a route: a
 * URL would make them two pages, back/forward would toggle density, and a link
 * to HQ would have to choose one. It is a per-device preference, exactly like a
 * window size, persisted in localStorage and toggled with `⌘.`.
 *
 * ## Why the focus lane lives here too
 *
 * Design's rule is that **Glance is never a dead end**: tapping any of the five
 * footer numbers opens Deck scrolled to that lane. That means "switch density"
 * and "and land on this lane" are one user action, so they are one state
 * transition — {@link setDensity} takes the lane. Splitting them would let a
 * render land between the two writes and show Deck at the top, which is the
 * dead end with an extra frame.
 *
 * The focus is consumed once ({@link useHqDensity} hands back a `clearFocus`)
 * so a later unrelated re-render cannot re-scroll the page out from under
 * someone who has started reading.
 *
 * `localStorage` is wrapped because Safari private mode throws on write; a
 * device that cannot remember the choice must still be able to make it.
 */

import { useCallback, useEffect, useState } from "react";

import type { HqLaneId } from "./hq-census";

export type HqDensity = "glance" | "deck";

/** Design's default: Glance is what you land on — the 30-second check. */
export const DEFAULT_DENSITY: HqDensity = "glance";

const STORAGE_KEY = "cue.hq.density";

function isDensity(value: unknown): value is HqDensity {
  return value === "glance" || value === "deck";
}

/** The remembered choice, or the default. Never throws. */
export function readDensity(): HqDensity {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isDensity(raw) ? raw : DEFAULT_DENSITY;
  } catch {
    return DEFAULT_DENSITY;
  }
}

function writeDensity(density: HqDensity): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, density);
  } catch {
    // Private mode. The toggle still works for this session — a device that
    // cannot remember must not be a device that cannot choose.
  }
}

/** `⌘.` on macOS, `Ctrl .` elsewhere — and never while typing. */
export function isToggleChord(e: KeyboardEvent): boolean {
  if (e.key !== "." || e.altKey || e.shiftKey) return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
    return false;
  }
  return true;
}

export interface HqDensityState {
  density: HqDensity;
  /**
   * The lane Deck should scroll to and mark, set by a Glance strip tap. Read
   * once, then cleared — see the module note.
   */
  focus: HqLaneId | null;
  setDensity: (density: HqDensity, focus?: HqLaneId) => void;
  toggle: () => void;
  clearFocus: () => void;
}

export function useHqDensity(): HqDensityState {
  // Lazy initialiser: reading localStorage during render on every pass would
  // be a synchronous storage hit per keystroke in the capture bar.
  const [density, setDensityState] = useState<HqDensity>(() => readDensity());
  const [focus, setFocus] = useState<HqLaneId | null>(null);

  const setDensity = useCallback((next: HqDensity, lane?: HqLaneId) => {
    setDensityState(next);
    writeDensity(next);
    setFocus(lane ?? null);
  }, []);

  const toggle = useCallback(() => {
    setDensityState((current) => {
      const next: HqDensity = current === "glance" ? "deck" : "glance";
      writeDensity(next);
      return next;
    });
    // A keyboard toggle is not a lane tap, so it must not inherit a stale
    // focus and scroll the reader somewhere they did not ask to go.
    setFocus(null);
  }, []);

  const clearFocus = useCallback(() => setFocus(null), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isToggleChord(e)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { density, focus, setDensity, toggle, clearFocus };
}
