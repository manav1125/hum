import { type CSSProperties, type ComponentProps } from "react";

import { cn } from "../utils/cn";

/**
 * VoiceOrb — the voice-mode presence. A dimensional electric-blue core inside a
 * breathing aura, echoing the Cue aperture ("it sees and listens"). It is
 * *alive*: while listening the core and aura scale with the live mic amplitude,
 * so the orb visibly leans in to the user's voice.
 *
 * State drives the motion:
 *   - idle       a calm, dim core with a soft resting glow
 *   - listening  amplitude-reactive core + aura, expanding rings, violet EQ
 *   - thinking   a slow conic shimmer orbits the core (cognition, not a spinner)
 *   - speaking   the core pulses and rings emanate outward in rhythm
 *
 * `amplitude` (0–1) is the smoothed RMS mic level; pass it while listening for
 * the reactive breath. All motion is paired with `motion-reduce:animate-none`
 * and the reactive transforms collapse to a calm static mark for reduced-motion
 * users. Colors are fully token-driven.
 */
export type VoiceOrbState = "idle" | "listening" | "thinking" | "speaking";

export interface VoiceOrbProps extends ComponentProps<"div"> {
  /** State — drives the rings, shimmer, and equalizer. Defaults to "idle". */
  state?: VoiceOrbState;
  /** Core diameter in px. Defaults to 88. */
  size?: number;
  /** Live mic amplitude 0–1; drives the reactive scale/glow while listening. */
  amplitude?: number;
  /** Accessible label. Defaults to a state-derived phrase. */
  label?: string;
}

const STATE_LABEL: Record<VoiceOrbState, string> = {
  idle: "Voice idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const EQ_BARS = [0, 1, 2, 3, 4];

export function VoiceOrb({
  state = "idle",
  size = 88,
  amplitude = 0,
  label,
  className,
  ref,
  ...rest
}: VoiceOrbProps) {
  const listening = state === "listening";
  const speaking = state === "speaking";
  const thinking = state === "thinking";
  const showRings = listening || speaking;
  const showEqualizer = listening;
  const coreSize = Math.round(size * 0.52);

  // Clamp the live amplitude and shape it — a gentle floor so the orb always
  // breathes a little while listening, then reacts up from there.
  const amp = Math.max(0, Math.min(1, amplitude));
  const reactive = listening ? 0.08 + amp * 0.92 : 0;

  // Core "leans in" with the voice; the aura swells further and brightens.
  const coreScale = listening ? 1 + reactive * 0.16 : 1;
  const auraScale = listening
    ? 1 + reactive * 0.55
    : speaking
      ? 1.14
      : 1;
  const auraOpacity = listening
    ? 0.28 + reactive * 0.42
    : speaking
      ? 0.42
      : state === "idle"
        ? 0.2
        : 0.34;

  return (
    <div
      {...rest}
      ref={ref}
      role="status"
      aria-label={label ?? STATE_LABEL[state]}
      data-slot="voice-orb"
      data-state={state}
      className={cn("flex flex-col items-center gap-4", className)}
    >
      <div
        className="relative flex items-center justify-center"
        style={{ width: size, height: size }}
      >
        {/* Aura — a soft radial glow that breathes with the voice. */}
        <span
          aria-hidden
          className="absolute rounded-full"
          style={{
            inset: "-30%",
            background:
              "radial-gradient(circle, color-mix(in srgb, var(--accent-cue) 60%, transparent) 0%, transparent 68%)",
            filter: "blur(10px)",
            opacity: auraOpacity,
            transform: `scale(${auraScale})`,
            transition:
              "transform 110ms linear, opacity 140ms linear",
            transformOrigin: "center",
          }}
        />

        {/* Expanding rings — sound arriving (listening) or emanating (speaking). */}
        {showRings ? (
          <>
            <span
              aria-hidden
              className="absolute inset-0 rounded-full animate-cue-ping motion-reduce:animate-none"
              style={{
                border:
                  "2px solid color-mix(in srgb, var(--accent-cue) 50%, transparent)",
              }}
            />
            <span
              aria-hidden
              className="absolute inset-0 rounded-full animate-cue-ping motion-reduce:animate-none"
              style={{
                border:
                  "2px solid color-mix(in srgb, var(--accent-cue) 50%, transparent)",
                animationDelay: "1.3s",
              }}
            />
          </>
        ) : null}

        {/* Thinking — a conic shimmer orbits the core (cognition in motion). */}
        {thinking ? (
          <span
            aria-hidden
            className="absolute rounded-full animate-spin motion-reduce:animate-none"
            style={{
              inset: "-9%",
              background:
                "conic-gradient(from 0deg, transparent 0deg, color-mix(in srgb, var(--accent-cue-violet) 90%, transparent) 90deg, transparent 200deg)",
              animationDuration: "2.4s",
              WebkitMask:
                "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))",
              mask: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))",
              opacity: 0.85,
            }}
          />
        ) : null}

        {/* Core — a lit, dimensional sphere. */}
        <span
          aria-hidden
          className={cn(
            "rounded-full",
            thinking ? "animate-cue-pulse motion-reduce:animate-none" : null,
          )}
          style={{
            width: coreSize,
            height: coreSize,
            background:
              "radial-gradient(circle at 36% 30%, color-mix(in srgb, var(--accent-cue) 62%, white) 0%, var(--accent-cue) 44%, var(--accent-cue-strong) 100%)",
            boxShadow:
              "var(--shadow-accent-glow), inset 0 -2px 6px color-mix(in srgb, var(--accent-cue-violet-strong) 45%, transparent)",
            opacity: state === "idle" ? 0.85 : 1,
            transform: `scale(${coreScale})`,
            transition: "transform 100ms linear, opacity 200ms ease",
            transformOrigin: "center",
          }}
        />
      </div>

      {/* Equalizer — violet bars that rise while the user speaks. */}
      {showEqualizer ? (
        <div
          aria-hidden
          className="flex h-4 items-end gap-1 motion-reduce:opacity-60"
          style={{
            opacity: 0.5 + reactive * 0.5,
            transition: "opacity 140ms linear",
          }}
        >
          {EQ_BARS.map((i) => (
            <span
              key={i}
              className="w-[3px] rounded-full animate-cue-eq motion-reduce:animate-none"
              style={
                {
                  height: 16,
                  background: "var(--accent-cue-violet)",
                  animationDelay: `${i * 0.12}s`,
                  transformOrigin: "bottom",
                } as CSSProperties
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
