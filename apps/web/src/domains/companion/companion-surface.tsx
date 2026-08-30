import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { CompanionPhase, CompanionTurn } from "@vellumai/ipc-contract";

import { renderCompanionMarkdown } from "./companion-markdown";
import { CompanionCreature, CompanionCreatureKeyframes } from "./companion-creature";
import type { CreatureTone } from "./companion-creature";

/**
 * The companion surface — design `C2`, on `C3`'s geometry.
 *
 * **One object changing shape.** The creature holds one x-position in every
 * phase and only `width` animates; the typing card is the single phase that
 * grows vertically. That is what makes this read as one creature changing
 * shape rather than several surfaces sharing a colour — and it is the property
 * to protect as phases gain content.
 *
 * **Presentational, and deliberately so.** Every phase comes from the caller,
 * including `hover`: in the real window the pointer is tracked by the main
 * process through `setIgnoreMouseEvents(true, { forward: true })`, which
 * delivers mouse-move while letting presses through to whatever is behind. A
 * surface that decided its own hover would have to claim the whole canvas to
 * find out, and a canvas many times the size of the pill claiming clicks is
 * three of upstream's five bugs.
 *
 * **Solid, not glass** (`C3`, Q3). Upstream tried and the platform refused:
 * native vibrancy fills the whole oversized canvas, and `backdrop-filter`
 * samples only what is inside the page — and the desktop is not in the page.
 * So the body is solid ink and the identity is carried by the creature and its
 * glow, not by a painted fake blur.
 */

/** The surface's own values, from the design's markup. */
const INK = "#101321";
const HAIRLINE = "1px solid rgba(255,255,255,.13)";
const PILL_SHADOW = "0 14px 34px -14px rgba(0,0,0,.55)";
const CARD_SHADOW = "0 24px 54px -20px rgba(0,0,0,.65)";
const CARD_WIDTH = 360;
/** The pill's padding at the creature's end, from the design's markup. */
const SEAT = 6;

const T1 = "#F4F4F6";
/** The standing muted-on-dark token. Never used as a background. */
const T2 = "#9A9AA8";
const ACCENT = "#3D6EE8";

export type { CompanionPhase };

/**
 * What VoiceOver says — design `C12`.
 *
 * **Turn changes only.** The creature expresses whose turn it is and leaves
 * the finer phase to the words beside it; the announcements mirror exactly
 * that, because a screen reader narrating every phase would say more about
 * Cue in one minute than the creature says all day. Phases that mean the same
 * turn announce nothing when they succeed each other.
 */
export function turnAnnouncement(phase: CompanionPhase): string | null {
  switch (phase) {
    case "working":
    case "summary":
      return "Cue is working";
    case "waiting":
    case "couldnt":
      return "Cue is waiting on you";
    case "watching":
      return "Cue is reading this window";
    case "recording":
      return "Recording";
    case "offline":
      return "Cue is offline";
    default:
      // Resting, hover, typing and listening all mean it is your turn, which
      // is what the surface already looks like. Saying so would be narration.
      return null;
  }
}

const TONE_FOR: Partial<Record<CompanionPhase, CreatureTone>> = {
  watching: "watching",
  recording: "recording",
  offline: "offline",
  couldnt: "amber",
  waiting: "amber",
  nudge: "nudge",
};

/** The four-beat introduction (`C4`), one beat at a time. */
export interface CompanionIntroBeat {
  beat: number;
  total: number;
  step: string;
  title: string;
  body: string;
  last: boolean;
}

