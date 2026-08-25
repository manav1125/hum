import type { CSSProperties } from "react";

/**
 * The creature — design `C1`.
 *
 * **We did not invent a mascot; we already had one.** The open ring with its
 * satellite dot is the mark on every surface we ship, and "the mark is the
 * state" is a standing rule. The companion is where the mark finally gets to
 * behave.
 *
 * The grammar, which is upstream's coarse-state insight kept exactly:
 *
 *   · **The dot expresses whose turn it is.** Seated in the ring = waiting on
 *     you. Travelling = working. The finer phase lives in the words beside it,
 *     where reading is deliberate — never in the creature.
 *   · **The blink is the ring's own gesture** — the open arc closes for 90ms
 *     and reopens. A wink, not an eyelid. Idle only: never while working.
 *   · **The gaze is the personality budget, spent once.** The dot rolls a few
 *     degrees toward the pointer as you approach. No bouncing, no sound, no
 *     speech bubbles — a presence you glance at, not a pet that performs.
 *
 * Two rings, adopted from upstream verbatim: working is a *travelling* light
 * (never a second pulse — rest already pulses), and watching is a fixed amber
 * ring, deliberately not our accent, so it agrees with the menu-bar capture
 * tint above it.
 */

/** Geometry from the design's own SVG. The viewBox everything is stated in. */
const VIEW = 512;
const RING = { cx: 232, cy: 256, r: 150, width: 46 } as const;
/** 707 drawn, 236 open — the arc's mouth, which is also the drop slot (C10). */
const RING_DASH = "707 236";
/**
 * The mouth, widened.
 *
 * `C10`: the arc opens toward a dragged item, and the ring turns so the
 * opening faces it. The character gesture and the affordance are the same
 * thing — there is no separate drop zone to draw, because the creature
 * already had one.
 */
const RING_DASH_OPEN = "580 363";
const RING_OPEN_ROTATION = 80;
const DOT_R = 34;

/**
 * Where the creature looks, per state — taken from the design's own SVG.
 *
 * **The whole mark turns, not just the dot.** The ring's rotation carries the
 * arc's mouth around with the gaze, which is why the gesture reads as the
 * creature looking at you rather than a bead sliding along a track. Rest sits
 * at `rotate(42)`; the gaze turns to `rotate(-38)` and the dot rides with it.
 */
const LOOK = {
  /** 4 o'clock. Seated: waiting on you. */
  rest: { dot: { x: 392, y: 372 }, ring: 42 },
  /** Rolled toward an approaching pointer — the one personality gesture. */
  gaze: { dot: { x: 332, y: 130 }, ring: -38 },
} as const;

export type CreatureTone =
  | "normal"
  | "watching"
  | "recording"
  | "offline"
  | "amber"
  /** Cue moving first (`C7`), and the tint a held glint keeps. */
  | "nudge";

/** Reserved values. Red belongs to recording alone; amber agrees with the host. */
const TONE = {
  normal: { ring: "#F4F4F6", dot: "#3D6EE8", glow: "61,110,232" },
  watching: { ring: "#FF9F45", dot: "#FF9F45", glow: "255,159,69" },
  recording: { ring: "#E5675B", dot: "#E5675B", glow: "229,103,91" },
  offline: { ring: "#9A9AA8", dot: "#9A9AA8", glow: "154,154,168" },
  amber: { ring: "#F4F4F6", dot: "#FF9F45", glow: "255,159,69" },
  nudge: { ring: "#F4F4F6", dot: "#6FD69A", glow: "111,214,154" },
} as const satisfies Record<CreatureTone, { ring: string; dot: string; glow: string }>;

export interface CreatureProps {
  /** The creature's box in points — the whole of the surface's scale. */
  box: number;
  /** Whose turn it is. `working` sends the dot travelling. */
  working?: boolean;
  /** Held open by a mic. The whole creature breathes. */
  listening?: boolean;
  /** The pointer is near: the dot rolls toward it. Ignored while working. */
  gazing?: boolean;
  tone?: CreatureTone;
  /** Ring weight, a character trait. */
  weight?: "fine" | "regular" | "bold";
  /** Blink frequency, a character trait. */
  blink?: "calm" | "lively";
  /** Quiet hours and Reduced Motion both still the creature. */
  still?: boolean;
  /**
   * A drag is passing over: the arc widens its mouth toward it (`C10`).
   */
  opening?: boolean;
  /**
   * An ignored nudge, held (`C7`).
   *
   * A glint on the shoulder of the disc rather than a second creature state:
   * the dot already carries the tint, and this is the mark that says there is
   * something to come back to. Never lost, and never repeated out loud.
   */
  held?: boolean;
}

