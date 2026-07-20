/**
 * TaskRunContextRow — the collapsed rendering for daemon-injected task-run
 * context messages (wire `ConversationMessage.taskRunContext`, stamped by the
 * daemon when it seeds a work-item run with project context).
 *
 * These messages are machinery, not something the user typed — rendering them
 * as a user bubble leaks the injected prompt ("You are working a task inside
 * a project…") into the transcript (UAT P2). Instead they collapse into a
 * quiet one-line "Project context ›" pill; tapping expands the full text for
 * transparency (and collapses it again).
 *
 * Styled with semantic tokens only, so the mobile `.cue-mchat` retint and
 * desktop both render it correctly.
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";

export function TaskRunContextRow({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="flex w-full flex-col items-start gap-2"
      data-testid="task-run-context-row"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={
          expanded ? "Collapse project context" : "Expand project context"
        }
        className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-[var(--border-base)] bg-[var(--surface-lift)] px-3 py-1 text-[12px] font-medium text-[var(--content-secondary)]"
        style={{ WebkitTapHighlightColor: "transparent", cursor: "pointer" }}
      >
        Project context
        <ChevronRight
          size={13}
          aria-hidden
          className="shrink-0 transition-transform duration-150"
          style={{ transform: expanded ? "rotate(90deg)" : undefined }}
        />
      </button>
      {expanded ? (
        <div className="max-h-72 w-full overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] px-3.5 py-3 text-[12.5px] leading-relaxed text-[var(--content-secondary)]">
          {text}
        </div>
      ) : null}
    </div>
  );
}