export interface CompanionSurfaceProps {
  phase: CompanionPhase;
  /**
   * The introduction, while it is running.
   *
   * Main decides whether to offer it at all — it never covers something the
   * user is in the middle of — and owns which beat this is, so a press that
   * arrives describing a beat that has moved on is discarded rather than
   * skipping one.
   */
  intro?: CompanionIntroBeat;
  /** A drag is passing over the creature (`C10`). */
  opening?: boolean;
  /** What was caught, named exactly (`C10`). */
  caught?: { kind: string; label: string };
  onDropChoose?: (choice: "read" | "file" | "note") => void;
  /**
   * `◎ Hold to talk` on the hover pill — the press, and the release.
   *
   * Two handlers rather than one `onClick` because the label is not a
   * metaphor: the mic opens on the way down and closes on the way up, so it
   * can never outlive the finger holding it. A click-to-toggle would leave a
   * live microphone in a panel that floats over everything, which is the one
   * thing this surface may not do.
   */
  onTalkStart?: () => void;
  onTalkEnd?: () => void;
  /**
   * What has been heard so far this hold, and what became of it.
   *
   * The only thing the renderer says about itself. Main cannot know it — the
   * words exist in this window and nowhere else — but main still owns the
   * *phase*, so this is the words, never the state.
   */
  heard?: string;
  /** The words are with the model. Not a phase: the mic is already shut. */
  transcribing?: boolean;
  /** The mic could not be reached, or the words did not come through. */
  talkError?: string;
  /**
   * What a finished hold left in the composer, ready to send or keep.
   *
   * Carries a sequence rather than being a bare string so that saying the
   * same words twice still lands twice. Compared by value, a second identical
   * transcript is indistinguishable from no transcript at all — and silently
   * dropping what somebody just said is the worst failure a capture surface
   * has.
   */
  draft?: { text: string; seq: number };
  /** A mic is open right now. The card cannot read this from `phase`: the
   *  typing card outranks `listening`, so the resolved phase stays `typing`. */
  micOpen?: boolean;
  /** `✎ Type` on the hover pill — the same thing `⌥Space` does. */
  onType?: () => void;
  /** `↵` — ask Cue. Handed to the app; never answered into a thread. */
  onAsk?: (message: string) => void;
  /** `⌘↵` — keep what you typed as a note instead (`Q4`). */
  onKeepAsNote?: (note: string) => void;
  /** `esc`. Closes the card and cancels nothing. */
  onCloseCard?: () => void;
  onDropRelease?: () => void;
  onIntroNext?: (fromBeat: number) => void;
  onIntroDismiss?: () => void;
  /** The creature's box in points — the whole of the surface's scale. */
  avatarBox: number;
  /** Which way the pill unfurls. Main decides; only main knows the display. */
  growth: "right" | "left";
  /** Which way the typing card unfurls. Main decides, for the same reason. */
  cardGrowth: "up" | "down";
  /** The words beside the creature, where the finer phase lives. */
  line?: string;
  /** A second, quieter line — the consequence, or the source. */
  detail?: string;
  /**
   * The tail of the conversation, most recent last (`C2`, upstream's shape).
   *
   * The card is a glance, not a chat window — only the last few are drawn and
   * the app holds the thread — but there IS a thread, and this is what lets
   * the card carry a second exchange instead of throwing each answer into the
   * app and forgetting the question.
   */
  turns?: CompanionTurn[];
  /** A turn is in flight. The last row and an unfinished one look identical. */
  thinking?: boolean;
  /** Follow a link a turn drew. The window itself may not navigate. */
  onOpenLink?: (href: string) => void;
  /** The answer in the typing card. */
  answer?: string;
  /** Where the answer came from. An unsourced answer never renders. */
  source?: string;
  /** Character traits, composed live. */
  weight?: "fine" | "regular" | "bold";
  blink?: "calm" | "lively";
  /** Quiet hours: the creature still sits there, but it never moves first. */
  quiet?: boolean;
  /**
   * The line an ignored nudge retracted to (`C7`).
   *
   * Held on the dot until the next hover — never lost, never repeated out
   * loud.
   */
  heldNudge?: string;
  onStop?: () => void;
  onOpen?: () => void;
  onDismiss?: () => void;
  onUndo?: () => void;
}