export function CompanionCreature({
  box,
  working = false,
  listening = false,
  gazing = false,
  tone = "normal",
  weight = "regular",
  blink = "calm",
  still = false,
  held = false,
  opening = false,
}: CreatureProps): React.ReactElement {
  const t = TONE[tone];
  const strokeWidth =
    RING.width * (weight === "fine" ? 0.78 : weight === "bold" ? 1.24 : 1);
  // The dot is seated while resting and rolled while gazing; working takes it
  // out of the ring entirely, so a gaze during work would be two claims about
  // the same thing.
  const look = gazing && !working ? LOOK.gaze : LOOK.rest;
  // Opening overrides the gaze: the creature is looking at what is being
  // dragged, and it cannot be turned two ways at once.
  const ringRotation = opening ? RING_OPEN_ROTATION : look.ring;

  // Blink is the arc closing — scaleY on the ring alone, about its own centre.
  const blinkSeconds = blink === "lively" ? 4 : 6.5;

  const disc: CSSProperties = {
    width: box,
    height: box,
    borderRadius: "50%",
    background: "#101321",
    // Dashed while a drag is over it — the same language every drop target on
    // every desktop uses, said in the creature's own accent.
    border: opening
      ? "2px dashed rgba(61,110,232,.6)"
      : "1px solid rgba(255,255,255,.13)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // Rest pulses; working travels. Never both — see the header.
    ...(still || working
      ? { boxShadow: "0 14px 34px -14px rgba(0,0,0,.55)" }
      : { animation: "cueCreatureGlow 3.2s ease-in-out infinite" }),
    ["--cue-glow" as string]: t.glow,
    position: "relative",
  };

  return (
    <div
      style={disc}
      data-companion-creature
      // Never draggable as an image, and the CSS as well as the attribute:
      // WebKit honours the CSS on paths where it ignores the attribute
      // (upstream `4e9f2133`).
      draggable={false}
      aria-hidden
    >
      <div
        style={{
          width: box * 0.52,
          height: box * 0.52,
          ...(listening && !still
            ? { animation: "cueCreatureBreathe 2.4s ease-in-out infinite" }
            : {}),
        }}
      >
        <svg
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          width="100%"
          height="100%"
          style={{ overflow: "visible", WebkitUserDrag: "none" } as CSSProperties}
        >
          <circle
            cx={RING.cx}
            cy={RING.cy}
            r={RING.r}
            fill="none"
            stroke={t.ring}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={opening ? RING_DASH_OPEN : RING_DASH}
            transform={`rotate(${ringRotation} ${RING.cx} ${RING.cy})`}
            style={{
              transformOrigin: `${RING.cx}px ${RING.cy}px`,
              // The turn is the gesture; the blink rides on top of it.
              transition: still ? undefined : "transform 280ms ease-out",
              ...(still || working
                ? {}
                : {
                    animation: `cueCreatureBlink ${blinkSeconds}s ease-in-out infinite`,
                  }),
            }}
          />
          {working && !still ? (
            // The travelling light: the dot leaves the ring and orbits. One
            // group rotates about the ring's centre so the dot keeps its own
            // size and colour while it travels.
            <g
              style={{
                transformOrigin: `${RING.cx}px ${RING.cy}px`,
                animation: "cueCreatureOrbit 1.5s linear infinite",
              }}
            >
              <circle cx={RING.cx + RING.r} cy={RING.cy} r={DOT_R} fill={t.dot} />
            </g>
          ) : (
            <circle
              cx={look.dot.x}
              cy={look.dot.y}
              r={DOT_R}
              fill={t.dot}
              style={
                still
                  ? undefined
                  : { transition: "cx 280ms ease-out, cy 280ms ease-out" }
              }
            />
          )}
        </svg>
      </div>
      {held ? (
        <span
          style={{
            position: "absolute",
            top: box * 0.09,
            right: box * 0.09,
            width: Math.max(6, box * 0.12),
            height: Math.max(6, box * 0.12),
            borderRadius: "50%",
            background: TONE.nudge.dot,
            boxShadow: `0 0 ${box * 0.12}px rgba(${TONE.nudge.glow},.8)`,
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The creature's keyframes.
 *
 * Rendered once by the surface rather than written into the global sheet: the
 * companion is the only place they apply, and keeping them here means the
 * creature is one file to read.
 *
 * Reduced Motion is honoured by the caller passing `still`, not by a media
 * query here — quiet hours need exactly the same treatment, and one path for
 * "do not move" is easier to be sure of than two.
 */
export function CompanionCreatureKeyframes(): React.ReactElement {
  return (
    <style>{`
@keyframes cueCreatureBlink {
  0%, 92%, 100% { transform: scaleY(1); }
  95% { transform: scaleY(.1); }
}
@keyframes cueCreatureOrbit {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes cueCreatureBreathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.06); }
}
@keyframes cueCreatureGlow {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(var(--cue-glow), .35),
                0 14px 34px -14px rgba(0,0,0,.55);
  }
  50% {
    box-shadow: 0 0 0 9px rgba(var(--cue-glow), 0),
                0 14px 34px -14px rgba(0,0,0,.55);
  }
}
@media (prefers-reduced-motion: reduce) {
  [data-companion-creature],
  [data-companion-creature] * { animation: none !important; }
}
`}</style>
  );
}
