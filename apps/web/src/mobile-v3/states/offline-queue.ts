/**
 * The offline queue — the promise that makes acting offline safe.
 *
 * v28 · K1: "what's queued (EACH UNDOABLE — the promise that makes acting
 * offline safe)". Undoable is the load-bearing word. A queue you cannot take
 * something out of is worse than no queue: it turns a mis-tap on the tube into
 * a send you get to watch happen forty minutes later.
 *
 * So the contract is:
 *
 *   · **Enqueue** parks the action locally, durably, with the user's own words.
 *   · **Undo** removes it BEFORE it ever runs. After it has run it is not undo
 *     any more, it is a second action, and this module will not pretend
 *     otherwise — a flushed item leaves the queue and stops offering the word.
 *   · **Flush** replays through a registered handler. An action whose handler
 *     is not registered STAYS QUEUED and says so. It is never dropped, and it
 *     is never reported as sent. A no-op is not a success.
 *
 * Storage is localStorage, not memory: the whole point is surviving the app
 * being killed in a tunnel.
 */
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";

const QUEUE_KEY = "cue:offline:queue:v1";

/** The eight verbs, narrowed to the ones that can be taken offline. */
export type OfflineVerb =
  | "approve"
  | "capture"
  | "archive"
  | "file"
  | "handoff"
  | "later";

export interface QueuedAction {
  id: string;
  /** What the user did, in words they will recognise. Shown verbatim. */
  label: string;
  verb: OfflineVerb;
  /** Epoch ms. Drives the "2 min ago" line — computed, never stored as text. */
  queuedAt: number;
  /** How to replay it. Opaque to this module; the handler owns the shape. */
  replay: { kind: string; payload: unknown };
}

export interface FlushReport {
  sent: QueuedAction[];
  /** Ran and failed. Stay queued; the user is told. */
  failed: QueuedAction[];
  /** No handler registered for the kind. Stay queued; the user is told. */
  unhandled: QueuedAction[];
}

type ReplayHandler = (payload: unknown) => Promise<void>;

const handlers = new Map<string, ReplayHandler>();
const listeners = new Set<() => void>();

/**
 * Register how a queued kind is replayed. The surface that enqueues an action
 * owns its replay — this module only guarantees the ordering and the undo.
 */
export function registerOfflineReplay(
  kind: string,
  handler: ReplayHandler,
): () => void {
  handlers.set(kind, handler);
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind);
  };
}

/** True when this kind can actually be replayed. Used by the honest copy. */
export function hasOfflineReplay(kind: string): boolean {
  return handlers.has(kind);
}

function read(): QueuedAction[] {
  try {
    const raw = getLocalSetting(QUEUE_KEY, "");
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isQueuedAction);
  } catch {
    // A corrupt queue is not an empty queue, but it is also not recoverable.
    // Returning [] here is the only option; it is never written back over the
    // stored value unless the caller mutates, so a partial parse failure does
    // not destroy what is there.
    return [];
  }
}

function isQueuedAction(value: unknown): value is QueuedAction {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.verb === "string" &&
    typeof v.queuedAt === "number" &&
    !!v.replay &&
    typeof (v.replay as Record<string, unknown>).kind === "string"
  );
}

function write(next: QueuedAction[]): void {
  setLocalSetting(QUEUE_KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

export function readOfflineQueue(): QueuedAction[] {
  return read();
}

export function subscribeOfflineQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for `useSyncExternalStore` — recomputed only on change. */
let snapshot: QueuedAction[] = read();
let snapshotDirty = true;
listeners.add(() => {
  snapshotDirty = true;
});

export function offlineQueueSnapshot(): QueuedAction[] {
  if (snapshotDirty) {
    snapshot = read();
    snapshotDirty = false;
  }
  return snapshot;
}

export function enqueueOfflineAction(
  action: Omit<QueuedAction, "id" | "queuedAt"> & { id?: string; queuedAt?: number },
): QueuedAction {
  const entry: QueuedAction = {
    id: action.id ?? `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    label: action.label,
    verb: action.verb,
    queuedAt: action.queuedAt ?? Date.now(),
    replay: action.replay,
  };
  write([...read(), entry]);
  return entry;
}

/**
 * Take an action back out. Returns the removed entry, or `null` when it was
 * not there — a caller that gets `null` must not tell the user it undid
 * anything.
 */
export function undoOfflineAction(id: string): QueuedAction | null {
  const current = read();
  const found = current.find((a) => a.id === id) ?? null;
  if (!found) return null;
  write(current.filter((a) => a.id !== id));
  return found;
}

export function clearOfflineQueue(): void {
  write([]);
}

/**
 * Replay everything that can be replayed, oldest first.
 *
 * Ordering is preserved on purpose: "archive these two, then approve the reply"
 * and the reverse are different outcomes. Anything that fails or has no handler
 * is left in the queue in its original order.
 */
export async function flushOfflineQueue(): Promise<FlushReport> {
  const report: FlushReport = { sent: [], failed: [], unhandled: [] };
  const current = read();
  const keep: QueuedAction[] = [];

  for (const action of current) {
    const handler = handlers.get(action.replay.kind);
    if (!handler) {
      report.unhandled.push(action);
      keep.push(action);
      continue;
    }
    try {
      await handler(action.replay.payload);
      report.sent.push(action);
    } catch {
      report.failed.push(action);
      keep.push(action);
    }
  }

  if (keep.length !== current.length) write(keep);
  return report;
}

/** "2 min ago" / "just now". Computed from the timestamp — never a stored string. */
export function queuedAgo(queuedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - queuedAt) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}
