import { type CSSProperties } from "react";

import { cn } from "../utils/cn";
import { resolveAgentIdentity } from "./work-state";

/**
 * Agent identity chip — a colored glyph + the agent's name, so every
 * autonomous action reads as accountable to a named agent rather than an
 * anonymous system. The roster emoji wins over the default glyph; unknown
 * agents fall back to a neutral tint (never a faked identity).
 * Design: autonomy-states v2.
 */
export interface AgentChipProps {
  name: string;
  /** The agent's self-chosen glyph/emoji from the roster. */
  emoji?: string | null;
  /** Trailing detail, e.g. "4 min", "you approved", "while away". */
  detail?: string;
  size?: "sm" | "md";
  className?: string;
}

export function AgentChip({
  name,
  emoji,
  detail,
  size = "md",
  className,
}: AgentChipProps) {
  const { colorVar, glyph } = resolveAgentIdentity(name, emoji);
  const glyphStyle: CSSProperties = {
    color: colorVar,
    fontSize: size === "sm" ? 11 : 13,
    lineHeight: 1,
  };
  return (
    <span
      data-slot="agent-chip"
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap select-none",
        "text-body-small text-[color:var(--content-secondary)]",
        className,
      )}
    >
      <span aria-hidden="true" style={glyphStyle}>
        {glyph}
      </span>
      <span className="text-[color:var(--content-default)]">{name}</span>
      {detail ? (
        <span className="text-[color:var(--content-tertiary)]">· {detail}</span>
      ) : null}
    </span>
  );
}
