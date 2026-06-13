import { type ComponentProps } from "react";

import { cn } from "../utils/cn";

/**
 * ApertureAvatar — Cue's character. An ink squircle holding a light aperture
 * ("it sees and listens") with an electric-blue pupil, echoing the app icon
 * (assets/cue/icon.svg). Replaces the inherited Vellum avatar.
 *
 * State drives the motion (design-book "avatar · idle / listening / speaking
 * / acting"):
 *   - idle       the pupil drifts and blinks
 *   - listening  + an expanding ping ring
 *   - thinking   the aperture slowly rotates
 *   - speaking   the pupil pulses
 *   - acting     the field turns violet (Cue is doing something on your behalf)
 *
 * All motion is paired with `motion-reduce:animate-none`, so reduced-motion
 * users get a calm, static mark. Colors come from tokens — no hard-coded hex.
 */
export type ApertureAvatarState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "acting";

export interface ApertureAvatarProps
  extends Omit<ComponentProps<"span">, "children"> {
  /** State — drives motion + field color. Defaults to "idle". */
  state?: ApertureAvatarState;
  /** Square edge length in px. Defaults to 40. */
  size?: number;
  /** Accessible label. Defaults to "Cue". */
  label?: string;
}

export function ApertureAvatar({
  state = "idle",
  size = 40,
  label = "Cue",
  className,
  style,
  ref,
  ...rest
}: ApertureAvatarProps) {
  const acting = state === "acting";
  const listening = state === "listening";

  return (
    <span
      {...rest}
      ref={ref}
      role="img"
      aria-label={label}
      data-slot="aperture-avatar"
      data-state={state}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-visible",
        className,
      )}
      style={{ width: size, height: size, ...style }}
    >
      {/* Ink (or violet) field */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-[28%]"
        style={{
          background: acting
            ? "var(--accent-cue-violet-strong)"
            : "var(--surface-ink)",
        }}
      />

      {/* Listening ping — an expanding ring outside the field */}
      {listening ? (
        <span
          aria-hidden
          className="absolute inset-0 rounded-[28%] animate-cue-ping motion-reduce:animate-none"
          style={{
            border: "2px solid color-mix(in srgb, var(--accent-cue) 55%, transparent)",
          }}
        />
      ) : null}

      {/* Aperture + pupil */}
      <svg
        aria-hidden
        viewBox="0 0 100 100"
        className="relative h-full w-full"
        fill="none"
      >
        {/* Aperture ring — a near-full "c" arc */}
        <g
          className={cn(
            state === "thinking"
              ? "animate-cue-spin motion-reduce:animate-none"
              : null,
          )}
          style={{ transformOrigin: "center" }}
        >
          <circle
            cx="50"
            cy="50"
            r="27"
            stroke="var(--content-on-ink)"
            strokeOpacity="0.9"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray="132 38"
            transform="rotate(-58 50 50)"
          />
        </g>

        {/* Pupil — drifts (idle/listening) or pulses (speaking) */}
        <g
          className={cn(
            state === "idle" || state === "listening"
              ? "animate-cue-look motion-reduce:animate-none"
              : null,
          )}
          style={{ transformOrigin: "center" }}
        >
          <circle
            cx="67"
            cy="63"
            r="8"
            fill="var(--accent-cue)"
            className={cn(
              state === "speaking"
                ? "animate-cue-pulse motion-reduce:animate-none"
                : state === "idle" || state === "listening"
                  ? "animate-cue-blink motion-reduce:animate-none"
                  : null,
            )}
            style={{ transformOrigin: "67px 63px" }}
          />
        </g>
      </svg>
    </span>
  );
}
