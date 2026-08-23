/**
 * The local note store — where a note lands **before** anything touches the
 * network.
 *
 * Lives in `stores/` rather than inside `domains/notes` because capture is
 * not the Notes page's private business — the floating corner writes notes
 * too, and the iOS capture doors will.
 *
 * Notes is the most offline-critical surface in the product: lifts, planes,
 * walking, the Tube. So the split is drawn explicitly and enforced here:
 *
 *   **Works with no signal** — writing, editing, deleting, and reading back
 *   everything already on this device.
 *   **Queues** — finding things to do, asking questions, filing to a project.
 *
 * A note therefore exists the instant you stop writing, and the sentence the
 * UI prints first is "your note is saved", because by then it is — on this
 * device, in IndexedDB, with an id it will keep forever. The daemon push is a
 * later, separate, retryable step ({@link ./note-sync}).
 *
 * ## Why an id is minted here
 *
 * The note gets its id on the device that wrote it. That makes the eventual
 * push idempotent — the daemon's create route accepts a client id and returns
 * the existing row rather than duplicating — which is what lets the queue
 * retry freely without ever producing two copies of one thought.
 *
 * ## Why this is not a cache
 *
 * A cache may be dropped. This may not: between writing a note on a plane and
 * landing, this store is the ONLY copy that exists. Nothing in here evicts,
 * expires or trims, and `pending` rows are cleared only once the daemon has
 * confirmed the write.
 */

import type { Note } from "@/types/notes";

const DB_NAME = "cue-notes";
const DB_VERSION = 1;
const NOTE_STORE = "notes";
const QUEUE_STORE = "queue";

/** What still has to reach the daemon. Order is the order it was done in. */
export type QueuedOp =
  | { op: "create"; noteId: string; at: number }
  | { op: "update"; noteId: string; at: number }
  | { op: "delete"; noteId: string; at: number }
  /** "Read this for things to do" — queued, because intelligence needs a network. */
  | { op: "read"; noteId: string; at: number };

/** A note as this device holds it, plus whether the daemon knows about it. */
export interface LocalNote extends Note {
  /**
   * True until the daemon has confirmed this note. Drives the "saved on this
   * device" line — never a spinner, because there is nothing to wait for.
   */
  pending: boolean;
}

/**
 * IndexedDB is unavailable in three real situations — SSR, tests, and Safari
 * private windows — and in every one of them capture must still work. The
 * fallback is an in-memory map: the note survives the session rather than the
 * relaunch, which is worse than durable and far better than refusing to save.
 */
const memoryNotes = new Map<string, LocalNote>();
const memoryQueue: QueuedOp[] = [];

let dbPromise: Promise<IDBDatabase> | null = null;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * How long to wait for the database to open before giving up on it.
 *
 * `indexedDB.open` has two ways to never answer: `onblocked`, when another
 * tab holds an older version open, and a handful of environments (private
 * windows, some custom protocol origins) where it simply stalls. Neither
 * fires `onerror`, so without this the promise hangs forever — and a hanging
 * store means the page waits forever, which is the one thing a capture
 * surface must never do. On timeout the caller falls through to the
 * in-memory fallback: the note is still saved, just not across a relaunch.
 */
