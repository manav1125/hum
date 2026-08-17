/**
 * "Have I done this one yet?" — the slot's memory, and the reason it stops
 * asking.
 *
 * Read and dismissed are the two things that collapse the slot to one row, and
 * both are per-PERIOD facts: today's brief, this week's review. Keying on the
 * period rather than on a bare boolean is what makes tomorrow's brief ask
 * again without anything having to reset it, and it is why "Later" cannot
 * accidentally silence the ritual forever.
 *
 * **Why the client owns this and not the daemon.** There is no read-receipt
 * anywhere in the brief or weekly contract, and inventing an endpoint for it
 * would be a second source of truth for a fact whose only consumer is one card
 * on one device. It is device-local on purpose: reading the brief on the phone
 * should not collapse it on the Mac, because the two are different mornings.
 *
 * **Marking read is the "one door" half.** `markRitualRead` is called by the
 * slot when the CTA is pressed *and* by the Brief and Weekly pages themselves
 * on mount — so an owner who arrives from the push, never seeing the slot, is
 * still recorded as having read it. If only the slot marked it, the push and
 * the slot would be two doors that disagree about whether you had walked
 * through.
 *
 * Storage failures (Safari private mode, a full quota, a disabled store) are
 * swallowed and read back as "not done": asking twice is a small annoyance,
 * throwing out of Today's render is not.
 */

export type RitualKind = "brief" | "weekly";

export interface RitualProgress {
  read: boolean;
  dismissed: boolean;
}

export const NO_PROGRESS: RitualProgress = { read: false, dismissed: false };

const PREFIX = "cue.mv3.ritual.";

/** Local `YYYY-MM-DD` — never `toISOString`, which is UTC and shifts the day. */
function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Which brief / which review.
 *
 * The brief's period is the day. The weekly's is the WEEK the Friday opened —
 * so Friday evening, Saturday and Sunday all resolve to the same key, and
 * dismissing on Friday keeps it dismissed on Sunday. Sunday (day 0) belongs to
 * the Friday two days behind it, not the one five days ahead.
 */
export function periodKey(kind: RitualKind, now: Date): string {
  if (kind === "brief") return dateKey(now);
  const day = now.getDay();
  // Distance back to the Friday that opened this window: Fri 0, Sat 1, Sun 2.
  const back = day === 5 ? 0 : day === 6 ? 1 : 2;
  const friday = new Date(now);
  friday.setDate(friday.getDate() - back);
  return dateKey(friday);
}

function storageKey(kind: RitualKind, period: string): string {
  return `${PREFIX}${kind}.${period}`;
}

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Subscription — so "Later" collapses the card without a route change        */
/* ------------------------------------------------------------------------- */

const listeners = new Set<() => void>();
let version = 0;

export function subscribeRitualProgress(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The `useSyncExternalStore` snapshot. Its value means nothing; its CHANGING
 * is the entire contract, and it is a scalar so React's identity check is not
 * fighting a freshly-built object on every render.
 */
export function ritualProgressVersion(): number {
  return version;
}

function announce(): void {
  version += 1;
  for (const fn of listeners) fn();
}

/* ------------------------------------------------------------------------- */
/* Read / write                                                              */
/* ------------------------------------------------------------------------- */

export function readRitualProgress(
  kind: RitualKind,
  now: Date,
): RitualProgress {
  const s = store();
  if (!s) return NO_PROGRESS;
  try {
    const raw = s.getItem(storageKey(kind, periodKey(kind, now)));
    if (!raw) return NO_PROGRESS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return NO_PROGRESS;
    const o = parsed as Record<string, unknown>;
    return { read: o.read === true, dismissed: o.dismissed === true };
  } catch {
    return NO_PROGRESS;
  }
}

function write(kind: RitualKind, now: Date, patch: Partial<RitualProgress>) {
  const s = store();
  if (!s) return;
  const period = periodKey(kind, now);
  const next = { ...readRitualProgress(kind, now), ...patch };
  try {
    s.setItem(storageKey(kind, period), JSON.stringify(next));
    prune(s, kind, period);
  } catch {
    // A store that will not take a write is a slot that asks twice. Fine.
  }
  announce();
}

/**
 * Drop this ritual's older periods on every write.
 *
 * Without it the key set grows by one a day forever — small, but it is the
 * kind of small that shows up years later as a quota error on the write that
 * mattered.
 */
function prune(s: Storage, kind: RitualKind, keep: string): void {
  const stale: string[] = [];
  const mine = `${PREFIX}${kind}.`;
  for (let i = 0; i < s.length; i += 1) {
    const key = s.key(i);
    if (key && key.startsWith(mine) && key !== storageKey(kind, keep)) {
      stale.push(key);
    }
  }
  for (const key of stale) s.removeItem(key);
}

/* ------------------------------------------------------------------------- */
/* R5 — has this owner met a brief before?                                    */
/* ------------------------------------------------------------------------- */

/**
 * The date of the first morning a brief was shown to this owner.
 *
 * Design's R5 is "one extra boolean (*has this owner seen a brief before*),
 * not a new state machine" — and a date IS that boolean, with the one thing a
 * bare flag cannot carry: *when*. The "first brief" face is owed a whole
 * morning, so it has to survive the owner reading it, closing the app and
 * coming back an hour later; a flag set on first render would take the face
 * away mid-morning, and a flag set on read would leave it up all week for
 * somebody who never opened it. Storing the day answers both.
 *
 * It sits OUTSIDE the `cue.mv3.ritual.<kind>.` namespace on purpose: `prune`
 * deletes every key under that prefix except the current period, which is
 * exactly what must not happen to a fact whose whole job is to outlive its day.
 */
const FIRST_BRIEF_KEY = `${PREFIX}first-brief`;

/** The stored morning, or `null` if no brief has ever been shown here. */
export function readFirstBriefMorning(): string | null {
  const s = store();
  if (!s) return null;
  try {
    return s.getItem(FIRST_BRIEF_KEY);
  } catch {
    return null;
  }
}

/**
 * Record that today is the morning the first brief was shown. Idempotent — a
 * second call on a later day must not move the stamp forward, or the
 * introduction would replay every time the deck happened to look new.
 */
export function markFirstBriefMorning(now: Date = new Date()): void {
  const s = store();
  if (!s) return;
  try {
    if (s.getItem(FIRST_BRIEF_KEY)) return;
    s.setItem(FIRST_BRIEF_KEY, dateKey(now));
  } catch {
    // A store that will not take the stamp re-introduces Cue tomorrow. A small
    // and rather charming failure compared with throwing out of Today.
    return;
  }
  announce();
}

/**
 * R5's boolean. False on a brand-new instance AND for the whole of the first
 * morning itself — that morning belongs to the "first brief" face.
 */
export function hasSeenBrief(now: Date = new Date()): boolean {
  const first = readFirstBriefMorning();
  return first !== null && first !== dateKey(now);
}

/** They opened it — from the slot, from the ⋯ archive, or from the push. */
export function markRitualRead(kind: RitualKind, now: Date = new Date()): void {
  write(kind, now, { read: true });
}

/** They pressed "Later". Not gone — quiet. */
export function dismissRitual(kind: RitualKind, now: Date = new Date()): void {
  write(kind, now, { dismissed: true });
}