export function CompanionSurface(props: CompanionSurfaceProps): React.ReactElement {
  const { phase, avatarBox, growth, cardGrowth, quiet = false } = props;
  const scale = avatarBox / 44;

  const creature = (
    <CompanionCreature
      box={avatarBox}
      working={phase === "working" || phase === "summary"}
      listening={phase === "listening" || phase === "recording"}
      gazing={phase === "hover"}
      tone={TONE_FOR[phase] ?? "normal"}
      weight={props.weight ?? "regular"}
      blink={props.blink ?? "calm"}
      still={quiet}
      held={props.heldNudge !== undefined && phase !== "nudge"}
      opening={props.opening ?? false}
    />
  );

  // The creature sits INSIDE the pill, not beside it. That is what makes the
  // surface one object changing shape: the body unfurls around a creature that
  // never moves, rather than a pill sliding out from under a separate disc.
  // The pill's own padding (6px at the creature's end) is why its edge sits
  // that far outside — see `SEAT`.
  const seat = SEAT * scale;

  if (props.intro) {
    return (
      <div
        style={{
          display: "inline-flex",
          flexDirection: growth === "right" ? "row" : "row-reverse",
          alignItems: cardGrowth === "up" ? "flex-end" : "flex-start",
        }}
      >
        <CompanionCreatureKeyframes />
        <div style={{ flex: "0 0 auto", padding: seat }}>{creature}</div>
        <IntroCard {...props} intro={props.intro} scale={scale} />
      </div>
    );
  }

  if (phase === "resting") {
    return (
      <div style={{ display: "inline-flex" }}>
        <CompanionCreatureKeyframes />
        {creature}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "inline-flex",
        // Reversing the row is half of growing leftward — the other half is
        // main anchoring the window by the right edge. Both halves, or the
        // creature draws where main does not believe it is (upstream
        // `db9392ef`).
        flexDirection: growth === "right" ? "row" : "row-reverse",
        alignItems:
          phase === "typing"
            ? cardGrowth === "up"
              ? "flex-end"
              : "flex-start"
            : "center",
        // Hold the creature's x: the pill's edge hangs `seat` outside it.
        marginLeft: growth === "right" ? -seat : 0,
        marginRight: growth === "left" ? -seat : 0,
        // Only width animates. Text never slides; it fades in place.
        transition: "width 240ms cubic-bezier(.22,1,.36,1)",
      }}
    >
      <CompanionCreatureKeyframes />
      {phase === "caught" && props.caught ? (
        <CaughtChip
          {...props}
          caught={props.caught}
          scale={scale}
          creature={creature}
        />
      ) : phase === "typing" ? (
        <TypingCard {...props} scale={scale} creature={creature} />
      ) : (
        <Pill {...props} scale={scale} creature={creature} />
      )}
    </div>
  );
}

/**
 * The last words of a live transcript, so a long sentence scrolls off its own
 * front instead of pushing the pill past the canvas it was sized for.
 *
 * Words, not characters: cutting mid-word reads as a rendering fault rather
 * than as speech still arriving.
 */
function tailWords(heard: string, max = 48): string {
  const text = heard.trim();
  if (text.length <= max) return text;
  const words = text.split(/\s+/);
  const kept: string[] = [];
  let length = 0;
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = words[i]!;
    if (length + word.length + 1 > max) break;
    kept.unshift(word);
    length += word.length + 1;
  }
  return kept.length ? `\u2026 ${kept.join(" ")}` : text.slice(-max);
}

