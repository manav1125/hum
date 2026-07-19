import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "./db-connection.js";
import { memoryV2ActivationLogs } from "./schema.js";

export interface MemoryV2ConceptRowRecord {
  slug: string;
  finalActivation: number;
  ownActivation: number;
  priorActivation: number;
  simUser: number;
  simAssistant: number;
  simNow: number;
  /**
   * Cross-encoder rerank delta in raw rerank space (`alpha · r_norm_u`)
   * for the user channel. Zero when rerank is disabled or the slug fell
   * outside the unified top-K-by-pre-rerank-A_o window. Applied
   * additively to A_o weighted by `c_user` — `simUser` itself is the
   * raw fused score and never carries the boost. Stored as a JSON field,
   * so older log rows pre-date this addition and decode with `undefined`;
   * readers should fall back to 0.
   */
  simUserRerankBoost: number;
  /**
   * Cross-encoder rerank delta for the assistant channel. Same semantics
   * as `simUserRerankBoost`, weighted by `c_assistant` when applied to
   * A_o. The NOW channel intentionally bypasses rerank, so there is no
   * `simNowRerankBoost`.
   */
  simAssistantRerankBoost: number;
  /**
   * True when rerank ran and this slug landed in the unified
   * top-K-by-pre-rerank-A_o pool. Distinguishes "cross-encoder evaluated
   * this and chose 0" from "rerank skipped this slug" so the inspector
   * can keep the rerank rows visible at `+0.000` instead of silently
   * dropping them. Older log rows pre-date this field and decode with
   * `undefined`; readers should fall back to `false`.
   */
  inRerankPool: boolean;
  spreadContribution: number;
  /**
   * Provenance of this concept row.
   *   - `prior_state` — carried over from prior turn's activation state.
   *   - `ann_top50`   — entered via ANN top-K candidate pool.
   *   - `both`        — present in both prior state and ANN pool.
   *   - `router`      — legacy tag for memory-v2 router selections written
   *     before tier-aware provenance landed. New rows never use this; old
   *     activation log rows still carry it and the inspector renders it
   *     as-is for backward compat.
   *   - `tier1`       — router-mode, selected by the tier-1 (recently
   *     modified) batch.
   *   - `tier2`       — router-mode, selected by the tier-2 (highest EMA)
   *     batch.
   *   - `tier3:<N>`   — router-mode, selected by tier-3 batch N (0-indexed).
   *     A single-batch (no-tier carve-out) workspace produces `tier3:0`.
   *     The bucket index lets inspector queries attribute selections to
   *     specific hash-bucketed parallel calls.
   *   - `carry_over`  — router-mode row representing a slug carried over
   *     from `priorEverInjected` that the router did NOT re-pick on this
   *     turn. The cached attachment from a prior turn is still present
   *     on a prior user message; emitting one of the tier tags for these
   *     rows would overcount router selections in inspector queries.
   *
   * All router-mode rows (`tier*`, `router`, `carry_over`) zero out the
   * activation values (`finalActivation`, `ownActivation`, etc.) because
   * the router does not compute spreading-activation scores.
   */
  source:
    | "prior_state"
    | "ann_top50"
    | "both"
    | "router"
    | "carry_over"
    | "tier1"
    | "tier2"
    | `tier3:${number}`;
  /**
   * Per-turn outcome for this slug:
   *   - `in_context`  — already injected on a prior turn; cached attachment
   *     remains visible without re-rendering.
   *   - `injected`    — freshly rendered into this turn's user message.
   *   - `not_injected`— a candidate that didn't make `slugsToRender`.
   *   - `page_missing`— would-have-been-injected, but `readPage` returned
   *     null (file vanished between selection and render — stale Qdrant
   *     or edge-index entry).
   *   - `corrupt`     — would-have-been-injected, but `readPage` threw
   *     (e.g. malformed frontmatter). Other slugs in the same batch
   *     rendered normally.
   */
  status:
    | "in_context"
    | "injected"
    | "not_injected"
    | "page_missing"
    | "corrupt";
  /**
   * v3 shadow only: the retrieval lane that surfaced this slug
   * (`hot` | `sparse` | `dense` | `tree` | `edge`). Lets a shadow run be
   * analyzed by provenance — which lane each v3 pick came from. Undefined on
   * `router`/`per-turn`/etc. v2 rows; stored in the JSON concept blob, so older
   * rows decode with `undefined`.
   */
  lane?: string;
}

export interface MemoryV2ConfigSnapshot {
  d: number;
  c_user: number;
  c_assistant: number;
  c_now: number;
  k: number;
  hops: number;
  top_k: number;
  epsilon: number;
}

/**
 * Fallback cap on the number of concept rows serialized per activation-log
 * row when the caller does not pass `maxConcepts` (config:
 * `memory.v2.activation_log_max_concepts`). With an unlimited
 * `ann_candidate_limit`, `telemetryRows` covers the ENTIRE concept-page
 * collection every turn — observed at ~114KB average / 579KB max per row in
 * production, the single largest driver of assistant.db growth. Nothing
 * reconstructs state from these rows (inspector + debug aggregation only),
 * so dropping the lowest-activation `not_injected` tail is lossless for
 * every functional consumer.
 */
export const DEFAULT_ACTIVATION_LOG_MAX_CONCEPTS = 300;

