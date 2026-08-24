import { useCallback, useEffect, useRef, useState } from "react";

import {
  companionOpenCue,
  companionTalk,
  getCompanionStatus,
  subscribeCompanionStatus,
  type AssistantStatus,
} from "@/domains/companion/companion-bridge";

import { CompanionSurface, outrank } from "./companion-surface";
import type { CompanionPhase } from "./companion-surface";

/**
 * The always-on companion, rendered inside its Electron canvas.
 *
 * Design `C1`–`C3`. The page's whole job is to draw the phase main gives it and
 * report back what the pointer is over; it decides almost nothing itself, and
 * that is deliberate:
 *
 *   · **Hover comes from main.** The window forwards mouse-move while letting
 *     presses through (`setIgnoreMouseEvents(true, {forward:true})`), so main
 *     knows where the pointer is without the window having claimed the canvas.
 *     A renderer that decided its own hover would have to claim all of it to
 *     find out, and that is how three of upstream's five bugs stole clicks
 *     from other applications.
 *   · **Growth and card-growth come from main.** Only main knows which display
 *     the creature is parked on, and therefore which way it has room to unfurl.
 *   · **The size comes from main**, as one number: everything the surface draws
 *     derives from the creature's box, so the two processes never hold two
 *     copies of a scale.
 *
 * The canvas itself is transparent and the surface is anchored to the near
 * edge — the cross-process constant `COMPANION_NEAR_EDGE`. Main places the
 * window by it and this anchors by it, so the creature lands exactly where
 * main believes it is.
 */

/** Kept in step with `companion-geometry.ts`. See that file for why. */
const BASE_AVATAR_BOX = 44;
const BASE_CANVAS_PAD = 24;
const NEAR_EDGE = BASE_AVATAR_BOX / 2 + BASE_CANVAS_PAD;

interface CompanionState {
  phase: CompanionPhase;
  avatarBox: number;
  growth: "right" | "left";
  cardGrowth: "up" | "down";
  line?: string;
  detail?: string;
  answer?: string;
  source?: string;
  quiet?: boolean;
}

const RESTING: CompanionState = {
  phase: "resting",
  avatarBox: 66,
  growth: "right",
  cardGrowth: "up",
};

export function CompanionPage(): React.ReactElement {
  const [state, setState] = useState<CompanionState>(RESTING);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  // Main publishes every phase change; the renderer never invents one.
  useEffect(() => {
    const api = window.vellum?.companion;
    if (!api?.onState) return;
    return api.onState((next) => {
      setState((prev) => ({ ...prev, ...(next as Partial<CompanionState>) }));
    });
  }, []);

  useEffect(() => {
    void getCompanionStatus().then((s) => s && setStatus(s));
    return subscribeCompanionStatus((s) => setStatus(s));
  }, []);

  /**
   * Tell main whether the pointer is over anything drawn.
   *
   * This is the other half of the forwarding trick: main hands the canvas back
   * whenever this says no, which is what keeps the empty region transparent to
   * clicks meant for the app behind.
   */
  const report = useCallback((over: boolean) => {
    window.vellum?.companion?.setPointerOver?.(over);
  }, []);

  // A phase change can take the drawn area out from under a stationary
  // pointer — no mouse-move follows, so nothing recomputes on its own. Report
  // again on every phase so main can re-decide. Upstream shipped this leak.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    report(r.width > 0 && r.height > 0 && state.phase !== "resting");
  }, [state.phase, report]);

  const busy = status === "thinking";
  const phase = busy ? outrank(state.phase, "working") : state.phase;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // The canvas is transparent; only the surface paints. A background
        // here would be a rectangle across the desktop.
        background: "transparent",
        // Anchored by the cross-process constant, on the near edge for each
        // growth direction — the asymmetry is what lets the creature reach the
        // top of the screen (see `companion-geometry.ts`).
        display: "flex",
        alignItems: state.cardGrowth === "up" ? "flex-end" : "flex-start",
        justifyContent: state.growth === "right" ? "flex-start" : "flex-end",
        padding: NEAR_EDGE - state.avatarBox / 2,
        overflow: "hidden",
      }}
    >
      <div
        ref={surfaceRef}
        onMouseEnter={() => report(true)}
        onMouseLeave={() => report(false)}
        // The creature is the drag handle; main ends the drag on a global
        // mouse-up, never on one this page has to receive.
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <CompanionSurface
          phase={phase}
          avatarBox={state.avatarBox}
          growth={state.growth}
          cardGrowth={state.cardGrowth}
          {...(state.line !== undefined ? { line: state.line } : {})}
          {...(state.detail !== undefined ? { detail: state.detail } : {})}
          {...(state.answer !== undefined ? { answer: state.answer } : {})}
          {...(state.source !== undefined ? { source: state.source } : {})}
          {...(state.quiet !== undefined ? { quiet: state.quiet } : {})}
          onOpen={() => void companionOpenCue()}
          onStop={() => void companionTalk()}
        />
      </div>
    </div>
  );
}
