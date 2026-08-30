import { useCallback, useEffect, useRef, useState } from "react";

import {
  companionDragBegin,
  companionDragEnd,
  companionListening,
  companionOpenCard,
  companionOpenLink,
  companionTalk,
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
  setCompanionDrawnRect,
  companionNudgeDismiss,
  companionNudgeOpen,
  companionStop,
  getCompanionState,
  openCompanionMenu,
  subscribeCompanionState,
} from "@/domains/companion/companion-bridge";

import { readSelectedAssistantId } from "@/assistant/selected-assistant-storage";
import { isSelfHostMode } from "@/lib/self-hosted/cue-self-host";
import { useTalkRecorder } from "@/hooks/use-talk-recorder";

import { CompanionSurface, turnAnnouncement } from "./companion-surface";
import type {
  CompanionIntroBeat,
  CompanionPhase,
} from "./companion-surface";
import type { CompanionTurn } from "@vellumai/ipc-contract";

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
  /** The tail of the conversation the card is talking into. */
  turns?: CompanionTurn[];
  /** A turn is in flight right now. */
  thinking?: boolean;
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
  const [draft, setDraft] = useState<{ text: string; seq: number }>({
    text: "",
    seq: 0,
  });

  /**
   * Whose mic this is.
   *
   * The raw storage key, NOT `useActiveAssistantId()`. This is a standalone
   * route — sibling of `/assistant`, outside auth and `RootLayout` so the
   * panel loads instantly — so the lifecycle that resolves an assistant is
   * not mounted above it and the hook would throw on first render. The key is
   * written by the app in the *other* window of the same origin, which is why
   * reading it here works at all, and why the `storage` event keeps it live
   * if the owner switches assistants while the companion is up.
   *
   * **On a self-host install that key is never written, and `self` is the
   * answer.** There is one assistant and nobody ever *selects* it — the
   * lifecycle resolves it from the gateway — so the slot stays empty for ever
   * and the mic fell back to opening the voice surface on every press. That
   * fallback is what "hold to talk does nothing" actually was. `self` is not
   * a guess: it is the id this app already addresses every daemon route with
   * on a self-host install (`assistant/api.ts`, `lifecycle-service.ts`), and
   * the gateway rewrites `/v1/assistants/:id/...` to a flat daemon path, so
   * the id is the app's own name for "the instance I am talking to".
   */
  const resolveAssistantId = useCallback(
    () => readSelectedAssistantId() ?? (isSelfHostMode() ? "self" : ""),
    [],
  );
  const [assistantId, setAssistantId] = useState(resolveAssistantId);
  useEffect(() => {
    const reread = () => setAssistantId(resolveAssistantId());
    window.addEventListener("storage", reread);
    window.addEventListener("vellum:pref-changed", reread);
    return () => {
      window.removeEventListener("storage", reread);
      window.removeEventListener("vellum:pref-changed", reread);
    };
  }, [resolveAssistantId]);

  /**
   * `◎ Hold to talk`, held right here (`C2`).
   *
   * The transcript lands in the card rather than sending itself. The card has
   * two verbs — `↵` asks and `⌘↵` keeps a note — so speech that sent itself
   * would pick one for you, and the Notes ↔ Chat boundary is the stronger
   * rule: speech chooses the words, the owner still chooses what they are for.
   */
  /**
   * The phase as main last published it, readable from a callback.
   *
   * `onTranscript` fires long after the render that created it, and what it
   * has to decide — whether the card is already open — is a fact about *now*.
   */
  const phaseRef = useRef<CompanionPhase>("resting");

  const onTranscript = useCallback((text: string) => {
    // A sequence, not just the words: saying the same thing twice has to land
    // twice, and a bare string compares equal to itself.
    setDraft((current) => ({ text, seq: current.seq + 1 }));
    /**
     * Ask for the card only when there is not one already.
     *
     * `openCard` is the summon, and the summon TOGGLES — pressing it twice is
     * how you close what it opened. So calling it unconditionally after a
     * hold-to-talk started *inside* the card would close the card at the
     * moment the words arrived, throwing away the field they were going into.
     */
    if (phaseRef.current !== "typing") companionOpenCard();
  }, []);
  const talk = useTalkRecorder({ assistantId, onTranscript });

  /**
   * Report the mic to main, which owns the phase.
   *
   * `transcribing` reports as *not* listening, and that is the honest
   * reading: the mic is shut by then. The pill says what became of the words
   * through `talkError`; the ring is reserved for a microphone that is
   * actually open.
   */
  useEffect(() => {
    companionListening(talk.state === "listening");
  }, [talk.state]);

  /**
   * A failure says its piece and then gets out of the way.
   *
   * It renders on the pill, on top of the affordances — so one that never
   * expired would leave the surface with a permanent complaint where "Hold to
   * talk" used to be.
   */
  const { error: talkError, dismissError } = talk;
  useEffect(() => {
    if (!talkError) return;
    const timer = setTimeout(dismissError, 6_000);
    return () => clearTimeout(timer);
  }, [talkError, dismissError]);

  /**
   * The stops a pointer hold cannot deliver for itself.
   *
   * A press that ends because the window went away never sends its own
   * release, so without these a mic could outlive the gesture that opened it
   * — the one thing this surface may not do.
   */
  const { state: talkState, finish: finishTalk } = talk;
  useEffect(() => {
    if (talkState !== "listening") return;
    const stop = () => void finishTalk();
    const onHidden = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [talkState, finishTalk]);

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
   * Tell main whether the pointer is over anything drawn.
   *
   * This is the other half of the forwarding trick: main hands the canvas back
   * whenever this says no, which is what keeps the empty region transparent to
   * clicks meant for the app behind.
   */
  /**
   * Publish exactly what was drawn, in window coordinates.
   *
   * **Main does the hit-testing, not this page.** The page's own answer would
   * depend on `mousemove` reaching a click-through, non-activating panel, and
   * when those do not arrive the window never becomes interactive — drawn,
   * visible, and dead to every click. That is what left the introduction on
   * screen with a Next button that did nothing. Main can always read the
   * cursor; this page always knows its rectangle. So it reports the
   * rectangle.
   */
  const reportCoverage = useCallback(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    setCompanionDrawnRect({
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
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
    /**
     * The drag handle is the creature and its pill, never the controls on it.
     *
     * Every button here used to begin a drag as well as its own action, which
     * was harmless only while a click did nothing. Now that a click that never
     * moved opens the card, a press on `✎ Type` would open it twice — once
     * from the button and once from the click — and the summon toggles, so
     * two opens is a card that never appears.
     */
    if ((e.target as HTMLElement | null)?.closest("button, input, textarea")) {
      return;
    }
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
  // Keep the ref in step with every publish, so a callback firing between
  // renders reads the phase the creature is actually in.
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

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
  /**
   * Keep the reported rectangle current, whatever moved it.
   *
   * **The mount-time report is not enough, and that is what left the
   * introduction unclickable.** Main creates this window hidden and reveals it
   * only once this page says it is the companion — so at mount the window has
   * never been shown, everything lays out at 0x0, and `reportCoverage`
   * correctly declines to publish an empty rectangle. Nothing re-reported
   * afterwards, so main kept falling back to the creature's own box: the
   * creature was clickable and the card beside it was dead.
   *
   * A ResizeObserver answers every version of this — the reveal, a phase
   * changing the pill's width, a card opening — without the page having to
   * know which one happened.
   */
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => reportCoverage());
    observer.observe(el);
    return () => observer.disconnect();
  }, [reportCoverage]);

  // Every change to what is drawn moves the rectangle main is testing
  // against — a card opening, a beat advancing, a nudge retracting.
  useEffect(() => {
    reportCoverage();
  }, [
    phase,
    state.avatarBox,
    state.growth,
    state.cardGrowth,
    state.intro,
    state.caught,
    state.line,
    reportCoverage,
  ]);

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
          {...(state.turns !== undefined ? { turns: state.turns } : {})}
          {...(state.thinking !== undefined ? { thinking: state.thinking } : {})}
          onOpenLink={companionOpenLink}
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
          onType={companionOpenCard}
          draft={draft}
          {...(talk.state === "listening" ? { micOpen: true } : {})}
          {...(talk.partial ? { heard: talk.partial } : {})}
          {...(talk.state === "transcribing" ? { transcribing: true } : {})}
          {...(talk.error ? { talkError: talk.error } : {})}
          /**
           * Hold to talk, held here — unless there is no assistant to
           * transcribe for.
           *
           * That happens in a window opened before the app has ever resolved
           * one. Rather than record into nothing and fail at the end, the
           * press falls back to the voice surface, which mounts the whole
           * lifecycle and can resolve an assistant for itself. A press that
           * goes somewhere beats one that records and then apologises.
           */
          onTalkStart={
            assistantId ? () => void talk.begin() : () => void companionTalk()
          }
          {...(assistantId ? { onTalkEnd: () => void talk.finish() } : {})}
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
