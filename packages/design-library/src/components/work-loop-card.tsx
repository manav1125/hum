import { type CSSProperties, type ReactNode, useId, useState } from "react";

import { cn } from "../utils/cn";
import { AgentChip } from "./agent-chip";
import { StateBadge } from "./state-badge";
import {
  WORK_STATE_META,
  type WorkLoopState,
  type WorkStateInput,
  resolveWorkLoopState,
} from "./work-state";

/**
 * The one card, parameterized by state. Renders the same title/agent/badge
 * frame for every point in the loop; the state only changes the accent, the
 * left rail tint, and which affordances show. Failure carries a reason and a
 * way forward — never a dead end. Needs-you can carry the approval-timeout
 * copy. Running can reveal the agent's plan inline (the "why" expander).
 * Design: autonomy-states v2.
 */
export interface WorkLoopCardAction {
  label: string;
  onClick?: () => void;
  /** Primary = filled accent button; secondary = quiet. */
  variant?: "primary" | "secondary";
}

export interface WorkLoopCardProps {
  title: string;
  /** Explicit loop state, or pass `item` to resolve one. */
  state?: WorkLoopState;
  item?: WorkStateInput;
  /** Source provenance, e.g. `Rachel · Slack` or a quoted commitment. */
  source?: ReactNode;
  /** Agent that owns the work. */
  agent?: { name: string; emoji?: string | null; detail?: string };
  /** Progress caption, e.g. "5 of 8 sources" (running). */
  progress?: string;
  /** Reason line — the honest "why we stopped" or "why it failed". */
  reason?: ReactNode;
  /** The agent's plan + sources; when set, a "why" toggle reveals it inline. */
  why?: ReactNode;
  actions?: WorkLoopCardAction[];
  className?: string;
  onClick?: () => void;
}

export function WorkLoopCard({
  title,
  state,
  item,
  source,
  agent,
  progress,
  reason,
  why,
  actions,
  className,
  onClick,
}: WorkLoopCardProps) {
  const resolved = state ?? (item ? resolveWorkLoopState(item) : "capture");
  const meta = WORK_STATE_META[resolved];
  const [whyOpen, setWhyOpen] = useState(false);
  const whyId = useId();

  const cardStyle: CSSProperties = {
    borderRadius: 12,
    border: "1px solid var(--border-base)",
    borderLeft: `3px solid ${meta.accentVar}`,
    background: "var(--surface-lift)",
  };

  return (
    <div
      data-slot="work-loop-card"
      data-state={resolved}
      className={cn(
        "flex flex-col gap-2.5 p-3.5 text-left",
        onClick ? "cursor-pointer" : "",
        className,
      )}
      style={cardStyle}
      onClick={onClick}
    >
      <div className="flex items-center justify-between gap-2">
        <StateBadge state={resolved} size="sm" />
        {progress ? (
          <span className="text-body-small text-[color:var(--content-tertiary)]">
            {progress}
          </span>
        ) : null}
      </div>

      {source ? (
        <div className="text-body-small text-[color:var(--content-secondary)]">
          {source}
        </div>
      ) : null}

      <div className="text-body-medium-emphasised text-[color:var(--content-emphasised)]">
        {title}
      </div>

      {reason ? (
        <div
          className="rounded-lg p-2.5 text-body-small text-[color:var(--content-default)]"
          style={{ background: meta.weakVar }}
        >
          {reason}
        </div>
      ) : null}

      {why ? (
        <div>
          <button
            type="button"
            aria-expanded={whyOpen}
            aria-controls={whyId}
            onClick={(e) => {
              e.stopPropagation();
              setWhyOpen((v) => !v);
            }}
            className={cn(
              "inline-flex items-center gap-1 text-body-small",
              "text-[color:var(--content-secondary)]",
              "hover:text-[color:var(--content-default)] transition-colors",
            )}
          >
            <span aria-hidden="true">{whyOpen ? "▾" : "▸"}</span> why
          </button>
          {whyOpen ? (
            <div
              id={whyId}
              className="mt-2 rounded-lg p-2.5 text-body-small text-[color:var(--content-default)]"
              style={{ background: "var(--surface-base)" }}
            >
              {why}
            </div>
          ) : null}
        </div>
      ) : null}

      {agent ? (
        <AgentChip
          name={agent.name}
          emoji={agent.emoji}
          detail={agent.detail}
          size="sm"
        />
      ) : null}

      {actions && actions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {actions.map((action, i) => {
            const primary = (action.variant ?? "primary") === "primary";
            const btnStyle: CSSProperties = primary
              ? {
                  background: meta.accentVar,
                  color: "#fff",
                  borderRadius: 8,
                }
              : {
                  background: "transparent",
                  color: "var(--content-secondary)",
                  border: "1px solid var(--border-base)",
                  borderRadius: 8,
                };
            return (
              <button
                key={i}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  action.onClick?.();
                }}
                className="px-3 py-1.5 text-body-small-emphasised transition-opacity hover:opacity-90"
                style={btnStyle}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
