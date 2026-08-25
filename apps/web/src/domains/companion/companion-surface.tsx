import { useState, type CSSProperties, type ReactNode } from "react";

import type { CompanionPhase } from "@vellumai/ipc-contract";

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

/** The horizontal states: everything that is not the typing card. */
function Pill(
  props: CompanionSurfaceProps & { scale: number; creature: ReactNode },
): React.ReactElement {
  const { phase, scale, line, detail, growth, creature } = props;
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
      {phase === "hover" ? (
        <HoverAffordances scale={scale} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {line ? <span style={{ color: T1, whiteSpace: "nowrap" }}>{line}</span> : null}
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

function HoverAffordances({ scale }: { scale: number }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 * scale }}>
      <span style={{ color: T1, whiteSpace: "nowrap" }}>◎ Hold to talk</span>
      <span style={{ color: T1, whiteSpace: "nowrap" }}>✎ Type</span>
      {/* `␣` (U+2423) is missing from several mono faces and falls back to a
          tofu box; the system UI stack has it. */}
      <span style={{ color: T2, fontSize: "0.86em", letterSpacing: ".04em" }}>
        ⌥␣
      </span>
    </div>
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
      {answer ? (
        <p style={{ margin: 0, color: T1, fontSize: 14, lineHeight: 1.5 }}>{answer}</p>
      ) : null}

      {source ? (
        <p style={{ margin: 0, color: T2, fontSize: 11.5 }}>
          {source}
          {" · "}
          <TextButton onClick={props.onOpen}>show</TextButton>
          {" · "}
          <TextButton onClick={props.onUndo}>Undo</TextButton>
        </p>
      ) : null}

      <Composer
        onAsk={props.onAsk}
        onKeepAsNote={props.onKeepAsNote}
        onClose={props.onCloseCard}
      />

      <p style={{ margin: 0, color: T2, fontSize: 11 }}>
        One exchange, then done ·{" "}
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
        style={{
          fontSize: "0.96em",
          color: T2,
          background: "rgba(255,255,255,.06)",
          border: "1px solid rgba(255,255,255,.11)",
          borderRadius: 8,
          padding: "5px 10px",
          whiteSpace: "nowrap",
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
}: {
  onAsk?: (message: string) => void;
  onKeepAsNote?: (note: string) => void;
  onClose?: () => void;
}): React.ReactElement {
  const [text, setText] = useState("");

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
        placeholder="Reply, or ⌘↵ to keep as a note…"
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