/** The horizontal states: everything that is not the typing card. */
function Pill(
  props: CompanionSurfaceProps & { scale: number; creature: ReactNode },
): React.ReactElement {
  const { phase, scale, line, detail, growth, creature } = props;
  /**
   * What the mic has to say for itself, if anything.
   *
   * While it is open the pill shows the words as they arrive — and says
   * "Listening…" until the first of them lands, so the creature breathing is
   * never the only evidence that something is recording (`C11`). Afterwards
   * it says what became of them, in the same place, because the release
   * leaves the pointer exactly here and a result reported anywhere else is a
   * result nobody sees.
   *
   * Clamped, because the canvas is fixed: a long sentence must scroll off its
   * own front rather than push the pill past the edge it was sized for.
   */
  const talkNote =
    phase === "listening"
      ? props.heard
        ? tailWords(props.heard)
        : "Listening\u2026"
      : props.transcribing
        ? "Making that out\u2026"
        : props.talkError;
  const pad =
    growth === "right"
      ? `${SEAT}px ${20 * scale}px ${SEAT}px ${SEAT}px`
      : `${SEAT}px ${SEAT}px ${SEAT}px ${20 * scale}px`;

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexDirection: growth === "right" ? "row" : "row-reverse",
        gap: 12 * scale,
        background: INK,
        border: HAIRLINE,
        borderRadius: 99,
        padding: pad,
        boxShadow: PILL_SHADOW,
        // Type scales with the creature only to `large`, then caps: at huge
        // and ridiculous the creature grows but the words do not shout (C12).
        fontSize: Math.min(13 * scale, 13 * 2),
      }}
    >
      {creature}
      {/* Hover offers, unless the mic has something to report — a result the
          affordances covered would be a result nobody ever saw. */}
      {phase === "hover" && !talkNote ? (
        <HoverAffordances
          scale={scale}
          {...(props.onTalkStart ? { onTalkStart: props.onTalkStart } : {})}
          {...(props.onTalkEnd ? { onTalkEnd: props.onTalkEnd } : {})}
          {...(props.onType ? { onType: props.onType } : {})}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {talkNote ?? line ? (
            <span style={{ color: T1, whiteSpace: "nowrap" }}>
              {talkNote ?? line}
            </span>
          ) : null}
          {detail ? (
            <span style={{ color: T2, fontSize: "0.86em", whiteSpace: "nowrap" }}>
              {detail}
            </span>
          ) : null}
        </div>
      )}

      {phase === "watching" ? <ConsentLine onStop={props.onStop} /> : null}
      {phase === "recording" ? (
        <TextButton onClick={props.onStop}>Stop</TextButton>
      ) : null}
      {phase === "working" ? (
        <TextButton onClick={props.onStop}>Stop</TextButton>
      ) : null}
      {phase === "nudge" ? (
        <>
          <TextButton onClick={props.onOpen}>Open ›</TextButton>
          {/* A nudge never carries buttons that act — one line, one Open, one
              ✕. Acting needs the card or the app, so a stray click cannot
              approve anything (C7, and C9's protocol). */}
          <TextButton onClick={props.onDismiss} muted aria-label="Dismiss">
            ✕
          </TextButton>
        </>
      ) : null}
      {phase === "couldnt" ? (
        <TextButton onClick={props.onOpen}>Try again ›</TextButton>
      ) : null}
    </div>
  );
}

/**
 * What hover offers — and, until now, only *said* it offered.
 *
 * These were two `<span>`s. The pill unfurled, named two things you could do,
 * and neither was attached to anything: the window was interactive the whole
 * time and there was simply nothing behind the words. A surface that lists
 * actions it cannot perform is worse than one that lists none.
 */
function HoverAffordances({
  scale,
  onTalkStart,
  onTalkEnd,
  onType,
}: {
  scale: number;
  onTalkStart?: () => void;
  onTalkEnd?: () => void;
  onType?: () => void;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 * scale }}>
      <AffordanceButton
        {...(onTalkStart ? { onPressStart: onTalkStart } : {})}
        {...(onTalkEnd ? { onPressEnd: onTalkEnd } : {})}
      >
        ◎ Hold to talk
      </AffordanceButton>
      <AffordanceButton onClick={onType}>✎ Type</AffordanceButton>
      {/* `␣` (U+2423) is missing from several mono faces and falls back to a
          tofu box; the system UI stack has it. */}
      <span style={{ color: T2, fontSize: "0.86em", letterSpacing: ".04em" }}>
        ⌥␣
      </span>
    </div>
  );
}

/**
 * An affordance that does the thing it names. ≥44pt effective (`C12`).
 *
 * Either a press (`onClick`) or a hold (`onPressStart`/`onPressEnd`). The hold
 * captures the pointer, so a finger that wanders off the button while held
 * still delivers its release here — otherwise a drifting hand would leave the
 * mic open with nothing to close it. `onPointerCancel` covers the rest: the
 * system taking the gesture away is a release too.
 */
