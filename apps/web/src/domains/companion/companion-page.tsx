import { useCallback, useEffect, useRef, useState } from "react";

import {
  companionDragBegin,
  companionDragEnd,
  companionOpenCue,
  companionIntroDismiss,
  companionIntroNext,
  companionAsk,
  companionCloseCard,
  companionDragOver,
  companionDrop,
  companionDropChoose,
  companionDropRelease,
  companionKeepAsNote,
  companionReady,
  companionNudgeDismiss,
  companionNudgeOpen,
  companionStop,
  getCompanionState,
  openCompanionMenu,
  setCompanionPointerOver,
  subscribeCompanionState,
} from "@/domains/companion/companion-bridge";

import { CompanionSurface, turnAnnouncement } from "./companion-surface";
import type {
  CompanionIntroBeat,
  CompanionPhase,
} from "./companion-surface";

/**
 * The always-on companion, rendered inside its Electron canvas.
 *
 * Design `C1`–`C3`. The page's whole job is to draw what main gives it and
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
 *   · **The drag is main's too.** This page reports the press and the release;
 *     every coordinate in between is read from the cursor by main, because a
 *     window moved one IPC message at a time cannot keep up with a fast hand,
 *     and a page that chases its own stale coordinates is upstream's
 *     `56405459`.
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
  /** A drag is passing over the creature (`C10`). */
  opening?: boolean;
  /** What was caught, named exactly (`C10`). */
  caught?: { kind: string; label: string };
  /** An ignored nudge, held on the dot until the next hover (`C7`). */
  heldNudge?: string;
  /** The introduction, while main is offering it (`C4`). */
  intro?: CompanionIntroBeat;
  /** Character, composed live (`C5`). */
  blink?: "calm" | "lively";
  weight?: "fine" | "regular" | "bold";
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

/**
 * What was actually dropped.
 *
 * Files first, then a URL, then plain text — the order matters because a file
 * drag from Finder also carries a `text/uri-list`, and describing a contract
 * as a `file://` URL would name it wrongly on a surface whose whole promise is
 * that the chip names exactly what arrived.
 */
function describeDropped(
  data: DataTransfer | null,
): { kind: "file" | "image" | "url" | "text"; value: string } | null {
  if (!data) return null;
  const file = data.files?.[0];
  if (file) {
    // Electron exposes the real path; a browser does not, and there the name
    // is still the honest thing to show.
    const path = (file as File & { path?: string }).path ?? file.name;
    return {
      kind: file.type.startsWith("image/") ? "image" : "file",
      value: path,
    };
  }
  const uri = data.getData("text/uri-list").trim();
  if (uri) return { kind: "url", value: uri.split("\n")[0] ?? uri };
  const text = data.getData("text/plain").trim();
  if (text) {
    return /^https?:\/\//.test(text)
      ? { kind: "url", value: text }
      : { kind: "text", value: text };
  }
  return null;
}

