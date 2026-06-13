import { X } from "lucide-react";
import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";

/**
 * Nudge — a left-accented "Cue noticed" card. The proactivity loop surfaces
 * these in the Now rail / Home feed (design-book "Dana hasn't replied →").
 *
 * Tone drives the left stripe + accent:
 *   - `info`        electric blue   — something Cue noticed for you
 *   - `commitment`  violet          — a promise / commitment it's tracking
 *   - `neutral`     hairline        — quiet, no accent
 *
 * The left edge is squared (stripe reads as a tab); the rest is rounded.
 */
export type NudgeTone = "info" | "commitment" | "neutral";

interface NudgeToneStyle {
  /** Left stripe + title accent color. */
  accent: string;
  /** Soft background wash. */
  surface: string;
}

const TONE_STYLES: Record<NudgeTone, NudgeToneStyle> = {
  info: {
    accent: "var(--accent-cue)",
    surface: "var(--surface-lift)",
  },
  commitment: {
    accent: "var(--accent-cue-violet)",
    surface: "var(--surface-lift)",
  },
  neutral: {
    accent: "var(--border-element)",
    surface: "var(--surface-lift)",
  },
};

export interface NudgeProps extends Omit<ComponentProps<"div">, "title"> {
  tone?: NudgeTone;
  /** Headline line. */
  title?: ReactNode;
  /** Supporting copy. */
  children?: ReactNode;
  /** Optional leading icon, colored to the tone accent. */
  icon?: ReactNode;
  /** Trailing slot — e.g. a SourceTag or timestamp. */
  meta?: ReactNode;
  /** Action row. */
  actions?: ReactNode;
  /** When set, renders a trailing dismiss button. */
  onDismiss?: () => void;
}

export function Nudge({
  tone = "info",
  title,
  children,
  icon,
  meta,
  actions,
  onDismiss,
  className,
  ref,
  ...rest
}: NudgeProps) {
  const style = TONE_STYLES[tone];
  return (
    <div
      {...rest}
      ref={ref}
      data-slot="nudge"
      data-tone={tone}
      role="status"
      className={cn(
        "relative flex items-start gap-2.5 rounded-l-none rounded-r-lg border-l-[3px] p-3 pr-2.5",
        "text-[color:var(--content-default)]",
        className,
      )}
      style={{ borderLeftColor: style.accent, background: style.surface }}
    >
      {icon ? (
        <span
          aria-hidden
          className="mt-0.5 flex shrink-0 items-center justify-center"
          style={{ color: style.accent }}
        >
          {icon}
        </span>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title ? (
          <span className="text-body-medium-default text-[color:var(--content-emphasised)]">
            {title}
          </span>
        ) : null}
        {children ? (
          <div className="text-body-medium-lighter text-[color:var(--content-secondary)]">
            {children}
          </div>
        ) : null}
        {meta ? <div className="flex flex-wrap items-center gap-1.5">{meta}</div> : null}
        {actions ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>

      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={cn(
            "shrink-0 cursor-pointer rounded bg-transparent p-0.5",
            "text-[color:var(--content-secondary)] opacity-70 transition-opacity",
            "hover:opacity-100 keyboard-focus:outline-none keyboard-focus:ring-2",
            "keyboard-focus:ring-[var(--ring)]",
          )}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