function AffordanceButton({
  children,
  onClick,
  onPressStart,
  onPressEnd,
}: {
  children: ReactNode;
  onClick?: () => void;
  onPressStart?: () => void;
  onPressEnd?: () => void;
}): React.ReactElement {
  const held = Boolean(onPressStart);
  return (
    <button
      type="button"
      {...(onClick ? { onClick } : {})}
      {...(held
        ? {
            onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
              // The whole surface is a drag handle; a press that starts the
              // mic must not also start walking the creature across the
              // desktop.
              event.stopPropagation();
              // **Start first, then capture.** Capture is what lets a finger
              // that drifts off the button still deliver its release here —
              // an improvement on the gesture, not a precondition for it. It
              // was called first, so anything that made it throw took the
              // whole recording with it and the press did nothing at all.
              onPressStart?.();
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // No capture: the release still arrives as this button's own
                // `pointerup`, and the blur/hide stops remain behind that.
              }
            },
            onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              onPressEnd?.();
            },
            onPointerCancel: () => onPressEnd?.(),
          }
        : {})}
      style={{
        background: "none",
        border: 0,
        font: "inherit",
        color: T1,
        whiteSpace: "nowrap",
        cursor: "pointer",
        margin: "-12px",
        padding: 12,
      }}
    >
      {children}
    </button>
  );
}

/**
 * The consent line, ours (`Q5`).
 *
 * Upstream's amber ring says *that* a capture is running. This says **what it
 * can and cannot see**, and it renders the entire time the watch is on — in
 * the product, every time, not on a privacy page.
 */
function ConsentLine({ onStop }: { onStop?: () => void }): React.ReactElement {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "#3ECF8E",
          flex: "0 0 auto",
        }}
        aria-hidden
      />
      <span style={{ color: T2, whiteSpace: "nowrap" }}>
        Reading this window only, while it&rsquo;s open
      </span>
      <TextButton onClick={onStop}>Stop</TextButton>
    </span>
  );
}

/**
 * The typing card — the only phase that grows vertically.
 *
 * The retired corner's rules migrate here intact (`Q1`): one exchange then
 * done, every answer cites its source, Undo sits next to the claim rather than
 * in a toast that expires, and "Open in Cue ›" is the handoff when something is
 * genuinely bigger. It never grows a thread.
 */
function TypingCard(
  props: CompanionSurfaceProps & { scale: number; creature: ReactNode },
): React.ReactElement {
  const { answer, source, scale, creature, growth } = props;
  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: growth === "right" ? "row" : "row-reverse",
        alignItems: "flex-end",
        gap: 0,
      }}
    >
      <div style={{ flex: "0 0 auto", padding: SEAT }}>{creature}</div>
    <div
      style={{
        width: CARD_WIDTH * Math.min(scale, 2),
        background: INK,
        border: HAIRLINE,
        borderRadius: 20,
        padding: "14px 15px",
        boxShadow: CARD_SHADOW,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {props.turns && props.turns.length > 0 ? (
        <Turns
          turns={props.turns}
          thinking={props.thinking ?? false}
          {...(props.onOpenLink ? { onOpenLink: props.onOpenLink } : {})}
        />
      ) : answer ? (
        <p style={{ margin: 0, color: T1, fontSize: 14, lineHeight: 1.5 }}>{answer}</p>
      ) : null}

      {source ? (
        <p style={{ margin: 0, color: T2, fontSize: 11.5 }}>
          {source}
          {" · "}
          <TextButton onClick={props.onOpen}>show</TextButton>
          {/* Only offered when something can actually take it back. Undo sits
              next to the claim rather than in a toast precisely so it can be
              trusted, and a trusted-looking button with nothing behind it is
              the failure this surface keeps being caught by. */}
          {props.onUndo ? (
            <>
              {" · "}
              <TextButton onClick={props.onUndo}>Undo</TextButton>
            </>
          ) : null}
        </p>
      ) : null}

      <Composer
        onAsk={props.onAsk}
        onKeepAsNote={props.onKeepAsNote}
        onClose={props.onCloseCard}
        micOpen={props.micOpen ?? false}
        transcribing={props.transcribing ?? false}
        {...(props.draft !== undefined ? { draft: props.draft } : {})}
        {...(props.onTalkStart ? { onTalkStart: props.onTalkStart } : {})}
        {...(props.onTalkEnd ? { onTalkEnd: props.onTalkEnd } : {})}
      />

      <p style={{ margin: 0, color: T2, fontSize: 11 }}>
        {/* It is not one exchange any more, and saying so was the surface
            describing a limitation rather than a rule. The handoff stays: the
            app is still where the thread lives. */}
        <TextButton onClick={props.onOpen}>Open in Cue ›</TextButton>
      </p>
    </div>
    </div>
  );
}

