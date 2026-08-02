import type { WatcherEvent } from "./watcher-store.js";

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
 * A decision that recorded events created for the owner.
 *
 * This is the ONE way a `record_only` source is allowed to put something in
 * front of somebody, and it is deliberately not the same shape as a
 * {@link WatcherItem}: an item describes a thing that happened, a decision
 * describes something the owner now has to settle. A provider that cannot say
 * which decision an event creates returns none, and the source stays silent.
 */
export interface WatcherDecision {
  /**
   * Stable dedup key for the decision itself — NOT the id of any one event
   * that contributed to it. Arrivals are idempotent on (channel, externalId),
   * so a decision re-derived on every poll must produce the same key each time
   * or it mints a duplicate row per poll.
   */
  externalId: string;
  /** The decision, phrased as the work: "Resolve the …". */
  title: string;
  /** One line of evidence behind it. */
  snippet: string;
  /** Why this was worth surfacing, in the owner's words. */
  reason: string;
  /** Which deterministic rule fired, for the arrivals audit. */
  ruleId: string;
  /** Coarse kind, recorded on the item's notes so provenance survives. */
  kind: string;
}

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
   * A narrow allowlist on top of `record_only`: given the events just recorded,
   * which of them created a DECISION the owner has to make?
   *
   * Only consulted for a `record_only` source, and the default remains "mint
   * nothing" — a provider that does not implement this stays silent forever,
   * and one that does may still return an empty array, which is the expected
   * answer on almost every poll. Throwing is treated as "no decisions": this
   * path is the exception to intake's usual fail-open bias, because a wrong
   * mint here is the failure mode the pin exists to prevent.
   *
   * `events` are the rows already written to `watcher_events`, so a provider
   * that needs more than the recorded payload (the other half of a conflict
   * never changed, so it is not in the sync feed) must go and fetch it.
   */
  decisionsFrom?(
    credentialService: string,
    events: readonly WatcherEvent[],
  ): Promise<WatcherDecision[]>;

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
