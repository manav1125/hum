/**
 * The eight verbs as a usable surface (§4).
 *
 * `work-vocabulary.ts` defines the verbs; this makes them pressable and
 * typeable. One binding, one bar, every surface — triage, the row `⋯`, task
 * detail, the review pager. Muscle memory only transfers if the keys are
 * identical everywhere, which is exactly the kind of promise that rots when
 * each surface rolls its own key handler. So there is one handler and it lives
 * here.
 *
 * Two things this gets right that a naive keydown listener does not:
 *
 * **It refuses to fire while the user is typing.** `D` is "Done elsewhere" and
 * also the fourth letter of "Wednesday". A global handler that does not check
 * the focused element will complete someone's task while they write a note —
 * a data-loss bug wearing the costume of a shortcut.
 *
 * **Undo is not a verb like the others.** The other seven act on one item;
 * `⌘Z` acts on the session and is handled even when no item is selected, so it
 * still works after the row you archived has left the screen.
 */

import { useEffect } from "react";

import { C, mono } from "./hq-kit";
import { undoLast } from "./work-undo";
import { WORK_VERBS, type WorkVerb, type WorkVerbId } from "./work-vocabulary";

export type WorkVerbHandlers = Partial<Record<WorkVerbId, () => void>>;

/** True when a keystroke belongs to whatever the user is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // Radix and friends render listboxes/menus that own their own keys.
  return target.closest('[role="dialog"],[role="menu"],[role="listbox"]') != null;
}

/**
 * Bind the verb keys.
 *
 * `enabled` exists so a surface can stand down while a modal or sheet is open
 * without unmounting — a bar that keeps firing underneath an overlay is the
 * other half of the typing bug.
 */
export function useWorkVerbKeys(
  handlers: WorkVerbHandlers,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      // Undo first, and regardless of selection: the point of ⌘Z is to reach
      // the thing that is no longer in front of you.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void undoLast().catch(() => {
          // The stack restores the entry itself; a failed undo must not throw
          // out of a global key handler and take the surface down with it.
        });
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const id = verbIdForEvent(e);
      if (!id) return;
      const run = handlers[id];
      if (!run) return;
      e.preventDefault();
      run();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handlers, enabled]);
}

/** Map a raw key event to a verb. Exported for the tests. */
export function verbIdForEvent(e: {
  key: string;
  shiftKey?: boolean;
}): WorkVerbId | null {
  if (e.key === "Enter") return "approve";
  if (e.key === "Backspace" || e.key === "Delete") return "archive";
  switch (e.key.toLowerCase()) {
    case "o":
      return "open";
    case "l":
      return "later";
    case "d":
      return "done_elsewhere";
    case "f":
      return "file";
    case "h":
      return "hand_off";
    default:
      return null;
  }
}

/**
 * The verb bar.
 *
 * Only verbs the caller supplied a handler for are rendered — an inert button
 * teaches the wrong shortcut, and a surface where `Hand off` does nothing is
 * worse than one that does not offer it. Every button shows its key, because
 * the bar is also how the shortcuts get learned.
 */
export function WorkVerbBar({
  handlers,
  busy,
  compact,
}: {
  handlers: WorkVerbHandlers;
  /** Verb currently in flight — disables the set and marks the one running. */
  busy?: WorkVerbId | null;
  compact?: boolean;
}) {
  const shown = WORK_VERBS.filter((v) => handlers[v.id] != null);
  if (shown.length === 0) return null;
  return (
    <div
      data-slot="work-verb-bar"
      role="toolbar"
      aria-label="Actions"
      style={{
        display: "flex",
        alignItems: "center",
        gap: compact ? 4 : 6,
        flexWrap: "wrap",
      }}
    >
      {shown.map((verb) => (
        <VerbButton
          key={verb.id}
          verb={verb}
          onPress={handlers[verb.id]!}
          busy={busy === verb.id}
          disabled={busy != null && busy !== verb.id}
          compact={compact}
        />
      ))}
    </div>
  );
}

function VerbButton({
  verb,
  onPress,
  busy,
  disabled,
  compact,
}: {
  verb: WorkVerb;
  onPress: () => void;
  busy: boolean;
  disabled: boolean;
  compact?: boolean;
}) {
  const primary = verb.id === "approve";
  return (
    <button
      type="button"
      data-verb={verb.id}
      onClick={onPress}
      disabled={disabled || busy}
      // The hint states the consequence, not the mechanism: "Never deletes —
      // teaches Cue what you don't need" is what makes Archive pressable.
      title={`${verb.label} · ${verb.key} — ${verb.hint}`}
      aria-label={`${verb.label} (${verb.key})`}
      aria-keyshortcuts={verb.key.length === 1 ? verb.key : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: compact ? "5px 9px" : "7px 12px",
        borderRadius: 9,
        border: `1px solid ${primary ? "transparent" : C.line}`,
        background: primary ? C.ink : C.surface,
        color: primary ? C.surface : C.t1,
        fontSize: compact ? 12 : 12.5,
        cursor: disabled || busy ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <span>{busy ? "…" : verb.label}</span>
      <span
        aria-hidden
        style={{
          fontFamily: mono,
          fontSize: 10.5,
          opacity: 0.62,
        }}
      >
        {verb.key}
      </span>
    </button>
  );
}
