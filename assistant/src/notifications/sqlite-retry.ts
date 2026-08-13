/**
 * Retry helper for transient SQLite write contention on the notification
 * pipeline's writes (port of the retry half of upstream b357993692).
 *
 * SQLite serializes writers at the database level: only one connection holds
 * the write lock at a time. `PRAGMA busy_timeout` makes a contending writer
 * *wait* for the lock, but it cannot rescue a statement that still loses the
 * race (the wait elapses) or a transaction that begins as a reader and then
 * fails to upgrade to a writer. Both surface as `SQLITE_BUSY`; transient disk
 * errors surface as `SQLITE_IOERR`. The only correct recovery for either is to
 * re-run the whole operation.
 *
 * This matters more here than on most write paths because a lost notification
 * is unrecoverable: by the time contention surfaces, the producer that
 * authored the signal has already returned, so there is nobody left to retry
 * it. The concrete contender on this instance is the memory worker's bulk
 * writes, which run on their own process against the same database.
 *
 * The wrapped function may be sync (a `bun:sqlite` statement) or async; it is
 * always awaited. It must be safe to re-run: a single statement, or a sequence
 * guarded so re-execution is idempotent. Do not wrap a partial sequence whose
 * earlier statements already committed, since a retry would double-apply them.
 *
 * NOTE: upstream keeps this helper at `src/util/sqlite-retry.ts`, shared with
 * the conversation loop and scheduler. This fork's equivalent write paths
 * (e.g. `memory/conversation-crud.ts`) still carry hand-rolled retry loops.
 * When those are unified, hoist this module to `util/` and drop the copy.
 */

import { getLogger } from "../util/logger.js";
import { computeRetryDelay, sleep } from "../util/retry.js";

const log = getLogger("notifications-sqlite-retry");

const DEFAULT_MAX_RETRIES = 3;
/** Base for the jittered backoff; busy_timeout absorbs the bulk of the wait. */
const DEFAULT_BASE_DELAY_MS = 50;

export interface SqliteRetryOptions {
  /** Short identifier for the wrapped operation, used in retry logs. */
  op: string;
  /** Maximum retry attempts after the initial try (default 3). */
  maxRetries?: number;
  /** Base delay in ms for the jittered backoff (default 50). */
  baseDelayMs?: number;
  /** Extra structured fields to include in retry warnings (e.g. an id). */
  context?: Record<string, unknown>;
}

function sqliteErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

/**
 * Whether an error is a transient SQLite contention/IO error worth retrying.
 * Matches on prefix because SQLite reports extended result codes
 * (`SQLITE_BUSY_SNAPSHOT`, `SQLITE_IOERR_WRITE`, ...).
 */
export function isTransientSqliteError(err: unknown): boolean {
  const code = sqliteErrorCode(err);
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_IOERR");
}

/**
 * Run `fn`, retrying transient SQLite contention with jittered backoff.
 * Non-transient errors propagate on the first attempt; a transient error that
 * survives every attempt propagates too, so callers keep their own failure
 * handling.
 */
export async function withSqliteRetry<T>(
  fn: () => T | Promise<T>,
  options: SqliteRetryOptions,
): Promise<T> {
  const {
    op,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    context = {},
  } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isTransientSqliteError(err)) {
        throw err;
      }
      const delayMs = computeRetryDelay(attempt, baseDelayMs);
      log.warn(
        {
          ...context,
          op,
          attempt: attempt + 1,
          maxRetries,
          delayMs: Math.round(delayMs),
          code: sqliteErrorCode(err),
        },
        "Transient SQLite contention; retrying",
      );
      await sleep(delayMs);
    }
  }
}
