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
 * Non-LLM rows (tts/asr/image/video) are priced from the per-unit table
 * below (documented estimates for the providers this deployment locks in)
 * and land as zero-token rows whose estimated_cost_usd carries the spend —
 * so voice, images, and video show up in the same Guardrails number.
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
  /** Non-token usage (image count, video seconds, TTS/ASR characters/seconds). */
  quantity?: number;
  unit?: string;
}

/**
 * Per-unit USD estimates for Learn's non-LLM spend, by usage kind. These are
 * documented list-price estimates for the providers the deployment locks in
 * (ElevenLabs voice, Nano Banana images, Veo video), verified against the
 * providers' published price pages 2026-09 — close enough for an honest
 * ledger, revisited when providers change. A kind missing here is recorded
 * unpriced rather than dropped.
 */
const NON_LLM_UNIT_PRICE_USD: Record<
  string,
  Partial<Record<string, number>>
> = {
  // ElevenLabs TTS (Multilingual v2/v3): $0.10 per 1k characters.
  tts: { character: 0.1 / 1000 },
  // ElevenLabs Scribe batch transcription: $0.22 per audio hour.
  asr: { second: 0.22 / 3600, character: 0 },
  // Gemini Flash Image ("Nano Banana"): $0.039 per image.
  image: { image: 0.039 },
  // Veo standard 1080p with audio: $0.40 per second of generated video.
  video: { second: 0.4 },
};

function priceNonLlm(record: LearnUsageRecord): {
  estimatedCostUsd: number | null;
  pricingStatus: "priced" | "unpriced";
} {
  const quantity = record.quantity ?? 0;
  const perUnit = record.unit
    ? NON_LLM_UNIT_PRICE_USD[record.kind]?.[record.unit]
    : undefined;
  if (quantity > 0 && perUnit !== undefined) {
    return { estimatedCostUsd: quantity * perUnit, pricingStatus: "priced" };
  }
  return { estimatedCostUsd: null, pricingStatus: "unpriced" };
}

/**
 * The sidecar names providers in its own vocabulary; Cue's pricing catalog
 * keys some of them differently. Map ONLY for the pricing lookup — the
 * ledger row keeps the sidecar's provider string as reported.
 */
const PRICING_PROVIDER_MAP: Record<string, string> = {
  google: "gemini",
};

function pricingProviderFor(providerId: string): string {
  return PRICING_PROVIDER_MAP[providerId] ?? providerId;
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

        const seen = existingRequestIds(
          records.map((r) => `${REQUEST_ID_PREFIX}${r.id}`),
        );
        for (const r of records) {
          const requestId = `${REQUEST_ID_PREFIX}${r.id}`;
          if (seen.has(requestId)) continue;
          const isLlm = r.kind === "llm";
          const pricing = isLlm
            ? resolveStructuredPricing(
                pricingProviderFor(r.providerId),
                r.modelId,
                buildPricingUsage({
                  providerName: pricingProviderFor(r.providerId),
                  model: r.modelId,
                  inputTokens:
                    r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens,
                  outputTokens: r.outputTokens,
                  cacheCreationInputTokens: r.cacheCreationTokens,
                  cacheReadInputTokens: r.cacheReadTokens,
                }),
              )
            : priceNonLlm(r);
          recordUsageEvent(
            {
              provider: r.providerId,
              // Non-LLM rows carry the kind in the model string so the model
              // mix reads honestly ("elevenlabs tts", "veo video").
              model: isLlm ? r.modelId : `${r.modelId} (${r.kind})`,
              inputTokens: isLlm ? r.inputTokens : 0,
              outputTokens: isLlm ? r.outputTokens : 0,
              cacheCreationInputTokens: isLlm
                ? r.cacheCreationTokens || null
                : null,
              cacheReadInputTokens: isLlm ? r.cacheReadTokens || null : null,
              rawUsage: null,
              actor: "learn",
              callSite: "learn",
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
