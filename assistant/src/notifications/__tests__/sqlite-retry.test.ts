/**
 * The notification pipeline's contention retry (retry half of upstream
 * b357993692).
 *
 * A lost notification is unrecoverable — by the time `SQLITE_BUSY` surfaces
 * the producer that authored the signal has already returned — so the
 * event-persist write must survive transient contention from the other
 * process writing this database (the memory worker's bulk writes).
 */
import { describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";

const loggerActual = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...loggerActual,
  getLogger: () => makeMockLogger(),
}));

const { isTransientSqliteError, withSqliteRetry } =
  await import("../sqlite-retry.js");

/** A `bun:sqlite`-shaped error: the code rides on `.code`. */
function sqliteError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

const FAST = { op: "test-op", baseDelayMs: 1 };

describe("isTransientSqliteError", () => {
  test("matches BUSY and IOERR by prefix, including extended result codes", () => {
    expect(isTransientSqliteError(sqliteError("SQLITE_BUSY"))).toBe(true);
    expect(isTransientSqliteError(sqliteError("SQLITE_BUSY_SNAPSHOT"))).toBe(
      true,
    );
    expect(isTransientSqliteError(sqliteError("SQLITE_IOERR_WRITE"))).toBe(
      true,
    );
  });

  test("does not match genuine failures, or non-SQLite errors", () => {
    expect(isTransientSqliteError(sqliteError("SQLITE_CONSTRAINT"))).toBe(
      false,
    );
    expect(isTransientSqliteError(new Error("boom"))).toBe(false);
    expect(isTransientSqliteError(null)).toBe(false);
    expect(isTransientSqliteError(undefined)).toBe(false);
    // A non-string `code` must not be treated as a match.
    expect(isTransientSqliteError({ code: 5 })).toBe(false);
  });
});

describe("withSqliteRetry", () => {
  test("returns the value without retrying when the write succeeds", async () => {
    let calls = 0;
    const result = await withSqliteRetry(() => {
      calls++;
      return "row";
    }, FAST);

    expect(result).toBe("row");
    expect(calls).toBe(1);
  });

  test("retries a transient error and returns the eventual success", async () => {
    let calls = 0;
    const result = await withSqliteRetry(() => {
      calls++;
      if (calls < 3) throw sqliteError("SQLITE_BUSY");
      return "row";
    }, FAST);

    expect(result).toBe("row");
    expect(calls).toBe(3);
  });

  test("a null return (the dedupe signal) is a success, not a retry", async () => {
    // `createEvent` returns null when the dedupe key already exists. That is
    // a real answer; retrying it would re-run the write for no reason.
    let calls = 0;
    const result = await withSqliteRetry(() => {
      calls++;
      return null;
    }, FAST);

    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  test("a non-transient error propagates on the first attempt", async () => {
    let calls = 0;
    await expect(
      withSqliteRetry(() => {
        calls++;
        throw sqliteError("SQLITE_CONSTRAINT");
      }, FAST),
    ).rejects.toThrow("SQLITE_CONSTRAINT");

    expect(calls).toBe(1);
  });

  test("a transient error surviving every attempt propagates, bounded by maxRetries", async () => {
    let calls = 0;
    await expect(
      withSqliteRetry(
        () => {
          calls++;
          throw sqliteError("SQLITE_BUSY");
        },
        { ...FAST, maxRetries: 2 },
      ),
    ).rejects.toThrow("SQLITE_BUSY");

    // Initial attempt plus two retries.
    expect(calls).toBe(3);
  });

  test("awaits an async write and retries it the same way", async () => {
    let calls = 0;
    const result = await withSqliteRetry(async () => {
      calls++;
      if (calls === 1) throw sqliteError("SQLITE_IOERR");
      return "row";
    }, FAST);

    expect(result).toBe("row");
    expect(calls).toBe(2);
  });
});
