/**
 * Learn usage bridge — folds the Cue Learn sidecar's LLM spend into the
 * workspace usage ledger so Guardrails shows ONE honest number.
 *
 * The sidecar (OpenMAIC fork) logs every generation to its own usage log and
 * serves raw rows at `GET /learn/api/usage/records?since=<epoch-ms>` (added in
 * the fork for exactly this bridge). This service polls that endpoint over Fly
 * private networking, prices each LLM row with Cue's own pricing tables, and
 * records it as a normal `llm_usage_events` row with `actor: "learn"`.
 *
 * Cursor and idempotency need no new state:
 *   - cursor  = the max sidecar record timestamp among imported rows. The
 *     sidecar's record ids are `<epoch-ms>-<counter>` and are preserved here
 *     as requestId `learn:<id>`, so the cursor is parsed straight out of the
 *     stored request ids (created_at can't serve — recordUsageEvent stamps
 *     import time, not record time),
 *   - dedupe  = requestId checked per batch, so a re-poll after a partial
 *     import never double-counts.
 *
 * Non-LLM rows (image/video/tts/asr) are skipped for now: the ledger is
 * token-denominated and pricing those honestly needs per-unit tables. Their
 * counts remain visible in Learn's own Token Plan panel.
 *
 * Enabled only when LEARN_UPSTREAM_URL is set (the same env that lights the
 * gateway's /learn proxy — daemon and gateway share the machine env).
 */

import { recordUsageEvent } from "../memory/llm-usage-store.js";
import { rawAll } from "../memory/raw-query.js";
import {
  buildPricingUsage,
  resolveStructuredPricing,
} from "../usage/pricing.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("learn-usage-sync");

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 500;
const REQUEST_ID_PREFIX = "learn:";

interface LearnUsageRecord {
  id: string;
  createdAt: number;
  kind: string;
  providerId: string;
  modelId: string;
  modelString: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function learnUpstreamUrl(): string | undefined {
  const raw = process.env.LEARN_UPSTREAM_URL?.trim();
  if (!raw) return undefined;
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/**
 * Poll cursor: the max sidecar record timestamp among imported rows, parsed
 * from the `learn:<epoch-ms>-<counter>` request ids (CAST stops at the first
 * non-digit, so the `-<counter>` suffix falls away).
 */
function readCursor(): number {
  try {
    const rows = rawAll<{ max_since: number | null }>(/*sql*/ `
      SELECT MAX(CAST(substr(request_id, ${REQUEST_ID_PREFIX.length + 1}) AS INTEGER)) AS max_since
      FROM llm_usage_events
      WHERE actor = 'learn' AND request_id LIKE '${REQUEST_ID_PREFIX}%'
      `);
    return rows[0]?.max_since ?? 0;
  } catch (err) {
    log.warn({ err }, "Learn usage cursor read failed — starting from 0");
    return 0;
  }
}

/** Request ids already imported among `ids` (partial-import dedupe). */
function existingRequestIds(ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  try {
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
    const rows = rawAll<{ request_id: string }>(
      /*sql*/ `SELECT request_id FROM llm_usage_events WHERE actor = 'learn' AND request_id IN (${placeholders})`,
      ...ids,
    );
    return new Set(rows.map((r) => r.request_id));
  } catch {
    return new Set();
  }
}

export class LearnUsageSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (!learnUpstreamUrl()) {
      log.info("Learn usage sync disabled — LEARN_UPSTREAM_URL not set");
      return;
    }
    this.timer = setInterval(() => void this.syncOnce(), SYNC_INTERVAL_MS);
    // First pass shortly after boot rather than a full interval later.
    setTimeout(() => void this.syncOnce(), 15_000);
    log.info({ intervalMs: SYNC_INTERVAL_MS }, "Learn usage sync started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll+import pass. Never throws — a sidecar hiccup waits for the next tick. */
  async syncOnce(): Promise<{ imported: number } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const base = learnUpstreamUrl();
      if (!base) return null;
      let since = readCursor();
      let imported = 0;
      // Page until drained; bounded by the sidecar's own record volume.
      for (let page = 0; page < 20; page++) {
        const res = await fetch(
          `${base}/learn/api/usage/records?since=${since}&limit=${BATCH_LIMIT}`,
          { signal: AbortSignal.timeout(20_000) },
        );
        if (!res.ok) {
          log.warn({ status: res.status }, "Learn usage poll failed");
          return { imported };
        }
        const body = (await res.json()) as {
          data?: {
            records?: LearnUsageRecord[];
            nextSince?: number;
            hasMore?: boolean;
          };
          records?: LearnUsageRecord[];
          nextSince?: number;
          hasMore?: boolean;
        };
        const payload = body.data ?? body;
        const records = payload.records ?? [];
        if (records.length === 0) return { imported };

        const llmRecords = records.filter((r) => r.kind === "llm");
        const seen = existingRequestIds(
          llmRecords.map((r) => `${REQUEST_ID_PREFIX}${r.id}`),
        );
        for (const r of llmRecords) {
          const requestId = `${REQUEST_ID_PREFIX}${r.id}`;
          if (seen.has(requestId)) continue;
          const pricing = resolveStructuredPricing(
            r.providerId,
            r.modelId,
            buildPricingUsage({
              providerName: r.providerId,
              model: r.modelId,
              inputTokens:
                r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens,
              outputTokens: r.outputTokens,
              cacheCreationInputTokens: r.cacheCreationTokens,
              cacheReadInputTokens: r.cacheReadTokens,
            }),
          );
          recordUsageEvent(
            {
              provider: r.providerId,
              model: r.modelId,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              cacheCreationInputTokens: r.cacheCreationTokens || null,
              cacheReadInputTokens: r.cacheReadTokens || null,
              rawUsage: null,
              actor: "learn",
              conversationId: null,
              runId: null,
              requestId,
            },
            pricing,
          );
          imported += 1;
        }
        since = payload.nextSince ?? since;
        if (!payload.hasMore) {
          if (imported > 0) log.info({ imported }, "Learn usage imported");
          return { imported };
        }
      }
      return { imported };
    } catch (err) {
      log.warn({ err }, "Learn usage sync pass failed");
      return null;
    } finally {
      this.running = false;
    }
  }
}