const DB_OPEN_TIMEOUT_MS = 3_000;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new Error("indexedDB.open timed out — using memory")),
        ),
      DB_OPEN_TIMEOUT_MS,
    );
    const done =
      <T>(fn: (value: T) => void) =>
      (value: T) =>
        settle(() => {
          clearTimeout(timer);
          fn(value);
        });

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // Some origins throw synchronously rather than firing `onerror`.
      settle(() => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(NOTE_STORE)) {
        db.createObjectStore(NOTE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { autoIncrement: true });
      }
    };
    request.onsuccess = () => done(resolve)(request.result);
    request.onerror = () =>
      done(reject)(request.error ?? new Error("indexedDB.open failed"));
    // Another tab holds an older version open. It will not resolve on its
    // own, so treat it as unavailable rather than waiting on a stranger.
    request.onblocked = () =>
      done(reject)(new Error("indexedDB.open blocked by another tab"));
  });
  // A rejected open is memoised like any other, which is intended: one failed
  // open means this environment has no IndexedDB, and retrying it on every
  // keystroke would cost far more than the fallback does.
  dbPromise.catch(() => {});
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = run(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

/** Mint an id on this device. The note keeps it forever, online or not. */
export function mintNoteId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `note-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Write a note locally. Resolves as soon as it is durable on this device —
 * **never awaits the network**, which is the whole contract.
 */
export async function saveNoteLocally(note: LocalNote): Promise<void> {
  if (!hasIndexedDb()) {
    memoryNotes.set(note.id, note);
    return;
  }
  try {
    await tx(NOTE_STORE, "readwrite", (store) => store.put(note));
  } catch {
    // A failed local write must not lose the note either. The in-memory copy
    // keeps it for this session, and the queue still carries it to the daemon.
    memoryNotes.set(note.id, note);
  }
}

export async function getLocalNote(id: string): Promise<LocalNote | null> {
  if (!hasIndexedDb()) return memoryNotes.get(id) ?? null;
  try {
    const found = await tx<LocalNote | undefined>(NOTE_STORE, "readonly", (s) =>
      s.get(id),
    );
    return found ?? memoryNotes.get(id) ?? null;
  } catch {
    return memoryNotes.get(id) ?? null;
  }
}

/**
 * Every note this device holds, newest thought first — the offline list.
 *
 * This is "reading everything already on the phone", which the split says
 * works with no signal. It reads local rows only and never touches the
 * network, so it cannot hang on a dead connection.
 */
export async function listLocalNotes(): Promise<LocalNote[]> {
  let rows: LocalNote[];
  if (!hasIndexedDb()) {
    rows = [...memoryNotes.values()];
  } else {
    try {
      rows = await tx<LocalNote[]>(NOTE_STORE, "readonly", (s) => s.getAll());
    } catch {
      rows = [...memoryNotes.values()];
    }
  }
  return rows.sort((a, b) => b.occurredAt - a.occurredAt);
}

export async function deleteNoteLocally(id: string): Promise<void> {
  memoryNotes.delete(id);
  if (!hasIndexedDb()) return;
  try {
    await tx(NOTE_STORE, "readwrite", (store) => store.delete(id));
  } catch {
    // Already gone from memory; the queued delete still reaches the daemon.
  }
}

/**
 * Mirror the daemon's copy of a note into the local store.
 *
 * Called after every successful fetch, so the offline list is the last thing
 * the daemon said rather than only the notes this device happened to write.
 * A note still `pending` locally is NOT overwritten — an unsent local edit
 * must outrank a stale server row, or syncing would silently undo the last
 * thing someone typed.
 */
export async function mirrorServerNotes(notes: Note[]): Promise<void> {
  for (const note of notes) {
    const local = await getLocalNote(note.id);
    if (local?.pending) continue;
    await saveNoteLocally({ ...note, pending: false });
  }
}

// -- The queue ---------------------------------------------------------------

export async function enqueue(op: QueuedOp): Promise<void> {
  if (!hasIndexedDb()) {
    memoryQueue.push(op);
    return;
  }
  try {
    await tx(QUEUE_STORE, "readwrite", (store) => store.add(op));
  } catch {
    memoryQueue.push(op);
  }
}

/** Everything still waiting to reach the daemon, oldest first. */
export async function listQueue(): Promise<QueuedOp[]> {
  if (!hasIndexedDb()) return [...memoryQueue];
  try {
    const rows = await tx<QueuedOp[]>(QUEUE_STORE, "readonly", (s) =>
      s.getAll(),
    );
    return [...rows, ...memoryQueue].sort((a, b) => a.at - b.at);
  } catch {
    return [...memoryQueue];
  }
}

/**
 * Drop the queue.
 *
 * Called only after a drain in which every operation either succeeded or was
 * discarded deliberately — never on a network failure, which must leave the
 * queue exactly as it was so the next drain retries it.
 */
export async function clearQueue(): Promise<void> {
  memoryQueue.length = 0;
  if (!hasIndexedDb()) return;
  try {
    await tx(QUEUE_STORE, "readwrite", (store) => store.clear());
  } catch {
    // Nothing to do — an unclearable queue retries, which is the safe way to
    // be wrong.
  }
}

/** Test seam: forget everything this device holds. */
export async function _resetLocalStoreForTests(): Promise<void> {
  memoryNotes.clear();
  memoryQueue.length = 0;
  if (!hasIndexedDb()) return;
  try {
    await tx(NOTE_STORE, "readwrite", (store) => store.clear());
    await tx(QUEUE_STORE, "readwrite", (store) => store.clear());
  } catch {
    // Already empty enough.
  }
}