/**
 * The introduction's card — `C4`.
 *
 * One beat at a time, and only two actions. Every action that is not `Next`
 * or `Dismiss` is one more thing a press arriving against a stale beat could
 * do wrongly, which is the whole reason main owns the position.
 */
function IntroCard({
  intro,
  scale,
  onIntroNext,
  onIntroDismiss,
}: CompanionSurfaceProps & {
  intro: CompanionIntroBeat;
  scale: number;
}): React.ReactElement {
  return (
    <div
      style={{
        width: 268 * Math.min(scale, 2),
        background: INK,
        border: HAIRLINE,
        borderRadius: 18,
        padding: "16px 17px",
        boxShadow: CARD_SHADOW,
      }}
    >
      <div
        style={{
          fontFamily: "'DM Mono', ui-monospace, monospace",
          fontSize: 8,
          letterSpacing: ".12em",
          color: T2,
        }}
      >
        {intro.step}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 11, color: T1 }}>
        {intro.title}
      </div>
      <div
        style={{ fontSize: 12, color: T2, lineHeight: 1.55, marginTop: 9 }}
      >
        {intro.body}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 16,
          justifyContent: "flex-end",
        }}
      >
        <button
          type="button"
          onClick={onIntroDismiss}
          style={{
            font: "inherit",
            fontSize: 12,
            color: "#C9D2E2",
            background: "none",
            border: "1px solid rgba(255,255,255,.18)",
            borderRadius: 99,
            padding: "6px 16px",
            cursor: "pointer",
          }}
        >
          Dismiss
        </button>
        {/* The last beat has nothing after it, so it offers no Next. */}
        {intro.last ? null : (
          <button
            type="button"
            // The press names the beat it was made against.
            onClick={() => onIntroNext?.(intro.beat)}
            style={{
              font: "inherit",
              fontSize: 12,
              color: "#fff",
              background: ACCENT,
              border: 0,
              borderRadius: 99,
              padding: "7px 17px",
              cursor: "pointer",
            }}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * What was caught — design `C10`.
 *
 * **The chip names exactly what arrived**, so a wrong drop is obvious before
 * anything happens to it. And the three choices are read, file, note: nothing
 * here sends or spends, because `C9`'s protocol holds even for something the
 * owner put in Cue's hands themselves.
 */
function CaughtChip({
  caught,
  scale,
  creature,
  growth,
  onDropChoose,
  onDropRelease,
}: CompanionSurfaceProps & {
  caught: { kind: string; label: string };
  scale: number;
  creature: ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexDirection: growth === "right" ? "row" : "row-reverse",
        gap: 12 * scale,
        background: INK,
        border: HAIRLINE,
        borderRadius: 99,
        padding: `${SEAT}px ${8 * scale}px ${SEAT}px ${SEAT}px`,
        boxShadow: PILL_SHADOW,
        fontSize: Math.min(12.5 * scale, 12.5 * 2),
      }}
    >
      {creature}
      <span
        // Bounded, and ellipsised rather than wrapped. The canvas is fixed and
        // never resizes on a phase, so a long filename must not be able to
        // push the choices off the end of it — which is what clipped "Read it"
        // in half on a real drop. `describeDrop` already trims the name and
        // keeps the extension; this is the layout half of the same promise.
        style={{
          fontSize: "0.96em",
          color: T2,
          background: "rgba(255,255,255,.06)",
          border: "1px solid rgba(255,255,255,.11)",
          borderRadius: 8,
          padding: "5px 10px",
          whiteSpace: "nowrap",
          maxWidth: 190 * scale,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {caught.kind === "url" ? "🔗" : caught.kind === "text" ? "✎" : "📄"}{" "}
        {caught.label}
      </span>
      <span style={{ color: T1, whiteSpace: "nowrap" }}>Got it —</span>
      <ChoiceButton onClick={() => onDropChoose?.("read")}>Read it</ChoiceButton>
      <ChoiceButton onClick={() => onDropChoose?.("file")}>
        ▤ File it
      </ChoiceButton>
      <ChoiceButton onClick={() => onDropChoose?.("note")}>✎ Note</ChoiceButton>
      {/* Nothing has been stored, so this is not a delete — it is letting go,
          which is also what ten seconds of silence does. */}
      <TextButton onClick={onDropRelease} muted aria-label="Let it go">
        ✕
      </TextButton>
    </div>
  );
}

/**
 * The exchange so far, most recent last.
 *
 * Scrolls rather than grows past `TURNS_MAX_HEIGHT`: the card is still a card,
 * and a surface that grew with every reply would run off the top of the
 * display. Pinned to the bottom, because the newest turn is the one being
 * read.
 */
const TURNS_MAX_HEIGHT = 220;

function Turns({
  turns,
  thinking,
  onOpenLink,
}: {
  turns: CompanionTurn[];
  thinking: boolean;
  onOpenLink?: (href: string) => void;
}): React.ReactElement {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setScrolled(el.scrollTop > 0);
  }, [turns, thinking]);

  return (
    <div style={{ position: "relative" }}>
      {/* There is more above, and the card says so.
          Pinned to the newest turn, the one before it is cut by the top edge —
          which reads as a message that broke rather than a conversation that
          continues. A fade is the difference between the two. */}
      {scrolled ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 18,
            background: `linear-gradient(${INK}, transparent)`,
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
      ) : null}
      <div
        ref={scroller}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        style={{
          maxHeight: TURNS_MAX_HEIGHT,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {turns.map((turn, i) => (
          <p
            key={`${turn.role}-${i}`}
            style={{
              margin: 0,
              fontSize: 13,
              lineHeight: 1.5,
              // Yours is quieter and indented; Cue's is the thing being read.
              color: turn.role === "user" ? T2 : T1,
              paddingLeft: turn.role === "user" ? 14 : 0,
            }}
          >
            {renderCompanionMarkdown(turn.text, onOpenLink)}
          </p>
        ))}
        {thinking ? <Working /> : null}
      </div>
    </div>
  );
}

/**
 * That Cue is working on it — said, not implied.
 *
 * It was a bare `…`, which is indistinguishable from an answer that trailed
 * off: you ask, the card shows three dots, and nothing tells you whether it is
 * composing or has already finished badly. The creature cannot help here —
 * the typing card outranks every phase that would have animated it — so this
 * row is the only thing that can say it.
 */
function Working(): React.ReactElement {
  return (
    <p
      style={{
        margin: 0,
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        fontSize: 12.5,
        color: T2,
      }}
      aria-live="polite"
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: ACCENT,
          animation: "cue-companion-working 1200ms ease-in-out infinite",
          flex: "0 0 auto",
        }}
        aria-hidden
      />
      Working on it…
    </p>
  );
}

