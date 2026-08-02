/** A single event detected by a watcher provider. */
export interface WatcherItem {
  /** Provider-specific dedup key (e.g. Gmail message ID). */
  externalId: string;
  /** Event category (e.g. 'new_email'). */
  eventType: string;
  /** One-line human-readable summary. */
  summary: string;
  /** Full event data for LLM processing. */
  payload: Record<string, unknown>;
  /** When the event occurred (epoch ms). */
  timestamp: number;
}

/** Result of a provider fetch call. */
export interface FetchResult {
  items: WatcherItem[];
  /** Opaque cursor for the next fetch. */
  watermark: string;
}

/**
 * What the engine does with the events a watcher detects.
 *
 *  · `came_in`     — put each event through the relevance gate: a playbook
 *                    claims it, it becomes a work item in the Came-in lane, or
 *                    it is filed away with a reason. This is what mints work.
 *  · `agent`       — the legacy path: one background LLM conversation per tick
 *                    per watcher, driven by the watcher's `action_prompt`.
 *  · `record_only` — record the event in `watcher_events` and stop. No work
 *                    item, no arrival, no LLM call, no notification. The
 *                    change stream is kept (it is the substrate a narrower
 *                    rule can later read) but nothing is put in front of the
 *                    owner.
 */
export type WatcherIntakeMode = "came_in" | "agent" | "record_only";

/**
 * A watcher provider adapts an external API into the watcher system.
 * Each provider knows how to poll for new events and track its position.
 */
export interface WatcherProvider {
  /** Unique provider key (e.g. 'gmail', 'stripe'). */
  id: string;
  /** Human-readable name. */
  displayName: string;
  /** Credential service required (e.g. 'google'). */
  requiredCredentialService: string;

  /**
   * Intake mode this provider PINS, overriding whatever the watcher row says.
   *
   * Almost no provider should set this: intake is normally the owner's choice
   * per watcher. It exists for sources where "what this event is" is settled
   * by the source itself rather than by configuration — a calendar event is
   * something you attend, not something in a queue, whichever watcher row
   * happens to point at the calendar.
   *
   * Pinning here rather than only in `auto-provision` is deliberate: the mode
   * is a property of the source, so a row that already exists with the wrong
   * mode (or one a user edits later) is corrected by deploying code, with no
   * data migration and no window in which the old behaviour can fire again.
   */
  pinnedIntakeMode?: WatcherIntakeMode;

  /**
   * Fetch new events since the given watermark.
   * Returns new items and an updated watermark.
   *
   * `watcherKey` is the unique watcher instance ID (e.g. the DB row UUID).
   * Providers that maintain per-watcher in-process state (like the Linear
   * issue-state cache) must key that state by `watcherKey` — not just
   * `credentialService` — so that multiple watchers sharing the same
   * credential maintain independent baselines.
   */
  fetchNew(
    credentialService: string,
    watermark: string | null,
    config: Record<string, unknown>,
    watcherKey: string,
  ): Promise<FetchResult>;

  /**
   * Get the initial watermark (start from "now" so we don't replay history).
   */
  getInitialWatermark(credentialService: string): Promise<string>;

  /**
   * Release any in-process state held for a watcher instance.
   * Called only when a watcher is truly deleted so that providers with
   * per-watcher caches (e.g. the Linear issue-state map) can evict the
   * stale entry and prevent unbounded memory growth.
   *
   * Must NOT be called on circuit-breaker auto-disable — that path is
   * reversible, and clearing state would cause missed events on re-enable.
   *
   * Optional — providers with no per-watcher state need not implement this.
   */
  cleanup?(watcherKey: string): void;
}
