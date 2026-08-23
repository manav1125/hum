/**
 * The sync worker — how a note written with no signal reaches the daemon.
 *
 * Capture already finished before this file runs: the note is durable on the
 * device and the owner has been told so. Everything here is the *later* half,
 * and it obeys three rules that the design states plainly:
 *
 *   1. **No spinner outlives the connection.** There is no retry loop that
 *      burns battery against a dead network. The queue drains when the
 *      browser says it is online and when the app comes back to the front —
 *      real signals, not a timer.
 *   2. **A failed push leaves the queue alone.** The whole point of the queue
 *      is that it survives; clearing it on failure would lose the note that
 *      was hardest to capture.
 *   3. **Ordering is preserved.** Operations replay oldest-first, so an
 *      update never lands before the create it depends on, and a delete
 *      always lands last.
 *
 * Pushes are idempotent by construction — the note carries the id it was
 * minted with, and the daemon's create route returns the existing row rather
 * than duplicating — so a drain interrupted halfway is safe to run again.
 */

import {
  notesByIdDelete,
  notesByIdPatch,
  notesByIdReadPost,
  notesPost,
} from "@/generated/daemon/sdk.gen";

import {
  clearQueue,
  deleteNoteLocally,
  getLocalNote,
  listQueue,
  saveNoteLocally,
  type QueuedOp,
} from "@/stores/note-local-store";

/** What a drain did, for the UI's "3 notes waiting" line. */
export interface DrainResult {
  pushed: number;
  /** Operations still queued — a connection that dropped mid-drain. */
  remaining: number;
}

let draining = false;

/** Whether this device currently believes it can reach anything. */
export function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

/**
 * Push everything waiting, oldest first.
 *
 * Stops at the first failure and leaves the rest queued: a network that just
 * dropped will fail the next one too, and hammering it is exactly the retry
 * loop this design refuses. Single-flight — a second call while a drain is in
 * progress returns immediately rather than racing it.
 */
export async function drainQueue(assistantId: string): Promise<DrainResult> {
  if (draining || !assistantId) return { pushed: 0, remaining: 0 };
  draining = true;
  try {
    const queue = await listQueue();
    if (queue.length === 0) return { pushed: 0, remaining: 0 };

    let pushed = 0;
    for (const [index, op] of queue.entries()) {
      const ok = await pushOne(assistantId, op);
      if (!ok) {
        // Leave the queue as it is. Re-queueing the tail is not needed: the
        // queue was never cleared, so the next drain replays from the top —
        // and every operation is idempotent, so replaying the ones already
        // pushed costs nothing but a round trip.
        return { pushed, remaining: queue.length - index };
      }
      pushed += 1;
    }

    await clearQueue();
    return { pushed, remaining: 0 };
  } finally {
    draining = false;
  }
}

/**
 * Push one operation. Returns false on any failure, which stops the drain.
 *
 * A note that has since been deleted locally is skipped rather than failed —
 * the delete is later in the same queue, and pushing a create for something
 * the owner has already thrown away would resurrect it.
 */
async function pushOne(assistantId: string, op: QueuedOp): Promise<boolean> {
  try {
    switch (op.op) {
      case "create": {
        const local = await getLocalNote(op.noteId);
        if (!local) return true;
        throwOnError(
          await notesPost({
            path: { assistant_id: assistantId },
            body: {
              id: local.id,
              body: local.body,
              title: local.title,
              source: local.source,
              occurredAt: local.occurredAt,
            },
          }),
        );
        await saveNoteLocally({ ...local, pending: false });
        return true;
      }
      case "update": {
        const local = await getLocalNote(op.noteId);
        if (!local) return true;
        throwOnError(
          await notesByIdPatch({
            path: { assistant_id: assistantId, id: op.noteId },
            body: {
              title: local.title,
              body: local.body,
              projectId: local.projectId,
            },
          }),
        );
        await saveNoteLocally({ ...local, pending: false });
        return true;
      }
      case "delete": {
        throwOnError(
          await notesByIdDelete({
            path: { assistant_id: assistantId, id: op.noteId },
          }),
        );
        await deleteNoteLocally(op.noteId);
        return true;
      }
      case "read": {
        // Intelligence queues, by design. A note captured on a plane is read
        // for things to do when the connection is back, not before.
        throwOnError(
          await notesByIdReadPost({
            path: { assistant_id: assistantId, id: op.noteId },
            body: {},
          }),
        );
        return true;
      }
      default:
        return true;
    }
  } catch {
    return false;
  }
}

/**
 * A rejected request counts as a failure here, not only a dropped connection.
 * The honest response to either is the same: leave it queued and show the
 * count. Silently dropping a note because one request was refused is the
 * failure this whole file exists to prevent.
 */
function throwOnError(result: { error?: unknown }): void {
  if (result.error) throw new Error(String(result.error));
}

/**
 * Drain when the connection comes back, and when the app returns to the
 * front. Two event sources rather than a poll: `online` catches the network
 * returning, `visibilitychange` catches the phone being unlocked in a place
 * that has signal — a case `online` alone misses, because the event fired
 * while the tab was asleep.
 *
 * Returns a teardown. Never installs a timer.
 */
export function startNoteSync(assistantId: string): () => void {
  if (typeof window === "undefined") return () => {};

  const attempt = () => {
    if (isOnline()) void drainQueue(assistantId);
  };

  window.addEventListener("online", attempt);
  document.addEventListener("visibilitychange", attempt);
  attempt();

  return () => {
    window.removeEventListener("online", attempt);
    document.removeEventListener("visibilitychange", attempt);
  };
}