/**
 * The card's composer — `C2`, and the corner's two verbs kept intact (`Q1`).
 *
 * `↵` asks and `⌘↵` keeps it as a note; `esc` closes and cancels nothing,
 * because dismissing a surface must never be a way to lose work that is
 * already running. Both verbs hand off to the app rather than acting here —
 * a card that acted would need somewhere to report, and somewhere to report
 * is a thread.
 */
function Composer({
  onAsk,
  onKeepAsNote,
  onClose,
  draft,
  micOpen = false,
  transcribing = false,
  onTalkStart,
  onTalkEnd,
}: {
  onAsk?: (message: string) => void;
  onKeepAsNote?: (note: string) => void;
  onClose?: () => void;
  /**
   * What a finished hold-to-talk left here.
   *
   * Speech chooses the words; it does not choose what they are for. The card
   * has two verbs — `↵` asks and `⌘↵` keeps a note — so a transcript that
   * sent itself would pick one for you, and the Notes ↔ Chat boundary is the
   * stronger rule.
   */
  draft?: { text: string; seq: number };
  micOpen?: boolean;
  transcribing?: boolean;
  onTalkStart?: () => void;
  onTalkEnd?: () => void;
}): React.ReactElement {
  const [text, setText] = useState(draft?.text ?? "");
  // A later hold appends to whatever is already here rather than replacing
  // it, so a second sentence extends the first instead of eating it. Keyed on
  // the sequence, not the words: saying the same thing twice must land twice.
  const seenSeq = useRef(draft?.seq ?? 0);
  useEffect(() => {
    if (!draft || draft.seq === seenSeq.current) return;
    seenSeq.current = draft.seq;
    const spoken = draft.text;
    if (spoken) {
      setText((current) => (current ? `${current} ${spoken}` : spoken));
    }
  }, [draft]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "rgba(255,255,255,.05)",
        border: HAIRLINE,
        borderRadius: 12,
        padding: "9px 10px",
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose?.();
            return;
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
          const body = text.trim();
          if (!body) return;
          if (e.metaKey || e.ctrlKey) onKeepAsNote?.(body);
          else onAsk?.(body);
          setText("");
        }}
        placeholder={
          micOpen
            ? "Listening\u2026"
            : transcribing
              ? "Making that out\u2026"
              : "Reply, speak, or \u2318\u21B5 to keep as a note\u2026"
        }
        aria-label="Ask Cue"
        autoFocus
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: 0,
          outline: "none",
          color: T1,
          font: "inherit",
          fontSize: 13,
        }}
      />
      {/* The mic, in the card as well as on the pill.
          The pill's affordance vanishes the moment the card opens — it is
          replaced by the card — so without this one, opening the card to type
          was also the act of giving up on speaking. Same hold, same recorder,
          and the words land in this field rather than sending themselves:
          the card has two verbs and speech does not get to pick one. */}
      {onTalkStart ? (
        <button
          type="button"
          onPointerDown={(event) => {
            event.preventDefault();
            // Start first, then capture — see `AffordanceButton`. A capture
            // that throws must never be able to swallow the recording.
            onTalkStart();
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // No capture; this button still receives its own `pointerup`.
            }
          }}
          onPointerUp={() => onTalkEnd?.()}
          onPointerCancel={() => onTalkEnd?.()}
          aria-label={micOpen ? "Release to stop" : "Hold to talk"}
          aria-pressed={micOpen}
          title="Hold to talk"
          style={{
            width: 24,
            height: 24,
            borderRadius: "50%",
            // Lit while a mic is open — the only evidence, in this phase, that
            // something is recording (`C11`): the typing card outranks
            // `listening`, so the creature does not change.
            background: micOpen ? "#E5484D" : "rgba(255,255,255,.08)",
            color: micOpen ? "#fff" : T2,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            flex: "0 0 auto",
            border: 0,
            cursor: "pointer",
          }}
        >
          ◎
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => {
          const body = text.trim();
          if (!body) return;
          onAsk?.(body);
          setText("");
        }}
        aria-label="Send"
        style={{
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: ACCENT,
          color: "#fff",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          flex: "0 0 auto",
          border: 0,
          cursor: "pointer",
        }}
      >
        ↑
      </button>
    </div>
  );
}

function ChoiceButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        font: "inherit",
        fontSize: "0.92em",
        color: "#C9D2E2",
        background: "none",
        border: "1px solid rgba(255,255,255,.16)",
        borderRadius: 99,
        padding: "5px 11px",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function TextButton({
  children,
  onClick,
  muted = false,
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  muted?: boolean;
} & Record<string, unknown>): React.ReactElement {
  const style: CSSProperties = {
    background: "none",
    border: 0,
    padding: 0,
    // ≥44pt effective target, bought with invisible padding rather than a
    // bigger glyph (C12).
    margin: "-12px",
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 12,
    paddingBottom: 12,
    color: muted ? T2 : ACCENT,
    font: "inherit",
    cursor: "pointer",
  };
  return (
    <button type="button" onClick={onClick} style={style} {...rest}>
      {children}
    </button>
  );
}