/**
 * Bound the telemetry rows serialized into one activation-log row.
 * Rows whose status is anything other than `not_injected` (injected,
 * in_context, page_missing, corrupt) are always kept — they are the
 * meaningful outcomes and are bounded by top_k. The remaining budget is
 * filled with the highest-`finalActivation` `not_injected` candidates.
 * Original relative order is preserved for the kept rows.
 */
export function capConceptRowsForLog(
  concepts: MemoryV2ConceptRowRecord[],
  maxConcepts: number | null,
): MemoryV2ConceptRowRecord[] {
  if (maxConcepts === null || concepts.length <= maxConcepts) return concepts;
  const keep = new Set<MemoryV2ConceptRowRecord>();
  for (const row of concepts) {
    if (row.status !== "not_injected") keep.add(row);
  }
  if (keep.size < maxConcepts) {
    const rejected = concepts
      .filter((row) => !keep.has(row))
      .sort((a, b) => b.finalActivation - a.finalActivation);
    for (const row of rejected) {
      if (keep.size >= maxConcepts) break;
      keep.add(row);
    }
  }
  return concepts.filter((row) => keep.has(row));
}

export interface RecordMemoryV2ActivationLogParams {
  conversationId: string;
  turn: number;
  /**
   * Call-site mode: `context-load` for fresh / post-compaction loads,
   * `per-turn` for normal append injections, `errored` when `injectMemoryV2Block`
   * threw before completing — telemetry is still written so silent failures
   * are observable in the database, with whatever `concepts` rows had been
   * built so far (possibly empty). `router` indicates the LLM router selected
   * the per-turn page set; router-mode rows carry zeroed activation values and
   * `source: "router"` on every concept row. `v3_shadow` is written by the
   * live-shadow v3 retrieval middleware: it records v3's selection set for
   * comparison without affecting injected context. The harness oracle filters
   * `mode='router'`, so `v3_shadow` rows never pollute it; the inspector can
   * still surface them.
   */
  mode: "context-load" | "per-turn" | "errored" | "router" | "v3_shadow";
  concepts: MemoryV2ConceptRowRecord[];
  config: MemoryV2ConfigSnapshot;
  /**
   * Cap on serialized concept rows (see {@link capConceptRowsForLog}).
   * Callers with an `AssistantConfig` in hand should pass
   * `config.memory.v2.activation_log_max_concepts`; omitted, the
   * {@link DEFAULT_ACTIVATION_LOG_MAX_CONCEPTS} fallback applies.
   * `null` = unlimited.
   */
  maxConcepts?: number | null;
}

export function recordMemoryV2ActivationLog(
  params: RecordMemoryV2ActivationLogParams,
): void {
  const db = getDb();
  const maxConcepts =
    params.maxConcepts === undefined
      ? DEFAULT_ACTIVATION_LOG_MAX_CONCEPTS
      : params.maxConcepts;
  const concepts = capConceptRowsForLog(params.concepts, maxConcepts);
  // Skills now live as concept rows under `slug: "skills/<id>"`, so the
  // separate `skills_json` column is always written empty. The column itself
  // remains in the schema for backwards-compat with prior log rows; the
  // reader drops it. A future migration can DROP the column once those rows
  // age out of relevance.
  db.insert(memoryV2ActivationLogs)
    .values({
      id: uuid(),
      conversationId: params.conversationId,
      messageId: null,
      turn: params.turn,
      mode: params.mode,
      conceptsJson: JSON.stringify(concepts),
      skillsJson: "[]",
      configJson: JSON.stringify(params.config),
      createdAt: Date.now(),
    })
    .run();
}

export function backfillMemoryV2ActivationMessageId(
  conversationId: string,
  messageId: string,
): void {
  const db = getDb();
  // `v3_shadow` rows are detached telemetry written outside the live turn with
  // a null messageId; they are not tied to any specific message. Excluding them
  // keeps their messageId null instead of stamping them with a later turn's id.
  db.update(memoryV2ActivationLogs)
    .set({ messageId })
    .where(
      and(
        eq(memoryV2ActivationLogs.conversationId, conversationId),
        isNull(memoryV2ActivationLogs.messageId),
        ne(memoryV2ActivationLogs.mode, "v3_shadow"),
      ),
    )
    .run();
}

export interface MemoryV2ActivationLog {
  conversationId: string;
  turn: number;
  mode: "context-load" | "per-turn" | "errored" | "router" | "v3_shadow";
  concepts: MemoryV2ConceptRowRecord[];
  config: MemoryV2ConfigSnapshot;
}

export function getMemoryV2ActivationLogByMessageIds(
  messageIds: string[],
): MemoryV2ActivationLog | null {
  if (messageIds.length === 0) return null;
  const db = getDb();
  const rows = db
    .select()
    .from(memoryV2ActivationLogs)
    .where(inArray(memoryV2ActivationLogs.messageId, messageIds))
    .orderBy(desc(memoryV2ActivationLogs.createdAt))
    .all();
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    conversationId: row.conversationId,
    turn: row.turn,
    mode: row.mode as
      | "context-load"
      | "per-turn"
      | "errored"
      | "router"
      | "v3_shadow",
    concepts: JSON.parse(row.conceptsJson) as MemoryV2ConceptRowRecord[],
    config: JSON.parse(row.configJson) as MemoryV2ConfigSnapshot,
  };
}
