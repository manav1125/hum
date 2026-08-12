import type { UntrustedContentSource } from "../security/untrusted-content.js";
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
  /**
   * When the event occurred at the SOURCE (epoch ms), or null when the
   * provider did not give one.
   *
   * Null rather than `Date.now()` on purpose. This is persisted as
   * `watcher_events.occurred_at` / `arrivals.occurred_at` and read as the
   * answer to "how long since this person wrote", so substituting the current
   * time turns a missing fact into a confident wrong one — and a wrong one
   * that always reads as "just now", which is the direction that silences a
   * real signal rather than raising a false one. A null is skippable; a
   * plausible lie is not detectable.
   */
  timestamp: number | null;
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
 * What one poll of a `record_only` source concluded.
 *
 * Two halves, because a source that can mint work must also be able to say
 * when that work is over. A detector that only ever adds turns the lane into a
 * pile: a conflict key is deliberately idempotent forever, so without the
 * second half the row outlives the clash and the owner is left dismissing
 * items about meetings they already moved.
 */
export interface WatcherDecisionSet {
  /** Decisions this poll's changes created. Empty is the normal answer. */
  decisions: WatcherDecision[];
  /**
   * Keys from `openKeys` the source can now PROVE are settled. Retiring hides
   * a row, so this must never carry a guess: a provider that could not read
   * enough to be sure returns none of them, and every item stays visible.
   */
  resolved: string[];
}

/**
 * What a watcher is actually pointed at, in one sentence the owner can read.
 *
 * This exists because a watcher row records HOW to poll (provider, credential,
 * interval) and nowhere records WHAT it polls, so the surface had nothing
 * truthful to show and showed the poll clock instead — a watcher with nothing
 * to watch is indistinguishable from a busy one. The provider is the only thing
 * that knows whether its config is sufficient, so it is the thing that answers.
 *
 * `watching: false` is a hard claim: this watcher CANNOT produce, whatever the
 * credential says. It must never be inferred from an empty result — a source
 * can be correctly configured and quiet — only from config the provider knows
 * it needs and does not have.
 */
export interface WatcherScope {
  /** False when there is nothing to poll: the watcher can never produce. */
  watching: boolean;
  /** One sentence naming what it polls, or what is missing when it can't. */
  summary: string;
  /** When `watching` is false, the one thing that would fix it. */
  fix?: string;
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
   * Which `<external_content>` source label this provider's events carry when
   * the engine fences them for the LLM. Selects the wording the model sees and
   * the per-source budget in `security/untrusted-content.ts`.
   *
   * Optional: the engine falls back to `"webhook"` so a provider that forgets
   * to declare one is still fenced. Nothing a provider returns is
   * assistant-authored, so there is no opt-out.
   */
  untrustedContentSource?: UntrustedContentSource;

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
   * Say what a watcher with this config is pointed at — see {@link WatcherScope}.
   *
   * Optional only so a provider that has not been taught to answer keeps
   * working; the list route falls back to a sentence that claims nothing beyond
   * the credential. A provider that requires configuration to poll anything
   * SHOULD implement this, because it is the only place that can tell the owner
   * their watcher is inert before they wait a week for a hit that cannot come.
   */
  describeScope?(config: Record<string, unknown>): WatcherScope;

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
   *
   * `openKeys` are the decision keys already in front of the owner. They are
   * passed in rather than looked up because the provider owns the only thing
   * that can settle them — the source's current state, which it is already
   * fetching for the first half of the answer.
   */
  decisionsFrom?(
    credentialService: string,
    events: readonly WatcherEvent[],
    openKeys: readonly string[],
  ): Promise<WatcherDecisionSet>;

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
