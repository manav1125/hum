/**
 * The session undo stack (§4).
 *
 * The verb table promises "Undo — always available, for the whole session", and
 * that promise is what makes the other seven verbs safe to press. A user who
 * believes Archive might be irreversible will read every row before acting,
 * which is precisely the inbox behaviour the deck exists to end. Reversibility
 * is not a courtesy here; it is the thing that lets someone move fast.
 *
 * So the stack is deliberately module-level rather than React state: it
 * survives navigation. Archiving on the review pager and then pressing ⌘Z after
 * walking to HQ must work, because from the user's side those are the same
 * session and the same mistake.
 *
 * It is NOT persisted across reloads. An undo entry closes over a live mutation
 * function, and a stack restored from storage would offer buttons that resolve
 * to nothing — a broken promise is worse than an absent one. A reload is a
 * legible boundary; a silently dead button is not.
 */

export interface UndoableAction {
  /** What the user reads: "Archived “Acme one-pager”". Past tense. */
  label: string;
  /** Reverses it. Rejecting leaves the entry on the stack to retry. */
  undo: () => Promise<void>;
}

/**
 * Bounded so a long session cannot grow without limit. Twenty is far past any
 * plausible run of ⌘Z, and the oldest entries are the least likely to be worth
 * reversing.
 */
const MAX_DEPTH = 20;

let stack: UndoableAction[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function pushUndo(action: UndoableAction): void {
  stack = [...stack, action].slice(-MAX_DEPTH);
  emit();
}

/** The entry ⌘Z would reverse, without reversing it. */
export function peekUndo(): UndoableAction | null {
  return stack.length > 0 ? (stack[stack.length - 1] ?? null) : null;
}

/**
 * Reverse the most recent action.
 *
 * The entry is popped BEFORE the undo runs so a slow reversal cannot be fired
 * twice by an impatient second ⌘Z, and restored on failure so the user keeps
 * the ability to retry. Returns what was undone, or null if the stack was
 * empty.
 */
export async function undoLast(): Promise<UndoableAction | null> {
  const action = stack[stack.length - 1];
  if (!action) return null;
  stack = stack.slice(0, -1);
  emit();
  try {
    await action.undo();
    return action;
  } catch (err) {
    stack = [...stack, action].slice(-MAX_DEPTH);
    emit();
    throw err;
  }
}

/** Test seam, and the right thing to call on sign-out. */
export function clearUndoStack(): void {
  stack = [];
  emit();
}

export function subscribeUndo(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function undoDepth(): number {
  return stack.length;
}
