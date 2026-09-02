import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { readUsageRecords } from '@/lib/server/usage-storage';

const log = createLogger('UsageRecordsAPI');

const MAX_LIMIT = 2000;

/** Months (YYYY-MM) from the month containing `sinceMs` through now. */
function monthsSince(sinceMs: number): string[] {
  const months: string[] = [];
  const cursor = new Date(sinceMs > 0 ? sinceMs : Date.now());
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  const now = new Date();
  while (
    cursor.getUTCFullYear() < now.getUTCFullYear() ||
    (cursor.getUTCFullYear() === now.getUTCFullYear() &&
      cursor.getUTCMonth() <= now.getUTCMonth())
  ) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

/**
 * GET /api/usage/records?since=<epoch-ms>&limit=<n>
 *
 * Raw usage records strictly newer than `since`, oldest first, capped at
 * `limit` (default/max 2000). Built for the Cue usage bridge: the Cue daemon
 * polls this and folds the rows into its own ledger, cursoring on the last
 * record's `createdAt` (`nextSince`). Records carry stable ids, so the
 * importer can also dedupe idempotently.
 */
export async function GET(req: NextRequest) {
  try {
    const sinceRaw = req.nextUrl.searchParams.get('since');
    const since = sinceRaw ? Number(sinceRaw) : 0;
    if (!Number.isFinite(since) || since < 0) {
      return apiError('INVALID_REQUEST', 400, 'since must be a non-negative epoch-ms number');
    }
    const limitRaw = req.nextUrl.searchParams.get('limit');
    const limit = Math.min(MAX_LIMIT, Math.max(1, limitRaw ? Number(limitRaw) || MAX_LIMIT : MAX_LIMIT));

    const records = (await readUsageRecords({ months: monthsSince(since) }))
      .filter((r) => r.createdAt > since)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);

    return apiSuccess({
      records,
      nextSince: records.length > 0 ? records[records.length - 1].createdAt : since,
      hasMore: records.length === limit,
    });
  } catch (error) {
    log.error('Usage records read failed:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to read usage records');
  }
}
