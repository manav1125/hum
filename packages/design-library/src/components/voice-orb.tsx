import { type CSSProperties, type ComponentProps } from "react";

import { cn } from "../utils/cn";

/**
 * VoiceOrb — the voice-mode visualization. A blue core with two staggered
 * expanding rings and a row of violet equalizer bars (design-book Voice / Cue
 * Live: the full-bleed ink screen with the pulsing orb + "● listening").
 *
 * State drives what animates:
 *   - idle       a calm, dim core
 *   - listening  expanding rings + violet equalizer (the user is speaking)
 *   - thinking   the core pulses; no rings or bars
 *   - speaking   expanding rings (Cue is speaking)
 *
 * Motion is paired with `motion-reduce:animate-none`. Colors are token-driven.
 */
export type VoiceOrbState = "idle" | "listening" | "thinking" | "speaking";

export interface VoiceOrbProps extends ComponentProps<"div"> {
  /** State — drives the rings + equalizer. Defaults to "idle". */
  state?: VoiceOrbState;
  /** Core diameter in px. Defaults to 88. */
  size?: number;
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
  label,
  className,
  ref,
  ...rest
}: VoiceOrbProps) {
  const showRings = state === "listening" || state === "speaking";
  const showEqualizer = state === "listening";
  const coreSize = Math.round(size * 0.52);

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
        {/* Expanding rings — two, staggered */}
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

        {/* Core */}
        <span
          aria-hidden
          className={cn(
            "rounded-full",
            state === "thinking"
              ? "animate-cue-pulse motion-reduce:animate-none"
              : null,
          )}
          style={{
            width: coreSize,
            height: coreSize,
            background:
              "radial-gradient(circle at 38% 34%, var(--accent-cue), var(--accent-cue-strong))",
            boxShadow: "var(--shadow-accent-glow)",
            opacity: state === "idle" ? 0.8 : 1,
            transformOrigin: "center",
          }}
        />
      </div>

      {/* Equalizer — violet bars while the user speaks */}
      {showEqualizer ? (
        <div aria-hidden className="flex h-4 items-end gap-1">
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
