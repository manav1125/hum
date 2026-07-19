/**
 * CueRing — THE mark. An OPEN ring + blue dot, never a closed circle or a
 * letter C (README DNA). Geometry read verbatim off the spec frames:
 *
 *   <svg viewBox="0 0 512 512">
 *     <circle cx=232 cy=256 r=150 stroke-width=42 stroke-linecap=round
 *             stroke-dasharray="707 236" transform="rotate(42 232 256)"/>
 *     <circle cx=392 cy=372 r=32 fill=#3D6EE8/>
 *   </svg>
 *
 * The tab-bar rendition thickens to stroke-width 46 / dot r 34 so the mark
 * survives 22px — exposed via props. Stroke defaults to `currentColor`
 * (README: ring stroke follows text color; the dot stays accent blue).
 */
import type React from "react";

export function CueRing({
  size = 80,
  stroke = "currentColor",
  strokeWidth = 42,
  dotRadius = 32,
  dotColor = "#3D6EE8",
  spinning = false,
  style,
}: {
  size?: number;
  stroke?: string;
  strokeWidth?: number;
  dotRadius?: number;
  /** Dot stays #3D6EE8 per the DNA; override only for monochrome contexts. */
  dotColor?: string;
  /** Slow full-mark rotation (22s linear, matching the orbit cadence). */
  spinning?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      data-mv3
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden
      style={{
        ...(spinning ? { animation: "mv3Spin 22s linear infinite" } : {}),
        ...style,
      }}
    >
      <circle
        cx="232"
        cy="256"
        r="150"
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray="707 236"
        transform="rotate(42 232 256)"
      />
      <circle cx="392" cy="372" r={dotRadius} fill={dotColor} />
    </svg>
  );
}

/** One orbiting chip — an active work stream around the Today hero. */
export interface OrbitChip {
  /** 12px glyph content (svg icon or a short glyph string). */
  icon: React.ReactNode;
  /** Chip hue — border/glow derive from it at spec alphas. */
  color: string;
}

/** Spec chip angles (frame 1): three slots at 20° / 140° / 260°. */
const CHIP_ANGLES = [20, 140, 260];
/** Satellite dots (frame 1): 7px @80° and 6px @300°, radius 62. */
const DOT_SLOTS: Array<{ angle: number; size: number; color: string }> = [
  { angle: 80, size: 7, color: "var(--mv3-ring-active)" },
  { angle: 300, size: 6, color: "var(--mv3-violet-fill)" },
];

/**
 * CueRingHero — the Today hero: the breathing mark inside two guide rings,
 * with small chips orbiting it (= active work streams) and an optional
 * status-pill caption ("Working on N things for you").
 *
 * Layout is the spec's verbatim: a 150px-tall block scaled 0.8 from center
 * top, chips carried on a 22s `mv3Spin` orbit at translateX(84px) and
 * counter-rotated (`mv3SpinR`) so they stay upright; satellite dots ride a
 * reverse 15s orbit at 62px. All animation is transform/opacity;
 * reduced-motion freezes everything via the shared `[data-mv3]` rule.
 */
export function CueRingHero({
  chips = [],
  caption,
  height = 150,
}: {
  chips?: OrbitChip[];
  caption?: React.ReactNode;
  height?: number;
}) {
  return (
    <div
      data-mv3
      style={{
        position: "relative",
        height,
        flexShrink: 0,
        transform: "scale(0.8)",
        transformOrigin: "center top",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: "52%",
          left: "50%",
          width: 0,
          height: 0,
        }}
      >
        {/* Guide rings — decorative closed circles are allowed as ORBITS
            (they are paths, not the mark). */}
        <span
          style={{
            position: "absolute",
            top: -84,
            left: -84,
            width: 168,
            height: 168,
            borderRadius: "50%",
            border: "1px solid var(--mv3-guide-ring)",
          }}
        />
        <span
          style={{
            position: "absolute",
            top: -62,
            left: -62,
            width: 124,
            height: 124,
            borderRadius: "50%",
            border: "1px dashed var(--mv3-guide-ring-dash)",
          }}
        />

        {/* Orbit chips — active work streams. */}
        {chips.length > 0 ? (
          <div
            style={{
              position: "absolute",
              animation: "mv3Spin 22s linear infinite",
            }}
          >
            {chips.slice(0, CHIP_ANGLES.length).map((chip, i) => (
              <div
                key={i}
                style={{
                  position: "absolute",
                  transform: `rotate(${CHIP_ANGLES[i]}deg) translateX(84px)`,
                }}
              >
                <span
                  style={{
                    display: "flex",
                    width: 26,
                    height: 26,
                    borderRadius: 9,
                    background: "var(--mv3-chip-bg)",
                    border: `1px solid color-mix(in srgb, ${chip.color} 40%, transparent)`,
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: `0 0 14px color-mix(in srgb, ${chip.color} 35%, transparent)`,
                    color: chip.color,
                    // Counter-rotation keeps the chip upright on the orbit.
                    animation: "mv3SpinR 22s linear infinite",
                  }}
                >
                  {chip.icon}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {/* Satellite dots — only when something is actually in motion. */}
        {chips.length > 0 ? (
          <div
            style={{
              position: "absolute",
              animation: "mv3SpinR 15s linear infinite",
            }}
          >
            {DOT_SLOTS.map((d) => (
              <div
                key={d.angle}
                style={{
                  position: "absolute",
                  transform: `rotate(${d.angle}deg) translateX(62px)`,
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: d.size,
                    height: d.size,
                    borderRadius: "50%",
                    background: d.color,
                    boxShadow: `0 0 ${d.size + 3}px color-mix(in srgb, ${d.color} 70%, transparent)`,
                  }}
                />
              </div>
            ))}
          </div>
        ) : null}

        {/* The breathing mark + its glow halo (static blur; only opacity and
            scale animate). */}
        <div
          style={{
            position: "absolute",
            top: -40,
            left: -40,
            width: 80,
            height: 80,
            animation: "mv3Breathe 5s ease-in-out infinite",
          }}
        >
          <span
            style={{
              position: "absolute",
              inset: -18,
              borderRadius: "50%",
              background:
                "radial-gradient(circle, var(--mv3-ring-glow), transparent 62%)",
              filter: "blur(14px)",
              animation: "mv3Glow 3.8s ease-in-out infinite",
            }}
          />
          <CueRing
            size={80}
            stroke="var(--mv3-text)"
            style={{ position: "relative" }}
          />
        </div>
      </div>

      {/* Status pill — "Working on N things for you". */}
      {caption ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 2,
            textAlign: "center",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              background: "var(--mv3-pill)",
              border: "1px solid var(--mv3-pill-border)",
              borderRadius: 99,
              padding: "6px 13px",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              boxShadow: "var(--mv3-pill-shadow)",
            }}
          >
            <span
              style={{
                position: "relative",
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--mv3-accent)",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: "50%",
                  background: "var(--mv3-accent)",
                  animation: "mv3Ping 1.8s ease-out infinite",
                }}
              />
            </span>
            <span
              style={{
                fontSize: 12,
                color: "var(--mv3-pill-text)",
                fontWeight: 500,
              }}
            >
              {caption}
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