export function CompanionPage(): React.ReactElement {
  const [state, setState] = useState<CompanionState>(RESTING);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  // Main publishes every change; the renderer never invents one. The one-shot
  // pull is for a cold window whose route chunk was still loading when main
  // first published — without it the creature would draw at its default size
  // until something happened to change.
  // Only this page sends it, which is exactly what makes it a useful answer:
  // a redirected route never mounts this component, so main never shows the
  // window.
  useEffect(() => {
    companionReady();
  }, []);

  useEffect(() => {
    // **Replace, never merge.** Main builds the whole payload every time, and
    // most of it is optional: `line`, `detail`, `intro`, `answer` are absent
    // from every publish that does not need them. Merging would keep the last
    // value of each forever — an answer that outlives its question, an
    // introduction that never goes away.
    void getCompanionState().then((next) => {
      if (next) setState(next as CompanionState);
    });
    return subscribeCompanionState((next) => {
      setState(next as CompanionState);
    });
  }, []);

  /**
   * Where the pointer is, as of the last move the canvas received.
   *
   * The canvas gets mouse-move for free — that is the whole point of
   * `{forward:true}` — so the page can answer "is the pointer over anything
   * drawn?" from geometry rather than from the browser's own enter/leave
   * bookkeeping. Which matters, because enter/leave is exactly what stops
   * arriving when the drawn area changes under a hand that is not moving.
   */
  const pointer = useRef<{ x: number; y: number } | null>(null);

  /**
   * Tell main whether the pointer is over anything drawn.
   *
   * This is the other half of the forwarding trick: main hands the canvas back
   * whenever this says no, which is what keeps the empty region transparent to
   * clicks meant for the app behind.
   */
  const reportCoverage = useCallback(() => {
    const el = surfaceRef.current;
    const at = pointer.current;
    if (!el || !at) {
      setCompanionPointerOver(false);
      return;
    }
    const r = el.getBoundingClientRect();
    setCompanionPointerOver(
      r.width > 0 &&
        r.height > 0 &&
        at.x >= r.left &&
        at.x <= r.right &&
        at.y >= r.top &&
        at.y <= r.bottom,
    );
  }, []);

  /**
   * Hold the pointer for the whole press.
   *
   * Capture is what makes the release reportable no matter where the hand
   * ends up: the button routinely comes up over another application, because
   * a fast drag outruns a window moved one IPC message at a time, and without
   * capture that `pointerup` is delivered to that application instead of here.
   * The press would then never end — and an unended press leaves the window
   * claiming a canvas many times the size of the creature.
   */
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    companionDragBegin();
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    companionDragEnd();
  }, []);

  // Losing the capture at all — the OS taking it back, the window going away
  // under the hand — has to end the press too, for the same reason.
  const onLostCapture = useCallback(() => {
    companionDragEnd();
  }, []);

  // Main resolves the phase, including hover and whether a run is in
  // progress. The page used to outrank a pushed phase against its own copy of
  // the status, which is two sources of truth for one question — and the one
  // that loses is whichever the user is actually looking at.
  const { phase } = state;

  /**
   * What a screen reader hears — `C12`.
   *
   * Turn changes only, and a nudge's one line once. Held in state rather than
   * derived inline so an unchanged turn re-rendering does not re-announce: an
   * aria-live region repeats whatever it is given, including the same
   * sentence twice.
   */
  const [announced, setAnnounced] = useState("");
  const lastSaid = useRef<string | null>(null);
  useEffect(() => {
    const say =
      phase === "nudge" ? (state.line ?? null) : turnAnnouncement(phase);
    if (say === null || say === lastSaid.current) return;
    lastSaid.current = say;
    setAnnounced(say);
  }, [phase, state.line]);

  // A phase change can take the drawn area out from under a stationary
  // pointer — the pill collapses, a card is dismissed — and no mouse-move
  // follows, so nothing recomputes on its own. The window would go on
  // claiming a canvas many times the size of the creature, swallowing presses
  // meant for whatever is behind it, until the user happened to move the
  // mouse. Upstream shipped this leak (`64e3eead`); re-testing on every drawn
  // phase is what closes it.
  useEffect(() => {
    reportCoverage();
  }, [phase, state.avatarBox, state.growth, reportCoverage]);

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
      // The canvas receives moves without having claimed anything; that is
      // what `{forward:true}` buys, and it is the only reason the page can
      // answer this question at all.
      onMouseMove={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY };
        reportCoverage();
      }}
      onMouseLeave={() => {
        pointer.current = null;
        setCompanionPointerOver(false);
      }}
      /**
       * Drops — `C10`.
       *
       * On the canvas rather than on the creature, because a drag has to be
       * seen approaching before it can be aimed: the arc opens while the item
       * is still in the air. `preventDefault` on drag-over is what makes this
       * a drop target at all.
       */
      onDragOver={(e) => {
        e.preventDefault();
        companionDragOver(true);
      }}
      onDragLeave={() => companionDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        companionDragOver(false);
        const dropped = describeDropped(e.dataTransfer);
        if (dropped) companionDrop(dropped);
      }}
    >
      <span
        // Polite: the creature never interrupts, and neither does its voice.
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {announced}
      </span>
      <div
        ref={surfaceRef}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onLostPointerCapture={onLostCapture}
        // The whole settings surface is one right-click away (`C5`) — which
        // is also the rule that keeps "Hide" easy to find.
        onContextMenu={(e) => {
          e.preventDefault();
          openCompanionMenu();
        }}
        data-companion-handle
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
          {...(state.blink !== undefined ? { blink: state.blink } : {})}
          {...(state.weight !== undefined ? { weight: state.weight } : {})}
          {...(state.intro !== undefined ? { intro: state.intro } : {})}
          {...(state.heldNudge !== undefined
            ? { heldNudge: state.heldNudge }
            : {})}
          {...(state.opening !== undefined ? { opening: state.opening } : {})}
          {...(state.caught !== undefined ? { caught: state.caught } : {})}
          onDropChoose={companionDropChoose}
          onDropRelease={companionDropRelease}
          onAsk={companionAsk}
          onKeepAsNote={companionKeepAsNote}
          onCloseCard={companionCloseCard}
          onIntroNext={companionIntroNext}
          onIntroDismiss={companionIntroDismiss}
          onOpen={() =>
            phase === "nudge" ? companionNudgeOpen() : void companionOpenCue()
          }
          onDismiss={companionNudgeDismiss}
          onStop={companionStop}
        />
      </div>
    </div>
  );
}
