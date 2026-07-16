import { type CSSProperties } from "react";

import { cn } from "../utils/cn";
import {
  WORK_STATE_META,
  type WorkLoopState,
  type WorkStateInput,
  resolveWorkLoopState,
} from "./work-state";

/**
 * The work-loop state badge — a glyph square + label that reads the same on
 * every surface. Pass an explicit `state`, or an `item` to resolve one.
 * Running gets a live pulse on the glyph; failure is the only red.
 * Design: autonomy-states v2.
 */
export interface StateBadgeProps {
  state?: WorkLoopState;
  item?: WorkStateInput;
  /** Show the text label beside the glyph (default true). */
  showLabel?: boolean;
  /** Override the label text (e.g. the longer phrase). */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}

export function StateBadge({
  state,
  item,
  showLabel = true,
  label,
  size = "md",
  className,
}: StateBadgeProps) {
  const resolved = state ?? (item ? resolveWorkLoopState(item) : "capture");
  const meta = WORK_STATE_META[resolved];
  const dim = size === "sm" ? 16 : 20;

  const squareStyle: CSSProperties = {
    width: dim,
    height: dim,
    borderRadius: 6,
    background: meta.weakVar,
    color: meta.accentVar,
    fontSize: size === "sm" ? 10 : 12,
    lineHeight: 1,
  };

  return (
    <span
      data-slot="state-badge"
      data-state={resolved}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap select-none",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="relative inline-flex items-center justify-center"
        style={squareStyle}
      >
        {meta.glyph}
        {resolved === "running" ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 rounded-full"
            style={{
              width: 6,
              height: 6,
              background: meta.accentVar,
              animation: "cue-pulse 1.6s ease-in-out infinite",
            }}
          />
        ) : null}
      </span>
      {showLabel ? (
        <span
          className="text-body-small-emphasised uppercase tracking-wide"
          style={{ color: meta.accentVar, fontSize: size === "sm" ? 10 : 11 }}
        >
          {label ?? meta.label}
        </span>
      ) : null}
    </span>
  );
}
